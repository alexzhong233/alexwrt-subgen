#!/bin/sh
# subgen 卸载（在路由器上执行）
#   sh uninstall.sh            删程序、页面、启动项，保留 /etc/subgen（配置和规则）
#   PURGE=1 sh uninstall.sh    连 /etc/subgen 和 /etc/config/subgen 一起删

set -u
PURGE="${PURGE:-0}"

log()  { printf '==> %s\n' "$*"; }

[ "$(id -u)" = "0" ] || { echo "要用 root 跑" >&2; exit 1; }

log "停止并禁用服务"
[ -x /etc/init.d/subgen ] && {
	/etc/init.d/subgen stop >/dev/null 2>&1
	/etc/init.d/subgen disable >/dev/null 2>&1
}

log "删除程序与页面"
rm -f /usr/bin/subgen /usr/bin/subgen.old
rm -f /etc/init.d/subgen
rm -rf /www/luci-static/resources/view/subgen /www/luci-static/resources/subgen
rm -f /usr/share/luci/menu.d/luci-app-subgen.json
rm -f /usr/share/rpcd/acl.d/luci-app-subgen.json
rm -f /usr/libexec/rpcd/subgen
rm -f /etc/uci-defaults/90_subgen

rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* /tmp/luci-modulecache 2>/dev/null
/etc/init.d/rpcd restart >/dev/null 2>&1

if [ "$PURGE" = "1" ]; then
	log "删除配置与规则"
	rm -rf /etc/subgen
	rm -f /etc/config/subgen
else
	log "保留 /etc/subgen（想一起删就加 PURGE=1）"
fi

echo
echo "卸载完成，刷新浏览器（Ctrl+F5）"
