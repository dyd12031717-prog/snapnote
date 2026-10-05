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
        static readonly Encoding NoBom = new UTF8Encoding(false); // UTF-8 无 BOM：写 JSON/配置一律用它（Node JSON.parse 对 BOM 敏感）
        static string _logFile; // %AppData%\SnapNote\logs\upgrader-<日期>.log（v1.6.4：动作留痕）

        /// 升级器自身日志：Main 第一行即初始化（早于一切逻辑——
        /// 「双击无反应」必须能从此日志判定：进程起没起、死在第几步）
        static void Log0(string m)
        {
            try
            {
                if (_logFile == null)
                {
                    string dir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SnapNote", "logs");
                    Directory.CreateDirectory(dir);
                    _logFile = Path.Combine(dir, "upgrader-" + DateTime.Now.ToString("yyyyMMdd") + ".log");
                }
                File.AppendAllText(_logFile,
                    DateTime.Now.ToString("s") + " " + m + Environment.NewLine, NoBom);
            }
            catch { /* 日志尽力而为，绝不影响主流程 */ }
        }

        [STAThread]
        static int Main(string[] args)
        {
            Log0("=== 升级器启动 | OS=" + Environment.OSVersion.VersionString
                + " | args=" + string.Join(" ", args));
            // 兜底：任何未捕获异常先落日志再可见（启动即崩也能定位到行）
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
            {
                Log0("!!! 未捕获异常：" + (e.ExceptionObject is Exception ? ((Exception)e.ExceptionObject).Message + " @ " + ((Exception)e.ExceptionObject).StackTrace : Convert.ToString(e.ExceptionObject)));
                try
                {
                    MessageBox.Show("升级器遇到错误，日志已保存：\n" + _logFile,
                        "SnapNote 升级器", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                catch { /* 无 UI 环境尽力 */ }
            };
            Application.ThreadException += delegate(object s, System.Threading.ThreadExceptionEventArgs e)
            {
                Log0("!!! UI 线程异常：" + e.Exception.Message + " @ " + e.Exception.StackTrace);
            };
            try { Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException); }
            catch { /* 老框架兜底失败忽略 */ }

            bool e2e = args.Any(a => a == "--e2e");
            string dirArgRaw = args.FirstOrDefault(a => a.StartsWith("--dir="));
            string dirArg = dirArgRaw == null ? null : dirArgRaw.Substring(6);
            if (e2e)
            {
                try { return RunUpgrade(dirArg, null, null); }
                catch (Exception ex) { Log0("UPGRADER_FAIL: " + ex.Message); return 1; }
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new UpgForm(dirArg));
            Log0("=== 退出 code=" + UpgForm.ExitCode);
            return UpgForm.ExitCode;
        }

        // ---------------- 升级主流程（UI 与 e2e 共用） ----------------
        // askDir：目录手选回调（UI 线程弹 FolderBrowserDialog——worker 是 MTA 线程，
        // 直接弹对话框会抛 ThreadStateException，必须由 UI 层 Invoke 回主线程；e2e 传 null）
        public static int RunUpgrade(string dirArg, Action<string> log, Func<string> askDir)
        {
            Action<string> L = delegate(string m) { if (log != null) log(m); Console.WriteLine(m); Log0(m); };
            string appRoot = ResolveInstallDir(dirArg, L, askDir);
            if (appRoot == null) { L("✕ 未找到 SnapNote 安装目录"); return 2; }
            L("安装目录：" + appRoot);

            // v1.6.4 SFX：单文件升级包——数据嵌在 exe 尾部，运行时自提取
            string dataZip = Path.Combine(AppDir(), "data.zip");
            bool fromBundled = false;
            if (!File.Exists(dataZip))
            {
                dataZip = ExtractBundledZip(L);
                fromBundled = dataZip != null;
                if (fromBundled) L("升级数据：内置（单文件模式）");
            }
            else L("升级数据：同目录 data.zip");
            if (dataZip == null || !File.Exists(dataZip))
            { L("✕ 升级数据缺失（exe 未内嵌且同目录无 data.zip——文件损坏或被杀软改动？）"); return 3; }

            string logFile = Path.Combine(appRoot, ".update-work", "upgrader-log.txt");
            try { Directory.CreateDirectory(Path.GetDirectoryName(logFile)); } catch { /* 忽略 */ }

            Func<string, int> WriteResult = delegate(string tail)
            {
                // 步骤 7 会删 .update-work 残留——结尾落盘前必须重建目录
                // （否则 AppendAllText 抛 DirectoryNotFoundException 被吞，日志丢失）
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(logFile));
                    File.AppendAllText(logFile, DateTime.Now.ToString("s") + " " + tail + Environment.NewLine, NoBom);
                }
                catch { /* 尽力 */ }
                return 0;
            };

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
                File.WriteAllText(chPath + ".tmp", json + Environment.NewLine, NoBom); // 无 BOM：Node JSON.parse 对 BOM 敏感
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
                if (fromBundled) { try { File.Delete(dataZip); } catch { /* 临时自提取文件 */ } }
                return 0;
            }
            catch (Exception ex)
            {
                L("✕ 升级失败：" + ex.Message);
                L("（旧版本未受影响，可重新打开软件继续使用；"
                  + "本日志已保存：" + logFile + "）");
                WriteResult("FAIL " + ex.Message);
                if (fromBundled) { try { File.Delete(dataZip); } catch { /* */ } }
                return 1;
            }
        }

        // ---------------- 工具方法 ----------------
        static string AppDir() { return Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName); }

        /// <summary>
        /// v1.6.4 SFX 自提取：升级数据 zip 拼接在本 exe 尾部（cat exe + zip）。
        /// 从自身文件尾部向上找 zip 的 EOCD 记录（PK\x05\x06，注释区最大 65535+22），
        /// 由 EOCD 的 CD 大小/偏移反推 zip 起点（校验 PK\x03\x04），整段切到临时文件。
        /// 找不到返回 null（纯 exe 无数据——同伴 data.zip 逻辑的前置）。
        /// </summary>
        static string ExtractBundledZip(Action<string> L)
        {
            string self;
            try { self = Process.GetCurrentProcess().MainModule.FileName; }
            catch { return null; }
            using (FileStream fs = File.OpenRead(self))
            {
                long size = fs.Length;
                if (size < 200) return null;
                long window = Math.Min(size, 70000);
                fs.Seek(size - window, SeekOrigin.Begin);
                byte[] tail = new byte[window];
                int got = 0;
                while (got < window) { int n = fs.Read(tail, got, (int)window - got); if (n <= 0) break; got += n; }
                if (got < window) return null;

                int eocd = -1;
                for (int i = (int)window - 22; i >= 0; i--)
                {
                    if (tail[i] == 0x50 && tail[i + 1] == 0x4B && tail[i + 2] == 0x05 && tail[i + 3] == 0x06) { eocd = i; break; }
                }
                if (eocd < 0) { L("（未检测到内置数据：尾部无 zip EOCD）"); return null; }

                int commentLen = tail[eocd + 20] | (tail[eocd + 21] << 8);
                uint cdSize = BitConverter.ToUInt32(tail, eocd + 12);
                uint cdOffset = BitConverter.ToUInt32(tail, eocd + 16);
                long zipEnd = (size - window) + eocd + 22 + commentLen;
                long zipStart = (size - window) + eocd - cdSize - cdOffset;
                if (zipStart < 0 || zipEnd > size) { L("（内置数据区段越界）"); return null; }

                // zip 起点必须是 local file header（PK\x03\x04）
                fs.Seek(zipStart, SeekOrigin.Begin);
                byte[] magic = new byte[4];
                if (fs.Read(magic, 0, 4) != 4
                    || magic[0] != 0x50 || magic[1] != 0x4B || magic[2] != 0x03 || magic[3] != 0x04)
                { L("（内置数据起点校验失败）"); return null; }

                string tmpZip = Path.Combine(Path.GetTempPath(),
                    "snapnote-sfx-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".zip");
                fs.Seek(zipStart, SeekOrigin.Begin);
                using (FileStream outFs = File.Create(tmpZip))
                {
                    byte[] buf = new byte[1 << 20];
                    long left = zipEnd - zipStart;
                    while (left > 0)
                    {
                        int n = fs.Read(buf, 0, (int)Math.Min(buf.Length, left));
                        if (n <= 0) break;
                        outFs.Write(buf, 0, n);
                        left -= n;
                    }
                }
                if (new FileInfo(tmpZip).Length != zipEnd - zipStart)
                { L("（内置数据提取不完整）"); try { File.Delete(tmpZip); } catch { } return null; }
                return tmpZip;
            }
        }

        static string ResolveInstallDir(string dirArg, Action<string> L, Func<string> askDir)
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
            // 3) 手选一次并记住（v1.6.4：经 askDir 回 UI 线程弹框——worker 是 MTA，
            //    此前直接在 worker 弹 FolderBrowserDialog 抛 ThreadStateException）
            if (askDir == null) return null; // e2e/无 UI：不手选，直接判定失败
            string picked = askDir();
            if (picked == null) return null;
            if (!File.Exists(Path.Combine(picked, "channels.json")))
            {
                MessageBox.Show("所选目录不像 SnapNote 安装目录（未找到 channels.json），升级未执行。",
                    "SnapNote 升级器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return null;
            }
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(loc));
                File.WriteAllText(loc, picked + Environment.NewLine, NoBom);
            }
            catch { /* 记不住不影响本次 */ }
            return picked;
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
                catch (Exception e)
                {
                    if (i >= 4 || !(e is IOException || e is UnauthorizedAccessException)) throw;
                    L("（目录被占用，" + (i + 1) * 2 + " 秒后重试：" + e.Message + "）");
                    Thread.Sleep((i + 1) * 2000);
                }
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
                catch (Exception e)
                {
                    if (i >= 4 || !(e is IOException || e is UnauthorizedAccessException)) throw;
                    L("（挪移受阻（杀软扫描锁常见），" + (i + 1) * 2 + " 秒后重试）");
                    Thread.Sleep((i + 1) * 2000);
                }
            }
        }

        static void CopyDirRetry(string src, string dst, Action<string> L)
        {
            for (int i = 0; ; i++)
            {
                try { CopyDir(src, dst); return; }
                catch (Exception e)
                {
                    if (i >= 3 || !(e is IOException || e is UnauthorizedAccessException)) throw;
                    L("（复制受阻（杀软扫描锁常见），" + (i + 1) * 2 + " 秒后重试）");
                    Thread.Sleep((i + 1) * 2000);
                }
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
                ExitCode = Program.RunUpgrade(dirArg, m => AppendLog(m), AskDir);
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

        /// 目录手选（v1.6.4 线程修复）：worker（MTA）不能直接弹 FolderBrowserDialog，
        /// Invoke 回 UI 主线程（STA）执行；返回 null=取消。
        string AskDir()
        {
            string picked = null;
            Invoke(new Action(delegate
            {
                using (FolderBrowserDialog dlg = new FolderBrowserDialog())
                {
                    dlg.Description = "选择 SnapNote 的安装目录（包含 SnapNote.exe 和 app-x.y.z 子目录的那个文件夹）";
                    dlg.ShowNewFolderButton = false;
                    if (dlg.ShowDialog(this) == DialogResult.OK) picked = dlg.SelectedPath;
                }
            }));
            return picked;
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
