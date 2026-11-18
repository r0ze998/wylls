#!/usr/bin/env node
// REFERENCE EXTERNAL AI RESIDENT for a local-play TEST world (⑤ option B, owner decision 2026-11-18): an independent
// program, in its own process, with its OWN TEST key, that joins a world under the same rules as a person.
//
//   node agent.mjs --launcher http://localhost:41400 --key ./resident-key.json [--new-key] \
//     [--mcp http://127.0.0.1:41440/mcp] [--nation 3] [--rounds 0] [--cadence-ms 6000] [--max-sends 40] [--min-gap-ms 4000]
//
// What it does, and only that:
//   1. key: reads its own key file (0600, TEST-only; `--new-key` makes one if the path is free). Only the public
//      address and signatures ever leave this process.
//   2. discovers its world as a page does: `POST <launcher>/local-play/start {wallet}` — the operator must have
//      admitted that public address (`--external-residents`); the answer names ITS world proxy. Funding is the world's
//      newcomer set-up (the launcher's, the same amount as the player's); this client asks for nothing else.
//   3. observes: the public herald through its proxy (`/h/me`, `/h/status`, `/h/season`, `/h/province`), and — with
//      `--mcp` — the read-only MCP server's tools over its own OAuth link (it signs the link statement itself; read
//      scope only; MCP has no write tool there).
//   4. decides with rule.mjs (fixed, offline; replace it with your own AI) ONE of the page's six orders.
//   5. acts on the page's own route only: the page's flocalplay-act.mjs `submitLocalAct` (context → the game's builder →
//      ONE signature by its own key → ONE submit) to `/gw/f/local-play/act/*` of its proxy, then follows the signature
//      (`followLocalAct`), never sending it again. The relay rebuilds the message from the intent and refuses any
//      transaction whose payer, actor or sole signer is not this wallet; the program refuses what it refuses a person.
// Its own limits (its choice, not the world's): at most --max-sends sends, one per --min-gap-ms. No model, no paid API,
// no network beyond loopback. One JSON line per step on stdout; a summary line at the end. SIGINT/SIGTERM: stops.
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { submitLocalAct, followLocalAct } from '../../../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { createKeyFile, loadKeyFile } from './key.mjs';
import { createMemory, decide, note } from './rule.mjs';
import { askWorld, getJson, selfView, chainSecondsOf, publicHomes, pagePost, walletShaped } from './public.mjs';
import { connectMcp } from './mcp-client.mjs';

const loopback = u => { try { const x = new URL(u); return x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname) && x.pathname.replace(/\/$/, '') === (x.pathname.endsWith('/mcp') ? '/mcp' : ''); } catch { return false; } };

export function parseArgs(argv) {
  const o = {}, flags = new Set(['new-key']), keys = ['launcher', 'key', 'mcp', 'nation', 'rounds', 'cadence-ms', 'max-sends', 'min-gap-ms', 'admit-wait-ms'];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    if (k && flags.has(k)) { o[k] = true; continue; }
    if (!k || !keys.includes(k) || o[k] !== undefined || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    o[k] = argv[++i];
  }
  if (!loopback(o.launcher ?? '') || new URL(o.launcher).pathname !== '/') throw new Error('--launcher: the launcher\'s loopback origin (http://localhost:<port>)');
  if (o.mcp !== undefined && (!loopback(o.mcp) || !o.mcp.endsWith('/mcp'))) throw new Error('--mcp: a loopback MCP resource (http://127.0.0.1:<port>/mcp)');
  if (!o.key) throw new Error('--key <file>');
  const num = (k, d, lo = 0, hi = Number.MAX_SAFE_INTEGER) => { if (o[k] === undefined) return d; const n = Number(o[k]); if (!/^[0-9]+$/.test(o[k]) || n < lo || n > hi) throw new Error(`--${k}`); return n; };
  return { launcher: new URL(o.launcher).origin, key: o.key, newKey: o['new-key'] === true, mcp: o.mcp ?? null, nation: num('nation', 3, 0, 5), rounds: num('rounds', 0),
    cadenceMs: num('cadence-ms', 6000), maxSends: num('max-sends', 40), minGapMs: num('min-gap-ms', 4000), admitWaitMs: num('admit-wait-ms', 600000) };
}

const delay = (ms, signal) => new Promise(r => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
const plain = v => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

export async function main(argv = process.argv.slice(2), { print = s => process.stdout.write(`${s}\n`) } = {}) {
  let o; try { o = parseArgs(argv); } catch (e) { process.stderr.write(`external resident: ${e.message}\n`); return 64; }
  const stop = new AbortController();
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => stop.abort(s));
  const out = (step, extra = {}) => print(JSON.stringify({ at: new Date().toISOString(), step, ...extra }));
  // 1. its own key
  let key;
  try { key = o.newKey && !existsSync(o.key) ? createKeyFile(o.key) : loadKeyFile(o.key); } catch (e) { out('key', { outcome: 'refused', why: e.message }); return 2; }
  out('key', { wallet: key.address, file: 'own key file (0600, TEST-only); never sent' });
  // 2. its world, as a page finds it
  let world = null;
  for (const until = Date.now() + o.admitWaitMs; !stop.signal.aborted && Date.now() < until;) {
    try { world = await askWorld(o.launcher, key.address); } catch (e) { out('discover', { outcome: 'refused', code: e.code ?? null, why: e.message }); return 3; }
    if (typeof world?.herald === 'string') break;
    out('discover', { outcome: 'waiting', answer: world }); world = null; await delay(3000, stop.signal);
  }
  if (!world) { out('discover', { outcome: 'no-world' }); return 3; }
  const herald = world.herald.replace(/\/$/, '');
  let info = null;
  for (let i = 0; i < 30 && !stop.signal.aborted && !info; i++) { try { info = await getJson(`${herald}/gw/f/local-play/info`); } catch { await delay(1000, stop.signal); } }
  if (info?.localPlay !== true || info.cluster !== 'localnet' || info.wallet !== key.address) { out('discover', { outcome: 'refused', why: 'the world\'s relay is not pinned to my wallet on localnet' }); return 3; }
  const identity = Object.freeze({ address: key.address, programId: info.program, seasonAddress: info.season, cluster: 'localnet' });
  out('discover', { outcome: 'admitted', herald, role: world.external?.role ?? null, program: info.program, season: info.season });
  // 3. MCP (read-only) over its own OAuth link
  let mcp = null;
  if (o.mcp) {
    try {
      mcp = await connectMcp(o.mcp, key);
      out('mcp', { outcome: 'connected', tools: mcp.tools.map(t => ({ name: t.name, readOnlyHint: t.annotations?.readOnlyHint ?? null })) });
      const c = await mcp.call('get_connection');
      out('mcp', { tool: 'get_connection', isError: c.isError, owner: c.value?.owner ?? null, agentId: c.value?.agentId ?? null, scopes: c.value?.scopes ?? null, write: c.value?.write ?? null });
    } catch (e) { out('mcp', { outcome: 'failed', why: String(e?.message ?? e).slice(0, 200) }); mcp = null; }
  }
  // 4-5. observe → decide → act
  const mem = createMemory({ nation: o.nation }), signer = walletShaped(key);
  let lastRefusal = null;
  const post = pagePost(o.launcher, { onRefusal: a => { lastRefusal = a; } });
  const tally = { sends: 0, landed: 0, failed: 0, refused: 0, unknown: 0, signatures: [] };
  let last = -Infinity, misses = 0;
  for (let round = 0; !stop.signal.aborted && (o.rounds === 0 || round < o.rounds); round++) {
    let obs = null, nowSecs = null, homes = [], village = null;
    try { obs = selfView(await getJson(`${herald}/h/me/${key.address}`)); misses = 0; } catch (e) {
      if (++misses >= 5) { out('observe', { outcome: 'world-gone', why: e.message }); break; }
      out('observe', { outcome: 'no-answer', why: e.message }); await delay(o.cadenceMs, stop.signal); continue;
    }
    if (obs && !obs.joined) { try { nowSecs = chainSecondsOf(await getJson(`${herald}/h/status`)); } catch { nowSecs = null; } }
    if (obs?.joined && !obs.holding) { try { homes = await publicHomes(herald, obs.faction); } catch { homes = []; } }
    if (obs?.holding && mcp) {
      try {
        const r = await mcp.call('get_village_status');
        village = r.isError ? null : r.value;
        out('mcp', { tool: 'get_village_status', round, isError: r.isError, ...(r.isError ? { error: r.value?.error ?? null } : { village: village?.village ? { p: village.village.p, q: village.village.q, site: village.village.site } : null, stores: (village?.village?.stores ?? []).map(s => `${s.resource}:${s.have}`) }) });
      } catch (e) { out('mcp', { tool: 'get_village_status', round, outcome: 'failed', why: String(e?.message ?? e).slice(0, 120) }); }
    }
    const d = decide(mem, { obs, homes, nowSecs, village });
    const seen = { joined: obs?.joined ?? null, faction: obs?.faction ?? null, village: obs?.holding ? `${obs.holding.p},${obs.holding.q},${obs.holding.site}` : null, homesSeen: homes.length };
    if (d.wait) { note(mem, d, 'wait'); out('decide', { round, outcome: 'wait', why: d.why, seen }); await delay(o.cadenceMs, stop.signal); continue; }
    if (tally.sends >= o.maxSends) { out('budget', { round, outcome: 'spent', why: `my own limit of ${o.maxSends} sends` }); break; }
    if (Date.now() - last < o.minGapMs) { await delay(o.minGapMs - (Date.now() - last), stop.signal); }
    lastRefusal = null;
    const sent = await submitLocalAct({ name: d.name, v: d.v, fields: d.fields }, { allowed: () => ({ ok: true, relay: herald }), identity: () => identity, rulesetHash: () => info.rulesetHash, signer: () => signer, post });
    let outcome, code = null, signature = null;
    if (!sent.ok) { outcome = 'refused'; code = sent.code; }
    else {
      signature = sent.signature; tally.sends += 1; last = Date.now(); tally.signatures.push(signature);
      const f = await followLocalAct(signature, { origin: herald, still: () => !stop.signal.aborted, post, tries: 20, every: 1000 });
      // (as the operator residents count it: a send the runner refused before execution is a failure of that order —
      //  it is still followed by its signature and never sent again)
      outcome = f.state === 'landed' ? 'landed' : f.state === 'failed' ? 'failed' : sent.relayCode === 'LocalActSendRefused' ? 'failed' : 'unknown'; code = f.code ?? sent.relayCode ?? null;
    }
    tally[outcome] += 1;
    note(mem, d, outcome);
    out('act', { round, act: d.name, fields: plain(d.fields), why: d.why, outcome, ...(code ? { code } : {}), ...(lastRefusal ? { detail: JSON.stringify(lastRefusal).slice(0, 300) } : {}), ...(signature ? { signature } : {}), seen });
    await delay(o.cadenceMs, stop.signal);
  }
  await mcp?.close().catch(() => {});
  out('stopped', { why: String(stop.signal.reason ?? 'done'), wallet: key.address, tally });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
