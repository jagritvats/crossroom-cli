/**
 * The system's own notices, for the pieces `crossroom background` keeps running: a person learns that something needs them without a browser tab,
 * a terminal or VS Code open.
 *
 * Each piece raises notices about its own work only, from what it already knows:
 * - the room server, an agent's question to a room's owner (the server's `openOwnerQuestions`);
 * - the runner, a packet held for review before it leaves.
 *
 * It uses what the system has, and installs nothing (`probeCaps` asks each program its version once):
 * - macOS: terminal-notifier 3 or later where it is installed (Homebrew), whose notice opens the
 *   page when clicked; otherwise `osascript`'s `display notification`, which comes from Script Editor
 *   and opens nothing;
 * - Linux: `notify-send` (libnotify), present on GNOME, KDE and most desktops; from 0.7.10 an Open
 *   action, waited for, opens the page with `xdg-open`;
 * - Windows: a toast through Windows PowerShell 5.1's WinRT types, under PowerShell's own app id,
 *   so no app has to be registered first; clicking it opens the page.
 * A new notice of a kind replaces the last one of that kind where the program can (terminal-notifier's
 * `-group`, a toast's tag), so they don't pile up. Crossroom never borrows another app's identity
 * (Terminal's, say), which macOS may honour today and drop tomorrow.
 *
 * What a notice may say is fixed: Crossroom's own sentence and a count. Never a room's title, a
 * seat's name, a question, a packet or a path, as the VS Code extension's status bar notice does.
 * A notice's command line can be read by every account on the
 * machine (`ps`), so nothing in one may be a secret either: the page a Windows toast opens is a
 * loopback address with no query and no fragment (`safeOpen`), never a link that carries a key.
 *
 * Off unless `PARLEY_OS_NOTICES=1`, which the env file of a `crossroom background install` service
 * sets (commands/runner-service.ts). The hosted instance never sets it, and a server bound to
 * anything but the loopback never raises one.
 */
import { execFile } from 'node:child_process';
import { oneLine } from '@parley/shared/text';

export interface Notice {
  title: string;
  body: string;
  /** A loopback page with no query or fragment, which the notice opens when it is clicked, where the system's program can. */
  open?: string;
  /** Its kind: a new notice of a kind replaces the last one where the system's program can (`watchCounts` sets it). */
  group?: string;
}

/** Whether this process raises the system's own notices. */
export const noticesOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.PARLEY_OS_NOTICES === '1';

/** Windows PowerShell's own app id: a toast needs one, and this one is on every Windows. */
export const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const TITLE_MAX = 80;
const BODY_MAX = 240;

/** One AppleScript string literal. */
const appleString = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Text in XML. */
const xmlText = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A page a notice may open: http on the loopback, with no credentials, query or fragment. Anything else is dropped. */
export function safeOpen(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' || !LOOPBACK_NAMES.has(u.hostname) || u.username || u.password || u.search || u.hash) return undefined;
  return u.href;
}

/** The toast Windows shows, as XML: a title, a line, and the page it opens when clicked. */
export function toastXml(n: Notice): string {
  const open = safeOpen(n.open);
  const launch = open ? ` activationType="protocol" launch="${xmlText(open)}"` : '';
  return `<toast${launch}><visual><binding template="ToastGeneric"><text>${xmlText(n.title)}</text><text>${xmlText(n.body)}</text></binding></visual></toast>`;
}

/**
 * What this computer's notice programs can do, found once per process (`probeCaps`), since the
 * system's own tools differ more than their names suggest:
 * - `terminalNotifier`: macOS, terminal-notifier 3 or later on PATH. It posts through the
 *   UserNotifications framework, so its notice is its own app's and opens a page when clicked, where
 *   `osascript`'s comes from Script Editor, opens nothing, and on macOS 26 has been seen to show
 *   nothing at all. Version 2 posted through the API macOS 15 drops.
 * - `notifyActions`: Linux, notify-send 0.7.10 or later, which can wait for a click on an action.
 */
export interface NoticeCaps {
  terminalNotifier?: boolean;
  notifyActions?: boolean;
}

/** A notice program's command, and what to do with its answer. */
export interface NoticeCommand {
  file: string;
  args: string[];
  /** It waits for the notice to be clicked or closed (notify-send `--wait`); stdout `open` means clicked. */
  waits?: boolean;
  /** The page to open when it says it was clicked. */
  opens?: string;
}

/** A tag naming one kind of notice, so a new one replaces the last of its kind instead of piling up. */
const tagOf = (group: string | undefined) => `crossroom-${(group ?? 'notice').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'notice'}`;

/** The program and arguments that show `n` on this platform, or null where Crossroom knows none. */
export function noticeCommand(platform: NodeJS.Platform, given: Notice, caps: NoticeCaps = {}): NoticeCommand | null {
  const n: Notice = { title: oneLine(given.title).slice(0, TITLE_MAX), body: oneLine(given.body).slice(0, BODY_MAX), ...(given.open ? { open: given.open } : {}) };
  const open = safeOpen(n.open);
  const tag = tagOf(given.group);
  if (platform === 'darwin') {
    if (caps.terminalNotifier)
      return { file: 'terminal-notifier', args: ['-title', n.title, '-message', n.body, '-group', tag, ...(open ? ['-open', open] : [])] };
    return { file: 'osascript', args: ['-e', `display notification ${appleString(n.body)} with title ${appleString(n.title)}`] };
  }
  // `--` so neither line is read as an option, whatever it starts with.
  if (platform === 'linux') {
    if (caps.notifyActions && open) return { file: 'notify-send', args: ['--app-name=Crossroom', '--action=open=Open', '--wait', '--', n.title, n.body], waits: true, opens: open };
    return { file: 'notify-send', args: ['--app-name=Crossroom', '--', n.title, n.body] };
  }
  if (platform === 'win32') {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      // Otherwise "Preparing modules for first use" goes to stderr as CLIXML.
      "$ProgressPreference = 'SilentlyContinue'",
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$x.LoadXml('${toastXml(n).replace(/'/g, "''")}')`,
      '$t = [Windows.UI.Notifications.ToastNotification]::new($x)',
      // The same tag and group replace the last toast of this kind in the Action Center.
      `$t.Tag = '${tag.slice(0, 16)}'`,
      "$t.Group = 'crossroom'",
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($t)`,
    ].join('\n');
    // Windows PowerShell 5.1 by name: PowerShell 7 cannot load WinRT types this way.
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
  }
  return null;
}

export interface NoticeRun {
  code: number;
  stdout?: string;
  stderr: string;
  /** Stopped by its clock: for a notice that waits for a click, nobody clicked in time, which is no failure. */
  timedOut?: boolean;
}
export type NoticeExec = (file: string, args: string[], o?: { timeoutMs?: number }) => Promise<NoticeRun>;

/** How long a notice that waits for a click (notify-send `--wait`) is listened to. */
export const CLICK_WAIT_MS = 10 * 60_000;

const realExec: NoticeExec = (file, args, o = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: o.timeoutMs ?? 15_000, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
      const code = e ? (typeof e.code === 'number' ? e.code : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (e ? e.message : '')), ...(e?.killed ? { timedOut: true } : {}) });
    });
  });

/** The first `major.minor.patch` in a program's own words, as numbers. */
export function versionOf(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

const atLeast = (v: [number, number, number] | null, want: [number, number, number]) =>
  !!v && (v[0] !== want[0] ? v[0] > want[0] : v[1] !== want[1] ? v[1] > want[1] : v[2] >= want[2]);

/** What the notice programs here can do: asked of each program once, by its version. */
export async function probeCaps(platform: NodeJS.Platform, exec: NoticeExec = realExec): Promise<NoticeCaps> {
  if (platform === 'darwin') {
    // `-help` prints "terminal-notifier (3.0.0) is a command-line tool…"; absent, the call fails.
    const r = await exec('terminal-notifier', ['-help']).catch(() => null);
    return { terminalNotifier: !!r && r.code === 0 && atLeast(versionOf(`${r.stdout ?? ''} ${r.stderr}`), [3, 0, 0]) };
  }
  if (platform === 'linux') {
    const r = await exec('notify-send', ['--version']).catch(() => null);
    return { notifyActions: !!r && r.code === 0 && atLeast(versionOf(r.stdout ?? ''), [0, 7, 10]) };
  }
  return {};
}

/** After this many failures in a row a piece stops trying, and says so once. */
export const NOTICE_FAILURES_MAX = 3;

/**
 * Something to raise notices with: the platform's own program, run without a shell. A notice that
 * fails is logged; after `NOTICE_FAILURES_MAX` in a row (no `notify-send` installed, a desktop with
 * no notification service) the piece stops trying, so it never spawns a failing program forever.
 */
export function systemNotices(o: { platform?: NodeJS.Platform; exec?: NoticeExec; log?: (line: string) => void; caps?: NoticeCaps } = {}): (n: Notice) => void {
  const platform = o.platform ?? process.platform;
  const exec = o.exec ?? realExec;
  const log = o.log ?? (() => {});
  let caps: Promise<NoticeCaps> | null = o.caps ? Promise.resolve(o.caps) : null;
  let failures = 0;
  let gave = false;
  const failed = (file: string, r: NoticeRun) => {
    failures++;
    if (failures >= NOTICE_FAILURES_MAX) {
      gave = true;
      log(`System notices are off: ${file} failed ${failures} times in a row (${oneLine(r.stderr).slice(0, 200) || `exit ${r.code}`}).`);
    }
  };
  return (n) => {
    if (gave) return;
    caps ??= probeCaps(platform, exec).catch(() => ({}));
    const shown = caps.then(async (c) => {
      if (gave) return;
      const cmd = noticeCommand(platform, n, c);
      if (!cmd) {
        if (!gave) log(`System notices are off: Crossroom knows no notice program on ${platform}.`);
        gave = true;
        return;
      }
      const r = await exec(cmd.file, cmd.args, cmd.waits ? { timeoutMs: CLICK_WAIT_MS } : {});
      // A notice nobody clicked before its clock ran out was still shown.
      if (r.code !== 0 && !(cmd.waits && r.timedOut)) return failed(cmd.file, r);
      failures = 0;
      // notify-send prints the action's name when it is clicked: the page, opened as the desktop opens a link.
      if (cmd.opens && r.stdout?.trim() === 'open') await exec('xdg-open', [cmd.opens]);
    });
    // A notice that could not be shown never takes the piece down with it.
    shown.catch(() => {});
  };
}

/**
 * What a piece watches: the ids of what waits for its person right now (open questions, pending
 * decisions, held packets), and the notice to raise, given how many wait. Ids, not a count, so a
 * question answered and another asked between two reads is still a new one. Ids stay in the
 * process: a notice carries the count alone.
 */
export interface CountWatch {
  ids(): readonly string[];
  notice(count: number): Notice;
}

export interface WatchOptions {
  send(n: Notice): void;
  /** How often each count is read. */
  everyMs?: number;
  /** The least time between two notices of one kind; a rise meanwhile is told once it has passed. */
  quietMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const WATCH_EVERY_MS = 10_000;
export const NOTICE_QUIET_MS = 60_000;

/**
 * Reads each watch every `everyMs` and raises its notice when something waits that has not been
 * told yet: a new question, never the same one again. At most one notice of a kind per `quietMs`;
 * what arrives meanwhile is told once it has passed, with the count as it stands then. What is
 * waiting already when the piece starts is told once, at its first read: after a reboot, that is
 * the point. A watch that cannot be read is said once, and again only after it has read fine.
 */
export function watchCounts(watches: Record<string, CountWatch>, o: WatchOptions): { tick(): void; stop(): void } {
  const now = o.now ?? Date.now;
  const quiet = o.quietMs ?? NOTICE_QUIET_MS;
  const state = new Map<string, { told: Set<string>; at: number; broken: boolean }>();
  const tick = () => {
    for (const [kind, w] of Object.entries(watches)) {
      const s = state.get(kind) ?? { told: new Set<string>(), at: Number.NEGATIVE_INFINITY, broken: false };
      state.set(kind, s);
      let ids: readonly string[];
      try {
        ids = w.ids();
      } catch (e) {
        if (!s.broken) o.log?.(`notices: could not read ${kind} (${(e as Error)?.message ?? e})`);
        s.broken = true;
        continue;
      }
      s.broken = false;
      const fresh = ids.some((id) => !s.told.has(id));
      if (fresh && now() - s.at >= quiet) {
        o.send({ group: kind, ...w.notice(ids.length) });
        s.told = new Set(ids);
        s.at = now();
      } else if (!fresh) {
        // What was told and has gone (answered, decided) is forgotten; an id never comes back.
        s.told = new Set(ids);
      }
    }
  };
  const timer = setInterval(tick, o.everyMs ?? WATCH_EVERY_MS);
  timer.unref();
  tick();
  return { tick, stop: () => clearInterval(timer) };
}
