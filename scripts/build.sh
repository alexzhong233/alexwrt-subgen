#!/bin/sh
# 一条命令出全部产物：OpenWrt 包里的二进制、Windows zip、macOS tar、Docker 用二进制
# 用法：sh scripts/build.sh    （在开发机上跑，需要 go）
set -e
cd "$(dirname "$0")/.."
mkdir -p dist

build() {
	echo "  -> $3"
	CGO_ENABLED=0 GOOS=$1 GOARCH=$2 GOFLAGS=-mod=mod \
		go build -trimpath -ldflags "-s -w" -o "$3" .
}

echo "== 编译 =="
build linux   arm64  dist/subgen-linux-arm64
build linux   amd64  dist/subgen-linux-amd64
build windows amd64  dist/subgen-windows-amd64.exe
build darwin  arm64  dist/subgen-darwin-arm64
build darwin  amd64  dist/subgen-darwin-amd64

echo "== 同步进 LuCI 包（预编译二进制 + 默认配置）=="
cp dist/subgen-linux-arm64 luci-app/files/subgen

# 配置源：本机有真实 config.yaml 就用它（自己刷固件时带订阅，省得再填一遍）；
# 没有就用公开模板。两个产物名都固定叫 config.yaml，Makefile / Dockerfile 里写死了。
CONF_SRC=config.yaml
[ -f "$CONF_SRC" ] || CONF_SRC=config.example.yaml
echo "  配置源：$CONF_SRC"
cp "$CONF_SRC" luci-app/files/config.yaml
cp base.yaml rules_inline.yaml rules_providers.yaml luci-app/files/
mkdir -p packaging/docker
sed 's|^cache_dir: .*|cache_dir: /app/cache       # 容器内路径，compose 里挂到 ./data|' "$CONF_SRC" \
	> packaging/docker/config.yaml

chmod 755 luci-app/files/subgen luci-app/files/subgen.init
chmod 644 luci-app/files/*.yaml
ls -l luci-app/files

echo "== 打包 Windows / macOS / OpenWrt 原生 =="
python scripts/pack.py

echo "== 完成 =="
ls -l dist
