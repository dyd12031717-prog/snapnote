#!/bin/bash
# v1.6.0 本地打包（Linux 开发机）：产物仅用于开发验证布局——
# 正式发布走 CI。本地差异：signAndEditExecutable=false（rcedit 依赖 wine，
# Linux 跑不了；exe 图标/版本信息由 patch_icon.mjs 用 resedit 纯 JS 补齐）。
set -e
cd /home/z/my-project/snapnote
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
export CSC_IDENTITY_AUTO_DISCOVERY=false
npx electron-builder --win --dir --x64 --config.win.signAndEditExecutable=false
node scripts/patch_icon.mjs
bash scripts/package_dualdir.sh
