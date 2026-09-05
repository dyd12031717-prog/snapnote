'use strict';
/** 语法检查所有 JS（node --check），供 npm run check */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const targets = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules' || name === '.tmp-smoke' || name === 'release') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (name.endsWith('.js')) targets.push(p);
  }
})(ROOT);

let fail = 0;
for (const file of targets) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log('  ok -', path.relative(ROOT, file));
  } catch (e) {
    fail++;
    console.error('  FAIL -', path.relative(ROOT, file));
    console.error(String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'));
  }
}
console.log(`checked ${targets.length} files, ${fail} failed`);
process.exit(fail ? 1 : 0);
