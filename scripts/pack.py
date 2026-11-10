# -*- coding: utf-8 -*-
"""把 dist 里的二进制和配置打成可直接用的压缩包。

  dist/subgen-windows-amd64.zip    解压 → 双击 start.bat
  dist/subgen-macos-arm64.tar.gz   解压 → 双击 start.command（首次右键→打开）
  dist/subgen-openwrt-arm64.tar.gz 给不用 apk 包、想直接丢文件的人
"""
import io
import os
import shutil
import tarfile
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DIST = os.path.join(ROOT, 'dist')

CONFIGS = ['config.yaml', 'base.yaml', 'rules_inline.yaml', 'rules_providers.yaml']

# 有真实 config.yaml 就用它，没有就用公开模板（仓库里只放模板，真实订阅不入库）
CONF_FILE = 'config.yaml' if os.path.exists(os.path.join(ROOT, 'config.yaml')) else 'config.example.yaml'


def read(p):
    return io.open(os.path.join(ROOT, p), encoding='utf-8').read()


def windows_config():
    """PC 上只给本机浏览器用，监听 loopback 更安全"""
    t = read(CONF_FILE)
    t = t.replace('listen: 0.0.0.0:25500', 'listen: 127.0.0.1:25500')
    return t


def write_zip(name, items):
    path = os.path.join(DIST, name)
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for arc, data in items:
            zi = zipfile.ZipInfo(arc)
            zi.external_attr = (0o755 if arc.endswith(('.exe', '.bat', '.command')) else 0o644) << 16
            z.writestr(zi, data)
    print('  ->', path, os.path.getsize(path), '字节')


def mode_for(arc):
    """Windows 上源文件的权限位不可信，按路径自己定：该可执行的给 755。"""
    if arc.endswith(('.sh', '.command')):
        return 0o755
    if '/init.d/' in arc or '/uci-defaults/' in arc or '/libexec/rpcd/' in arc:
        return 0o755
    if arc.startswith('usr/bin/') or arc == 'subgen':
        return 0o755
    return 0o644


def write_tar(name, items):
    path = os.path.join(DIST, name)
    with tarfile.open(path, 'w:gz') as t:
        for arc, src in items:
            info = t.gettarinfo(src, arcname=arc)
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            info.mode = mode_for(arc)
            with open(src, 'rb') as f:
                t.addfile(info, f)
    print('  ->', path, os.path.getsize(path), '字节')


def main():
    os.makedirs(DIST, exist_ok=True)

    # ---------- Windows ----------
    exe = os.path.join(DIST, 'subgen-windows-amd64.exe')
    with open(exe, 'rb') as f:
        exe_bytes = f.read()
    items = [('subgen.exe', exe_bytes)]
    items.append(('config.yaml', windows_config().encode('utf-8')))
    for c in CONFIGS[1:]:
        items.append((c, read(c).encode('utf-8')))
    items.append(('start.bat', read('packaging/windows/start.bat').encode('utf-8')))
    items.append(('sync-once.bat', read('packaging/windows/sync-once.bat').encode('utf-8')))
    items.append(('schedule.bat', read('packaging/windows/schedule.bat').encode('utf-8')))
    items.append(('README.txt', read('packaging/windows/README.txt').encode('utf-8')))
    write_zip('subgen-windows-amd64.zip', items)

    # ---------- macOS arm64 / amd64 ----------
    for arch in ('arm64', 'amd64'):
        bin_path = os.path.join(DIST, 'subgen-darwin-%s' % arch)
        if not os.path.exists(bin_path):
            continue
        items = [
            ('subgen', bin_path),
            ('config.yaml', os.path.join(ROOT, CONF_FILE)),
            ('base.yaml', os.path.join(ROOT, 'base.yaml')),
            ('rules_inline.yaml', os.path.join(ROOT, 'rules_inline.yaml')),
            ('rules_providers.yaml', os.path.join(ROOT, 'rules_providers.yaml')),
            ('start.command', os.path.join(ROOT, 'packaging/macos/start.command')),
            ('sync-once.command', os.path.join(ROOT, 'packaging/macos/sync-once.command')),
            ('schedule.command', os.path.join(ROOT, 'packaging/macos/schedule.command')),
            ('README.txt', os.path.join(ROOT, 'packaging/macos/README.txt')),
        ]
        # macOS 上配置也用 loopback
        tmp = os.path.join(DIST, '.config.macos.yaml')
        io.open(tmp, 'w', encoding='utf-8', newline='\n').write(windows_config())
        items[1] = ('config.yaml', tmp)
        write_tar('subgen-macos-%s.tar.gz' % arch, items)
        os.unlink(tmp)

    # ---------- OpenWrt 原生（不用包管理器的场景）----------
    # 解开就能 sh install.sh；里面带 rpcd 插件和 uci-defaults，否则 LuCI 的启停按钮是灰的
    for arch in ('arm64', 'amd64'):
        bin_path = os.path.join(DIST, 'subgen-linux-%s' % arch)
        if not os.path.exists(bin_path):
            continue
        items = [
            ('install.sh', os.path.join(ROOT, 'luci-app/install.sh')),
            ('uninstall.sh', os.path.join(ROOT, 'luci-app/uninstall.sh')),
            ('usr/bin/subgen', bin_path),
            ('etc/init.d/subgen', os.path.join(ROOT, 'luci-app/files/subgen.init')),
            ('etc/subgen/config.yaml', os.path.join(ROOT, CONF_FILE)),
            ('etc/subgen/base.yaml', os.path.join(ROOT, 'base.yaml')),
            ('etc/subgen/rules_inline.yaml', os.path.join(ROOT, 'rules_inline.yaml')),
            ('etc/subgen/rules_providers.yaml', os.path.join(ROOT, 'rules_providers.yaml')),
            ('www/luci-static/resources/view/subgen/config.js',
             os.path.join(ROOT, 'luci-app/htdocs/luci-static/resources/view/subgen/config.js')),
            ('www/luci-static/resources/subgen/ui.js',
             os.path.join(ROOT, 'luci-app/htdocs/luci-static/resources/subgen/ui.js')),
            ('usr/share/luci/menu.d/luci-app-subgen.json',
             os.path.join(ROOT, 'luci-app/root/usr/share/luci/menu.d/luci-app-subgen.json')),
            ('usr/share/rpcd/acl.d/luci-app-subgen.json',
             os.path.join(ROOT, 'luci-app/root/usr/share/rpcd/acl.d/luci-app-subgen.json')),
            ('usr/libexec/rpcd/subgen',
             os.path.join(ROOT, 'luci-app/root/usr/libexec/rpcd/subgen')),
            ('etc/uci-defaults/90_subgen',
             os.path.join(ROOT, 'luci-app/root/etc/uci-defaults/90_subgen')),
        ]
        write_tar('subgen-openwrt-%s.tar.gz' % arch, items)


if __name__ == '__main__':
    main()
