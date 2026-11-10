#!/bin/sh
# subgen 一键安装 / 升级（在路由器上执行）
#
#   sh install.sh                 安装或升级，保留现有的 /etc/subgen/config.yaml
#   FORCE_CONF=1 sh install.sh    连 config.yaml 一起覆盖（想恢复出厂配置时用）
#   NO_START=1 sh install.sh      只铺文件，不启动服务
#
# 兼容 busybox ash（OpenWrt 默认 shell），不依赖 install 命令和 bash 语法。

set -u

SRC="$(cd "$(dirname "$0")" && pwd)"
FORCE_CONF="${FORCE_CONF:-0}"
NO_START="${NO_START:-0}"

C_B=$'\033[36m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_0=$'\033[0m'
log()  { printf '%s==>%s %s\n' "$C_B" "$C_0" "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_Y" "$C_0" "$*"; }
die()  { printf '%s[x]%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "要用 root 跑"
[ -x "$SRC/usr/bin/subgen" ] || die "在 $SRC 里找不到 usr/bin/subgen，请把整个解压目录拷到路由器再执行"

# ---------- 二进制能不能在本机跑 ----------
# 架构不对时 exec 返回 126/127，直接跑一次比 readelf 可靠
"$SRC/usr/bin/subgen" -h >/dev/null 2>&1
RC=$?
if [ "$RC" -ge 126 ]; then
	die "这个 subgen 跑不起来（本机架构 $(uname -m)，返回码 $RC）。多半是拿了别的架构的包，去下对应版本。"
fi

log "停止旧服务"
[ -x /etc/init.d/subgen ] && /etc/init.d/subgen stop >/dev/null 2>&1
sleep 1

# 旧二进制留着，万一新版跑不起来可以 mv 回去
if [ -f /usr/bin/subgen ] && [ ! -f /usr/bin/subgen.old ]; then
	cp -f /usr/bin/subgen /usr/bin/subgen.old
	log "旧二进制备份为 /usr/bin/subgen.old"
fi

# ---------- 服务本体 ----------
log "安装 /usr/bin/subgen"
mkdir -p /usr/bin /etc/init.d
cp -f "$SRC/usr/bin/subgen" /usr/bin/subgen
chmod 0755 /usr/bin/subgen
cp -f "$SRC/etc/init.d/subgen" /etc/init.d/subgen
chmod 0755 /etc/init.d/subgen

# ---------- 配置与规则 ----------
log "安装 /etc/subgen"
mkdir -p /etc/subgen
if [ -f /etc/subgen/config.yaml ] && [ "$FORCE_CONF" != "1" ]; then
	log "保留现有 config.yaml（要覆盖就加 FORCE_CONF=1）"
else
	[ -f /etc/subgen/config.yaml ] && cp -f /etc/subgen/config.yaml /etc/subgen/config.yaml.old
	cp -f "$SRC/etc/subgen/config.yaml" /etc/subgen/config.yaml
	chmod 0600 /etc/subgen/config.yaml
fi

# 规则文件跟着版本走，但留一份 .old 方便对比
for f in base.yaml rules_inline.yaml rules_providers.yaml; do
	[ -f "/etc/subgen/$f" ] && cp -f "/etc/subgen/$f" "/etc/subgen/$f.old"
	cp -f "$SRC/etc/subgen/$f" "/etc/subgen/$f"
	chmod 0644 "/etc/subgen/$f"
done

# ---------- 配置文件路径写进 sysupgrade 保留区 ----------
# /etc/config/ 整目录会被保留，所以升级固件后仍指向同一份配置
if [ ! -f /etc/config/subgen ]; then
	mkdir -p /etc/config
	cat > /etc/config/subgen <<-'EOF'
	config subgen 'cfg'
		option config '/etc/subgen/config.yaml'
	EOF
	log "写入 /etc/config/subgen（记录配置路径，升级保留）"
fi

# ---------- LuCI 页面 ----------
log "安装 LuCI 页面"
mkdir -p /www/luci-static/resources/view/subgen /www/luci-static/resources/subgen
cp -f "$SRC/www/luci-static/resources/view/subgen/config.js" /www/luci-static/resources/view/subgen/config.js
cp -f "$SRC/www/luci-static/resources/subgen/ui.js" /www/luci-static/resources/subgen/ui.js

mkdir -p /usr/share/luci/menu.d /usr/share/rpcd/acl.d /usr/libexec/rpcd
cp -f "$SRC/usr/share/luci/menu.d/luci-app-subgen.json" /usr/share/luci/menu.d/
cp -f "$SRC/usr/share/rpcd/acl.d/luci-app-subgen.json" /usr/share/rpcd/acl.d/
cp -f "$SRC/usr/libexec/rpcd/subgen" /usr/libexec/rpcd/subgen
chmod 0755 /usr/libexec/rpcd/subgen

# uci-defaults 留给以后 apk 包用；这里手动执行一次，装完立刻生效
if [ -f "$SRC/etc/uci-defaults/90_subgen" ]; then
	mkdir -p /etc/uci-defaults
	cp -f "$SRC/etc/uci-defaults/90_subgen" /etc/uci-defaults/90_subgen
	chmod 0755 /etc/uci-defaults/90_subgen
	/etc/uci-defaults/90_subgen >/dev/null 2>&1
fi

# ---------- keep.d：刷机时保留 /etc/subgen ----------
mkdir -p /lib/upgrade/keep.d
if [ -f "$SRC/lib/upgrade/keep.d/luci-app-subgen" ]; then
	cp -f "$SRC/lib/upgrade/keep.d/luci-app-subgen" /lib/upgrade/keep.d/luci-app-subgen
	chmod 0644 /lib/upgrade/keep.d/luci-app-subgen
else
	echo "/etc/subgen/" > /lib/upgrade/keep.d/luci-app-subgen
fi

# ---------- 清 LuCI 缓存并重启 rpcd（否则新菜单/ACL 不生效）----------
rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache 2>/dev/null
/etc/init.d/rpcd restart >/dev/null 2>&1

# ---------- 启动 ----------
/etc/init.d/subgen enable >/dev/null 2>&1
if [ "$NO_START" = "1" ]; then
	warn "按 NO_START=1 跳过启动；要用时 /etc/init.d/subgen start"
else
	log "启动服务"
	/etc/init.d/subgen start >/dev/null 2>&1
	sleep 2
	if /etc/init.d/subgen running >/dev/null 2>&1; then
		log "服务运行中"
	else
		warn "服务没起来，看日志：logread -e subgen"
	fi
fi

# ---------- 打印访问地址 ----------
CONF=/etc/subgen/config.yaml
LISTEN=$(sed -n 's/^listen:[[:space:]]*\([^#]*\).*/\1/p' "$CONF" | head -1 | tr -d ' ')
TOKEN=$(sed -n 's/^token:[[:space:]]*\([^#]*\).*/\1/p' "$CONF" | head -1 | tr -d ' ')
PORT="${LISTEN##*:}"
[ -n "$PORT" ] || PORT=25500

LANIP=$(uci -q get network.lan.ipaddr | cut -d/ -f1)
[ -n "$LANIP" ] || LANIP=$(ip -4 addr show br-lan 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | head -1)
[ -n "$LANIP" ] || LANIP=127.0.0.1

echo
log "装好了"
echo "    LuCI 页面    http://$LANIP/  →  服务 → 订阅转换"
echo "    内置控制台   http://$LANIP:$PORT/$TOKEN/admin"
echo "    订阅地址     http://$LANIP:$PORT/$TOKEN/sub   （填到 Nikki / Clash）"
echo "    配置文件     $CONF"
echo
echo "   改监听/令牌：vi $CONF 后 /etc/init.d/subgen restart"
echo "   卸载：sh $SRC/uninstall.sh"
