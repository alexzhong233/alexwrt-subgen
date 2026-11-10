#!/bin/sh
# subgen 在线一键安装（在路由器上跑，不需要先把文件拷过来）
#
#   wget -O - https://raw.githubusercontent.com/alexzhong233/alexwrt-subgen/main/scripts/remote-install.sh | sh
#
# 国内 raw 拉不动时换镜像：
#   wget -O - https://cdn.jsdelivr.net/gh/alexzhong233/alexwrt-subgen@main/scripts/remote-install.sh | sh
#
# 想指定别的镜像源（比如自己的 gh 加速）：
#   wget -O - .../remote-install.sh | SUBGEN_MIRROR=https://ghfast.top/https://raw.githubusercontent.com/alexzhong233/alexwrt-subgen/main sh

set -u

BASE="${SUBGEN_MIRROR:-https://raw.githubusercontent.com/alexzhong233/alexwrt-subgen/main}"
WORK=/tmp/subgen-remote

die() { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[36m==>\033[0m %s\n' "$*"; }

[ "$(id -u)" = "0" ] || die "要用 root 跑"

case "$(uname -m)" in
	aarch64|arm64) ARCH=arm64 ;;
	x86_64|amd64)  ARCH=amd64 ;;
	*) die "路由器是 $(uname -m)，现在只有 arm64 / amd64 的二进制" ;;
esac
log "架构 $(uname -m) → $ARCH"

command -v wget >/dev/null 2>&1 || command -v curl >/dev/null 2>&1 ||
	die "既没有 wget 也没有 curl，没法下载"

fetch() {
	# $1 = 仓库内路径，$2 = 落地路径
	mkdir -p "$(dirname "$2")"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --connect-timeout 12 -o "$2" "$BASE/$1" 2>/dev/null && return 0
		curl -fsSL --connect-timeout 30 -o "$2" "$BASE/$1" 2>/dev/null && return 0
	else
		wget -q -T 20 -O "$2" "$BASE/$1" 2>/dev/null && return 0
	fi
	die "下载失败：$1
    可能是网络到 GitHub 不通。换镜像重试：
    wget -O - https://cdn.jsdelivr.net/gh/alexzhong233/alexwrt-subgen@main/scripts/remote-install.sh | sh"
}

rm -rf "$WORK"
mkdir -p "$WORK"

log "下载文件"
while IFS='|' read -r dst src; do
	[ -n "$dst" ] || continue
	case "$src" in
		*@ARCH@*) src=$(echo "$src" | sed "s/@ARCH@/$ARCH/") ;;
	esac
	printf '    %s\n' "$dst"
	fetch "$src" "$WORK/$dst"
done <<-'EOF'
	install.sh|luci-app/install.sh
	uninstall.sh|luci-app/uninstall.sh
	usr/bin/subgen|dist/subgen-linux-@ARCH@
	etc/init.d/subgen|luci-app/files/subgen.init
	etc/subgen/config.yaml|config.example.yaml
	etc/subgen/base.yaml|base.yaml
	etc/subgen/rules_inline.yaml|rules_inline.yaml
	etc/subgen/rules_providers.yaml|rules_providers.yaml
	www/luci-static/resources/view/subgen/config.js|luci-app/htdocs/luci-static/resources/view/subgen/config.js
	www/luci-static/resources/subgen/ui.js|luci-app/htdocs/luci-static/resources/subgen/ui.js
	usr/share/luci/menu.d/luci-app-subgen.json|luci-app/root/usr/share/luci/menu.d/luci-app-subgen.json
	usr/share/rpcd/acl.d/luci-app-subgen.json|luci-app/root/usr/share/rpcd/acl.d/luci-app-subgen.json
	usr/libexec/rpcd/subgen|luci-app/root/usr/libexec/rpcd/subgen
	etc/uci-defaults/90_subgen|luci-app/root/etc/uci-defaults/90_subgen
EOF

chmod 0755 "$WORK/install.sh" "$WORK/uninstall.sh" "$WORK/usr/bin/subgen" \
	"$WORK/usr/libexec/rpcd/subgen" "$WORK/etc/uci-defaults/90_subgen" "$WORK/etc/init.d/subgen"

log "执行安装"
sh "$WORK/install.sh"
