// SnapNote 启动器（launcher stub）
// ============================================================
// 角色与约束（PRD v1.6.0「双目录原子切换」）：
//  - 极薄：只做「读指针 → 拉起当前版本目录里的主程序」；
//    逻辑永不变化，永不参与更新流程，因此无需自更新。
//  - 目标主程序：app-<x.y.z>\SnapNoteApp.exe（zip 布局组装时固定）。
//  - 单实例竞态：先等待运行中的 SnapNoteApp 退出（最多 20s），
//    避免回滚/重启进新版时新旧进程交叠撞单实例锁。
//  - 兜底链：channels.json 的 current 目录缺失 → 扫描 app-* 取
//    目录名版本号最大者；全部失败 → MessageBox（失败必须可见）。
//
// 编译（CI windows runner，.NET Framework 自带 csc）：
//   csc /nologo /target:winexe /win32icon:assets\icon.ico ^
//       /out:SnapNote.exe launcher\SnapNoteLauncher.cs
// 产物 ~10KB。用 .NET Framework 4.x（Windows 7+ 自带运行时，零依赖）。
// ============================================================
using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Threading;

static class SnapNoteLauncher
{
    const string AppExe = "SnapNoteApp.exe";
    const string ChannelsFile = "channels.json";
    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;

    [STAThread]
    static int Main()
    {
        try
        {
            string target = ResolveTarget();
            if (target == null)
            {
                ShowError("SnapNote 程序目录不完整",
                    "未找到任何可用版本目录（app-x.y.z）。\n" +
                    "请重新下载完整安装包解压，或联系开发者。");
                return 2;
            }
            WaitAppExit(20 * 1000); // 等旧进程退出，避单实例锁竞态
            Process.Start(new ProcessStartInfo
            {
                FileName = target,
                WorkingDirectory = Path.GetDirectoryName(target),
                UseShellExecute = false,
            });
            return 0;
        }
        catch (Exception ex)
        {
            ShowError("SnapNote 启动器出错", ex.Message);
            return 1;
        }
    }

    /// 解析本次应启动的版本目录（绝对路径），失败返回 null。
    static string ResolveTarget()
    {
        // 1) 指针文件优先
        string cur = ReadCurrent();
        if (cur != null)
        {
            string p = Path.Combine(Root, cur, AppExe);
            if (File.Exists(p)) return p;
        }
        // 2) 扫描 app-*，取版本号最大（目录名序不可靠）
        string best = null; Version bestV = null;
        foreach (string dir in Directory.GetDirectories(Root, "app-*"))
        {
            Match m = Regex.Match(Path.GetFileName(dir), @"^app-(\d+\.\d+\.\d+)");
            if (!m.Success) continue;
            if (!File.Exists(Path.Combine(dir, AppExe))) continue;
            var v = Version.Parse(m.Groups[1].Value);
            if (bestV == null || v > bestV) { bestV = v; best = dir; }
        }
        return best == null ? null : Path.Combine(best, AppExe);
    }

    /// 读 channels.json 的 current 字段（解析失败/文件缺失返回 null，不抛）。
    static string ReadCurrent()
    {
        try
        {
            string json = File.ReadAllText(Path.Combine(Root, ChannelsFile));
            Match m = Regex.Match(json, "\"current\"\\s*:\\s*\"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value : null;
        }
        catch { return null; }
    }

    /// 等待运行中的 SnapNoteApp 退出（含退出中的旧进程），超时不阻塞启动。
    static void WaitAppExit(int maxWaitMs)
    {
        for (int waited = 0; waited < maxWaitMs; waited += 400)
        {
            if (Process.GetProcessesByName("SnapNoteApp").Length == 0) return;
            Thread.Sleep(400);
        }
    }

    static void ShowError(string title, string body)
    {
        MessageBox.Show(body, title, MessageBoxButtons.OK,
            MessageBoxIcon.Error, MessageBoxDefaultButton.Button1,
            MessageBoxOptions.DefaultDesktopOnly);
    }
}
