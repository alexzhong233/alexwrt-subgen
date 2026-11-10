# luci-app-subgen —— subgen 订阅转换服务 + LuCI 控制台，一体包
#
# 二进制是预编译好的（Go 静态编译，openwrt 构建机上不需要 Go 工具链）。
# 换架构或升级版本：在开发机跑 scripts/build.sh，它会自动刷新 luci-app/files/subgen。
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-subgen
PKG_VERSION:=0.2.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=alex

# 里面是 aarch64 的二进制，不能标 all；你的目标不是 aarch64_cortex-a53 就改这里
PKGARCH:=aarch64_cortex-a53

include $(INCLUDE_DIR)/package.mk

define Package/luci-app-subgen
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=订阅转换 + 分级生成（subgen 服务 + 控制台）
  DEPENDS:=
endef

define Package/luci-app-subgen/description
 把机场订阅转换成完整 mihomo 配置，并可按 fallback 分级（zanz → 时间订阅 → 按量订阅 → DIRECT）。
 自带 LuCI 控制台：订阅 / 静态连接 / 规则集 / 分级，右侧实时预览。
endef

define Build/Compile
endef

define Package/luci-app-subgen/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/subgen $(1)/usr/bin/subgen
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/subgen.init $(1)/etc/init.d/subgen
	$(INSTALL_DIR) $(1)/etc/subgen
	$(INSTALL_CONF) ./files/config.yaml $(1)/etc/subgen/config.yaml
	$(INSTALL_DATA) ./files/base.yaml $(1)/etc/subgen/base.yaml
	$(INSTALL_DATA) ./files/rules_inline.yaml $(1)/etc/subgen/rules_inline.yaml
	$(INSTALL_DATA) ./files/rules_providers.yaml $(1)/etc/subgen/rules_providers.yaml
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view/subgen
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/subgen/config.js $(1)/www/luci-static/resources/view/subgen/config.js
	$(INSTALL_DIR) $(1)/www/luci-static/resources/subgen
	$(INSTALL_DATA) ./htdocs/luci-static/resources/subgen/ui.js $(1)/www/luci-static/resources/subgen/ui.js
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-subgen.json $(1)/usr/share/luci/menu.d/
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-subgen.json $(1)/usr/share/rpcd/acl.d/
	$(INSTALL_DIR) $(1)/usr/libexec/rpcd
	$(INSTALL_BIN) ./root/usr/libexec/rpcd/subgen $(1)/usr/libexec/rpcd/subgen
	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./root/etc/uci-defaults/90_subgen $(1)/etc/uci-defaults/90_subgen
	# sysupgrade 时保留 /etc/subgen（订阅/规则/缓存），否则刷机后配置路径还在、文件没了
	$(INSTALL_DIR) $(1)/lib/upgrade/keep.d
	$(INSTALL_DATA) ./root/lib/upgrade/keep.d/luci-app-subgen $(1)/lib/upgrade/keep.d/luci-app-subgen
endef

define Package/luci-app-subgen/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/subgen enable >/dev/null 2>&1
	/etc/init.d/subgen restart >/dev/null 2>&1
	rm -rf /tmp/luci-indexcache* /tmp/luci-modulecache
	/etc/init.d/rpcd restart >/dev/null 2>&1
}
exit 0
endef

define Package/luci-app-subgen/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/subgen stop >/dev/null 2>&1
exit 0
endef

$(eval $(call BuildPackage,luci-app-subgen))
