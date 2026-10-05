# v1.6.0 双目录重构 — 工作笔记（2026-10-05）

> PRD 已确认（docs/PRD-dualdir.md / SnapNote_v1.6.0_更新机制重构PRD.pdf）
> 本文件是开发过程中的关键结论存档，防上下文压缩丢失。

## 勘察结论（M1a）

- **updater.js**（419 行）：check/download 链不动；`applyAndRestart()`（PS 路线）替换为
  `applyUpdate()`（Node 解压+双目录+翻指针）+ `restartIntoNew()`；`cleanupStale()` 扩展为
  `cleanupPrevious()`（首跑清 previous 目录）。
- **main.js** 关键点：
  - L88 `appDir = dirname(execPath)` → 需派生 `appRoot`（execPath 父目录名匹配
    `/^app-\d/` 则取其父；平铺/开发态取 dirname 本身——迁移中间态兼容）
  - L91-93 exeBase 从 execPath basename 推导 → 改名 SnapNoteApp 后天然适配 ✓
  - L104 updater 构造注入 appDir → 改传 appRoot
  - L110 'ready' 菜单文案 "下载完成，重启并更新 ▸" → "新版本就绪，重启进新版 ▸"
  - L193 restartToUpdate 调 applyAndRestart → 改 restartIntoNew
  - L1026 cleanupStale → cleanupPrevious + 竞态锁处理
  - L1029 update-error.log 检测逻辑保留（PS 链最后一跑的留痕仍走它）
  - L1070 测试钩子 __exeBase 断言需同步（main.test.js 查 __exeBase 用法）
- **package.json**：build.win 加 `"executableName": "SnapNoteApp"`（exe 名与
  productName/zip 名解耦——electron-builder 官方机制）；artifactName 不变。
- **测试**：updater.test.js 风格 = mock fetch 注入 + node:test；新 applyUpdate 用
  真实临时目录测 fs 链。
- **CI**：build job 产物后加「csc 编译 launcher + 组装双目录 zip」；smoke 改
  app 子目录 exe；e2e job 重写脚本。

## 设计定稿（超出 PRD 的实现细节）

1. **launcher.exe 编译**：CI windows runner 上 csc 编译（.NET Framework 4.x，
   windows-latest 自带）。本地 Linux 不编译（本地 build-dist.sh 打包时无 launcher
   → 仅开发包，非发布形态）。launcher 源码在仓库 `launcher/SnapNoteLauncher.cs`。
2. **单实例锁竞态**（重启进新版/回滚的新旧进程交叠）：
   - launcher（C#）：拉起目标前等待 SnapNoteApp 进程消失（最多 20s，400ms 轮询）
   - 主程序：`--wait-lock` 启动参数 → main.js 拿不到锁时重试 10s 而非立刻 quit
3. **回滚**：翻转 channels.json 的 current/previous → spawn 根 launcher → app.quit()。
   （不用 --wait-lock：launcher 自带等待。）
4. **applyUpdate 解压**：`System32\tar.exe` 绝对路径（child_process.execFile，
   v1.5.5 教训），失败兜底 `Expand-Archive`；解压到 workDir/extract，失败抛错
   （无破坏，state='error' 可重试）。
5. **目录挪移**：解压后扫描 extract 根的 `app-*` 目录 → 挪入 appRoot（同卷
   renameSync，跨卷 cpSync recursive + 验证 exe 存在 + 删源）。
6. **指针原子写**：channels.json.tmp → rename。
7. **zip 内 channels.json**：组装时写入 `{"current":"app-<version>","previous":null}`
   ——全新解压即用；旧 PS 链 /MIR 会把它镜像到根（迁移自动完成）。
8. **PS 链兼容性已逐行推演**（PRD 4.3）：/XF SnapNote.exe 只排根 launcher（两步
   换名恰好补上）+ app-1.6.0\SnapNoteApp.exe 不在排除名单 ✓ 旧链零修改。
   v1.6.0 起代码删除 buildUpdateScript（git 历史可回溯）。
9. **execPath→appRoot 派生**：
   ```js
   function deriveAppRoot(execPath) {
     const dir = path.dirname(execPath);
     const base = path.basename(dir);
     return /^app-\d+\.\d+\.\d+/.test(base) ? path.dirname(dir) : dir;
   }
   ```
10. **workDir**：`appRoot/.update-work`（不再 tmp——跨卷 rename 痛点消除；
    进程内管理，download() 的 zip 也放这里；被 .gitignore 式对待——便携目录
    无 git，忽略即可）。zip 下载仍走 tmp？——**统一放 .update-work**（appRoot
    下同卷，挪移必为 rename）✓ 失败重试幂等（先清 extract）。
11. e2e_update.js 重写：CI 上真实 zip → applyUpdate → 断言目录+指针 → spawn
    新 exe --smoke-test（--wait-lock 链路顺带验证）。

## 进度

- [x] M1a 勘察
- [ ] M1b launcher.cs + executableName + 组装脚本
- [ ] M2 updater.js applyUpdate/restartIntoNew/rollback/cleanupPrevious
- [ ] M2b 单测
- [ ] M3 回滚菜单 + CI + e2e 重写
- [ ] M4 全量验证 + 发版

## 发版检查单（M4）

- npm test 全绿（87 旧 + ~15 新）
- 本地 electron-builder --win zip + 组装（无 launcher 路径）冒烟
- CI 全绿（build+e2e）→ 真机两跳验收（用户）
- v1.6.1 验证版随后（Node 链真机跳）
