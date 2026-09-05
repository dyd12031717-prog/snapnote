# 磁吸便签 SnapNote

贴在屏幕右缘的轻量任务便签 —— 开机自动提醒今日任务，快捷键随叫随到，
用完自动磁吸回屏幕最右端。基于 Electron 的独立 Windows 桌面程序，
不依赖浏览器、无需联网。

---

## 快速上手

**普通用户**：到本仓库 **Releases** 页面下载 `SnapNote-Portable-x64.zip`，解压到任意目录，双击 **SnapNote.exe** 即可运行，无需安装。首屏右缘出现琥珀色「今日」把手——那就是它。

> Windows SmartScreen 可能提示"未知发布者"：点 **更多信息 → 仍要运行** 即可
> （个人开发者未购买代码签名证书的正常现象）。

### 安装版（可选）

如果你拿到的是源码，想生成 NSIS 安装包（SnapNote-Setup.exe），
在任何一台 Windows 电脑上执行：

```bash
npm install
npm run dist
```

产物在 `release/` 目录：`SnapNote-Setup-1.0.0.exe`（安装版）与便携版 zip。

### 自动更新（v1.1.0+）

便携版内置自动更新，装好之后再也不用手动下载解压覆盖：

- 启动约 15 秒后自动静默检查本仓库 Releases（也支持托盘右键 → **检查更新**）
- 发现新版本 → 系统通知弹出，点击即开始**后台下载**
- 下载完成 → 通知点击 **重启并更新**：程序自动替换自身并重启，任务数据完好保留
- 更新只访问 GitHub，无需账号密码，开发态（`npm start`）自动禁用

> 发布流程：推送 `v*` 标签 → GitHub Actions 自动构建 → 产出新便携 zip 并发布 Release。

---

## 日常使用

| 动作 | 效果 |
|---|---|
| 点击右缘把手 / 按 `Ctrl+Alt+N` | 便签从右缘磁吸展开，光标直接落在输入框 |
| 输入文字 + 回车 | 立即记下一条任务，可连续录入 |
| 点「今晚 20:00 / 明天 09:00」等胶囊 | 给任务定时（也可点「自定义」选任意时间）|
| 点任务前的圆圈 | 标记完成（划线沉底）|
| 点「删除」 | 删除该任务 |
| 点击便签外的任何地方 | 30 秒后便签自动磁吸回屏幕右缘 |
| 托盘琥珀图标：左键 | 唤起/收起便签 |
| 托盘图标：右键 | 打开便签 / 设置 / 开机自启开关 / 退出 |
| `Esc` | 立即收回便签 |

### 开机提醒

Windows 登录后约 8 秒，屏幕**右上角**滑入今日任务摘要卡片
（"早上好，今天有 N 个任务，最早 HH:MM ××××"），点击展开便签，约 6 秒自动消失。
到点任务也会同样提醒（伴随提示音，可在设置中关闭）。

### 修改快捷键

托盘右键 → 设置 → 点「修改」→ 在新窗口按下想要的组合键（如 `Ctrl+Shift+K`）→ 保存。

---

## 数据与隐私

- 全部数据只存在本机：`C:\Users\<你>\AppData\Roaming\SnapNote\tasks.json`（明文 JSON）
- 无网络请求、无账号、无遥测
- 每次写入自动保留 `.bak` 副本，文件损坏时自动回退

---

## 从源码运行 / 开发

```bash
npm install          # 安装依赖（首次含 Electron 二进制下载）
npm start            # 启动应用
npm test             # 35 项单元与主进程逻辑测试
npm run check        # 全源码语法检查
npm run smoke        # 应用级冒烟自检（贴边/展开/收回/调度/Toast）
python3 scripts/verify_ui.py   # 渲染层 UI 无头验证 + 截图
```

## 项目结构

```
snapnote/
├─ electron/           # 主进程
│  ├─ main.js          # 窗口/磁吸动画/托盘/快捷键/自启/IPC/自动更新
│  ├─ preload.js       # 安全渲染桥（contextIsolation）
│  ├─ lib/store.js     # 任务存储（原子写 + .bak 回退）
│  ├─ lib/scheduler.js # 到点提醒调度
│  ├─ lib/timeparse.js # 时间胶囊/过期判断
│  └─ lib/updater.js   # 便携版自动更新（检查/下载/替换重启）
├─ renderer/           # 渲染层（便签 / Toast / 设置）
├─ tests/              # 单元测试 + Electron mock 桩
├─ scripts/verify_ui.py# 无头 UI 验证
├─ .github/workflows/  # CI：打 tag 自动构建并发布 Release
├─ assets/             # 应用图标 / 托盘图标
└─ docs/               # PRD 文档与设计源文件
```

需求与设计详见《磁吸便签SnapNote_产品需求文档PRD.pdf》（docs/ 目录）。
