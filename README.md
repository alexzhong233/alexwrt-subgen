# subgen

把**机场订阅 + 规则 + 分级**合成一份 mihomo 配置，以标准订阅地址（或一个本地文件）交出去。
带控制台：LuCI 界面和独立网页是同一份代码，改完右侧实时预览，点保存才生效。

服务**不需要常驻**——用的时候打开，用完关掉；也可以只跑一次 `-gen` 生成文件，交给计划任务定时同步。

```
订阅 A ─┐
订阅 B ─┼─▶ subgen ──▶ mihomo 配置 ──▶ Nikki / mihomo / Clash
静态节点 ┘     ↑
             规则（内联 9k 条 / 远程 rule-providers / 自定义）
             分级（订阅池、规则集目标组、手写 fallback 链）
```

## 目录

```
main.go                                 服务本体（Go 单文件）
web/index.html                          独立模式的壳（补 view/ui/E 三个桩）
luci-app/                               OpenWrt 包：服务 + 界面一体
  htdocs/luci-static/resources/subgen/ui.js          ← 控制台 UI 唯一真源（Go 也 embed 它）
  htdocs/luci-static/resources/view/subgen/config.js ← 3 行包装，LuCI 从这进
  files/subgen                                       ← 预编译 arm64 二进制
  files/{config,base,rules_inline,rules_providers}.yaml、subgen.init
  root/usr/libexec/rpcd/subgen                       ← 给页面用的启停接口
  root/etc/uci-defaults/90_subgen                    ← 首次安装固定配置路径
packaging/{docker,windows,macos}/       各平台打包件
scripts/build.sh                        一条命令出全部产物
```

## 产物

```sh
sh scripts/build.sh
```

| 产物 | 怎么用 |
|---|---|
| `dist/subgen-windows-amd64.zip` | **Windows**：解压 → `start.bat`（起服务+开控制台）/ `sync-once.bat`（只生成一次）/ `schedule.bat`（装每天 04:30 的计划任务） |
| `dist/subgen-macos-arm64.tar.gz` | **macOS M 芯片**：解压 → `start.command` / `sync-once.command` / `schedule.command`（launchd） |
| `dist/subgen-macos-amd64.tar.gz` | macOS Intel |
| `luci-app/` | **OpenWrt 进固件**：丢进 `package/`，`CONFIG_PACKAGE_luci-app-subgen=y` |
| `dist/subgen-openwrt-{arm64,amd64}.tar.gz` | **OpenWrt 离线安装**：解开 → `sh install.sh`（见下） |
| `docker compose up -d --build` | 路由器 / NAS 上跑，Nikki 订它的 `/sub` |

> 仓库里只有 `dist/subgen-linux-{arm64,amd64}` 两个二进制（在线安装用）；zip / tar 包在本地 `build.sh` 生成，不入库。
> 真实订阅和节点密码只在你自己机器的 `config.yaml` 里（已 gitignore），仓库里放的是模板 `config.example.yaml`。

### Windows / macOS

解压即用，配置、缓存、生成结果都在同目录。默认监听 `127.0.0.1:25500`，只给本机浏览器。
控制台地址 `http://127.0.0.1:25500/alexwrt/admin`，订阅地址 `http://127.0.0.1:25500/alexwrt/sub`。

macOS 首次会被 Gatekeeper 拦（二进制没签名）：右键 → 打开，或
`xattr -d com.apple.quarantine ./subgen ./start.command`。

### OpenWrt

三种装法，任选一种。装完都是：菜单「服务 → 订阅转换」，或直接 `http://路由器IP:25500/<token>/admin`。

**① 路由器上一条命令（推荐，不用传文件）**

```sh
wget -O - https://raw.githubusercontent.com/alexzhong233/alexwrt-subgen/main/scripts/remote-install.sh | sh
```

raw 拉不动（国内常见）就换镜像：

```sh
wget -O - https://cdn.jsdelivr.net/gh/alexzhong233/alexwrt-subgen@main/scripts/remote-install.sh | sh
```

也可以自己给加速前缀：

```sh
wget -O - .../remote-install.sh | SUBGEN_MIRROR=https://ghfast.top/https://raw.githubusercontent.com/alexzhong233/alexwrt-subgen/main sh
```

**② 电脑上一条命令（走 ssh，不依赖 GitHub 连通性）**

```sh
sh scripts/install-openwrt.sh root@192.168.88.1
```

自动探测路由器架构（aarch64 / x86_64）挑二进制，打包推上去再装。加 `-f` 覆盖路由上已有的 `config.yaml`，`-n` 只装不启动。Windows 上用 Git Bash 跑。

**③ 进固件**

把 `luci-app/` 放进固件源码 `package/`，`.config` 里 `CONFIG_PACKAGE_luci-app-subgen=y`。
包内有 `/usr/bin/subgen`、`/etc/subgen/*.yaml`、`/etc/init.d/subgen`、rpcd 插件、LuCI 页面、uci-defaults。
`luci-app/Makefile` 里 `PKGARCH:=aarch64_cortex-a53`，二进制是 arm64 静态编译，换架构先跑 `build.sh` 再改这行。

**安装脚本做了什么**

`luci-app/install.sh`（三个入口跑的其实是同一个）：

1. 停止旧服务，把旧二进制备份成 `/usr/bin/subgen.old`
2. 铺二进制、init 脚本、规则文件；**`/etc/subgen/config.yaml` 已存在就保留**，不覆盖你的订阅
3. 首次写入 `/etc/config/subgen`（`option config '/etc/subgen/config.yaml'`）——`/etc/config` 会被 sysupgrade 保留，所以**升级固件后配置路径不丢**
4. 铺 LuCI 页面、rpcd 插件、uci-defaults，清 LuCI 缓存并重启 rpcd（否则新菜单不出现）
5. `enable` + `start`，最后打印控制台与订阅地址

卸载：

```sh
sh /tmp/subgen-remote/uninstall.sh          # 保留 /etc/subgen
PURGE=1 sh /tmp/subgen-remote/uninstall.sh  # 连配置一起删
```

## 后端启停（重点：不必常驻）

控制台顶栏有状态徽标和按钮：

- **OpenWrt（LuCI）**：`启动后端` / `停止后端` 走 rpcd 插件调 `/etc/init.d/subgen`，不需要浏览器有 shell 权限，也不用常驻。
- **Windows / macOS**：`关闭后端` 直接让进程退出；下次用的时候再双击 `start.bat` / `start.command`。

**记住配置路径**：OpenWrt 首次装好时 `uci-defaults` 会写 `/etc/config/subgen`：

```
config subgen 'cfg'
	option config '/etc/subgen/config.yaml'
```

`/etc/config/` 整个目录被 sysupgrade 保留，所以升级固件后服务仍然指向同一份配置；init 脚本也从这里读路径（改路径只改这一行）。

**定时/手动同步**（不常驻的正解）：

```sh
subgen -c config.yaml -gen out.yaml     # 生成一次，写文件，退出
subgen -c config.yaml -once > out.yaml  # 生成一次，打到 stdout
```

- Windows：`sync-once.bat` 生成 `mihomo-config.yaml`；`schedule.bat` 用 `schtasks` 装每天 04:30 的任务。
- macOS：`sync-once.command` / `schedule.command`（launchd，卸载见脚本输出）。
- OpenWrt：`/usr/bin/subgen -c /etc/subgen/config.yaml -gen /tmp/x.yaml` 挂 cron 即可；或者干脆让 Nikki 那边手动开一次后端、更新订阅、再停止。

## 控制台

顶部填服务地址 + token（默认 `alexwrt`），点「重新连接」。四个标签：

- **订阅**：几条都行。任一失败不影响整体（先用 `cache/` 上次成功的，没有就跳过这层）。「主打」那条负责把流量信息透传给客户端。
- **静态连接**：订阅里没有的单独节点（socks5 / http / ss / trojan / vmess / vless / hysteria2），填完在分级里按名字引用。
- **规则**：`内联文件`（默认 9k 条，不依赖外网）或 `远程规则集`（勾 geosite/geoip 预设 → 自动生成 rule-providers + RULE-SET，每个预设单独选命中目标）；`自定义规则` 永远排最前面。
- **分级**（按来源分三类，避免一锅乱炖）：

| 分区 | 是什么 | 怎么建 |
|---|---|---|
| 📥 来自订阅 | 一条订阅一个节点池（`url-test`，可按正则只留/排除） | 点「按订阅一键建池」 |
| 🎯 来自规则集 | 规则集命中后落脚的目标组 | 「规则」里选不到就先在这补建 |
| ✏️ 自己写的 | 手写成员：fallback 降级链、select 手动选择 | 点「新建手写组」 |

优先级只由「🚀主出口」这个 fallback 的成员顺序决定：
`members: [zanz, @⏱时间订阅池, @📊按量订阅池, DIRECT]` = zanz 优先 → 时间订阅 → 按量订阅 → 直连。分区上下位置不影响优先级。

**实时预览**：任何编辑 700ms 后把**未保存**的配置发到服务端干跑（`POST /api/render`，不落盘、不重启），显示节点数 / 组数 / 规则数 / 体积 / 每条订阅这一轮的拉取结果 / 每组前几个成员 / 生成的 YAML。
「保存并生效」才写回 `config.yaml`（旧文件存 `config.yaml.bak`；保存前先试生成，生成不出来拒绝保存）。

## ACL4SSR 规则集（对齐 subconverter / OpenClash 在线转换）

在线转换服务（`sub.xeton.dev`、`api.dler.io`）背后跑的是 subconverter + ACL4SSR 那套 `.ini`。
仓库里带了两个文件，把那套分组原样搬了过来，不用自己重写：

| 文件 | 内容 |
|---|---|
| `rules_acl4ssr.yaml` | 32 个 rule-providers + 34 条 RULE-SET，组名与 ACL4SSR 一致 |
| `config.acl4ssr.yaml` | 配套 29 个代理组，地区正则和成员顺序照抄 `ACL4SSR_Online_Full.ini` |

用法：

```sh
cp config.yaml config.yaml.bak        # 先备份
cp config.acl4ssr.yaml config.yaml    # 填上自己的订阅和静态节点
subgen -c config.yaml -gen out.yaml
```

生成配置的体积从 **500 KB 降到 45 KB** —— 规则内容不再内联，由 mihomo 按 `interval`
拉取并缓存在 `./ruleset/`。

几个坑：

- url 统一走 `ghfast.top` 加速前缀，直连 `raw.githubusercontent.com` 在国内拉不动。
  要换镜像改 `rules_acl4ssr.yaml` 里的前缀即可。
- 首次启动要联网拉 32 个文件，之后一天一次（`interval: 86400`）。开机时如果代理还没
  起来会拉不到，但有上次的本地缓存就不影响使用。
- **组名必须和 RULE-SET 的目标一字不差**。改了一个忘了另一个，mihomo 会直接拒绝启动。
  改完跑一次交叉校验：

```sh
python - <<'EOF'
import yaml
cfg=yaml.safe_load(open('config.acl4ssr.yaml')); rules=yaml.safe_load(open('rules_acl4ssr.yaml'))
groups={g['name'] for g in cfg['groups']}
bad=[r.split(',')[2] for r in rules['rules'] if r.startswith('RULE-SET,') and r.split(',')[2] not in groups]
print('缺组:', bad or '无')
EOF
```

- `rules_mode: providers` 现在会读规则文件里的 `rule-providers:` 段（`main.go` 的
  `buildRules`），所以自定义规则集不必再改 Go 源码。代码里的内置预设只是叠加层。

## HTTP 接口

| 路径 | 说明 |
|---|---|
| `GET /<token>/sub` | 订阅地址；`?refresh=1` 强制重拉机场 |
| `GET /<token>/admin` | 控制台 |
| `GET/POST /<token>/api/config` | 读 / 写配置 |
| `POST /<token>/api/render` | 干跑渲染，`?full=1` 返回完整 YAML |
| `GET /<token>/api/status` | 运行状态、pid、配置路径 |
| `POST /<token>/api/quit` | 让进程退出（PC 端「关闭后端」） |
| `GET /<token>/api/presets` | 内置规则集清单 |

CORS 已开（LuCI 页面与后端不同端口）。默认只校验路径里的 token。

## 已知限制

- 只吃 **clash 格式**订阅（完整 config 或纯 `proxies:` 列表）和 base64 节点列表；v2ray 分享链接要在机场后台切 clash。
- 输出全量内联（9k 条规则 + 60 多节点 ≈ 500 KB），客户端每次更新要重解析。
- 机场有频率限制（连续拉会 502），`cache_ttl` 别低于 600，被限时用 `cache/` 兜底。
- 远程 rule-providers 需要能访问 github raw，国内要给 provider 加 `proxy:` 或自建镜像。
- `config.yaml` 里有机场 token，别外传；`0.0.0.0` 监听请用防火墙限制在 LAN。
