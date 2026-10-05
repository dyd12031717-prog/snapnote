#!/usr/bin/env bash
# ============================================================
# v1.6.4 单文件升级包（SFX 自解压）：SnapNote-Upgrader-<ver>.exe
#   = launcher/SnapNoteUpgrader.exe（纯逻辑升级器）+ Portable zip 尾部拼接
# 用户旅程：下载 → 直接双击（无解压/无同伴文件）→ 关软件-升级-重启全自动。
# 升级器运行时读自身尾部 EOCD 自提取数据（launcher/SnapNoteUpgrader.cs
# ExtractBundledZip）。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
OUT="release/SnapNote-Upgrader-${VERSION}.exe"

if [ ! -f launcher/SnapNoteUpgrader.exe ]; then
  echo "ERROR: launcher/SnapNoteUpgrader.exe 不存在（需先 csc 编译）" >&2
  exit 1
fi
PORTABLE=$(ls release/SnapNote-Portable-*-win-x64.zip 2>/dev/null | head -1)
if [ -z "$PORTABLE" ] || [ ! -f "$PORTABLE" ]; then
  echo "ERROR: release 下无 Portable zip（先跑 package_dualdir.sh）" >&2
  exit 1
fi

rm -f "${OUT}"
cat launcher/SnapNoteUpgrader.exe "${PORTABLE}" > "${OUT}"

# SFX 结构自检（失败必须可见——不留半成品）：
# 1) 尾部 EOCD 存在且能反推出 zip 起点；2) 切出 zip 段真实可解压出版本目录
node - "${OUT}" <<'SELFCHK'
const fs = require('fs');
const [out] = process.argv.slice(2);
const size = fs.statSync(out).size;
const win = 70000;
const fd = fs.openSync(out, 'r');
const tail = Buffer.alloc(Math.min(win, size));
fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - win));
let eocd = -1;
for (let i = tail.length - 22; i >= 0; i--) {
  if (tail[i] === 0x50 && tail[i+1] === 0x4b && tail[i+2] === 0x05 && tail[i+3] === 0x06) { eocd = i; break; }
}
if (eocd < 0) { console.error('SFX 自检失败：尾部无 EOCD'); process.exit(1); }
const base = size - tail.length;
const commentLen = tail[eocd + 20] | (tail[eocd + 21] << 8);
const cdSize = tail.readUInt32LE(eocd + 12);
const cdOffset = tail.readUInt32LE(eocd + 16);
const zipStart = base + eocd - cdSize - cdOffset;
const zipEnd = base + eocd + 22 + commentLen;
const magic = Buffer.alloc(4);
fs.readSync(fd, magic, 0, 4, zipStart);
if (!(magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04)) {
  console.error('SFX 自检失败：zip 起点非 PK\\x03\\x04'); process.exit(1);
}
// 切出 zip 段做真实解压验证（zipfile 等价：临时文件 + 解包首文件名）
const zipLen = zipEnd - zipStart;
const chunk = Buffer.alloc(zipLen);
fs.readSync(fd, chunk, 0, zipLen, zipStart);
fs.closeSync(fd);
const tmp = out + '.sfxcheck.zip';
fs.writeFileSync(tmp, chunk);
// 解压验证用 python（windows runner 预装且 Git Bash 无 unzip——实测教训）
const { execSync } = require('child_process');
const PY = process.env.PY || (require('child_process').execSync(
  'command -v python3 >/dev/null 2>&1 && echo python3 || echo python').toString().trim());
const list = execSync(`${PY} -c "import sys,zipfile; print(chr(10).join(zipfile.ZipFile(sys.argv[1]).namelist()))" "${tmp}"`,
  { encoding: 'utf8' });
fs.rmSync(tmp, { force: true });
if (!/app-\d+\.\d+\.\d+/.test(list)) { console.error('SFX 自检失败：zip 段无版本目录'); process.exit(1); }
console.log('SFX 自检 PASS | 内嵌数据 ' + (zipLen / 1048576).toFixed(1) + 'MB');
SELFCHK

if [ ! -s "${OUT}" ]; then
  echo "ERROR: 升级包未生成或为空：${OUT}" >&2
  exit 1
fi
echo "OK: ${OUT}（单文件，双击即用）"
ls -la "${OUT}"
