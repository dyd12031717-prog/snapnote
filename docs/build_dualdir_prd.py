#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SnapNote v1.6.0 双目录重构 PRD PDF 生成（精简版，Report 路线/ReportLab）。"""
import sys, re
sys.path.insert(0, "/home/z/my-project/skills/pdf/scripts")
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor, white
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
    TableStyle, PageBreak, CondPageBreak, XPreformatted, KeepTogether)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

FONT_DIR = "/usr/share/fonts"
pdfmetrics.registerFont(TTFont("NotoSerifSC", f"{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Regular.ttf"))
pdfmetrics.registerFont(TTFont("NotoSerifSC-Bold", f"{FONT_DIR}/truetype/noto-serif-sc/NotoSerifSC-Bold.ttf"))
pdfmetrics.registerFont(TTFont("MonoSC", f"{FONT_DIR}/truetype/chinese/SarasaMonoSC-Regular.ttf"))

ACCENT = HexColor("#B45309"); DARK = HexColor("#1F2937")
GRAY = HexColor("#6B7280"); LINE = HexColor("#E5E7EB"); BG = HexColor("#FAF7F2")

body = ParagraphStyle("body", fontName="NotoSerifSC", fontSize=10.2, leading=17,
    textColor=DARK, spaceAfter=6)
lead = ParagraphStyle("lead", parent=body, fontSize=10.8, textColor=GRAY, leading=18)
h1s = ParagraphStyle("h1s", fontName="NotoSerifSC-Bold", fontSize=17, leading=22,
    textColor=DARK, spaceBefore=18, spaceAfter=10)
h2s = ParagraphStyle("h2s", fontName="NotoSerifSC-Bold", fontSize=12.5, leading=17,
    textColor=ACCENT, spaceBefore=13, spaceAfter=6)
h3s = ParagraphStyle("h3s", fontName="NotoSerifSC-Bold", fontSize=10.8, leading=15,
    textColor=DARK, spaceBefore=9, spaceAfter=4)
mono = ParagraphStyle("mono", fontName="MonoSC", fontSize=8.6, leading=13,
    textColor=DARK, backColor=BG, borderPadding=(6,8,6,8), spaceBefore=4, spaceAfter=8)
cell = ParagraphStyle("cell", parent=body, fontSize=9.2, leading=13.5, spaceAfter=0)
cellh = ParagraphStyle("cellh", parent=cell, fontName="NotoSerifSC-Bold", textColor=white)

class TOCDoc(SimpleDocTemplate):
    def afterFlowable(self, fl):
        if isinstance(fl, Paragraph):
            if fl.style.name == "h1s": self.notify("TOCEntry", (0, fl.getPlainText(), self.page))
            elif fl.style.name == "h2s": self.notify("TOCEntry", (1, fl.getPlainText(), self.page))

def deco(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE); canvas.setLineWidth(0.7)
    canvas.line(52, 46, 543, 46)
    canvas.setFont("NotoSerifSC", 8); canvas.setFillColor(GRAY)
    canvas.drawString(52, 34, "SnapNote v1.6.0 更新机制重构 PRD · 双目录原子切换")
    canvas.drawRightString(543, 34, f"第 {doc.page} 页")
    canvas.setFillColor(ACCENT); canvas.rect(52, 806, 8, 10, stroke=0, fill=1)
    canvas.restoreState()

story = []
def H1(t): story.append(Paragraph(t, h1s))
def H2(t): story.append(Paragraph(t, h2s))
def P(t): story.append(Paragraph(t, body))
def PRE(t): story.append(XPreformatted(t, mono))
def TBL(head, rows, widths=None):
    data = [[Paragraph(h, cellh) for h in head]] + [[Paragraph(c, cell) for c in r] for r in rows]
    tw = widths or [90, 130, 220, 100][:len(head)] and [491.0/len(head)]*len(head)
    t = Table(data, colWidths=widths or tw, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0,0), (-1,0), ACCENT), ("GRID", (0,0), (-1,-1), 0.5, LINE),
        ("VALIGN", (0,0), (-1,-1), "TOP"), ("TOPPADDING", (0,0), (-1,-1), 4),
        ("BOTTOMPADDING", (0,0), (-1,-1), 4), ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 6),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [white, BG])]))
    story.append(CondPageBreak(60)); story.append(t); story.append(Spacer(1, 8))

# 封面
story.append(Spacer(1, 170))
story.append(Paragraph("SnapNote v1.6.0", ParagraphStyle("cv1", fontName="NotoSerifSC-Bold",
    fontSize=26, leading=34, textColor=ACCENT, alignment=TA_CENTER)))
story.append(Paragraph("更新机制重构产品需求文档", ParagraphStyle("cv2", fontName="NotoSerifSC-Bold",
    fontSize=20, leading=30, textColor=DARK, alignment=TA_CENTER, spaceBefore=6)))
story.append(Spacer(1, 16))
story.append(Paragraph("双目录原子切换 · 从源头消灭更新链路的结构性风险", ParagraphStyle("cv3",
    fontName="NotoSerifSC", fontSize=11.5, leading=18, textColor=GRAY, alignment=TA_CENTER)))
story.append(Spacer(1, 40))
for k, v in [("版本", "v1.6.0（架构重构版）"), ("日期", "2026-10-05"),
    ("状态", "待确认（确认后开工）"), ("决策", "方案 A：先立地基，浏览器扩展二期顺延 v1.7.0")]:
    story.append(Paragraph(f"{k}　｜　{v}", ParagraphStyle("cvm", fontName="NotoSerifSC",
        fontSize=10, leading=17, textColor=DARK, alignment=TA_CENTER)))
story.append(PageBreak())

story.append(Paragraph("目录", h1s))
toc = TableOfContents(); toc.levelStyles = [
    ParagraphStyle("t1", fontName="NotoSerifSC-Bold", fontSize=10.5, leading=18, textColor=DARK, leftIndent=6),
    ParagraphStyle("t2", fontName="NotoSerifSC", fontSize=9.5, leading=15, textColor=GRAY, leftIndent=24)]
story.append(toc)
story.append(PageBreak())

H1("一、一句话目标")
P("把更新机制从「程序退出后由外部脚本删旧拷新（危险、不可测、环境依赖）」重构为「新版本完整就位后翻指针（安全、可测、环境无关）」——从源头消灭 tar 劫持、robocopy 中断、杀软拦截这一整类故障，让以后每个版本的发布都不再是赌注。")

H1("二、为什么必须重构")
P("v1.5.x 替换链是结构性缺陷，补丁无法收敛。证据如下：")
TBL(["证据", "说明"], [
    ["5/7 版本在修同一条链路", "同一子系统反复出问题 = 结构问题而非实现问题"],
    ["失败空间无限 vs 测试空间有限", "PS 脚本跑在用户环境全集（PATH/杀软/盘符/权限），CI 只能模拟有限环境"],
    ["破坏性语义", "robocopy /MIR 先删后拷，任何中途死亡 = 目录半损"],
    ["成熟度对照组", "Chrome/Steam 均为「双目录+指针」；无主流软件以「退出后脚本镜像替换」为唯一更新路径"],
], [150, 341])
P("v1.5.5 的多层防御（绝对路径 tar、兜底解压、回滚、留痕）把已知坑埋了，但「不再踩新坑」无法被证明。本重构消灭的是坑的类别。")

H1("三、新架构总览")
H2("3.1 目录布局")
PRE("""E:\\project\\SnapNote\\              ← 解压根目录（双击入口永远在这层）
├── SnapNote.exe                  ← 启动器（极薄 stub，约 10KB，逻辑永不变化）
├── channels.json                 ← 指针：{"current":"app-1.6.0","previous":null}
├── app-1.6.0\\                    ← 版本目录 A（当前运行）
│   ├── SnapNoteApp.exe           ← 主程序（v1.6.0 起改名，原因见决策 1）
│   ├── resources\\                ← Electron 资源
│   └── ...
└── app-1.7.0\\                    ← 版本目录 B（更新就位后；A 变为回滚后路）""")
H2("3.2 角色职责")
TBL(["角色", "形态", "职责", "更新频率"], [
    ["启动器 SnapNote.exe", "C# stub（源码入仓库，CI 编译）", "读指针拉起主程序；指针损坏时扫 app-* 取最大版本兜底；全损弹窗", "永不更新"],
    ["主程序 SnapNoteApp.exe", "Electron 应用", "便签/收集/气泡/更新器宿主，更新器全程 Node", "每版本"],
    ["channels.json", "纯文本指针", "current / previous 两个版本目录名", "每次更新翻转"],
], [88, 108, 235, 60])

H1("四、四条关键链路设计")
H2("4.1 全新安装")
P("下载 zip（新布局成品）→ 解压到任意目录 → 双击根 SnapNote.exe（启动器）→ 读 channels.json → 拉起 app-1.6.0\\SnapNoteApp.exe。解压即用，与现状体验完全一致。")
H2("4.2 常规更新（v1.6.0+，核心链路，100% Node）")
PRE("""下载 zip + sha256 校验（现有 27 个测试继续护住，代码不动）
→ applyUpdate（全 Node，可单测）：
     1. System32 bsdtar 绝对路径解压到临时目录（失败无害可重试）
     2. zip 内 app-x.y.z\\ 挪入根（同卷 rename 原子；跨卷 copy+校验+删源）
     3. 指针翻转（先写临时文件再 rename，原子保证）
     4. 托盘通知「新版本已就绪」——不自动杀程序，主动权在用户
→ 用户点「重启进新版」→ spawn app-x.y.z\\SnapNoteApp.exe → 本进程退出
→ 新版本首跑：异步清理 previous 目录 + 临时残留""")
P("失败语义：任何一步失败 = 旧版本原地照跑，指针未翻，用户零感知损失。最坏情况是「这次更新没成」，而不是旧版任何形式的损坏。")
H2("4.3 v1.5.x → v1.6.0 迁移（旧 PS 链最后一跑，接力式）")
P("现有 v1.5.5 客户端执行未修改的 PS 脚本对新布局 zip，逐行推演已验证成立：")
TBL(["PS 步骤", "对新 zip 的执行结果"], [
    ["等待旧进程退出", "Get-Process SnapNote ✓（旧真程序名未变）"],
    ["System32 tar 解压", "产出 {启动器, channels.json, app-1.6.0\\SnapNoteApp.exe + resources}"],
    ["robocopy /MIR /XF SnapNote.exe", "app-1.6.0\\ 整体镜像入根 ✓（主程序已改名，不触发 /XF 深层排除——改名的根本原因）；根启动器被 /XF 跳过，由下一步补"],
    ["exe 两步换名", "旧根 SnapNote.exe → .old；拷启动器 → 根 ✓"],
    ["启动根 exe", "= 启动器 → 读指针 → 拉起 app-1.6.0\\SnapNoteApp.exe ✓"],
    ["新程序首跑", "cleanupStale 删 .old ✓ 迁移完成"],
], [130, 361])
P("旧链一次都不用改，跑完即完成新布局铺设；此后该客户端永久转入 4.2 纯 Node 链路。v1.6.0 起删除 PS 生成逻辑（git 历史永久可回溯）。")
H2("4.4 回滚（用户主动权）")
P("托盘菜单新增「回滚到上一版本」：指针翻转 → 经启动器拉起 previous 版本 → 通知「已回滚至 vX.Y.Z」。任何一次更新后不满意，10 秒内可退回，无需联系开发者。")

H1("五、关键决策与取舍")
TBL(["#", "决策", "理由", "代价"], [
    ["1", "主程序改名 SnapNoteApp.exe", "旧 PS 的 /XF 按文件名深层排除同名 exe；改名后接力迁移零修改成立", "任务管理器进程名显示 SnapNoteApp"],
    ["2", "启动器用 C# stub（CI csc 编译）", "极薄秒启动，无 Electron 负担，不引入新构建依赖", "仓库新增 launcher.cs（本地不编译，CI 负责）"],
    ["3", "解压暂用系统 bsdtar 绝对路径", "零新依赖；失败语义已从致命降级为可重试", "环境依赖残留一项（v1.7 换纯 JS 归零）"],
    ["4", "保留 previous 一层版本目录", "回滚能力的物理基础", "磁盘约 2× 版本目录；托盘提供「清理旧版本」"],
    ["5", "更新就绪后不自动重启", "主动权交到用户手里", "无（通知+菜单高亮引导）"],
], [18, 118, 210, 145])

H1("六、测试与验收标准")
H2("6.1 自动化（CI 全绿才发版）")
P("新增单测约 15 个：指针翻转原子性、双目录就位、跨卷拷贝分支、回滚翻转、新程序首跑清理、迁移识别、启动器目标推导。e2e_update.js 重写为双目录版，CI 真实跑「v1.6.0 → v1.6.1」全链——预期首次绿（不再有 PS 环境依赖）。冒烟改为启动器链：launcher → SnapNoteApp --smoke-test。")
H2("6.2 真机验收（两跳，缺一不可）")
P("① 迁移跳：v1.5.5 真机点「重启并更新」升 v1.6.0 → 根目录出现启动器 + app-1.6.0 子目录 → 版本号 1.6.0 ✓（同时验证 v1.5.5 的 PS 修复，一箭双雕）。② Node 链跳：随即发布 v1.6.1 → 真机走纯 Node 更新 → 成功后回滚菜单可退回 1.6.0 ✓。两跳通过后，更新机制从「每次发布的赌注」转为「有测试护城河的常规代码」。")

H1("七、风险清单与兜底")
TBL(["风险", "概率", "兜底"], [
    ["启动器被 SmartScreen/杀软误报", "低", "与现状 zip 解压 exe 同属 MotW 场景，非新增类别；误报率极高时再评估签名"],
    ["E 盘特殊文件系统 rename 非原子", "低", "指针用「临时文件+替换」双保险；失败重试无害"],
    ["迁移跳失败（PS 最后一跑挂）", "低", "失败=停留 v1.5.5 无损；update-error.log 留痕；可手动解压 v1.6.0 zip 覆盖"],
    ["启动器自身需更新的极端场景", "极低", "随版本目录分发新启动器副本，翻指针前同步替换根启动器（附加步骤非主路径）"],
], [150, 40, 301])

H1("八、工作量与里程碑")
TBL(["阶段", "内容", "估算"], [
    ["M1", "launcher.cs + CI 编译与 zip 双目录组装 + 主程序改名", "0.5 天"],
    ["M2", "Node 更新链（applyUpdate/指针/重启/清理）+ 15 个单测", "1 天"],
    ["M3", "迁移验证 + CI e2e 重写 + 回滚菜单 + 失败留痕适配", "0.5 天"],
    ["M4", "v1.6.0 发布 + 真机两跳验收 + v1.6.1 验证版", "0.5 天 + 验收等待"],
], [50, 351, 90])
P("总计约 2.5 个开发日。浏览器扩展二期（PRD 已定稿）顺延为 v1.7.0，其剪贴板/备忘录一期功能不受本次重构任何影响。")

H1("附：与现状的兼容性承诺")
P("便签/备忘录/气泡/快捷键/磁吸零改动（87 测试继续全绿为准入线）；用户数据目录零迁移（%AppData% 与 exe 位置无关）；更新检查/下载（镜像、续传、sha256、截断检测）代码不动只换末端；v1.5.x 全系旧客户端可经 4.3 一步迁入新架构，错过多版无窗口期问题。")

doc = TOCDoc("/home/z/my-project/snapnote/docs/SnapNote_v1.6.0_更新机制重构PRD.pdf",
    pagesize=A4, leftMargin=52, rightMargin=52, topMargin=56, bottomMargin=60,
    title="SnapNote v1.6.0 更新机制重构 PRD", author="SnapNote")
doc.multiBuild(story, onFirstPage=deco, onLaterPages=deco)
print("PDF OK")
