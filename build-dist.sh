#!/bin/bash
cd /home/z/my-project/snapnote
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npx electron-builder --win zip --x64
