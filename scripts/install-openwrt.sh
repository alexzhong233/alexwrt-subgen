#!/bin/sh
# 在电脑上（Windows Git Bash / macOS / Linux）一条命令装到路由器
#
#   sh scripts/install-openwrt.sh root@192.168.88.1
#   sh scripts/install-openwrt.sh root@192.168.88.1 -p 2222     指定 ssh 端口
#   sh scripts/install-openwrt.sh root@192.168.88.1 -f          覆盖路由器上的 config.yaml
#   sh scripts/install-openwrt.sh root@192.168.88.1 -n          装完不启动服务
#
# 它会：探测路由器架构 → 挑对应二进制 → 打包推上去 → 在路由器上跑 install.sh

set -u

HOST=""
PORT=22
FORCE=""
NOSTART=""
REMOTE_DIR=/tmp/subgen-install

usage() {
	sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
	exit 1
}

while [ $# -gt 0 ]; do
	case "$1" in
		-p) PORT="$2"; shift 2 ;;
		-f) FORCE=1; shift ;;
		-n) NOSTART=1; shift ;;
		-h|--help) usage ;;
		-*) echo "未知参数 $1" >&2; usage ;;
		*) HOST="$1"; shift ;;
	esac
done

[ -n "$HOST" ] || usage

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

die() { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[36m==>\033[0m %s\n' "$*"; }

command -v ssh >/dev/null 2>&1 || die "找不到 ssh，Windows 装 Git 时勾选 OpenSSH，或系统设置里开启"
command -v scp >/dev/null 2>&1 || die "找不到 scp"

# 先确认能连上，不然后面的报错很难读
log "连接 $HOST:$PORT"
MACH=$(ssh -p "$PORT" -o ConnectTimeout=10 "$HOST" 'uname -m' 2>/dev/null) ||
	die "连不上 $HOST（检查 IP、端口、密钥/密码；Windows 上用 Git Bash 跑，不要在 cmd 里跑）"

case "$MACH" in
	aarch64|arm64)  BIN=dist/subgen-linux-arm64; ARCH=aarch64 ;;
	x86_64|amd64)   BIN=dist/subgen-linux-amd64; ARCH=x86_64 ;;
	*) die "路由器是 $MACH，现在只有 arm64 / amd64 的二进制；用 luci-app 打进固件，或自己交叉编译" ;;
esac
log "路由器架构 $MACH → 用 $BIN"

[ -f "$BIN" ] || die "缺少 $BIN，先在本地跑 sh scripts/build.sh"

# ---------- 本地拼一个安装目录 ----------
STAGE=$(mktemp -d 2>/dev/null) || STAGE="./.stage.$$"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/usr/bin" "$STAGE/etc/init.d" "$STAGE/etc/subgen" \
	"$STAGE/www/luci-static/resources/view/subgen" "$STAGE/www/luci-static/resources/subgen" \
	"$STAGE/usr/share/luci/menu.d" "$STAGE/usr/share/rpcd/acl.d" "$STAGE/usr/libexec/rpcd" \
	"$STAGE/etc/uci-defaults"

cp -f "$BIN" "$STAGE/usr/bin/subgen"
cp -f luci-app/files/subgen.init "$STAGE/etc/init.d/subgen"
for f in config.yaml base.yaml rules_inline.yaml rules_providers.yaml; do
	cp -f "$f" "$STAGE/etc/subgen/$f"
done
cp -f luci-app/htdocs/luci-static/resources/view/subgen/config.js "$STAGE/www/luci-static/resources/view/subgen/config.js"
cp -f luci-app/htdocs/luci-static/resources/subgen/ui.js "$STAGE/www/luci-static/resources/subgen/ui.js"
cp -f luci-app/root/usr/share/luci/menu.d/luci-app-subgen.json "$STAGE/usr/share/luci/menu.d/"
cp -f luci-app/root/usr/share/rpcd/acl.d/luci-app-subgen.json "$STAGE/usr/share/rpcd/acl.d/"
cp -f luci-app/root/usr/libexec/rpcd/subgen "$STAGE/usr/libexec/rpcd/subgen"
cp -f luci-app/root/etc/uci-defaults/90_subgen "$STAGE/etc/uci-defaults/90_subgen"
cp -f luci-app/install.sh "$STAGE/install.sh"
cp -f luci-app/uninstall.sh "$STAGE/uninstall.sh"

SIZE=$(du -sk "$STAGE" 2>/dev/null | awk '{print $1}')
log "上传 $((SIZE / 1024 + 1)) MB 到 $HOST:$REMOTE_DIR"
ssh -p "$PORT" "$HOST" "rm -rf $REMOTE_DIR && mkdir -p $REMOTE_DIR" || die "无法在路由器上建 $REMOTE_DIR"

# 老版本 OpenSSH 需要 -O（走 scp 协议），新版本默认 SFTP；两种都试一遍
scp -O -q -P "$PORT" -r "$STAGE/." "$HOST:$REMOTE_DIR/" 2>/dev/null ||
	scp -q -P "$PORT" -r "$STAGE/." "$HOST:$REMOTE_DIR/" ||
	die "上传失败"

log "在路由器上执行安装"
ENVV=""
[ -n "$FORCE" ] && ENVV="FORCE_CONF=1 "
[ -n "$NOSTART" ] && ENVV="${ENVV}NO_START=1 "
ssh -p "$PORT" -t "$HOST" "${ENVV}sh $REMOTE_DIR/install.sh"
RC=$?

ssh -p "$PORT" "$HOST" "rm -rf $REMOTE_DIR" >/dev/null 2>&1
exit $RC
