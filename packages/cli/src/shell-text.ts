/**
 * Text a shell handed over as bytes, in whatever encoding the shell gave it: a Crossroom server reads
 * seat calls' form fields through `decodeShellText`, and `crossroom op` reads
 * `key@-` (stdin) and `key@<file>` through `decodeLocalText`.
 */

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const UTF8_LOOSE = new TextDecoder('utf-8');

/**
 * windows-1252's bytes 0x80 to 0x9F; every other byte is its own code point. Carried here because
 * Node 22's `TextDecoder('windows-1252')` decodes as Latin-1 (0x97 to U+0097, not the em dash),
 * and Node 22.13 is the oldest runtime Crossroom supports.
 */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

function cp1252(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b >= 0x80 && b < 0xa0 ? CP1252_HIGH[b - 0x80]! : b);
  return s;
}

/**
 * Text a shell client sent, in whatever encoding its shell gave it.
 *
 * Git for Windows' curl, the `curl` in Claude Code's Bash tool on Windows, reads its arguments
 * through the ANSI code page. An em dash typed inline (`-d text="a — b"`) arrives as the single
 * byte 0x97, and decoding that as UTF-8 put U+FFFD into the record and the minutes. So bytes that
 * are not UTF-8, and hold no UTF-8 character at all, are read as windows-1252, the ANSI code page
 * of most Western machines. One genuine UTF-8 character means UTF-8 with a damaged byte, which
 * stays as it is. Characters outside the code page arrive as "?" and nothing here can restore
 * them; the briefing says to send such text on stdin, which curl passes through untouched.
 */
export function decodeShellText(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    const loose = UTF8_LOOSE.decode(bytes);
    return /[^\x00-\x7f�]/.test(loose) ? loose : cp1252(bytes);
  }
}

/**
 * Text piped to a command, or read from a file, on this machine: UTF-8 whatever the console's code
 * page, which is what an agent's shell sends (Git Bash pipes bytes as they are). A byte-order mark
 * says otherwise: Windows PowerShell 5.1's `>` writes UTF-16LE with one, and its `Out-File -Encoding
 * utf8` a UTF-8 one, which is dropped. Bytes that are not UTF-8 at all are an ANSI code page's,
 * read as `decodeShellText` reads them.
 */
export function decodeLocalText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decodeShellText(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return decodeShellText(bytes);
}
