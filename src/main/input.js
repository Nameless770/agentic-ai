'use strict';

// Real mouse and keyboard input on Windows. A small hidden PowerShell process
// calls the Windows SendInput API; it only understands a fixed set of commands
// (move, click, scroll, type, keys), so nothing the model says can run code.
// Coordinates are physical screen pixels.

const { spawn } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class BuddyInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  static void PhysicalPixels() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new Exception("Windows blocked the input (error " + Marshal.GetLastWin32Error() + ").");
  }

  static INPUT Mouse(uint flags, int data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i;
  }

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
  }

  static bool Extended(int vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90 || vk == 0x2C;
  }

  public static string Cursor() { PhysicalPixels(); POINT p; GetCursorPos(out p); return p.X + "," + p.Y; }

  public static void Move(int x, int y) { PhysicalPixels(); SetCursorPos(x, y); }

  public static void Click(int x, int y, string button, int count) {
    PhysicalPixels();
    SetCursorPos(x, y);
    Thread.Sleep(80);
    uint down = 0x02, up = 0x04;
    if (button == "right") { down = 0x08; up = 0x10; }
    else if (button == "middle") { down = 0x20; up = 0x40; }
    for (int n = 0; n < count; n++) {
      Send(new INPUT[] { Mouse(down, 0), Mouse(up, 0) });
      Thread.Sleep(60);
    }
  }

  public static void Scroll(int x, int y, int notches) {
    PhysicalPixels();
    SetCursorPos(x, y);
    Thread.Sleep(60);
    Send(new INPUT[] { Mouse(0x0800, notches * 120) });
  }

  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') Keys(new int[] { 0x0D });
      else if (c == '\t') Keys(new int[] { 0x09 });
      else Send(new INPUT[] { Key(0, c, 0x4), Key(0, c, 0x4 | 0x2) });
      Thread.Sleep(6);
    }
  }

  public static void Keys(int[] vks) {
    List<INPUT> list = new List<INPUT>();
    foreach (int vk in vks) list.Add(Key((ushort)vk, 0, Extended(vk) ? 0x1u : 0u));
    for (int i = vks.Length - 1; i >= 0; i--) list.Add(Key((ushort)vks[i], 0, 0x2u | (Extended(vks[i]) ? 0x1u : 0u)));
    Send(list.ToArray());
  }
}
'@
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $id = 0
  try {
    $cmd = $line | ConvertFrom-Json
    $id = $cmd.id
    $result = $null
    switch ($cmd.op) {
      'cursor' { $result = [BuddyInput]::Cursor() }
      'move'   { [BuddyInput]::Move([int]$cmd.x, [int]$cmd.y) }
      'click'  { [BuddyInput]::Click([int]$cmd.x, [int]$cmd.y, [string]$cmd.button, [int]$cmd.count) }
      'scroll' { [BuddyInput]::Scroll([int]$cmd.x, [int]$cmd.y, [int]$cmd.notches) }
      'type'   { [BuddyInput]::Type([string]$cmd.text) }
      'keys'   { [BuddyInput]::Keys([int[]]@($cmd.vks)) }
      default  { throw ('Unknown command: ' + $cmd.op) }
    }
    [Console]::Out.WriteLine((@{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
  }
}
`;

// Key names the model may use -> Windows virtual-key codes.
const VK = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, windows: 0x5b, meta: 0x5b, super: 0x5b, cmd: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e,
  insert: 0x2d, ins: 0x2d, space: 0x20, spacebar: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  arrowup: 0x26, arrowdown: 0x28, arrowleft: 0x25, arrowright: 0x27, home: 0x24, end: 0x23,
  pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22, capslock: 0x14, printscreen: 0x2c, prtsc: 0x2c,
  menu: 0x5d, apps: 0x5d, ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde, plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe,
};
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i;
for (let c = 65; c <= 90; c++) VK[String.fromCharCode(c + 32)] = c; // a-z
for (let d = 0; d <= 9; d++) VK[String(d)] = 0x30 + d;

const MODIFIERS = new Set([0x11, 0x10, 0x12, 0x5b]);

/** "Ctrl+Shift+S" -> { vks: [...], label: "Ctrl+Shift+S" }, or throws for unknown keys. */
function parseKeys(combo) {
  const raw = String(combo || '').trim();
  if (!raw) throw new Error('No keys given.');
  const parts = raw === '+' ? ['plus'] : raw.split(/\s*\+\s*/).filter(Boolean);
  if (!parts.length || parts.length > 4) throw new Error(`Can't press "${raw}".`);
  const vks = parts.map((p) => {
    const vk = VK[p.toLowerCase()];
    if (vk === undefined) throw new Error(`Unknown key "${p}".`);
    return vk;
  });
  // Modifiers first, then the main key.
  vks.sort((a, b) => Number(MODIFIERS.has(b)) - Number(MODIFIERS.has(a)));
  const label = parts.map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1).toLowerCase())).join('+');
  return { vks, label };
}

class InputHelper {
  constructor() {
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.seq = 0;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
      let proc;
      try {
        proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        this.ready = null;
        reject(err);
        return;
      }
      this.proc = proc;
      const timer = setTimeout(() => reject(new Error("The mouse and keyboard helper didn't start.")), 30000);
      let buf = '';
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (data) => {
        buf += data;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.ready) {
            clearTimeout(timer);
            resolve();
            continue;
          }
          const waiter = this.pending.get(msg.id);
          if (!waiter) continue;
          this.pending.delete(msg.id);
          if (msg.ok) waiter.resolve(msg.result);
          else waiter.reject(new Error(msg.error || 'The input command failed.'));
        }
      });
      proc.stderr.on('data', (data) => console.warn('[input]', String(data).trim()));
      const fail = (err) => {
        clearTimeout(timer);
        for (const waiter of this.pending.values()) waiter.reject(err);
        this.pending.clear();
        if (this.proc === proc) {
          this.proc = null;
          this.ready = null;
        }
        reject(err);
      };
      proc.on('error', fail);
      proc.on('exit', (code) => fail(new Error(`The mouse and keyboard helper stopped (code ${code}).`)));
    });
    return this.ready;
  }

  async call(op, args = {}, timeoutMs = 15000) {
    await this.start();
    const id = ++this.seq;
    // Only ASCII on the pipe: everything else travels as \\uXXXX escapes.
    const json = JSON.stringify({ id, op, ...args }).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The mouse and keyboard helper timed out.'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(`${json}\n`);
    });
  }

  async cursor() {
    const [x, y] = String(await this.call('cursor')).split(',').map(Number);
    return { x, y };
  }

  click(x, y, { button = 'left', count = 1 } = {}) {
    return this.call('click', { x: Math.round(x), y: Math.round(y), button, count });
  }

  scroll(x, y, notches) {
    return this.call('scroll', { x: Math.round(x), y: Math.round(y), notches: Math.round(notches) });
  }

  move(x, y) {
    return this.call('move', { x: Math.round(x), y: Math.round(y) });
  }

  type(text) {
    return this.call('type', { text: String(text) }, 15000 + String(text).length * 25);
  }

  keys(combo) {
    const { vks } = parseKeys(combo);
    return this.call('keys', { vks });
  }

  dispose() {
    const proc = this.proc;
    this.proc = null;
    this.ready = null;
    if (!proc) return;
    try {
      proc.stdin.end();
      proc.kill();
    } catch {
      // already gone
    }
  }
}

module.exports = { InputHelper, parseKeys };
