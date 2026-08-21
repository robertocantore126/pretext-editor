// Tiny launcher: opens a console window and runs run-dev.bat, which starts the
// dev server. Compiled with /win32icon so the file carries the editor icon.
// Rebuild: C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /win32icon:icon.ico /out:Pretext-Editor.exe launcher.cs
using System;
using System.Diagnostics;
using System.IO;

static class Launcher
{
    static int Main()
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string bat = Path.Combine(dir, "run-dev.bat");
        if (!File.Exists(bat))
        {
            Console.Error.WriteLine("run-dev.bat non trovato accanto a questo programma.");
            if (!Console.IsInputRedirected)
            {
                Console.WriteLine("Premi un tasto per chiudere...");
                Console.ReadKey();
            }
            return 1;
        }
        using (Process p = Process.Start(new ProcessStartInfo("cmd.exe", "/c \"" + bat + "\"") { UseShellExecute = false }))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}
