#!/usr/bin/env bash
# ============================================================
# v1.6.0 双目录成品 zip 组装（PRD 5.2「组装流水线」）
#
# 输入：release/win-unpacked/  （electron-builder --win --dir 产物，
#        含 SnapNoteApp.exe + resources，exe 名由 package.json
#        build.win.executableName 决定）
#        launcher/SnapNote.exe  （可选；CI 上 csc 编译产物。本地
#        Linux 无法编译——缺失时打开发警告，产物仅用于开发冒烟）
#
# 输出：release/SnapNote-Portable-<ver>-win-x64.zip
#        zip 根 = { SnapNote.exe(launcher), channels.json, app-<ver>/ }
#
# 关键点：channels.json 打进 zip —— 全新用户解压即用；旧 v1.5.x
# 客户端经 PS 链 /MIR 镜像后指针随 zip 内容就位（迁移自动完成）。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
UNPACKED="release/win-unpacked"
STAGING="release/.staging"
OUT="release/SnapNote-Portable-${VERSION}-win-x64.zip"

if [ ! -f "${UNPACKED}/SnapNoteApp.exe" ]; then
  echo "ERROR: ${UNPACKED}/SnapNoteApp.exe 不存在。先跑 electron-builder --win --dir" >&2
  exit 1
fi

rm -rf "${STAGING}"
mkdir -p "${STAGING}/app-${VERSION}"
cp -a "${UNPACKED}/." "${STAGING}/app-${VERSION}/"

# launcher（CI 编译产物；本地缺失仅警告）
if [ -f launcher/SnapNote.exe ]; then
  cp launcher/SnapNote.exe "${STAGING}/SnapNote.exe"
else
  echo "WARN: launcher/SnapNote.exe 缺失（本地开发包，非发布形态——发布走 CI）" >&2
fi

printf '{"current":"app-%s","previous":null}\n' "${VERSION}" > "${STAGING}/channels.json"

rm -f "${OUT}"
( cd "${STAGING}" && zip -qr "../$(basename "${OUT}")" . )

echo "OK: ${OUT}"
ls -la "${OUT}"
