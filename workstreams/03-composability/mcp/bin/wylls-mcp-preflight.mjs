#!/usr/bin/env node
// Checks a running wylls-mcp against one client's documented OAuth and discovery requirements (src/preflight.mjs).
//
//   node bin/wylls-mcp-preflight.mjs http://127.0.0.1:41960/mcp claude-code
//   node bin/wylls-mcp-preflight.mjs http://127.0.0.1:41960/mcp chatgpt      # scheme fails on loopback by design
//   node bin/wylls-mcp-preflight.mjs https://<approved deployment>/mcp chatgpt --allow-remote
//
// Loopback servers only by default (it registers OAuth clients). `--allow-remote` is the library's `allowRemote`,
// nothing more, and for an approved deployment only: it lifts the "on this machine" check for the URL given and for
// the URLs that server names (its metadata, authorization server, registration and token endpoints). Every request
// is still checked first (http or https, no credentials in the URL), redirects are still refused, and nothing
// after a refusal is requested. Never a default; give it once, exactly as `--allow-remote`.
//
// (2026-11-17) Output: one JSON document on stdout. Exit 0: every check passed. Exit 1: a check failed, or the
// preflight stopped with an error (`{ok: false, error}`; a request that failed after others were made, such as a
// registration, is not undone). Exit 2: usage (stderr), and nothing is requested. `error` is one of two fixed texts:
// the library's own refusal of a URL off this machine, or "request failed" (an exception's own message is never
// printed: it may quote a URL, a header or a token).
import { pathToFileURL } from 'node:url';
import { preflight, PREFLIGHT_CLIENTS } from '../src/preflight.mjs';

/** The library's one refusal before any request (src/preflight.mjs), recognised by its fixed opening words. */
const OFF_MACHINE = 'preflight runs against a server on this machine only';
/** What the command says of an error: a fixed text only. `message` is read only as an own data property holding
 * text (a getter is never run); anything else thrown, or anything unreadable, is "request failed". */
export function errorText(e) {
  let m = '';
  try {
    const d = e !== null && typeof e === 'object' ? Object.getOwnPropertyDescriptor(e, 'message') : undefined;
    if (d && 'value' in d && typeof d.value === 'string') m = d.value;
  } catch { m = ''; }
  return m.startsWith(OFF_MACHINE) ? `${OFF_MACHINE} (it registers OAuth clients); --allow-remote is for an approved deployment` : 'request failed';
}

export const USAGE = `usage: wylls-mcp-preflight <mcp url> [${PREFLIGHT_CLIENTS.join('|')}] [--allow-remote]`;

/** The command, transport-free: returns the exit code; `fetch` is passed to the library (a test gives a fake). */
export async function main(argv, { print = s => process.stdout.write(`${s}\n`), warn = s => process.stderr.write(`${s}\n`), fetch: f = globalThis.fetch } = {}) {
  const flags = argv.filter(a => a.startsWith('-'));
  const pos = argv.filter(a => !a.startsWith('-'));
  if (flags.some(x => x !== '--allow-remote') || flags.length > 1 || pos.length < 1 || pos.length > 2) { warn(USAGE); return 2; }
  const [url, client = 'claude-code'] = pos;
  if (!PREFLIGHT_CLIENTS.includes(client)) { warn(USAGE); return 2; }
  try { new URL(url); } catch { warn(`${USAGE}\n(the mcp url does not parse)`); return 2; }
  const allowRemote = flags.length === 1;
  if (allowRemote) warn('--allow-remote: for an approved deployment only; the server under test names the next URLs, and they may be off this machine');
  let r;
  try { r = await preflight(url, { client, allowRemote, fetch: f }); } catch (e) {
    print(JSON.stringify({ client, ok: false, error: errorText(e) }, null, 2));
    return 1;
  }
  print(JSON.stringify(r, null, 2));
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
