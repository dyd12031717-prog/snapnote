'use strict';
/**
 * 主进程动作日志 — SnapNote v1.6.4+
 *
 * 用户需求（2026-10-05）：「无论我执行什么动作都要生成日志报告」——此前
 * 「双击升级器无反应」无从排查，因为没有留痕。同时「垃圾不能一直占空间」——
 * 每周自动清理一次。
 *
 * 设计：
 *  - 文件：%AppData%\SnapNote\logs\snapnote-YYYYMMDD.log（按天分文件，追加写）
 *  - 隐私红线：只记动作名与元数据（版本/路径/耗时/错误码），
 *    绝不写便签内容、捕获文本、剪贴板内容等用户数据本体。
 *  - 周清理：启动时检查 .lastClean，距上次 ≥7 天才执行（清理本身也留痕）；
 *    删除 >7 天的日志文件；总量 >20MB 时从最旧开始删到 10MB 内（兜底防刷爆）。
 *  - 一切 best-effort：日志失败绝不影响主流程。
 */
const fs = require('fs');
const path = require('path');

const RETAIN_DAYS = 7;      // 用户拍板：每星期清一次
const HARD_LIMIT_BYTES = 20 * 1024 * 1024; // 总量兜底上限
const SOFT_TARGET_BYTES = 10 * 1024 * 1024; // 超限后删到此线

let _dir = null;
let _file = null;

/** 初始化（app ready 后尽早调用）。幂等。 */
function init(appDataPath) {
  if (_dir) return true;
  try {
    _dir = path.join(appDataPath, 'SnapNote', 'logs');
    fs.mkdirSync(_dir, { recursive: true });
    _file = path.join(_dir, 'snapnote-' + new Date().toISOString().slice(0, 10) + '.log');
    weeklyClean();
    log('logger', '启动日志初始化 | dir=' + _dir);
    return true;
  } catch (e) {
    _dir = null;
    return false;
  }
}

/** 追加一行（自动带 ISO 时间；内部失败静默） */
function log(event, detail) {
  if (!_file) return;
  try {
    fs.appendFileSync(_file,
      new Date().toISOString() + ' [' + event + '] ' + (detail == null ? '' : String(detail)) + '\n', 'utf8');
  } catch (e) { /* 尽力而为 */ }
}

/** 错误事件（同 log，事件名标红语义由查询方处理） */
function error(event, err) {
  log('ERROR:' + event, err && err.message ? err.message : String(err));
}

/** 每周清理：上次清理 ≥7 天才跑；删过期文件 + 总量兜底。 */
function weeklyClean() {
  if (!_dir) return;
  try {
    const marker = path.join(_dir, '.lastClean');
    const now = Date.now();
    let last = 0;
    if (fs.existsSync(marker)) last = Number(fs.readFileSync(marker, 'utf8').trim()) || 0;
    if (now - last < RETAIN_DAYS * 86400000) return; // 未到一周，跳过

    const cutoff = now - RETAIN_DAYS * 86400000;
    const files = fs.readdirSync(_dir)
      .filter((f) => /^snapnote-\d{4}-\d{2}-\d{2}\.log$/.test(f) || /^upgrader-\d{8}\.log$/.test(f))
      .map((f) => {
        const p = path.join(_dir, f);
        const st = fs.statSync(p);
        return { p, mtime: st.mtimeMs, size: st.size };
      });
    let removed = 0;
    let bytes = 0;
    for (const f of files) {
      if (f.mtime < cutoff) { fs.rmSync(f.p, { force: true }); removed++; }
      else bytes += f.size;
    }
    // 总量兜底：超 HARD_LIMIT 时从最旧删到 SOFT_TARGET
    if (bytes > HARD_LIMIT_BYTES) {
      const byAge = files.filter((f) => fs.existsSync(f.p)).sort((a, b) => a.mtime - b.mtime);
      for (const f of byAge) {
        if (bytes <= SOFT_TARGET_BYTES) break;
        bytes -= f.size;
        fs.rmSync(f.p, { force: true });
        removed++;
      }
    }
    fs.writeFileSync(marker, String(now), 'utf8');
    log('logger', '每周清理完成 | 删除过期文件 ' + removed + ' 个 | 剩余 ' +
      Math.round(bytes / 1024) + 'KB');
  } catch (e) { /* 清理失败不影响启动 */ }
}

/** 日志目录（诊断指引「发我日志」时用） */
function dir() { return _dir; }

module.exports = { init, log, error, weeklyClean, dir, RETAIN_DAYS };
