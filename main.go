// alexwrt-subgen —— 订阅转换 + 分级生成服务（带本地 Web 控制台）
//
// 干三件事：
//  1. 拉取多个机场订阅（clash 格式），任一失败自动跳过，并用上一次成功的磁盘缓存兜底
//  2. 把静态节点（zanz / mac-netbird 这类订阅里没有的）和订阅节点合并
//  3. 按 config.yaml 里的 groups 生成策略组（fallback 降级链 / url-test 池 / select），
//     拼上 base.yaml 和规则，输出一份完整的 mihomo 配置当订阅
//
// 控制台：http://127.0.0.1:25500/<token>/admin
// 订阅：  http://127.0.0.1:25500/<token>/sub
package main

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// 控制台 UI 只有一份：LuCI 的静态资源目录里那份，Go 二进制直接 embed 同一文件，
// 独立运行时由 web/index.html 把 view/ui/E 四个桩补上再执行它
//
//go:embed luci-app/htdocs/luci-static/resources/subgen/ui.js
var uiJS []byte

//go:embed web/index.html
var uiShell []byte

// Node 是一条代理节点，键值原样保留
type Node map[string]any

type SubConfig struct {
	Name    string `yaml:"name" json:"name"`
	URL     string `yaml:"url" json:"url"`
	UA      string `yaml:"ua,omitempty" json:"ua"`
	Primary bool   `yaml:"primary,omitempty" json:"primary"`
	Enabled *bool  `yaml:"enabled,omitempty" json:"enabled,omitempty"`
}

// RuleSet 一个远程规则集（rule-providers 条目 + 对应的 RULE-SET 规则）
type RuleSet struct {
	ID     string `yaml:"id" json:"id"`         // 例：geosite-cn / geoip-cn
	Target string `yaml:"target" json:"target"` // 命中后走哪个组
}

type GroupConfig struct {
	Name          string   `yaml:"name" json:"name"`
	// Kind 只给界面分类用，不参与生成：sub=来自订阅、ruleset=规则集目标、custom=自己写
	Kind          string   `yaml:"kind,omitempty" json:"kind"`
	Type          string   `yaml:"type" json:"type"`
	Members       []string `yaml:"members,omitempty" json:"members"`
	Source        string   `yaml:"source,omitempty" json:"source"`
	Filter        string   `yaml:"filter,omitempty" json:"filter"`
	ExcludeFilter string   `yaml:"exclude_filter,omitempty" json:"exclude_filter"`
	IncludeAll    bool     `yaml:"include_all,omitempty" json:"include_all"`
	URL           string   `yaml:"url,omitempty" json:"url"`
	Interval      int      `yaml:"interval,omitempty" json:"interval"`
	Timeout       int      `yaml:"timeout,omitempty" json:"timeout"`
	Tolerance     int      `yaml:"tolerance,omitempty" json:"tolerance"`
	Lazy          *bool    `yaml:"lazy,omitempty" json:"lazy"`
}

type Config struct {
	Listen      string      `yaml:"listen" json:"listen"`
	Token       string      `yaml:"token" json:"token"`
	CacheTTL    int         `yaml:"cache_ttl" json:"cache_ttl"`
	CacheDir    string      `yaml:"cache_dir" json:"cache_dir"`
	Base        string      `yaml:"base" json:"base"`
	RulesMode   string      `yaml:"rules_mode" json:"rules_mode"` // inline | providers
	Rules       string      `yaml:"rules" json:"rules"`
	CustomRules []string    `yaml:"custom_rules" json:"custom_rules"`
	// Final 是「一条规则都没匹配上」时的去向。留空 = 沿用规则文件里的 MATCH（订阅作者一般写代理组）；
	// 填 DIRECT 就是白名单模式：只有规则明确点名的域名走代理，其余全直连
	Final string `yaml:"final,omitempty" json:"final"`
	RuleSets    []RuleSet   `yaml:"rule_sets" json:"rule_sets"`
	DropNodes   []string    `yaml:"drop_nodes" json:"drop_nodes"`
	Static      []Node      `yaml:"static_proxies" json:"static_proxies"`
	Subs        []SubConfig `yaml:"subscriptions" json:"subscriptions"`
	Groups      []GroupConfig `yaml:"groups" json:"groups"`
}

type cachedSub struct {
	nodes    []Node
	fetched  time.Time
	userinfo string
	err      error
}

// subCache 是进程级共享的订阅缓存：/api/render 干跑和正式 /sub 共用同一份，
// 不会因为你在页面上多点几次预览就去机场拉几次
type subCache struct {
	mu sync.Mutex
	m  map[string]*cachedSub
}

type App struct {
	cfg     Config
	cfgDir  string
	cfgPath string
	cache   *subCache
	dropRe  []*regexp.Regexp
	// 命令行 -listen 只是临时覆盖，保存配置时不要把覆盖值写进文件
	fileListen     string
	overrideListen string
}

// ---------------- 预设规则集 ----------------

type Preset struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	Behavior      string `json:"behavior"`
	DefaultTarget string `json:"default_target"`
}

var presets = []Preset{
	{"geosite-cn", "大陆域名", "domain", "DIRECT"},
	{"geoip-cn", "大陆 IP", "ipcidr", "DIRECT"},
	{"geosite-gfw", "GFW 列表", "domain", "🚀节点选择"},
	{"geosite-google", "Google", "domain", "🚀节点选择"},
	{"geosite-youtube", "YouTube", "domain", "🎬媒体解锁"},
	{"geosite-netflix", "Netflix", "domain", "🎬媒体解锁"},
	{"geosite-disney", "Disney+", "domain", "🎬媒体解锁"},
	{"geosite-openai", "OpenAI / ChatGPT", "domain", "🤖AI网站"},
	{"geosite-telegram", "Telegram", "domain", "🚀节点选择"},
	{"geosite-twitter", "X / Twitter", "domain", "🚀节点选择"},
	{"geosite-facebook", "Facebook", "domain", "🚀节点选择"},
	{"geosite-instagram", "Instagram", "domain", "🚀节点选择"},
	{"geosite-spotify", "Spotify", "domain", "🚀节点选择"},
	{"geosite-tiktok", "TikTok", "domain", "🚀节点选择"},
	{"geosite-microsoft", "Microsoft", "domain", "🚀节点选择"},
	{"geosite-apple", "Apple", "domain", "🚀节点选择"},
	{"geosite-steam", "Steam", "domain", "🚀节点选择"},
	{"geosite-category-ads-all", "广告拦截", "domain", "🛑广告拦截"},
}

func presetByID(id string) (Preset, bool) {
	for _, p := range presets {
		if p.ID == id {
			return p, true
		}
	}
	return Preset{}, false
}

const rulesetRawBase = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo"

func rulesetURL(id string) string {
	if strings.HasPrefix(id, "geoip-") {
		return rulesetRawBase + "/geoip/" + strings.TrimPrefix(id, "geoip-") + ".mrs"
	}
	return rulesetRawBase + "/geosite/" + strings.TrimPrefix(id, "geosite-") + ".mrs"
}

// ---------------- 启动 ----------------

func main() {
	cfgPath := flag.String("c", "config.yaml", "配置文件路径")
	once := flag.Bool("once", false, "只生成一次并打印到 stdout")
	gen := flag.String("gen", "", "生成到指定文件后退出")
	listen := flag.String("listen", "", "覆盖监听地址")
	flag.Parse()

	app, err := loadApp(*cfgPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}
	app.fileListen = app.cfg.Listen
	if *listen != "" {
		app.cfg.Listen = *listen
		app.overrideListen = *listen
	}

	if *once || *gen != "" {
		body, _, err := app.generate()
		if err != nil {
			log.Fatalf("生成失败: %v", err)
		}
		if *gen != "" {
			if err := os.WriteFile(*gen, body, 0644); err != nil {
				log.Fatalf("写文件失败: %v", err)
			}
			log.Printf("已生成 %s（%d 字节）", *gen, len(body))
			return
		}
		os.Stdout.Write(body)
		return
	}

	s := &server{app: app}
	log.Printf("控制台 http://%s/%s/admin", app.cfg.Listen, app.cfg.Token)
	log.Printf("订阅   http://%s/%s/sub", app.cfg.Listen, app.cfg.Token)
	srv := &http.Server{Addr: app.cfg.Listen, Handler: cors(s.handler()), ReadHeaderTimeout: 15 * time.Second}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("服务退出: %v", err)
	}
}

func loadApp(path string) (*App, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg Config
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("解析 %s: %w", path, err)
	}
	return newApp(cfg, filepath.Dir(path), path, &subCache{m: map[string]*cachedSub{}})
}

// normalize 把 nil 切片补成空数组，前端不用到处判 null
func (c *Config) normalize() {
	if c.CustomRules == nil {
		c.CustomRules = []string{}
	}
	if c.RuleSets == nil {
		c.RuleSets = []RuleSet{}
	}
	if c.DropNodes == nil {
		c.DropNodes = []string{}
	}
	if c.Static == nil {
		c.Static = []Node{}
	}
	if c.Subs == nil {
		c.Subs = []SubConfig{}
	}
	if c.Groups == nil {
		c.Groups = []GroupConfig{}
	}
	for i := range c.Groups {
		if c.Groups[i].Members == nil {
			c.Groups[i].Members = []string{}
		}
		if c.Groups[i].Kind == "" {
			if c.Groups[i].Source != "" {
				c.Groups[i].Kind = "sub"
			} else {
				c.Groups[i].Kind = "custom"
			}
		}
	}
}

func newApp(cfg Config, dir, path string, cache *subCache) (*App, error) {
	cfg.normalize()
	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:25500"
	}
	if cfg.CacheTTL == 0 {
		cfg.CacheTTL = 3600
	}
	if cfg.CacheDir == "" {
		cfg.CacheDir = "cache"
	}
	if cfg.Base == "" {
		cfg.Base = "base.yaml"
	}
	if cfg.RulesMode == "" {
		cfg.RulesMode = "inline"
	}
	if cfg.Rules == "" {
		cfg.Rules = "rules_inline.yaml"
	}
	if cfg.Token == "" {
		return nil, errors.New("token 不能为空")
	}
	if len(cfg.Subs) == 0 {
		return nil, errors.New("至少要有一条订阅")
	}
	if len(cfg.Groups) == 0 {
		return nil, errors.New("至少要有一个策略组")
	}
	a := &App{cfg: cfg, cfgDir: dir, cfgPath: path, cache: cache}
	if !filepath.IsAbs(a.cfg.CacheDir) {
		a.cfg.CacheDir = filepath.Join(dir, a.cfg.CacheDir)
	}
	os.MkdirAll(a.cfg.CacheDir, 0755)
	for _, p := range cfg.DropNodes {
		re, err := regexp.Compile(p)
		if err != nil {
			return nil, fmt.Errorf("drop_nodes 正则 %q 无效: %w", p, err)
		}
		a.dropRe = append(a.dropRe, re)
	}
	for _, g := range cfg.Groups {
		if g.Filter != "" {
			if _, err := regexp.Compile(g.Filter); err != nil {
				return nil, fmt.Errorf("组 %s 的 filter 无效: %w", g.Name, err)
			}
		}
		if g.ExcludeFilter != "" {
			if _, err := regexp.Compile(g.ExcludeFilter); err != nil {
				return nil, fmt.Errorf("组 %s 的 exclude_filter 无效: %w", g.Name, err)
			}
		}
	}
	return a, nil
}

// save 把配置写回 config.yaml（旧文件留 .bak），返回新的 App
func (a *App) save(cfg Config) (*App, error) {
	cfg.normalize()
	if a.overrideListen != "" && cfg.Listen == a.overrideListen {
		cfg.Listen = a.fileListen
	}
	na, err := newApp(cfg, a.cfgDir, a.cfgPath, a.cache)
	if err != nil {
		return nil, err
	}
	na.fileListen, na.overrideListen = cfg.Listen, a.overrideListen
	na.cfg.Listen = a.cfg.Listen
	// 至少能生成一次，避免把错误配置存进去把服务搞死
	if _, _, err := na.generate(); err != nil {
		return nil, fmt.Errorf("这份配置生成不出来，未保存: %w", err)
	}
	if old, err := os.ReadFile(a.cfgPath); err == nil {
		os.WriteFile(a.cfgPath+".bak", old, 0600)
	}
	out, err := yaml.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	header := "# 由控制台写入（/<token>/admin 或 LuCI）。注释会丢，改前的原始文件在 config.yaml.bak\n"
	if err := os.WriteFile(a.cfgPath, append([]byte(header), []byte(unescapeUnicode(string(out)))...), 0600); err != nil {
		return nil, err
	}
	return na, nil
}

// ---------------- HTTP ----------------

type server struct {
	mu  sync.RWMutex
	app *App
}

func (s *server) current() *App {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.app
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		app := s.current()
		tok, rest := splitToken(r.URL.Path)
		if q := r.URL.Query().Get("token"); q != "" {
			tok = q
		}
		if tok != app.cfg.Token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		switch rest {
		case "admin", "":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(uiShell)
		case "ui.js":
			w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			w.Write(uiJS)
		case "sub":
			if r.URL.Query().Get("refresh") != "" {
				app.cache.mu.Lock()
				app.cache.m = map[string]*cachedSub{}
				app.cache.mu.Unlock()
			}
			body, userinfo, err := app.generate()
			if err != nil {
				log.Printf("生成失败: %v", err)
				http.Error(w, "generate failed: "+err.Error(), http.StatusInternalServerError)
				return
			}
			if userinfo != "" {
				w.Header().Set("Subscription-Userinfo", userinfo)
			}
			w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
			w.Header().Set("Profile-Update-Interval", "6")
			w.Write(body)
		case "api/config":
			s.handleConfig(w, r)
		case "api/status":
			writeJSON(w, map[string]any{
				"ok": true, "running": true, "pid": os.Getpid(),
				"config": app.cfgPath, "listen": app.cfg.Listen, "token": app.cfg.Token,
			})
		case "api/quit":
			// 独立模式（PC）用：页面点“关闭后端”就把进程停掉，没必要一直在后台跑
			if r.Method != http.MethodPost {
				http.Error(w, "method not allowed", 405)
				return
			}
			writeJSON(w, map[string]any{"ok": true})
			log.Printf("控制台要求关闭后端，进程退出")
			go func() {
				time.Sleep(300 * time.Millisecond)
				os.Exit(0)
			}()
		case "api/presets":
			writeJSON(w, map[string]any{"presets": presets})
		case "api/preview":
			s.handlePreview(w, r)
		case "api/render":
			s.handleRender(w, r)
		default:
			http.NotFound(w, r)
		}
	})
	return mux
}

// cors 让 LuCI 页面（http://路由器IP）能直连本服务（另一个端口）
func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func splitToken(p string) (string, string) {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) == 0 {
		return "", ""
	}
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], strings.Join(parts[1:], "/")
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	json.NewEncoder(w).Encode(v)
}

func (s *server) handleConfig(w http.ResponseWriter, r *http.Request) {
	app := s.current()
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, app.cfg)
	case http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		var cfg Config
		if err := json.Unmarshal(body, &cfg); err != nil {
			http.Error(w, "JSON 解析失败: "+err.Error(), 400)
			return
		}
		na, err := app.save(cfg)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		s.mu.Lock()
		s.app = na
		s.mu.Unlock()
		log.Printf("配置已保存并重新载入")
		writeJSON(w, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", 405)
	}
}

func (s *server) handlePreview(w http.ResponseWriter, r *http.Request) {
	res, err := statsOf(s.current())
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, res)
}

// handleRender 干跑：用页面上还没保存的配置渲染一份，不落盘。实时预览靠它
func (s *server) handleRender(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	cur := s.current()
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	var cfg Config
	if err := json.Unmarshal(body, &cfg); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": "JSON 解析失败: " + err.Error()})
		return
	}
	// 用同一个缓存，预览不会额外打机场
	tmp, err := newApp(cfg, cur.cfgDir, cur.cfgPath, cur.cache)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	res, err := statsOf(tmp)
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	if r.URL.Query().Get("full") != "" {
		if raw, _, e := tmp.generate(); e == nil {
			res["yaml"] = string(raw)
		}
	}
	writeJSON(w, res)
}

func statsOf(app *App) (map[string]any, error) {
	body, _, err := app.generate()
	if err != nil {
		return nil, err
	}
	var doc struct {
		Proxies []Node           `yaml:"proxies"`
		Groups  []map[string]any `yaml:"proxy-groups"`
		Rules   []string         `yaml:"rules"`
	}
	if err := yaml.Unmarshal(body, &doc); err != nil {
		return nil, errors.New("生成结果不是合法 YAML: " + err.Error())
	}
	type groupView struct {
		Name  string   `json:"name"`
		Type  string   `json:"type"`
		Count int      `json:"count"`
		First []string `json:"first"`
	}
	var gs []groupView
	for _, raw := range doc.Groups {
		item := groupView{}
		item.Name, _ = raw["name"].(string)
		item.Type, _ = raw["type"].(string)
		if v, ok := raw["proxies"].([]any); ok {
			item.Count = len(v)
			for i, x := range v {
				if i >= 6 {
					break
				}
				item.First = append(item.First, fmt.Sprint(x))
			}
		}
		gs = append(gs, item)
	}
	// 每个订阅这一轮的结果，页面上直接显示哪个机场挂了
	type subStat struct {
		Name  string `json:"name"`
		Nodes int    `json:"nodes"`
		Error string `json:"error"`
	}
	var subs []subStat
	for _, s := range app.cfg.Subs {
		st := subStat{Name: s.Name}
		app.cache.mu.Lock()
		if c, ok := app.cache.m[s.Name]; ok && c != nil {
			st.Nodes = len(c.nodes)
			if c.err != nil {
				st.Error = c.err.Error()
			}
		}
		app.cache.mu.Unlock()
		subs = append(subs, st)
	}

	head := body
	if len(head) > 1200 {
		head = head[:1200]
	}
	return map[string]any{
		"ok":      true,
		"size":    len(body),
		"nodes":   len(doc.Proxies),
		"groups":  gs,
		"rules":   len(doc.Rules),
		"head":    string(head),
		"subs":    subs,
		"sub_url": "http://" + app.cfg.Listen + "/" + app.cfg.Token + "/sub",
	}, nil
}

// ---------------- 订阅拉取 ----------------

func (a *App) fetchSub(s SubConfig) *cachedSub {
	a.cache.mu.Lock()
	if c, ok := a.cache.m[s.Name]; ok && time.Since(c.fetched) < time.Duration(a.cfg.CacheTTL)*time.Second {
		a.cache.mu.Unlock()
		return c
	}
	a.cache.mu.Unlock()

	c := &cachedSub{fetched: time.Now()}
	ua := s.UA
	if ua == "" {
		ua = "clash.meta"
	}
	nodes, userinfo, err := a.download(s.URL, ua)
	if err != nil {
		if diskNodes, derr := a.readDiskCache(s.Name); derr == nil && len(diskNodes) > 0 {
			log.Printf("[%s] 拉取失败(%v)，用磁盘缓存兜底（%d 个节点）", s.Name, err, len(diskNodes))
			c.nodes = diskNodes
		} else {
			log.Printf("[%s] 拉取失败(%v)，且没有可用缓存，该订阅这一轮跳过", s.Name, err)
			c.err = err
		}
	} else {
		c.nodes, c.userinfo = nodes, userinfo
		a.writeDiskCache(s.Name, nodes)
		log.Printf("[%s] 拉到 %d 个节点", s.Name, len(nodes))
	}
	a.cache.mu.Lock()
	a.cache.m[s.Name] = c
	a.cache.mu.Unlock()
	return c
}

func (a *App) download(url, ua string) ([]Node, string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", ua)
	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, "", err
	}
	if len(body) < 64 {
		return nil, "", fmt.Errorf("返回内容只有 %d 字节，视为空订阅", len(body))
	}
	nodes, err := parseProxyBody(body)
	if err != nil {
		return nil, "", err
	}
	return nodes, resp.Header.Get("Subscription-Userinfo"), nil
}

func parseProxyBody(body []byte) ([]Node, error) {
	var wrap struct {
		Proxies []Node `yaml:"proxies"`
	}
	if err := yaml.Unmarshal(body, &wrap); err == nil && len(wrap.Proxies) > 0 {
		return wrap.Proxies, nil
	}
	dec, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(body)))
	if err == nil {
		var list []Node
		if e := yaml.Unmarshal(dec, &list); e == nil && len(list) > 0 {
			return list, nil
		}
	}
	return nil, errors.New("无法解析订阅内容（既不是 clash yaml，也不是 base64 节点列表）")
}

func (a *App) diskPath(name string) string {
	return filepath.Join(a.cfg.CacheDir, safeName(name)+".yaml")
}

func (a *App) readDiskCache(name string) ([]Node, error) {
	raw, err := os.ReadFile(a.diskPath(name))
	if err != nil {
		return nil, err
	}
	var wrap struct {
		Proxies []Node `yaml:"proxies"`
	}
	if err := yaml.Unmarshal(raw, &wrap); err != nil {
		return nil, err
	}
	return wrap.Proxies, nil
}

func (a *App) writeDiskCache(name string, nodes []Node) {
	out := struct {
		Proxies []Node `yaml:"proxies"`
	}{nodes}
	b, err := yaml.Marshal(out)
	if err != nil {
		return
	}
	os.WriteFile(a.diskPath(name), b, 0600)
}

func safeName(s string) string {
	return strings.NewReplacer("/", "_", " ", "_", ":", "_", "\\", "_").Replace(s)
}

// ---------------- 生成 ----------------

func (a *App) generate() ([]byte, string, error) {
	subNodes := map[string][]Node{}
	userinfo := ""
	for _, s := range a.cfg.Subs {
		if s.Enabled != nil && !*s.Enabled {
			continue
		}
		c := a.fetchSub(s)
		if c == nil || c.err != nil || len(c.nodes) == 0 {
			continue
		}
		subNodes[s.Name] = c.nodes
		if s.Primary && c.userinfo != "" {
			userinfo = c.userinfo
		}
	}

	seen := map[string]bool{}
	var proxies []Node
	appendNode := func(n Node) {
		name, _ := n["name"].(string)
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		proxies = append(proxies, n)
	}
	for _, n := range a.cfg.Static {
		appendNode(n)
	}
	for _, s := range a.cfg.Subs {
		nodes, ok := subNodes[s.Name]
		if !ok {
			continue
		}
		for _, n := range nodes {
			if a.dropped(fmt.Sprint(n["name"])) {
				continue
			}
			appendNode(n)
		}
	}

	groups, err := a.buildGroups(subNodes)
	if err != nil {
		return nil, "", err
	}
	providers, rules, err := a.buildRules()
	if err != nil {
		return nil, "", err
	}

	base, err := os.ReadFile(a.resolve(a.cfg.Base))
	if err != nil {
		return nil, "", fmt.Errorf("读 base 失败: %w", err)
	}
	if len(proxies) == 0 {
		return nil, "", errors.New("一个节点都没有，拒绝输出空配置")
	}

	var b strings.Builder
	b.WriteString(strings.TrimRight(string(base), "\n"))
	b.WriteString("\n\n# ===== 以下由 alexwrt-subgen 生成 =====\nproxies:\n")
	for _, n := range proxies {
		b.WriteString("    - " + flowNode(n) + "\n")
	}
	b.WriteString("\nproxy-groups:\n")
	for _, g := range groups {
		b.WriteString("    - " + g + "\n")
	}
	if len(providers) > 0 {
		b.WriteString("\nrule-providers:\n")
		for _, id := range sortedKeys(providers) {
			b.WriteString("    " + id + ":\n")
			for _, line := range providers[id] {
				b.WriteString("        " + line + "\n")
			}
		}
	}
	b.WriteString("\nrules:\n")
	for _, r := range rules {
		b.WriteString("    - " + quote(r) + "\n")
	}

	out := []byte(b.String())
	var check map[string]any
	if err := yaml.Unmarshal(out, &check); err != nil {
		return nil, "", fmt.Errorf("生成的配置不是合法 YAML: %w", err)
	}
	return out, userinfo, nil
}

func (a *App) resolve(p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(a.cfgDir, p)
}

func (a *App) dropped(name string) bool {
	for _, re := range a.dropRe {
		if re.MatchString(name) {
			return true
		}
	}
	return false
}

func sortedKeys(m map[string][]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// buildRules 返回 rule-providers（可选）和最终 rules 列表
func (a *App) buildRules() (map[string][]string, []string, error) {
	providers := map[string][]string{}
	var rules []string
	// 自定义规则永远在最前面
	rules = append(rules, a.cfg.CustomRules...)

	// 远程规则集
	if a.cfg.RulesMode == "providers" {
		for _, rs := range a.cfg.RuleSets {
			p, ok := presetByID(rs.ID)
			if !ok {
				log.Printf("[规则] 未知规则集 %q，跳过", rs.ID)
				continue
			}
			providers[rs.ID] = []string{
				"type: http",
				"behavior: " + p.Behavior,
				"format: mrs",
				"url: " + quote(rulesetURL(rs.ID)),
				"path: " + quote("./ruleset/"+rs.ID+".mrs"),
				"interval: 86400",
			}
			target := rs.Target
			if target == "" {
				target = p.DefaultTarget
			}
			rules = append(rules, "RULE-SET,"+rs.ID+","+target)
		}
	}

	// 内联规则文件
	if a.cfg.RulesMode != "providers" {
		raw, err := os.ReadFile(a.resolve(a.cfg.Rules))
		if err != nil {
			return nil, nil, fmt.Errorf("读规则文件失败: %w", err)
		}
		var doc struct {
			RuleProviders map[string]any `yaml:"rule-providers"`
			Rules         []string       `yaml:"rules"`
		}
		if err := yaml.Unmarshal(raw, &doc); err != nil {
			return nil, nil, fmt.Errorf("解析规则文件失败: %w", err)
		}
		rules = append(rules, doc.Rules...)
	}

	hasMatch := false
	for i := len(rules) - 1; i >= 0; i-- {
		if strings.HasPrefix(strings.TrimSpace(strings.ToUpper(rules[i])), "MATCH,") {
			hasMatch = true
			// final 非空就把兜底目标换掉：填 DIRECT 就是「白名单模式」，
			// 只有订阅规则明确点名的才走代理，其余全直连（等价 passwall 的 gfwlist 模式）
			if a.cfg.Final != "" {
				rules[i] = "MATCH," + a.cfg.Final
			}
			break
		}
	}
	if !hasMatch {
		final := a.cfg.Final
		if final == "" {
			final = "🐟漏网之鱼"
		}
		rules = append(rules, "MATCH,"+final)
	}
	return providers, rules, nil
}

func (a *App) buildGroups(subNodes map[string][]Node) ([]string, error) {
	type resolved struct {
		cfg     GroupConfig
		members []string
		fromSrc bool
		skip    bool
	}
	var list []resolved
	known := map[string]bool{}
	for _, g := range a.cfg.Groups {
		r := resolved{cfg: g}
		if g.Source != "" {
			r.fromSrc = true
			var nodes []Node
			for _, sn := range strings.Split(g.Source, ",") {
				if n, ok := subNodes[strings.TrimSpace(sn)]; ok {
					nodes = append(nodes, n...)
				}
			}
			if len(nodes) == 0 {
				r.skip = true
				log.Printf("[组 %s] 订阅「%s」没有节点，跳过该组", g.Name, g.Source)
				list = append(list, r)
				continue
			}
			var inc, exc *regexp.Regexp
			if g.Filter != "" {
				inc = regexp.MustCompile(g.Filter)
			}
			if g.ExcludeFilter != "" {
				exc = regexp.MustCompile(g.ExcludeFilter)
			}
			for _, n := range nodes {
				name := fmt.Sprint(n["name"])
				if a.dropped(name) {
					continue
				}
				if inc != nil && !inc.MatchString(name) {
					continue
				}
				if exc != nil && exc.MatchString(name) {
					continue
				}
				r.members = append(r.members, name)
			}
			if len(r.members) == 0 {
				r.skip = true
				log.Printf("[组 %s] 订阅「%s」里没有匹配 filter 的节点，跳过该组", g.Name, g.Source)
			}
		} else {
			r.members = append(r.members, g.Members...)
		}
		list = append(list, r)
	}
	for _, r := range list {
		if !r.skip {
			known[r.cfg.Name] = true
		}
	}
	for round := 0; round < len(list)+1; round++ {
		changed := false
		for i := range list {
			r := &list[i]
			if r.skip || r.fromSrc {
				continue
			}
			var kept []string
			for _, m := range r.members {
				if isGroupRef(m) {
					target := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(m), groupRefPrefix))
					if !known[target] {
						log.Printf("[组 %s] 成员「%s」所在组被跳过，剔除", r.cfg.Name, target)
						changed = true
						continue
					}
				}
				kept = append(kept, m)
			}
			r.members = kept
			if len(r.members) == 0 && !r.cfg.IncludeAll {
				r.skip = true
				delete(known, r.cfg.Name)
				log.Printf("[组 %s] 成员全被剔除，跳过该组", r.cfg.Name)
				changed = true
			}
		}
		if !changed {
			break
		}
	}
	var lines []string
	for _, r := range list {
		if r.skip {
			continue
		}
		lines = append(lines, renderGroup(r.cfg, r.members))
	}
	if len(lines) == 0 {
		return nil, errors.New("所有组都被跳过了，检查配置")
	}
	return lines, nil
}

const groupRefPrefix = "@"

func isGroupRef(m string) bool { return strings.HasPrefix(strings.TrimSpace(m), groupRefPrefix) }

func renderGroup(g GroupConfig, members []string) string {
	var parts []string
	parts = append(parts, fmt.Sprintf("name: %s", quote(g.Name)))
	parts = append(parts, fmt.Sprintf("type: %s", quote(g.Type)))
	if g.IncludeAll {
		parts = append(parts, "include-all-proxies: true")
	}
	if len(members) > 0 {
		var ms []string
		for _, m := range members {
			if isGroupRef(m) {
				ms = append(ms, quote(strings.TrimPrefix(strings.TrimSpace(m), groupRefPrefix)))
			} else {
				ms = append(ms, quote(m))
			}
		}
		parts = append(parts, fmt.Sprintf("proxies: [%s]", strings.Join(ms, ", ")))
	}
	if g.URL != "" {
		parts = append(parts, fmt.Sprintf("url: %s", quote(g.URL)))
	}
	if g.Interval > 0 {
		parts = append(parts, fmt.Sprintf("interval: %d", g.Interval))
	}
	if g.Timeout > 0 {
		parts = append(parts, fmt.Sprintf("timeout: %d", g.Timeout))
	}
	if g.Tolerance > 0 {
		parts = append(parts, fmt.Sprintf("tolerance: %d", g.Tolerance))
	}
	if g.Lazy != nil {
		parts = append(parts, fmt.Sprintf("lazy: %t", *g.Lazy))
	}
	return "{ " + strings.Join(parts, ", ") + " }"
}

func flowNode(n Node) string {
	keys := make([]string, 0, len(n))
	for k := range n {
		keys = append(keys, k)
	}
	order := map[string]int{"name": 0, "type": 1, "server": 2, "port": 3}
	sort.Slice(keys, func(i, j int) bool {
		oi, iok := order[keys[i]]
		oj, jok := order[keys[j]]
		if iok && jok {
			return oi < oj
		}
		if iok != jok {
			return iok
		}
		return keys[i] < keys[j]
	})
	var parts []string
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s: %s", k, scalar(n[k])))
	}
	return "{ " + strings.Join(parts, ", ") + " }"
}

func scalar(v any) string {
	switch t := v.(type) {
	case string:
		return quote(t)
	case bool:
		return fmt.Sprintf("%t", t)
	case int:
		return fmt.Sprintf("%d", t)
	case int64:
		return fmt.Sprintf("%d", t)
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%v", t)
	case nil:
		return "null"
	case []any, map[string]any:
		b, err := yaml.Marshal(t)
		if err != nil {
			return quote(fmt.Sprint(t))
		}
		return strings.TrimSpace(strings.ReplaceAll(string(b), "\n", " "))
	default:
		return quote(fmt.Sprint(t))
	}
}

// yaml.v3 会把 emoji 写成 \U0001F4CA，写回文件后完全没法看，这里还原成原字符
var unicodeEscape = regexp.MustCompile(`\\U([0-9A-Fa-f]{8})|\\u([0-9A-Fa-f]{4})`)

func unescapeUnicode(s string) string {
	return unicodeEscape.ReplaceAllStringFunc(s, func(m string) string {
		v, err := strconv.ParseInt(m[2:], 16, 32)
		if err != nil {
			return m
		}
		return string(rune(v))
	})
}

func quote(s string) string {
	if s == "" {
		return `''`
	}
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}
