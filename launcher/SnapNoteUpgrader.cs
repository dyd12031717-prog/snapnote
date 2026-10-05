// SnapNote 升级器（SnapNoteUpgrader.exe）— v1.6.3+
// ============================================================
// 用户旅程：双击 → 找到安装目录 → 关闭运行中的 SnapNote → 新版本就位
//          （双目录+翻指针，旧版保留可回滚）→ 自动重启 → 显示完成。
//
// 目录寻址链：--dir 参数 > %AppData%\SnapNote\install-location.txt
//            （主程序每次启动自报）> FolderBrowserDialog 手选（UI 模式，
//            选择后写回 location 文件，下次免选）。
//
// 同目录同伴文件：data.zip（新版本完整包 = Portable zip 同构内容）。
//
// --e2e 模式（CI 自动化）：无 UI，读 --dir=，跑完退出码 0/1。
// 失败必须可见：UI 红字显示 + 落盘 <appRoot>\.update-work\upgrader-log.txt。
//
// 编译（CI windows runner）：
//   csc /nologo /target:winexe /r:System.IO.Compression.FileSystem.dll
//       /out:SnapNoteUpgrader.exe launcher\SnapNoteUpgrader.cs
// .NET Framework 4.5+（Windows 8+ 自带；ZipFile 需 4.5，Win7 走对话框提示）。
// ============================================================
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace SnapNoteUpgrader
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            bool e2e = args.Any(a => a == "--e2e");
            string dirArg = args.FirstOrDefault(a => a.StartsWith("--dir="))?.Substring(6);
            if (e2e)
            {
                try { return RunUpgrade(dirArg, null); }
                catch (Exception ex) { Console.Error.WriteLine("UPGRADER_FAIL: " + ex.Message); return 1; }
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UpgForm(dirArg));
            return UpgForm.ExitCode;
        }

        // ---------------- 升级主流程（UI 与 e2e 共用） ----------------
        public static int RunUpgrade(string dirArg, Action<string> log)
        {
            void L(string m) { log?.Invoke(m); Console.WriteLine(m); }
            string appRoot = ResolveInstallDir(dirArg, L);
            if (appRoot == null) { L("✕ 未找到 SnapNote 安装目录"); return 2; }
            L("安装目录：" + appRoot);

            string dataZip = Path.Combine(AppDir(), "data.zip");
            if (!File.Exists(dataZip)) { L("✕ 升级包数据文件缺失：data.zip（须与升级器同目录）"); return 3; }

            string logFile = Path.Combine(appRoot, ".update-work", "upgrader-log.txt");
            try { Directory.CreateDirectory(Path.GetDirectoryName(logFile)); } catch { /* 忽略 */ }

            int WriteResult(string tail)
            {
                // 步骤 7 会删 .update-work 残留——结尾落盘前必须重建目录
                // （否则 AppendAllText 抛 DirectoryNotFoundException 被吞，日志丢失）
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(logFile));
                    File.AppendAllText(logFile, DateTime.Now.ToString("s") + " " + tail + Environment.NewLine, Encoding.UTF8);
                }
                catch { /* 尽力 */ }
                return 0;
            }

            try
            {
                // 1) 结束运行中的 SnapNote（托盘常驻，CloseMainWindow 不可靠 → Kill + 轮询）
                var procs = Process.GetProcessesByName("SnapNoteApp");
                if (procs.Length > 0)
                {
                    L("正在关闭运行中的 SnapNote（" + procs.Length + " 个进程）…");
                    foreach (var p in procs) { try { p.Kill(); } catch { /* 已退 */ } }
                    var deadline = DateTime.Now.AddSeconds(20);
                    while (Process.GetProcessesByName("SnapNoteApp").Length > 0 && DateTime.Now < deadline)
                        Thread.Sleep(300);
                    if (Process.GetProcessesByName("SnapNoteApp").Length > 0)
                        throw new Exception("SnapNote 进程 20 秒内未能退出（杀软拦截？请手动退出后重试）");
                    L("已退出");
                }
                else L("SnapNote 未在运行（直接升级）");

                // 2) 解压 data.zip 到临时目录
                string work = Path.Combine(Path.GetTempPath(), "snapnote-upg-" + Guid.NewGuid().ToString("N").Substring(0, 8));
                L("解压升级包…");
                ZipFile.ExtractToDirectory(dataZip, work);

                // 3) 定位版本目录 app-x.y.z
                var appDirEnt = Directory.GetDirectories(work, "app-*")
                    .OrderByDescending(d => ParseVer(Path.GetFileName(d))).FirstOrDefault();
                if (appDirEnt == null) throw new Exception("升级包内未找到版本目录（app-x.y.z）——包结构不符");
                string verName = Path.GetFileName(appDirEnt);
                string ver = verName.Substring(4);
                L("升级到 v" + ver);

                // 4) 放置版本目录（已存在则删——进程已杀无锁；删失败退避重试防杀软扫描锁）
                string dst = Path.Combine(appRoot, verName);
                if (Directory.Exists(dst)) RmDirRetry(dst, L);
                MoveDirRetry(appDirEnt, dst, L);
                if (!File.Exists(Path.Combine(dst, "SnapNoteApp.exe")))
                    throw new Exception("新版本目录校验失败（缺 SnapNoteApp.exe）");

                // 5) 更新根启动器（先删后拷，10KB 无锁问题）
                string srcLauncher = Path.Combine(work, "SnapNote.exe");
                if (File.Exists(srcLauncher))
                {
                    string dstLauncher = Path.Combine(appRoot, "SnapNote.exe");
                    if (File.Exists(dstLauncher)) File.Delete(dstLauncher);
                    File.Copy(srcLauncher, dstLauncher, true);
                }

                // 6) 翻指针（保留旧 current 为 previous——回滚能力不丢）
                string old = ReadCurrent(appRoot);
                string json = "{\"current\":\"" + verName + "\",\"previous\":" 
                    + (old != null ? "\"" + old + "\"" : "null") + "}";
                string chPath = Path.Combine(appRoot, "channels.json");
                File.WriteAllText(chPath + ".tmp", json + Environment.NewLine, Encoding.UTF8);
                if (File.Exists(chPath)) File.Delete(chPath);
                File.Move(chPath + ".tmp", chPath);
                L("指针已翻转：" + verName + "（上一版：" + (old ?? "无") + "）");

                // 7) 清理升级残留 + 临时目录
                try { Directory.Delete(Path.Combine(appRoot, ".update-work"), true); } catch { /* 应用内更新残留，尽力清 */ }
                try { Directory.Delete(work, true); } catch { /* 临时目录，系统自清 */ }

                // 8) 重启软件
                L("启动 SnapNote…");
                Process.Start(new ProcessStartInfo
                {
                    FileName = Path.Combine(appRoot, "SnapNote.exe"),
                    WorkingDirectory = appRoot,
                    UseShellExecute = true,
                });
                L("✓ 升级完成，已启动 v" + ver);
                WriteResult("OK v" + ver + " (from " + (old ?? "clean") + ")");
                return 0;
            }
            catch (Exception ex)
            {
                L("✕ 升级失败：" + ex.Message);
                L("（旧版本未受影响，可重新打开软件继续使用；"
                  + "本日志已保存：" + logFile + "）");
                WriteResult("FAIL " + ex.Message);
                return 1;
            }
        }

        // ---------------- 工具方法 ----------------
        static string AppDir() { return Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName); }

        static string ResolveInstallDir(string dirArg, Action<string> L)
        {
            // 1) 显式参数（e2e/高级用户）
            if (!string.IsNullOrEmpty(dirArg) && File.Exists(Path.Combine(dirArg, "channels.json")))
                return dirArg;
            // 2) 主程序自报的位置（v1.6.3 起每次启动写入）
            string loc = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SnapNote", "install-location.txt");
            if (File.Exists(loc))
            {
                string p = File.ReadAllText(loc, Encoding.UTF8).Trim();
                if (File.Exists(Path.Combine(p, "channels.json"))) { L("（位置来自应用自报：" + p + "）"); return p; }
            }
            // 3) UI 手选一次并记住（记录到 location 文件，下次免选）
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择 SnapNote 的安装目录（包含 SnapNote.exe 和 app-x.y.z 子目录的那个文件夹）";
                dlg.ShowNewFolderButton = false;
                if (dlg.ShowDialog() != DialogResult.OK) return null;
                if (!File.Exists(Path.Combine(dlg.SelectedPath, "channels.json")))
                {
                    MessageBox.Show("所选目录不像 SnapNote 安装目录（未找到 channels.json），升级未执行。",
                        "SnapNote 升级器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return null;
                }
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(loc));
                    File.WriteAllText(loc, dlg.SelectedPath + Environment.NewLine, Encoding.UTF8);
                } catch { /* 记不住不影响本次 */ }
                return dlg.SelectedPath;
            }
        }

        static int[] ParseVer(string name)
        {
            var m = Regex.Match(name, @"^app-(\d+)\.(\d+)\.(\d+)");
            if (!m.Success) return new[] { 0, 0, 0 };
            return new[] { int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value) };
        }

        static string ReadCurrent(string appRoot)
        {
            try
            {
                string json = File.ReadAllText(Path.Combine(appRoot, "channels.json"), Encoding.UTF8);
                var m = Regex.Match(json, "\"current\"\\s*:\\s*\"([^\"]+)\"");
                return m.Success ? m.Groups[1].Value : null;
            }
            catch { return null; }
        }

        static void RmDirRetry(string dir, Action<string> L)
        {
            for (int i = 0; ; i++)
            {
                try { Directory.Delete(dir, true); return; }
                catch (Exception e) when (i < 4 && (e is IOException || e is UnauthorizedAccessException))
                { L("（目录被占用，" + (i + 1) * 2 + " 秒后重试：" + e.Message + "）"); Thread.Sleep((i + 1) * 2000); }
            }
        }

        static void MoveDirRetry(string src, string dst, Action<string> L)
        {
            // 跨卷（临时目录常在 C:，用户可装在 E:）Directory.Move 必抛——降级递归拷贝
            string srcRoot = Path.GetPathRoot(Path.GetFullPath(src));
            string dstRoot = Path.GetPathRoot(Path.GetFullPath(dst));
            if (!string.Equals(srcRoot, dstRoot, StringComparison.OrdinalIgnoreCase))
            {
                L("（跨磁盘卷，改用复制模式：C: → " + dstRoot + "）");
                CopyDirRetry(src, dst, L);
                try { Directory.Delete(src, true); } catch { /* 临时目录，系统自清 */ }
                return;
            }
            for (int i = 0; ; i++)
            {
                try { Directory.Move(src, dst); return; }
                catch (Exception e) when (i < 4 && (e is IOException || e is UnauthorizedAccessException))
                { L("（挪移受阻（杀软扫描锁常见），" + (i + 1) * 2 + " 秒后重试）"); Thread.Sleep((i + 1) * 2000); }
            }
        }

        static void CopyDirRetry(string src, string dst, Action<string> L)
        {
            for (int i = 0; ; i++)
            {
                try { CopyDir(src, dst); return; }
                catch (Exception e) when (i < 3 && (e is IOException || e is UnauthorizedAccessException))
                { L("（复制受阻（杀软扫描锁常见），" + (i + 1) * 2 + " 秒后重试）"); Thread.Sleep((i + 1) * 2000); }
            }
        }

        static void CopyDir(string src, string dst)
        {
            Directory.CreateDirectory(dst);
            foreach (string f in Directory.GetFiles(src))
                File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);
            foreach (string d in Directory.GetDirectories(src))
                CopyDir(d, Path.Combine(dst, Path.GetFileName(d)));
        }
    }

    // ---------------- UI ----------------
    internal class UpgForm : Form
    {
        readonly TextBox _log = new TextBox();
        readonly Label _status = new Label();
        readonly Button _close = new Button();
        Thread _worker;
        public static int ExitCode = 0;

        public UpgForm(string dirArg)
        {
            Text = "SnapNote 升级器";
            Width = 560; Height = 420;
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            Font = new System.Drawing.Font("Microsoft YaHei", 9.75F);

            _status.Dock = DockStyle.Top; _status.Height = 58;
            _status.TextAlign = System.Drawing.ContentAlignment.MiddleLeft;
            _status.Padding = new Padding(14, 0, 14, 0);
            _status.Text = "准备升级…（升级器会自动关闭并重启 SnapNote）";
            _status.Font = new System.Drawing.Font("Microsoft YaHei", 12F, System.Drawing.FontStyle.Bold);
            Controls.Add(_status);

            _log.Dock = DockStyle.Fill; _log.Multiline = true; _log.ReadOnly = true;
            _log.ScrollBars = ScrollBars.Vertical; _log.BackColor = System.Drawing.Color.FromArgb(250, 248, 242);
            _log.Font = new System.Drawing.Font("Consolas", 9F);
            Controls.Add(_log);

            _close.Dock = DockStyle.Bottom; _close.Height = 44; _close.Text = "关闭";
            _close.Enabled = false; _close.Click += (s, e) => Close();
            Controls.Add(_close);

            _worker = new Thread(() =>
            {
                ExitCode = Program.RunUpgrade(dirArg, m => AppendLog(m));
                Invoke(new Action(() =>
                {
                    _close.Enabled = true;
                    _status.ForeColor = ExitCode == 0 ? System.Drawing.Color.FromArgb(24, 122, 55)
                                                      : System.Drawing.Color.FromArgb(176, 32, 32);
                    _status.Text = ExitCode == 0 ? "✓ 升级完成，SnapNote 已启动"
                                                 : "✕ 升级未完成（旧版本不受影响，详见日志）";
                }));
            });
            _worker.IsBackground = true;
        }

        void AppendLog(string m)
        {
            Invoke(new Action(() =>
            {
                _log.AppendText(m + Environment.NewLine);
            }));
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            _worker.Start();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!_close.Enabled) { e.Cancel = true; return; } // 升级中不许关（防半途杀流程）
            base.OnFormClosing(e);
        }
    }
}
