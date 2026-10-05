#!/usr/bin/env bash
# ============================================================
# v1.6.3 升级包组装：SnapNote-Upgrader-<ver>.zip = {
#   SnapNoteUpgrader.exe（csc 编译的升级器）+ data.zip（新版本完整包）
#   + 使用说明.txt
# }
# 用户旅程：解压 → 双击 SnapNoteUpgrader.exe → 自动关软件-升级-重启。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
STAGING="release/.upgrader-staging"
OUT="release/SnapNote-Upgrader-${VERSION}.zip"

if [ ! -f launcher/SnapNoteUpgrader.exe ]; then
  echo "ERROR: launcher/SnapNoteUpgrader.exe 不存在（需先 csc 编译）" >&2
  exit 1
fi
PORTABLE=$(ls release/SnapNote-Portable-*-win-x64.zip 2>/dev/null | head -1)
if [ -z "$PORTABLE" ] || [ ! -f "$PORTABLE" ]; then
  echo "ERROR: release 下无 Portable zip（先跑 package_dualdir.sh）" >&2
  exit 1
fi

rm -rf "${STAGING}"
mkdir -p "${STAGING}"
cp launcher/SnapNoteUpgrader.exe "${STAGING}/"
cp "${PORTABLE}" "${STAGING}/data.zip"

cat > "${STAGING}/使用说明.txt" <<'EOF'
SnapNote 升级包 —— 使用方法
============================================================
1. 把本压缩包里的三个文件解压到任意位置（可以放桌面）
2. 双击 SnapNoteUpgrader.exe
3. 接下来全自动：它会找到你的 SnapNote 安装目录 →
   关闭正在运行的 SnapNote → 升级到新版本 → 自动重新打开
4. 看到「✓ 升级完成」即完成，解压出来的文件可以删掉

注：
- 首次运行可能弹出 Windows「未知发布者」提示（未签名软件的
  正常提醒），点「更多信息」→「仍要运行」即可
- 升级采用双目录结构：新版就位成功才切换，旧版本保留作后路
  （SnapNote 托盘菜单里可「回滚到上一版」）
- 万一升级器找不到安装目录，会让你手动选一次（以后记住）
- 升级全程日志在 安装目录\.update-work\upgrader-log.txt
EOF

rm -f "${OUT}"
( cd "${STAGING}" && {
  if command -v zip >/dev/null 2>&1; then
    zip -qr "../$(basename "${OUT}")" .
  elif command -v 7z >/dev/null 2>&1; then
    7z a -tzip "../$(basename "${OUT}")" . >/dev/null
  elif [ -x "/c/Program Files/7-Zip/7z.exe" ]; then
    "/c/Program Files/7-Zip/7z.exe" a -tzip "../$(basename "${OUT}")" . >/dev/null
  else
    pwsh -NoProfile -Command "Compress-Archive -Path * -DestinationPath '../$(basename "${OUT}")' -Force"
  fi
} )

if [ ! -s "${OUT}" ]; then
  echo "ERROR: 升级包未生成或为空：${OUT}" >&2
  exit 1
fi
echo "OK: ${OUT}"
ls -la "${OUT}"
