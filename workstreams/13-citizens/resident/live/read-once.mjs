// The resident's saved respond results, read once from explicit settings, with a result an operator can read
// (2026-11-17). The product entry over enact-read.mjs readRespondResults, with workstream 12's worldFromSeason given
// explicitly (adapters/canonical.mjs, as factory.mjs uses it). Not the one-step entry (once.mjs, unchanged).
//
// What it reads (enact-read.mjs, unchanged): the lock file's metadata (lstat), the journal (one read); and ONLY when a
// `sending` line needs the board's answer: herald /h/season, board /coop/config and one /coop/view, GET each.
// What it never does: write anything (the journal, its lock, state.json), make or remove a lock, observe for
// candidates, propose, sign, post, re-send, or choose a wallet, URL, key or identity. Nothing runs at import beyond
// loading its modules; one call of runReadOnce is one read.
import { readRespondResults } from './enact-read.mjs';
import { worldFromSeason as ws12WorldFromSeason } from '../../../12-memory/adapters/canonical.mjs';

export const READ_ONCE_KIND = 'ws13-enact-read-once/1';
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALLOWED = new Set(['residentDir', 'wallet', 'heraldUrl', 'boardUrl']);
const short = (v, n = 160) => String(v ?? '').replace(/[A-Za-z0-9+/=_-]{40,}/g, '…').slice(0, n);
const httpUrl = v => { try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } };

/**
 * The settings, checked; nothing is completed with a default. All four are required:
 * residentDir (absolute), wallet (base58), heraldUrl and boardUrl (http(s), no credentials, query or fragment).
 * → {ok, config, missing: [{field, why}], refused: [field]}
 */
export function readOnceConfig(input) {
  const missing = [], refused = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, config: null, missing: [{ field: '*', why: 'the settings must be an object' }], refused: [] };
  for (const k of Object.keys(input)) if (!ALLOWED.has(k)) refused.push(k);   // signer, proposal, fetchImpl, worldFromSeason, … are not settings
  if (typeof input.residentDir !== 'string' || !input.residentDir.startsWith('/')) missing.push({ field: 'residentDir', why: "the resident's directory (absolute): its enact journal is read from it" });
  if (typeof input.wallet !== 'string' || !B58.test(input.wallet)) missing.push({ field: 'wallet', why: "the resident's own address (base58), given by its owner; none is chosen here" });
  if (!httpUrl(input.heraldUrl)) missing.push({ field: 'heraldUrl', why: 'the herald of the world: an http(s) URL without credentials, query or fragment' });
  if (!httpUrl(input.boardUrl)) missing.push({ field: 'boardUrl', why: "workstream 1's board the respond was posted to: an http(s) URL without credentials, query or fragment" });
  const ok = !missing.length && !refused.length;
  return { ok, config: ok ? Object.freeze({ residentDir: input.residentDir, wallet: input.wallet, heraldUrl: input.heraldUrl, boardUrl: input.boardUrl }) : null, missing, refused };
}

/** What this read may do, said as it is. */
export const EFFECTS = Object.freeze({
  local: 'the enact journal (one read) and its lock file (lstat only)',
  outside: 'only when a sending line needs the board: herald /h/season, board /coop/config, board /coop/view (GET)',
  writes: 'none: no journal, lock or state.json write; no lock made or removed',
  sent: 'nothing: no proposal, signature, POST or re-send',
});

/** The result as an operator reads it: the journal's word and the board's view now, kept apart. */
export function summarizeRead(r) {
  const lines = Array.isArray(r?.lines) ? r.lines : [];
  const n = x => lines.filter(l => l.result === x).length;
  return {
    journal: r?.journal ?? null,
    read: r?.read ?? null,
    lock: r?.lock ?? null,
    counts: {
      fromJournal: { posted: n('posted'), refused: n('refused'), intent: n('intent'), signedNotPosted: n('signed-not-posted') },
      fromBoardNow: { confirmed: n('confirmed') },
      unknown: n('unknown'),
      held: n('held'),
    },
    notice: 'posted/refused are what the journal says; confirmed is what the board shows now (not a chain fact); unknown is not known, never "not sent"; a missing journal is no evidence about the past',
  };
}

/**
 * One read. The settings are checked HERE, whoever calls: invalid or foreign settings return
 * {outcome: 'config-missing'} before anything is read. `read` and `fetchImpl` are stand-ins only for a test.
 * → {kind, outcome: 'result'|'not-read'|'config-missing'|'error', effects, summary?, result?}
 */
export async function runReadOnce(input, { fetchImpl = globalThis.fetch, read = readRespondResults } = {}) {
  const c = readOnceConfig(input);
  if (!c.ok) return { kind: READ_ONCE_KIND, outcome: 'config-missing', missing: c.missing, refused: c.refused, effects: EFFECTS };
  const config = c.config;
  try {
    const r = await read({ dir: config.residentDir, wallet: config.wallet, boardUrl: config.boardUrl, heraldUrl: config.heraldUrl, fetchImpl, worldFromSeason: ws12WorldFromSeason });
    return { kind: READ_ONCE_KIND, outcome: r?.ok ? 'result' : 'not-read', effects: EFFECTS, summary: summarizeRead(r), result: r };
  } catch (e) {
    return { kind: READ_ONCE_KIND, outcome: 'error', effects: EFFECTS, error: { code: typeof e?.code === 'string' ? e.code : e?.name ?? 'Error', message: short(e?.message, 120) } };
  }
}
