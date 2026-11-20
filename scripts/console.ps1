# The Venes helper's hands on Windows, where there's no tmux: it types into a console and reads its
# screen for the helper, which asks over this script's standard input, a line of JSON at a time, and is
# answered the same way. A console is any process's that's in it, by that process's id.
#
# Windows lets a process attach to another's console, write key presses into its input and read the
# characters on its screen. That's all this does, and it can only be done from the same desktop session
# the console is in, which is where Claude Code starts the helper.
$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies "System.Web.Extensions" -TypeDefinition @"
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

public static class VenesConsole {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct SCREEN_INFO { public COORD Size; public COORD Cursor; public ushort Attributes; public SMALL_RECT Window; public COORD Largest; }
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] public struct KEY_EVENT {
    [FieldOffset(0)] public int Down; [FieldOffset(4)] public ushort Repeat; [FieldOffset(6)] public ushort Key;
    [FieldOffset(8)] public ushort Scan; [FieldOffset(10)] public char Char; [FieldOffset(12)] public uint State; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT_RECORD { [FieldOffset(0)] public ushort Type; [FieldOffset(4)] public KEY_EVENT KeyEvent; }
  [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] public struct CHAR_INFO { [FieldOffset(0)] public char Char; [FieldOffset(2)] public ushort Attributes; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFO { public IntPtr Reserved1; public IntPtr Peb; public IntPtr Reserved2a; public IntPtr Reserved2b; public IntPtr Id; public IntPtr Parent; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint id);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool WriteConsoleInputW(IntPtr input, INPUT_RECORD[] records, uint count, out uint written);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputW(IntPtr output, [Out] CHAR_INFO[] cells, COORD size, COORD at, ref SMALL_RECT region);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr output, out SCREEN_INFO info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList([Out] uint[] ids, uint count);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int what, ref PROCESS_INFO info, int size, out int used);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  static readonly IntPtr Invalid = new IntPtr(-1);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  // The console each process asked about turned out to be reached through: itself, or the one that started it.
  static readonly Dictionary<int, int> Reached = new Dictionary<int, int>();
  // What Claude Code runs as, and what stands between it and a hook: a hook's own process has no console.
  static readonly HashSet<string> Programs = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "claude", "node", "codex", "agy", "antigravity" };
  const int Climb = 6;
  const int RowsAtOnce = 24;
  const int RecordsAtOnce = 256;

  class Failure : Exception { public string Code; public Failure(string code, string message) : base(message) { Code = code; } }

  public static void Serve() {
    // What this process is asked through, answers through and complains through stays its own: a program
    // it starts is handed every handle that can be handed on, and these no longer can.
    foreach (int which in new int[] { -10, -11, -12 }) { IntPtr handle = GetStdHandle(which); if (handle != IntPtr.Zero && handle != Invalid) SetHandleInformation(handle, 1, 0); }
    Stream output = Console.OpenStandardOutput();
    StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    Json.MaxJsonLength = 64 * 1024 * 1024;
    Dictionary<string, object> hello = new Dictionary<string, object>(); hello["ready"] = true; hello["pid"] = Process.GetCurrentProcess().Id;
    Say(output, hello);
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Length == 0) continue;
      Dictionary<string, object> reply = new Dictionary<string, object>();
      try {
        Dictionary<string, object> ask = Json.Deserialize<Dictionary<string, object>>(line);
        if (ask.ContainsKey("id")) reply["id"] = ask["id"];
        Answer(ask, reply);
      } catch (Failure failure) {
        reply["error"] = failure.Message; reply["code"] = failure.Code;
      } catch (Exception error) {
        reply["error"] = error.Message; reply["code"] = "failed";
      }
      Say(output, reply);
    }
  }

  static void Say(Stream output, Dictionary<string, object> value) {
    byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value) + "\n");
    output.Write(bytes, 0, bytes.Length); output.Flush();
  }

  static int Number(Dictionary<string, object> ask, string name) {
    if (!ask.ContainsKey(name) || ask[name] == null) throw new Failure("bad_request", name + " is missing");
    return Convert.ToInt32(ask[name]);
  }

  static void Answer(Dictionary<string, object> ask, Dictionary<string, object> reply) {
    string op = ask.ContainsKey("op") ? Convert.ToString(ask["op"]) : "";
    if (op == "read") { Attach(Number(ask, "pid"), reply, false); try { Read(reply); } finally { FreeConsole(); } }
    else if (op == "write") { Attach(Number(ask, "pid"), reply, false); try { Write((ArrayList)ask["records"], reply); } finally { FreeConsole(); } }
    else if (op == "list") { Attach(Number(ask, "pid"), reply, false); try { List(reply); } finally { FreeConsole(); } }
    else if (op == "alive") Alive((ArrayList)ask["pids"], reply);
    else if (op == "running") Running(reply);
    else if (op == "where") { Attach(Number(ask, "pid"), reply, true); FreeConsole(); }
    else if (op == "start") Start(ask, reply);
    else if (op == "stop") Stop(Number(ask, "pid"), reply);
    else throw new Failure("bad_request", "no such thing to do: " + op);
  }

  static string NameOf(int id) {
    try { return Process.GetProcessById(id).ProcessName; } catch (Exception) { return null; }
  }

  static int ParentOf(int id) {
    IntPtr process = OpenProcess(0x1000, false, (uint)id);
    if (process == IntPtr.Zero) return 0;
    try {
      PROCESS_INFO info = new PROCESS_INFO(); int used;
      return NtQueryInformationProcess(process, 0, ref info, Marshal.SizeOf(typeof(PROCESS_INFO)), out used) == 0 ? info.Parent.ToInt32() : 0;
    } finally { CloseHandle(process); }
  }

  // The process whose console is meant by one that's named: itself when it's a program that runs in
  // one, or else the nearest such above it. A hook says only who started it, which can be a shell Claude
  // Code runs it through, hidden, with a console of its own that nothing is ever shown in.
  static int ProgramOf(int id) {
    if (Reached.ContainsKey(id) && NameOf(Reached[id]) != null) return Reached[id];
    int at = id;
    for (int step = 0; step < Climb && at > 4; step++) {
      string name = NameOf(at);
      if (name == null) break;
      if (Programs.Contains(name)) { Reached[id] = at; return at; }
      at = ParentOf(at);
    }
    return id;
  }

  // To the console a process is in. One named by a hook is the program's that ran the hook (`climb`):
  // any other is the very process named, as one started from here is.
  static void Attach(int id, Dictionary<string, object> reply, bool climb) {
    FreeConsole();
    int at = climb ? ProgramOf(id) : id;
    string name = NameOf(at);
    if (name == null) throw new Failure("gone", "that process has gone");
    if (!AttachConsole((uint)at)) {
      int error = Marshal.GetLastWin32Error();
      // Not allowed is an answer: its console is in another Windows session than this, or another account's.
      if (error == 5) throw new Failure("out_of_reach", "that console is in another Windows session than the helper");
      throw new Failure("no_console", "that process has no console (" + error + ")");
    }
    reply["pid"] = at; reply["program"] = name;
  }

  // Every process of a program that runs in a console, for telling which consoles are still there.
  static void Running(Dictionary<string, object> reply) {
    List<object> found = new List<object>();
    foreach (Process each in Process.GetProcesses()) {
      try { if (Programs.Contains(each.ProcessName)) found.Add(each.Id); } catch (Exception) { } finally { each.Dispose(); }
    }
    reply["pids"] = found;
  }

  static IntPtr Open(string name) {
    IntPtr handle = CreateFileW(name, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (handle == Invalid) throw new Failure("failed", name + " wouldn't open (" + Marshal.GetLastWin32Error() + ")");
    return handle;
  }

  // The window's rows, each as its text and the attributes of its cells in runs: how many cells, then
  // which attributes. A wide letter's second cell is left out, so that a cell is a letter.
  static void Read(Dictionary<string, object> reply) {
    IntPtr output = Open("CONOUT$");
    try {
      SCREEN_INFO info;
      if (!GetConsoleScreenBufferInfo(output, out info)) throw new Failure("failed", "the screen couldn't be read (" + Marshal.GetLastWin32Error() + ")");
      int width = info.Window.Right - info.Window.Left + 1;
      List<object> rows = new List<object>();
      for (int top = info.Window.Top; top <= info.Window.Bottom; top += RowsAtOnce) {
        int bottom = Math.Min(top + RowsAtOnce - 1, info.Window.Bottom); int height = bottom - top + 1;
        CHAR_INFO[] cells = new CHAR_INFO[width * height];
        COORD size = new COORD(); size.X = (short)width; size.Y = (short)height; COORD at = new COORD();
        SMALL_RECT region = new SMALL_RECT(); region.Left = info.Window.Left; region.Right = info.Window.Right; region.Top = (short)top; region.Bottom = (short)bottom;
        if (!ReadConsoleOutputW(output, cells, size, at, ref region)) throw new Failure("failed", "the screen couldn't be read (" + Marshal.GetLastWin32Error() + ")");
        for (int y = 0; y < height; y++) {
          StringBuilder text = new StringBuilder(); List<object> runs = new List<object>(); int count = 0; int current = -1;
          for (int x = 0; x < width; x++) {
            CHAR_INFO cell = cells[y * width + x];
            if ((cell.Attributes & 0x200) != 0) continue;
            int attributes = cell.Attributes & 0xC0FF;
            if (attributes != current) { if (count > 0) { runs.Add(count); runs.Add(current); } current = attributes; count = 0; }
            text.Append(cell.Char == (char)0 ? ' ' : cell.Char); count++;
          }
          if (count > 0) { runs.Add(count); runs.Add(current); }
          Dictionary<string, object> row = new Dictionary<string, object>(); row["text"] = text.ToString(); row["runs"] = runs; rows.Add(row);
        }
      }
      reply["rows"] = rows; reply["columns"] = width;
      reply["cursor"] = new int[] { info.Cursor.X - info.Window.Left, info.Cursor.Y - info.Window.Top };
    } finally { CloseHandle(output); }
  }

  // Key presses, each a key going down and coming up: its virtual key, its letter, and the keys held with it.
  static void Write(ArrayList records, Dictionary<string, object> reply) {
    IntPtr input = Open("CONIN$");
    try {
      List<INPUT_RECORD> made = new List<INPUT_RECORD>();
      foreach (object each in records) {
        ArrayList one = (ArrayList)each;
        for (int down = 1; down >= 0; down--) {
          INPUT_RECORD record = new INPUT_RECORD(); record.Type = 1;
          record.KeyEvent.Down = down; record.KeyEvent.Repeat = 1; record.KeyEvent.Key = Convert.ToUInt16(one[0]);
          record.KeyEvent.Char = (char)Convert.ToInt32(one[1]); record.KeyEvent.State = Convert.ToUInt32(one[2]);
          made.Add(record);
        }
      }
      int sent = 0;
      while (sent < made.Count) {
        INPUT_RECORD[] part = made.GetRange(sent, Math.Min(RecordsAtOnce, made.Count - sent)).ToArray(); uint written;
        if (!WriteConsoleInputW(input, part, (uint)part.Length, out written) || written == 0) throw new Failure("failed", "the keys weren't taken (" + Marshal.GetLastWin32Error() + ")");
        sent += (int)written;
      }
      reply["written"] = sent / 2;
    } finally { CloseHandle(input); }
  }

  // What runs in the console, the newest first, which is what's in front of whoever sits at it.
  static void List(Dictionary<string, object> reply) {
    uint[] ids = new uint[64]; uint count = GetConsoleProcessList(ids, (uint)ids.Length);
    int own = Process.GetCurrentProcess().Id; List<object> found = new List<object>();
    for (int at = 0; at < Math.Min(count, (uint)ids.Length); at++) {
      if (ids[at] == own) continue;
      string name = NameOf((int)ids[at]); if (name == null) continue;
      Dictionary<string, object> one = new Dictionary<string, object>(); one["pid"] = (int)ids[at]; one["name"] = name; found.Add(one);
    }
    reply["processes"] = found;
  }

  static void Alive(ArrayList ids, Dictionary<string, object> reply) {
    List<object> found = new List<object>();
    foreach (object each in ids) {
      int id = Convert.ToInt32(each); string name = NameOf(id);
      if (name == null) continue;
      Dictionary<string, object> one = new Dictionary<string, object>(); one["pid"] = id; one["name"] = name; found.Add(one);
    }
    reply["processes"] = found;
  }

  // An argument as a command line carries it, by the rules a program's own start-up reads one with.
  static string Quoted(string argument) {
    if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return argument;
    StringBuilder quoted = new StringBuilder("\""); int slashes = 0;
    foreach (char letter in argument) {
      if (letter == '\\') { slashes++; continue; }
      if (letter == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append('"'); }
      else { quoted.Append('\\', slashes); quoted.Append(letter); }
      slashes = 0;
    }
    quoted.Append('\\', slashes * 2); quoted.Append('"');
    return quoted.ToString();
  }

  // A program in a console of its own, on the desktop: this process has none to hand down, so Windows
  // makes one, in the terminal the reader has it open consoles in. It's handed none of this process's
  // own ways in and out either, which were closed to it when this started (see Serve): with them it
  // would hold the helper's way to this process open after this had gone.
  static void Start(Dictionary<string, object> ask, Dictionary<string, object> reply) {
    ProcessStartInfo how = new ProcessStartInfo();
    how.FileName = Convert.ToString(ask["file"]); how.UseShellExecute = false; how.CreateNoWindow = false;
    List<string> arguments = new List<string>();
    if (ask.ContainsKey("args") && ask["args"] != null) foreach (object each in (ArrayList)ask["args"]) arguments.Add(Quoted(Convert.ToString(each)));
    how.Arguments = String.Join(" ", arguments.ToArray());
    if (ask.ContainsKey("cwd") && ask["cwd"] != null) how.WorkingDirectory = Convert.ToString(ask["cwd"]);
    if (ask.ContainsKey("env") && ask["env"] != null) foreach (KeyValuePair<string, object> each in (Dictionary<string, object>)ask["env"]) how.EnvironmentVariables[each.Key] = Convert.ToString(each.Value);
    FreeConsole();
    try {
      using (Process made = Process.Start(how)) { reply["pid"] = made.Id; }
    } catch (Exception error) {
      throw new Failure("start_failed", error.Message);
    }
  }

  // A program and whatever it started, ended.
  static void Stop(int id, Dictionary<string, object> reply) {
    ProcessStartInfo how = new ProcessStartInfo("taskkill.exe", "/PID " + id + " /T /F");
    how.UseShellExecute = false; how.CreateNoWindow = true;
    using (Process ending = Process.Start(how)) { ending.WaitForExit(10000); reply["stopped"] = ending.HasExited && ending.ExitCode == 0; }
  }
}
"@
[VenesConsole]::Serve()
