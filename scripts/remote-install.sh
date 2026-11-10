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
#
# 下载策略：优先拿 dist/subgen-openwrt-<arch>.tar.gz 整包（约 3 MB，一次 HTTPS 请求），
# 里面已经是排好的目标路径树，解开直接跑 install.sh。整包拿不到才退回逐个文件，
# 每个文件重试 3 次 —— OpenWrt 的 uclient-fetch 连续打多个 HTTPS 请求时会偶发
# "SSL error: error:00000001:lib(0)::reason(1)"，同一个文件重试基本就过。
# 关掉整包：SUBGEN_NO_TARBALL=1；调重试：SUBGEN_RETRY=5

set -u

BASE="${SUBGEN_MIRROR:-https://raw.githubusercontent.com/alexzhong233/alexwrt-subgen/main}"
BASE="${BASE%/}"
WORK=/tmp/subgen-remote
TRIES="${SUBGEN_RETRY:-3}"

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

HAVE_CURL=0
command -v curl >/dev/null 2>&1 && HAVE_CURL=1

# 单次下载 + 重试。$1 = URL，$2 = 落地路径
fetch_one() {
	_url="$1"
	_out="$2"
	_try=1
	mkdir -p "$(dirname "$_out")"
	while :; do
		rm -f "$_out"
		if [ "$HAVE_CURL" = "1" ]; then
			curl -fsSL --connect-timeout 15 --max-time 600 -o "$_out" "$_url" 2>/dev/null
		else
			wget -q -T 60 -O "$_out" "$_url" 2>/dev/null
		fi
		if [ -s "$_out" ]; then
			return 0
		fi
		rm -f "$_out"
		if [ "$_try" -ge "$TRIES" ]; then
			return 1
		fi
		printf '    重试 %s/%s …\n' "$_try" "$TRIES"
		sleep "$_try"
		_try=$((_try + 1))
	done
}

rm -rf "$WORK"
mkdir -p "$WORK"

# ---------------------------------------------------------------- 整包优先
PKG_OK=0
if [ -z "${SUBGEN_NO_TARBALL:-}" ] && command -v tar >/dev/null 2>&1; then
	log "整包下载 dist/subgen-openwrt-$ARCH.tar.gz（约 3 MB）"
	if fetch_one "$BASE/dist/subgen-openwrt-$ARCH.tar.gz" "$WORK/pkg.tar.gz"; then
		if tar -xzf "$WORK/pkg.tar.gz" -C "$WORK" >/dev/null 2>&1 &&
			[ -s "$WORK/usr/bin/subgen" ] && [ -f "$WORK/install.sh" ]; then
			PKG_OK=1
			rm -f "$WORK/pkg.tar.gz"
			log "解包完成（$(ls -l "$WORK/usr/bin/subgen" | awk '{print $5}') 字节二进制）"
		fi
	fi
	if [ "$PKG_OK" = "0" ]; then
		rm -rf "$WORK"
		mkdir -p "$WORK"
		log "整包不可用，改为逐个文件下载（每个文件重试 $TRIES 次）"
	fi
fi

# ---------------------------------------------------------------- 逐文件回退
# 注意：这里必须是变量而不是 here-doc —— 脚本是通过 `wget | sh` 从 stdin 喂进来的，
# 万一某条分支跳过 here-doc 段，后面的 here-doc 正文会被 sh 当成命令执行。
FILES='install.sh|luci-app/install.sh
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
lib/upgrade/keep.d/luci-app-subgen|luci-app/root/lib/upgrade/keep.d/luci-app-subgen'

if [ "$PKG_OK" = "0" ]; then
	log "下载文件"
	echo "$FILES" | while IFS='|' read -r dst src; do
		[ -n "$dst" ] || continue
		case "$src" in
			*@ARCH@*) src=$(echo "$src" | sed "s/@ARCH@/$ARCH/") ;;
		esac
		printf '    %s\n' "$dst"
		if ! fetch_one "$BASE/$src" "$WORK/$dst"; then
			echo "$dst" >> "$WORK/.failed"
		fi
	done
	if [ -f "$WORK/.failed" ]; then
		die "这些文件没下下来：
$(sed 's/^/    /' "$WORK/.failed")

    再跑一次通常就过了。一直失败就换镜像：
    wget -O - https://cdn.jsdelivr.net/gh/alexzhong233/alexwrt-subgen@main/scripts/remote-install.sh | sh"
	fi
fi

chmod 0755 "$WORK/install.sh" "$WORK/uninstall.sh" "$WORK/usr/bin/subgen" \
	"$WORK/usr/libexec/rpcd/subgen" "$WORK/etc/uci-defaults/90_subgen" "$WORK/etc/init.d/subgen" 2>/dev/null

log "执行安装"
sh "$WORK/install.sh"
