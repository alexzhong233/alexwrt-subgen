# subgen 服务（路由器/NAS 上跑，配合 Nikki 或任意 mihomo 客户端订阅）
# 构建：在仓库根目录  docker build -f packaging/docker/Dockerfile --build-arg BIN=dist/subgen-linux-arm64 -t alexwrt-subgen .
# 注意：二进制是交叉编译好的静态文件，FROM scratch 不需要拉任何基础镜像，构建不联网
ARG BIN=dist/subgen-linux-arm64
FROM scratch
WORKDIR /app
COPY ${BIN} /app/subgen
COPY packaging/docker/config.yaml /app/config.yaml
COPY base.yaml rules_inline.yaml rules_providers.yaml /app/
VOLUME ["/app/cache"]
EXPOSE 25500
ENTRYPOINT ["/app/subgen", "-c", "/app/config.yaml"]
