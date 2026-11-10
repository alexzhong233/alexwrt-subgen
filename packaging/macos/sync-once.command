#!/bin/sh
# 只生成一次配置，不常驻
cd "$(dirname "$0")" || exit 1
./subgen -c config.yaml -gen mihomo-config.yaml || { echo "生成失败"; read -r _; exit 1; }
echo "已生成：$(pwd)/mihomo-config.yaml"
