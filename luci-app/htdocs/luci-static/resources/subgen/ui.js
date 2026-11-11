'require view';
'require ui';
'require rpc';

/* =========================================================================
 * luci-app-subgen —— alexwrt-subgen 的可视化控制台
 * 左侧编辑：订阅 / 静态连接 / 规则 / 分级；右侧实时预览（防抖 700ms 干跑）
 * 数据全部走 subgen 服务的 HTTP 接口，本页不做任何本地写入
 * ========================================================================= */

/* LuCI 里 rpc 可用（走 rpcd → /etc/init.d/subgen）；独立模式（PC）走 /api/quit */
var SG_RPC = (typeof rpc !== 'undefined') ? {
	status: rpc.declare({ object: 'subgen', method: 'status' }),
	start: rpc.declare({ object: 'subgen', method: 'start' }),
	stop: rpc.declare({ object: 'subgen', method: 'stop' })
} : null;
var STANDALONE = (typeof SUBGEN_STANDALONE !== 'undefined') ? true : false;

var ST = { cfg: null, presets: [], backend: { running: null, config: '' }, tab: (function () { try { var q = new URLSearchParams(location.search).get('tab'); return ['subs','static','rules','groups'].indexOf(q) >= 0 ? q : 'subs'; } catch (e) { return 'subs'; } })(), timer: null, seq: 0, connOK: false, last: null, lastFull: false };

/* ---------- 基础工具（都写在最前面，避免 var 提升踩坑） ---------- */

function conn() {
	return {
		base: (localStorage.getItem('subgen_base') || ('http://' + location.hostname + ':25500')).replace(/\/+$/, ''),
		token: localStorage.getItem('subgen_token') || 'alexwrt'
	};
}

function apiURL(path) {
	var c = conn();
	return c.base + '/' + encodeURIComponent(c.token) + path;
}

function el(tag, attrs, kids) {
	var n = document.createElement(tag);
	attrs = attrs || {};
	Object.keys(attrs).forEach(function (k) {
		if (k === 'class') n.className = attrs[k];
		else if (k === 'text') n.textContent = attrs[k];
		else if (k === 'style') n.setAttribute('style', attrs[k]);
		else if (typeof attrs[k] === 'function') n.addEventListener(k, attrs[k]);
		else if (attrs[k] === true) n.setAttribute(k, '');
		else if (attrs[k] !== false && attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
	});
	(kids || []).forEach(function (c) {
		if (c === null || c === undefined) return;
		n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	});
	return n;
}

function btn(label, fn, cls) {
	return el('button', { class: 'btn cbi-button ' + (cls || ''), type: 'button', click: fn }, [label]);
}

function inp(value, onchange, attrs) {
	// 用 input 而不是 change：change 只在失焦时触发，粘完链接直接点保存
	// （或直接切标签页）就会丢掉最后输入的内容。schedulePreview 自带 700ms
	// 防抖，逐字触发也不会打服务端。
	var a = { class: 'cbi-input-text', value: value === null || value === undefined ? '' : value, input: function () { onchange(this.value); } };
	Object.keys(attrs || {}).forEach(function (k) { a[k] = attrs[k]; });
	return el('input', a);
}

function num(value, onchange, attrs) {
	return inp(value, function (v) { var n = parseInt(v, 10); onchange(isNaN(n) ? 0 : n); }, Object.assign({ type: 'number' }, attrs || {}));
}

function sel(value, options, onchange) {
	var s = el('select', { class: 'cbi-input-select', change: function () { onchange(this.value); } });
	options.forEach(function (o) {
		var opt = el('option', { value: o }, [o]);
		if (o === value) opt.selected = true;
		s.appendChild(opt);
	});
	return s;
}

function chk(checked, onchange, label) {
	var i = el('input', { type: 'checkbox', checked: !!checked, change: function () { onchange(this.checked); } });
	return el('label', { class: 'sg-chk' }, [i, label || '']);
}

function grid(cols, cls) {
	return el('div', { class: 'sg-grid ' + (cls || ''), style: 'grid-template-columns:' + cols });
}

function cell(text, cls) {
	return el('div', { class: cls || '', text: text === undefined || text === null ? '' : String(text) });
}

function headRow(labels, cols, cls) {
	var g = grid(cols, 'sg-head ' + (cls || ''));
	labels.forEach(function (l) { g.appendChild(el('div', { text: l })); });
	return g;
}

function status(text, kind) {
	var n = document.getElementById('sg-status');
	if (!n) return;
	n.textContent = text || '';
	n.className = 'sg-status ' + (kind || '');
}

/* ---------- HTTP ---------- */

function getConfig() {
	return fetch(apiURL('/api/config'), { cache: 'no-store' }).then(function (r) {
		if (!r.ok) throw new Error('HTTP ' + r.status);
		return r.json();
	});
}

function getPresets() {
	return fetch(apiURL('/api/presets'), { cache: 'no-store' }).then(function (r) { return r.json(); });
}

function saveConfig(cfg) {
	return fetch(apiURL('/api/config'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(cfg)
	}).then(function (r) {
		return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
	});
}

function renderDraft(cfg, full) {
	return fetch(apiURL('/api/render' + (full ? '?full=1' : '')), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(cfg)
	}).then(function (r) { return r.json(); });
}

/* ---------- 实时预览 ---------- */

function schedulePreview() {
	if (ST.timer) clearTimeout(ST.timer);
	status('正在渲染…', 'busy');
	ST.timer = setTimeout(function () { doPreview(false); }, 700);
}

function doPreview(full) {
	var my = ++ST.seq;
	status('渲染中…', 'busy');
	renderDraft(ST.cfg, full).then(function (d) {
		if (my !== ST.seq) return;             // 有更新的请求了，丢弃旧结果
		paintPreview(d, full);
		status(d.ok ? '预览已更新（未保存）' : '渲染失败', d.ok ? 'ok' : 'err');
	}).catch(function (e) {
		if (my !== ST.seq) return;
		paintPreview({ ok: false, error: String(e) }, full);
		status('连不上服务：' + e, 'err');
	});
}

function paintPreview(d, full) {
	ST.last = d;
	ST.lastFull = !!full;
	var box = document.getElementById('sg-preview');
	if (!box) return;
	box.textContent = '';

	if (!d.ok) {
		box.appendChild(el('div', { class: 'sg-err', text: '渲染失败：' + (d.error || '未知错误') }));
		return;
	}

	var line = el('div', { class: 'sg-sum' }, [
		el('b', { text: d.nodes }), ' 个节点 · ',
		el('b', { text: d.groups.length }), ' 个组 · ',
		el('b', { text: d.rules }), ' 条规则 · ',
		el('b', { text: Math.round(d.size / 1024) }), ' KB'
	]);
	box.appendChild(line);

	/* 订阅状态 */
	if (d.subs && d.subs.length) {
		var sl = el('div', { class: 'sg-subs' });
		d.subs.forEach(function (s) {
			sl.appendChild(el('div', { class: 'sg-subitem ' + (s.error ? 'bad' : 'good') },
				[s.name + '：' + (s.error ? '拉取失败（' + s.error + '）' : s.nodes + ' 个节点')]));
		});
		box.appendChild(sl);
	}

	/* 组表：CSS Grid，不用 table（第三方主题会对 table 加 !important 规则） */
	box.appendChild(headRow(['组名', '类型', '成员', '前几个'], '1.3fr .7fr .4fr 2fr'));
	d.groups.forEach(function (g) {
		var r = grid('1.3fr .7fr .4fr 2fr', 'sg-row');
		r.appendChild(cell(g.name));
		r.appendChild(cell(g.type));
		r.appendChild(cell(g.count));
		r.appendChild(cell((g.first || []).join(' · '), 'dim'));
		box.appendChild(r);
	});

	/* YAML 片段 */
	box.appendChild(el('div', { class: 'sg-yaml-title' }, ['生成结果（前 1200 字符）']));
	box.appendChild(el('pre', { class: 'sg-pre', text: d.head || '' }));
	if (!full) {
		box.appendChild(btn('看完整 YAML', function () { doPreview(true); }, 'cbi-button-action'));
	} else if (d.yaml) {
		box.appendChild(el('div', { class: 'sg-yaml-title' }, ['完整 YAML']));
		box.appendChild(el('pre', { class: 'sg-pre tall', text: d.yaml }));
	}

	box.appendChild(el('div', { class: 'sg-url' }, ['Nikki 订阅地址：', el('code', { text: d.sub_url.replace('0.0.0.0', location.hostname) })]));
}

/* ---------- 各区块 ---------- */

function secSubs() {
	var box = el('div', { class: 'sg-card' });
	box.appendChild(el('div', { class: 'sg-card-h', text: '订阅（可加多个，任何一个拉挂都会自动跳过）' }));

	var cols = '1fr 2.4fr .8fr .5fr .5fr .4fr';
	var list = el('div', { class: 'sg-list' });
	list.appendChild(headRow(['名字', '订阅链接', 'UA', '主打', '启用', ''], cols));

	ST.cfg.subscriptions.forEach(function (s, i) {
		var row = grid(cols, 'sg-row');
		row.appendChild(inp(s.name, function (v) { s.name = v; schedulePreview(); }));
		row.appendChild(inp(s.url, function (v) { s.url = v; schedulePreview(); }));
		row.appendChild(inp(s.ua, function (v) { s.ua = v; schedulePreview(); }));
		row.appendChild(chk(s.primary, function (v) {
			ST.cfg.subscriptions.forEach(function (x) { x.primary = false; });
			s.primary = v;
			paint();
			schedulePreview();
		}));
		row.appendChild(chk(s.enabled !== false, function (v) { s.enabled = v; schedulePreview(); }));
		row.appendChild(btn('删', function () { ST.cfg.subscriptions.splice(i, 1); paint(); schedulePreview(); }, 'cbi-button-remove'));
		list.appendChild(row);
	});
	box.appendChild(list);

	/* 手动添加：以前只有「+ 添加订阅」，点了先插入一行空表再逐格填，还不
	 * 会校验；粘一条链接进去忘了点保存就等于没加。改成和「静态连接」一样
	 * 的表单，填完点按钮一次性入库。 */
	var f = { name: '', url: '', ua: 'clash.meta' };
	var addRow = el('div', { class: 'sg-addrow' });
	addRow.appendChild(inp('', function (v) { f.name = v; }, { placeholder: '名字（备注，可空）' }));
	addRow.appendChild(inp('', function (v) { f.url = v; }, { placeholder: '订阅链接 http(s)://…' }));
	addRow.appendChild(inp('', function (v) { f.ua = v; }, { placeholder: 'UA（默认 clash.meta）' }));
	addRow.appendChild(btn('+ 手动订阅', function () {
		var url = (f.url || '').trim();
		if (!url) { status('订阅链接不能为空', 'err'); return; }
		if (!/^(https?|file):\/\//i.test(url)) { status('订阅链接要以 http:// 或 https:// 开头', 'err'); return; }
		if (ST.cfg.subscriptions.some(function (x) { return (x.url || '').trim() === url; })) {
			status('这条订阅已经在列表里了', 'err'); return;
		}
		ST.cfg.subscriptions.push({
			name: (f.name || '').trim() || ('订阅' + (ST.cfg.subscriptions.length + 1)),
			url: url,
			ua: (f.ua || '').trim() || 'clash.meta',
			primary: ST.cfg.subscriptions.length === 0
		});
		f.name = ''; f.url = ''; f.ua = 'clash.meta';
		paint(); schedulePreview();
		status('已加入订阅列表（还没保存，别忘了点保存）', 'ok');
	}, 'cbi-button-add'));
	box.appendChild(addRow);

	return box;
}

function nodeFieldSet(type) {
	if (type === 'socks5' || type === 'http') return ['username', 'password'];
	if (type === 'ss') return ['cipher', 'password'];
	if (type === 'trojan') return ['password', 'sni'];
	if (type === 'vmess' || type === 'vless') return ['uuid', 'sni', 'network'];
	return ['username', 'password'];
}

function secStatic() {
	var box = el('div', { class: 'sg-card' });
	box.appendChild(el('div', { class: 'sg-card-h', text: '静态连接（订阅里没有的单独节点，比如 zanz / mac-netbird / 公司 socks）' }));

	var cols = '1fr .7fr 1.4fr .5fr 1fr .4fr';
	var list = el('div', { class: 'sg-list' });
	list.appendChild(headRow(['名字', '类型', '服务器', '端口', '账号/密码等', ''], cols));

	ST.cfg.static_proxies.forEach(function (n, i) {
		var row = grid(cols, 'sg-row');
		row.appendChild(inp(n.name, function (v) { n.name = v; schedulePreview(); }));
		row.appendChild(sel(n.type || 'socks5', ['socks5', 'http', 'ss', 'trojan', 'vmess', 'vless', 'hysteria2'], function (v) {
			n.type = v; paint(); schedulePreview();
		}));
		row.appendChild(inp(n.server, function (v) { n.server = v; schedulePreview(); }));
		row.appendChild(num(n.port, function (v) { n.port = v; schedulePreview(); }));
		var extra = [];
		nodeFieldSet(n.type).forEach(function (k) {
			if (k === 'sni' || k === 'network') return;
			extra.push(inp(n[k], function (v) { n[k] = v; schedulePreview(); }, { placeholder: k }));
		});
		row.appendChild(el('div', { class: 'sg-inline' }, extra));
		row.appendChild(btn('删', function () { ST.cfg.static_proxies.splice(i, 1); paint(); schedulePreview(); }, 'cbi-button-remove'));
		list.appendChild(row);
	});
	box.appendChild(list);

	/* 添加表单 */
	var f = { name: '', type: 'socks5', server: '', port: 1080, username: '', password: '' };
	var addRow = el('div', { class: 'sg-addrow' });
	addRow.appendChild(inp('', function (v) { f.name = v; }, { placeholder: '名字（规则里要引用它）' }));
	addRow.appendChild(sel('socks5', ['socks5', 'http', 'ss', 'trojan', 'vmess', 'vless', 'hysteria2'], function (v) {
		f.type = v;                       /* 只记类型，不重绘，避免输入框被重建丢焦点 */
	}));
	addRow.appendChild(inp('', function (v) { f.server = v; }, { placeholder: '服务器' }));
	addRow.appendChild(num(1080, function (v) { f.port = v; }, { placeholder: '端口' }));
	addRow.appendChild(inp('', function (v) { f.username = v; }, { placeholder: '用户名/密码' }));

	var addBtn = btn('+ 添加节点', function () {
		if (!f.name || !f.server) { status('名字和服务器必须填', 'err'); return; }
		var node = { name: f.name, type: f.type, server: f.server, port: f.port };
		if (f.type === 'socks5' || f.type === 'http') {
			if (f.username) node.username = f.username;
			if (f.password) node.password = f.password;
		} else if (f.type === 'ss') {
			node.cipher = f.password || 'aes-128-gcm';
			node.password = f.password || '';
		} else {
			node.password = f.password || '';
		}
		node.udp = true;
		if (f.type === 'socks5' || f.type === 'trojan') node['skip-cert-verify'] = true;
		ST.cfg.static_proxies.push(node);
		paint();
		schedulePreview();
	}, 'cbi-button-add');
	box.appendChild(el('div', { class: 'sg-addbox' }, [el('div', { class: 'dim', text: '添加一个' }), addRow, addBtn]));
	return box;
}

function secRules() {
	var box = el('div', { class: 'sg-card' });
	box.appendChild(el('div', { class: 'sg-card-h', text: '转换规则' }));

	/* 模式 */
	var modeRow = el('div', { class: 'sg-inline' }, [el('span', { class: 'dim', text: '模式：' })]);
	[['inline', '内联文件（本地 9k 条，最稳）'], ['providers', '远程规则集 rule-providers（配置小、能自动更）']].forEach(function (m) {
		var r = el('label', { class: 'sg-chk' }, [
			el('input', {
				type: 'radio', name: 'sg-mode', checked: ST.cfg.rules_mode === m[0],
				change: function () { ST.cfg.rules_mode = m[0]; paint(); schedulePreview(); }
			}), m[1]
		]);
		modeRow.appendChild(r);
	});
	box.appendChild(modeRow);

	if (ST.cfg.rules_mode === 'providers') {
		box.appendChild(el('div', { class: 'sg-tip', text: '勾选后会自动生成 rule-providers + RULE-SET 规则。注意 mihomo 拉 github 是直连的，国内不通时给 provider 加 proxy 或自建镜像（服务端 rules_providers.yaml 里有说明）。' }));
		box.appendChild(el('div', { class: 'dim', text: '“命中后走”里选不到想要的组？先去「分级」的“来自规则集”里补建目标组，再回来选。' }));
		var cols = '.5fr 1.4fr 2.2fr 1.1fr';
		var list = el('div', { class: 'sg-list' });
		list.appendChild(headRow(['', '规则集', '说明', '命中后走'], cols));
		var chosen = {};
		ST.cfg.rule_sets.forEach(function (r) { chosen[r.id] = r; });
		ST.presets.forEach(function (p) {
			var row = grid(cols, 'sg-row');
			var cur = chosen[p.id];
			row.appendChild(chk(!!cur, function (v) {
				if (v) ST.cfg.rule_sets.push({ id: p.id, target: p.default_target });
				else ST.cfg.rule_sets = ST.cfg.rule_sets.filter(function (x) { return x.id !== p.id; });
				paint(); schedulePreview();
			}));
			row.appendChild(cell(p.id));
			row.appendChild(cell(p.title, 'dim'));
			var targets = ['DIRECT', 'REJECT'].concat(ST.cfg.groups.map(function (g) { return g.name; }));
			row.appendChild(cur ? sel(cur.target, targets, function (v) { cur.target = v; schedulePreview(); }) : cell('—', 'dim'));
			list.appendChild(row);
		});
		box.appendChild(list);
	} else {
		box.appendChild(el('div', { class: 'sg-inline' }, [
			el('span', { class: 'dim', text: '规则文件：' }),
			inp(ST.cfg.rules, function (v) { ST.cfg.rules = v; schedulePreview(); }, { style: 'flex:0 0 260px' })
		]));
	}

	/* 自定义规则 */
	box.appendChild(el('div', { class: 'sg-sub-h', text: '自定义规则（永远排最前面，一行一条）' }));
	var ta = el('textarea', {
		class: 'cbi-input-textarea', rows: 6, style: 'width:100%;font-family:monospace',
		change: function () {
			ST.cfg.custom_rules = this.value.split('\n').map(function (s) { return s.trim(); }).filter(function (s) { return s && s[0] !== '#'; });
			schedulePreview();
		}
	});
	ta.value = (ST.cfg.custom_rules || []).join('\n');
	box.appendChild(ta);
	box.appendChild(el('div', { class: 'dim', text: '例：DOMAIN,aiii.doyo.icu,mac-netbird ／ IP-CIDR,10.0.0.0/8,DIRECT,no-resolve ／ RULE-SET,名字,组名' }));
	return box;
}

function groupKind(g) {
	return g.kind || (g.source ? 'sub' : 'custom');
}

/* 一张组卡片：按来源类型只显示该关心的字段 */
function groupCard(g) {
	var card = el('div', { class: 'sg-gcard' });
	var top = el('div', { class: 'sg-gtop' });
	top.appendChild(inp(g.name, function (v) { g.name = v; schedulePreview(); }, { style: 'flex:1 1 180px' }));
	top.appendChild(sel(g.type || 'select', ['select', 'url-test', 'fallback', 'load-balance'], function (v) { g.type = v; schedulePreview(); }));
	top.appendChild(btn('删', function () {
		var i = ST.cfg.groups.indexOf(g);
		if (i >= 0) ST.cfg.groups.splice(i, 1);
		paint(); schedulePreview();
	}, 'cbi-button-remove'));
	card.appendChild(top);

	var body = el('div', { class: 'sg-gbody' });

	if (groupKind(g) === 'sub') {
		body.appendChild(el('label', { class: 'sg-lbl' }, [
			el('span', { text: '用哪条订阅' }),
			inp(g.source || '', function (v) { g.source = v; schedulePreview(); }, { placeholder: '按量 或 按量,时间' })
		]));
		var l = el('div', { class: 'sg-inline' });
		l.appendChild(el('label', { class: 'sg-lbl small' }, [el('span', { text: '只留' }), inp(g.filter || '', function (v) { g.filter = v; schedulePreview(); }, { placeholder: '(日本|东京)' })]));
		l.appendChild(el('label', { class: 'sg-lbl small' }, [el('span', { text: '排除' }), inp(g.exclude_filter || '', function (v) { g.exclude_filter = v; schedulePreview(); }, { placeholder: '剩余流量' })]));
		body.appendChild(l);
	}
	else {
		body.appendChild(el('label', { class: 'sg-lbl' }, [
			el('span', { text: '成员' }),
			inp((g.members || []).join(', '), function (v) {
				g.members = v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
				schedulePreview();
			}, { placeholder: '@🚀主出口, DIRECT ／ zanz, DIRECT' })
		]));
		if (groupKind(g) === 'ruleset') {
			var users = (ST.cfg.rule_sets || []).filter(function (r) { return r.target === g.name; }).map(function (r) { return r.id; });
			body.appendChild(el('div', { class: 'dim', text: users.length ? ('被这些规则集命中：' + users.join('、')) : '暂时没有规则集指向它——去「规则」标签里把某个规则集的目标选成它' }));
		}
		body.appendChild(chk(!!g.include_all, function (v) { g.include_all = v; schedulePreview(); }, 'include-all（下拉里列出全部节点，方便手动切）'));
	}

	var p = el('div', { class: 'sg-inline' });
	p.appendChild(el('label', { class: 'sg-lbl small' }, [el('span', { text: '测试地址' }), inp(g.url || '', function (v) { g.url = v; schedulePreview(); }, { placeholder: 'http://cp.cloudflare.com/generate_204' })]));
	p.appendChild(el('label', { class: 'sg-lbl tiny' }, [el('span', { text: 'interval' }), num(g.interval || 0, function (v) { g.interval = v || 0; schedulePreview(); })]));
	p.appendChild(el('label', { class: 'sg-lbl tiny' }, [el('span', { text: 'tolerance' }), num(g.tolerance || 0, function (v) { g.tolerance = v || 0; schedulePreview(); })]));
	body.appendChild(p);
	card.appendChild(body);
	return card;
}

/* 一个来源分区 */
function secKind(kind, title, hint) {
	var wrap = el('div', { class: 'sg-kind' });
	wrap.appendChild(el('div', { class: 'sg-kind-h', text: title }));
	wrap.appendChild(el('div', { class: 'dim', text: hint }));

	var mine = ST.cfg.groups.filter(function (g) { return groupKind(g) === kind; });
	if (!mine.length) wrap.appendChild(el('div', { class: 'dim', text: '（还没有）' }));
	mine.forEach(function (g) { wrap.appendChild(groupCard(g)); });

	if (kind === 'sub') {
		wrap.appendChild(btn('+ 按订阅一键建池', function () {
			(ST.cfg.subscriptions || []).forEach(function (s) {
				var name = s.name + '池';
				if (ST.cfg.groups.some(function (g) { return g.name === name; })) return;
				ST.cfg.groups.push({
					name: name, kind: 'sub', type: 'url-test', source: s.name,
					url: 'http://cp.cloudflare.com/generate_204', interval: 3600, lazy: true, tolerance: 100
				});
			});
			paint(); schedulePreview();
		}, 'cbi-button-add'));
	}
	else if (kind === 'ruleset') {
		wrap.appendChild(btn('+ 按规则集补建目标组', function () {
			var main = (ST.cfg.groups.filter(function (g) { return g.name.indexOf('主出口') >= 0; })[0] || {}).name;
			var base = main ? ['@' + main] : ['DIRECT'];
			(ST.cfg.rule_sets || []).forEach(function (r) {
				if (!r.target || r.target === 'DIRECT' || r.target === 'REJECT') return;
				if (ST.cfg.groups.some(function (g) { return g.name === r.target; })) return;
				ST.cfg.groups.push({
					name: r.target, kind: 'ruleset', type: 'select',
					members: base.concat(['DIRECT']), include_all: true,
					url: 'http://cp.cloudflare.com/generate_204', interval: 300
				});
			});
			paint(); schedulePreview();
		}, 'cbi-button-add'));
	}
	else {
		wrap.appendChild(btn('+ 新建手写组', function () {
			ST.cfg.groups.push({
				name: '新组', kind: 'custom', type: 'fallback', members: ['DIRECT'],
				url: 'http://cp.cloudflare.com/generate_204', interval: 180
			});
			paint(); schedulePreview();
		}, 'cbi-button-add'));
	}
	return wrap;
}

function secGroups() {
	var box = el('div', { class: 'sg-card' });
	box.appendChild(el('div', { class: 'sg-card-h', text: '分级' }));
	box.appendChild(el('div', { class: 'sg-tip', text: '这里只决定“有哪些组、每个组里放什么”。真正的优先顺序由「🚀主出口」那个 fallback 的成员顺序决定，不是这里的上下位置。' }));

	box.appendChild(secKind('sub', '📥 来自订阅', '机场订阅里的节点，一条订阅一个池。zanz / mac-netbird 这种单独节点不算订阅，别放这里。'));
	box.appendChild(secKind('ruleset', '🎯 来自规则集', '这些组是给规则集当落脚点的。规则那边选好目标后，这里点一下补建就行。'));
	box.appendChild(secKind('custom', '✏️ 自己写的', '手写成员：fallback 降级链、select 手动选择都在这里。@组名 表示引用另一个组。'));
	return box;
}

function secConn() {
	var c = conn();
	var box = el('div', { class: 'sg-card' });
	box.appendChild(el('div', { class: 'sg-card-h', text: '服务连接' }));
	var row = el('div', { class: 'sg-inline' });
	row.appendChild(el('span', { class: 'dim', text: '地址' }));
	row.appendChild(inp(c.base, function (v) { localStorage.setItem('subgen_base', v.trim()); reconnect(); }, { style: 'flex:1 1 240px' }));
	row.appendChild(el('span', { class: 'dim', text: 'token' }));
	row.appendChild(inp(c.token, function (v) { localStorage.setItem('subgen_token', v.trim()); reconnect(); }, { style: 'flex:0 0 120px' }));
	row.appendChild(btn('重新连接', reconnect, 'cbi-button-action'));
	box.appendChild(row);
	box.appendChild(el('div', { class: 'dim', text: '这个地址是路由器上 subgen 服务的监听地址，例：http://192.168.88.1:25500' }));
	return box;
}

/* ---------- 主框架 ---------- */

function paint() {
	var root = document.getElementById('sg-root');
	if (!root) return;
	root.textContent = '';

	root.appendChild(el('div', { class: 'sg-title' }, [
		el('div', {}, [el('b', { text: 'subgen 订阅转换' }),
			el('span', { class: 'dim', text: '　改完点保存，客户端/路由那边点“更新订阅”就生效' })]),
		el('div', { class: 'sg-actions' }, [
			el('span', { class: 'sg-badge', id: 'sg-badge', text: '后端：…' }),
			(STANDALONE ? null : btn('启动后端', startBackend)),
			btn(STANDALONE ? '关闭后端' : '停止后端', stopBackend, 'cbi-button-remove'),
			btn('重新载入', loadAll),
			btn('保存并生效', doSave, 'cbi-button-apply cbi-button-save')
		])
	]));
	root.appendChild(el('div', { class: 'sg-cfgpath', id: 'sg-cfgpath' }));

	root.appendChild(secConn());

	var tabs = [
		['subs', '订阅'], ['static', '静态连接'], ['rules', '规则'], ['groups', '分级']
	];
	var tabBar = el('div', { class: 'sg-tabs' });
	tabs.forEach(function (t) {
		tabBar.appendChild(el('button', {
			class: 'sg-tab' + (ST.tab === t[0] ? ' on' : ''), type: 'button',
			click: function () { ST.tab = t[0]; paint(); if (ST.cfg) schedulePreview(); }
		}, [t[1]]));
	});
	root.appendChild(tabBar);

	var main = el('div', { class: 'sg-main' });
	var left = el('div', { class: 'sg-left' });
	if (ST.tab === 'subs') left.appendChild(secSubs());
	else if (ST.tab === 'static') left.appendChild(secStatic());
	else if (ST.tab === 'rules') left.appendChild(secRules());
	else left.appendChild(secGroups());

	var right = el('div', { class: 'sg-right' });
	right.appendChild(el('div', { class: 'sg-card-h', text: '实时预览' }));
	right.appendChild(el('div', { class: 'sg-status', id: 'sg-status' }));
	right.appendChild(el('div', { id: 'sg-preview' }));
	var keepPreview = ST.last;

	main.appendChild(left);
	main.appendChild(right);
	root.appendChild(main);

	/* paint() 会把右栏清掉，这里把上一次的预览结果补回去，避免切 tab 后预览消失 */
	if (keepPreview) paintPreview(keepPreview, ST.lastFull);
}

function refreshBackend() {
	var done = function (st) {
		ST.backend = st || { running: null, config: '' };
		paintBadge();
	};
	if (SG_RPC) {
		SG_RPC.status().then(function (r) { done(r); }).catch(function () { done({ running: false }); });
	}
	else if (STANDALONE) {
		fetch(apiURL('/api/status'), { cache: 'no-store' }).then(function (r) { return r.json(); })
			.then(done).catch(function () { done({ running: false }); });
	}
}

function paintBadge() {
	var n = document.getElementById('sg-badge');
	if (!n) return;
	var run = ST.backend.running;
	n.textContent = run === null ? '后端：未知' : (run ? '后端：运行中' : '后端：已停止');
	n.className = 'sg-badge ' + (run === null ? '' : (run ? 'on' : 'off'));
	var pathEl = document.getElementById('sg-cfgpath');
	if (pathEl) pathEl.textContent = ST.backend.config ? ('配置文件：' + ST.backend.config) : '';
}

function startBackend() {
	status('正在启动后端…', 'busy');
	if (SG_RPC) {
		SG_RPC.start().then(function () {
			setTimeout(function () { refreshBackend(); loadAll(); }, 1200);
		}).catch(function (e) { status('启动失败：' + e, 'err'); });
	} else {
		status('独立模式下请重新双击 start.bat / start.command 启动', 'err');
	}
}

function stopBackend() {
	if (!window.confirm('停掉后端后这个页面就不能预览和保存了，确定？')) return;
	status('正在停止后端…', 'busy');
	if (SG_RPC) {
		SG_RPC.stop().then(function () {
			setTimeout(function () { refreshBackend(); status('后端已停止，要用时点“启动后端”', 'ok'); }, 800);
		}).catch(function (e) { status('停止失败：' + e, 'err'); });
	} else {
		fetch(apiURL('/api/quit'), { method: 'POST' }).then(function () {
			status('后端已退出，可以关掉这个页面了。下次用的时候再双击 start.bat / start.command', 'ok');
			ST.backend = { running: false };
			document.getElementById('sg-root').textContent = '';
			document.getElementById('sg-root').appendChild(el('div', { class: 'sg-card' }, [
				el('div', { class: 'sg-card-h', text: '后端已关闭' }),
				el('div', { class: 'dim', text: '这个服务不需要常驻：想做定时同步，就用“同步一次.bat / sync.command”配合计划任务。' })
			]));
		}).catch(function (e) { status('关闭失败：' + e, 'err'); });
	}
}

function loadAll() {
	status('连接服务…', 'busy');
	Promise.all([getConfig(), getPresets()]).then(function (res) {
		ST.cfg = res[0];
		ST.presets = res[1].presets || [];
		ST.connOK = true;
		paint();
		refreshBackend();
		doPreview(false);
	}).catch(function (e) {
		ST.connOK = false;
		paint();
		status('连不上 subgen 服务：' + e + '　—— 如果后端没启动，点右上角“启动后端”', 'err');
	});
}

function reconnect() { ST.cfg = null; loadAll(); }

function doSave() {
	status('保存中…', 'busy');
	saveConfig(ST.cfg).then(function (r) {
		if (r.ok) {
			status('已保存到服务端，Nikki 更新订阅即生效', 'ok');
			ui.addNotification(null, E('p', {}, ['配置已保存，去 Nikki 点一次“更新订阅”']), 'info');
			doPreview(false);
		} else {
			status('保存失败：' + (r.error || ''), 'err');
			ui.addNotification(null, E('p', {}, ['保存失败：' + (r.error || '')]), 'danger');
		}
	}).catch(function (e) { status('保存失败：' + e, 'err'); });
}

var CSS = [
	'.sg-title{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}',
	'.sg-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
	'.sg-badge{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid rgba(128,128,128,.35);color:#888}',
	'.sg-badge.on{color:#18a058;border-color:#18a05866;background:#18a05814}',
	'.sg-badge.off{color:#d03050;border-color:#d0305066;background:#d0305014}',
	'.sg-cfgpath{font-size:12px;color:#888;margin:-4px 0 8px;word-break:break-all}',
	'.sg-tabs{display:flex;gap:6px;margin:10px 0}',
	'.sg-tab{border:1px solid rgba(128,128,128,.35);background:transparent;padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;color:inherit}',
	'.sg-tab.on{background:#2b7de9;border-color:#2b7de9;color:#fff}',
	'.sg-main{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:14px;align-items:start;min-width:0}',
	'@media(max-width:1000px){.sg-main{grid-template-columns:minmax(0,1fr)}}',
	'.sg-left,.sg-right{min-width:0;overflow:hidden}',
	'.sg-grid>div{min-width:0;overflow-wrap:anywhere}',
	'.sg-card{border:1px solid rgba(128,128,128,.25);border-radius:10px;padding:12px;margin-bottom:12px}',
	'.sg-card-h{font-weight:600;margin-bottom:8px}',
	'.sg-sub-h{font-weight:600;margin:14px 0 6px}',
	'.sg-grid{display:grid;gap:6px 8px;align-items:center}',
	'.sg-head{font-size:12px;color:#888;padding-bottom:4px;border-bottom:1px solid rgba(128,128,128,.25)}',
	'.sg-row{padding:4px 0;border-bottom:1px solid rgba(128,128,128,.1);min-width:0}',
	'.sg-row>*{min-width:0!important}',
	'.sg-row .cbi-input-text,.sg-row .cbi-input-select{width:100%;box-sizing:border-box;min-width:0}',
	'.sg-grid{min-width:0;width:100%}',
	'.sg-list{overflow:hidden}',
	'.sg-head div{overflow:hidden;text-overflow:ellipsis}',
	'.sg-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
	'.sg-chk{display:inline-flex;align-items:center;gap:4px;font-size:13px;white-space:nowrap}',
	'.sg-status{font-size:12px;margin:4px 0 8px;min-height:16px}',
	'.sg-status.ok{color:#18a058}.sg-status.err{color:#d03050}.sg-status.busy{color:#c27c0e}',
	'.sg-sum{font-size:13px;margin-bottom:8px}',
	'.sg-subs{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;margin-bottom:8px}',
	'.sg-subitem.good{color:#18a058}.sg-subitem.bad{color:#d03050}',
	'.sg-pre{background:#0f1115;color:#d7dce3;padding:8px;border-radius:8px;max-height:220px;overflow:auto;font-size:11px;font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}',
	'.sg-pre.tall{max-height:420px}',
	'.sg-yaml-title{font-size:12px;color:#888;margin:10px 0 4px}',
	'.sg-url{font-size:12px;margin-top:8px;word-break:break-all}',
	'.sg-err{color:#d03050;font-size:13px}',
	'.sg-gcard{border:1px solid rgba(128,128,128,.2);border-radius:8px;padding:8px;margin-bottom:8px}',
	'.sg-kind{border:1px dashed rgba(128,128,128,.3);border-radius:10px;padding:10px;margin:10px 0}',
	'.sg-kind-h{font-weight:600;margin-bottom:2px}',
	'.sg-kind>.dim{margin-bottom:8px}',
	'.sg-gtop{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}',
	'.sg-gbody{display:flex;flex-direction:column;gap:6px}',
	'.sg-lbl{display:grid;grid-template-columns:132px minmax(0,1fr);gap:8px;align-items:center;font-size:12px;color:#888;min-width:0}',
	'.sg-lbl>span{line-height:1.3}',
	'.sg-lbl input{width:100%;box-sizing:border-box;min-width:0}',
	'.sg-lbl.small{grid-template-columns:62px minmax(0,1fr)}',
	'.sg-lbl.tiny{grid-template-columns:58px 92px}',
	'.sg-gbody .sg-inline{align-items:center}',
	'.sg-addrow{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}',
	'.sg-addrow .cbi-input-text{flex:1 1 130px}',
	'.sg-addbox{border-top:1px dashed rgba(128,128,128,.3);margin-top:10px;padding-top:8px}',
	'.sg-tip{font-size:12px;color:#c27c0e;margin:6px 0}',
	'.dim{color:#888;font-size:12px}'
].join('\n');

return view.extend({
	render: function () {
		var wrap = el('div', { class: 'cbi-map' });
		wrap.appendChild(el('style', {}, [CSS]));
		wrap.appendChild(el('div', { id: 'sg-root' }, [el('div', { class: 'sg-status busy', text: '加载中…' })]));
		/* loadAll 里会重建 #sg-root，所以放到下一帧 */
		setTimeout(loadAll, 0);
		return wrap;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
