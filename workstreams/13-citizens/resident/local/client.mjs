#!/usr/bin/env node
// ⑬ RESIDENT as an EXTERNAL AI RESIDENT of a local-play TEST world (2026-11-22; ⑤ option B path, #57/#142).
//
//   node workstreams/13-citizens/resident/local/client.mjs --launcher http://localhost:41550 --key <file> --dir <abs dir> \
//     [--new-key] [--goal village-first|surplus-use] [--nation 0-5] [--mcp http://127.0.0.1:<port>/mcp] [--cadence-ms 3000] [--rounds 0]
//     [--plan --runexec <runexec binary> [--plan-db <abs sqlite>] [--plan-steps 12]]
//
// --plan: multi-turn plans run by workstream 04's plan store (executor.mjs; `runexec plan …`, its SQLite in
// <dir>/plans.sqlite unless --plan-db): once the village exists, the resident makes a plan of its own orders and
// sends one step per turn, restart-safe; a refusal or a changed world remakes the plan.
//
// The operator admits the resident's PUBLIC address (`scripts/play-local.sh --external <address>`); this process holds
// its own TEST key (examples/external-resident/key.mjs: 0600, test_only) and goes through the reference resident's
// own path (agent.mjs discoverWorld + sendOrder: the launcher's page start route, the page's own submitLocalAct /
// followLocalAct on its own world proxy). Only the mind is ⑬'s: brain.mjs (goals, limits) with journal.mjs (memory,
// restart-safe, one action per turn) over observe.mjs (its own public records). No model, no paid API, no network
// beyond loopback. The decision log: one JSON line per step on stdout and in <dir>/decisions.jsonl.
// Stop: SIGINT/SIGTERM, or the operator's halt file <dir>/HALT (a pause: results of earlier orders are still read).
import { pathToFileURL } from 'node:url';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createKeyFile, loadKeyFile } from '../../../03-composability/mcp/examples/external-resident/key.mjs';
import { walletShaped, getJson, chainSecondsOf, pagePost } from '../../../03-composability/mcp/examples/external-resident/public.mjs';
import { discoverWorld, sendOrder } from '../../../03-composability/mcp/examples/external-resident/agent.mjs';
import { connectMcp } from '../../../03-composability/mcp/examples/external-resident/mcp-client.mjs';
import { followLocalAct, LOCAL_ACT_CONTEXT_PATH } from '../../../../permutation-server/web/frontier/flocalplay-act.mjs';
import { localDepartStatus, postLocalDepart, LOCAL_DEPART_STATUS_PATH, LOCAL_DEPART_STATUS_SCHEMA } from '../../../../permutation-server/web/frontier/flocalplay-depart.mjs';
import { fromBase64 } from '../../../../permutation-server/web/sdk/bytes.mjs';
import { createWideEyes, EXPEDITION } from './wide.mjs';
import { createTerritoryEyes } from './territory.mjs';
import { parseTransaction } from '../../../../permutation-server/web/sdk/solana-tx.mjs';
import { encode } from '../../../../permutation-server/web/sdk/base58.mjs';
import { bellOf } from '../../../../permutation-gateway/src/frontier/local-play-operator-policy.mjs';
import { GOALS } from '../goals.mjs';
import { createObserver } from './observe.mjs';
import { openState, settleIntendedOnOpen } from './journal.mjs';
import { localStep } from './runner.mjs';
import { BRAIN_KIND } from './brain.mjs';
import { createPlanExecutor } from './executor.mjs';
import { PLAN_LIMITS } from './plan.mjs';
import { createPlansClient } from '../../../04-execution/clients/plans.mjs';
import { randomBytes } from 'node:crypto';

const loopback = u => { try { const x = new URL(u); return x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname); } catch { return false; } };

export function parseArgs(argv) {
  const o = {}, flags = new Set(['new-key', 'plan']), keys = ['launcher', 'key', 'dir', 'goal', 'nation', 'mcp', 'cadence-ms', 'rounds', 'admit-wait-ms', 'runexec', 'plan-db', 'plan-steps'];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    if (k && flags.has(k)) { o[k] = true; continue; }
    if (!k || !keys.includes(k) || o[k] !== undefined || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    o[k] = argv[++i];
  }
  if (!loopback(o.launcher ?? '') || new URL(o.launcher).pathname !== '/') throw new Error('--launcher: the launcher\'s loopback origin');
  if (o.mcp !== undefined && (!loopback(o.mcp) || !o.mcp.endsWith('/mcp'))) throw new Error('--mcp: a loopback MCP resource (http://127.0.0.1:<port>/mcp)');
  if (!o.key) throw new Error('--key <file>');
  if (!o.dir || !path.isAbsolute(o.dir)) throw new Error('--dir <absolute directory> (state, decision log, HALT)');
  const goal = o.goal ?? 'village-first';
  if (!Object.hasOwn(GOALS, goal)) throw new Error(`--goal: one of ${Object.keys(GOALS).join(', ')}`);
  const num = (k, d, lo, hi) => { if (o[k] === undefined) return d; const n = Number(o[k]); if (!/^[0-9]+$/.test(o[k]) || n < lo || n > hi) throw new Error(`--${k}`); return n; };
  if (o.plan && (!o.runexec || !path.isAbsolute(o.runexec))) throw new Error('--plan needs --runexec <absolute path of the runexec binary>');
  if (!o.plan && (o.runexec || o['plan-db'] || o['plan-steps'])) throw new Error('--runexec / --plan-db / --plan-steps go with --plan');
  if (o['plan-db'] !== undefined && !path.isAbsolute(o['plan-db'])) throw new Error('--plan-db: an absolute path');
  return { plan: o.plan === true, runexec: o.runexec ?? null, planDb: o['plan-db'] ?? (o.plan ? path.join(o.dir, 'plans.sqlite') : null), planSteps: num('plan-steps', PLAN_LIMITS.steps, 4, 64),
    launcher: new URL(o.launcher).origin, key: o.key, newKey: o['new-key'] === true, dir: o.dir, goal, nation: num('nation', 3, 0, 5), mcp: o.mcp ?? null,
    cadenceMs: num('cadence-ms', 3000, 200, 600000), rounds: num('rounds', 0, 0, 1e9), admitWaitMs: num('admit-wait-ms', 600000, 0, 864e5) };
}

const delay = (ms, signal) => new Promise(r => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });
const plain = v => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x)));

export async function main(argv = process.argv.slice(2), { print = s => process.stdout.write(`${s}\n`) } = {}) {
  let o; try { o = parseArgs(argv); } catch (e) { process.stderr.write(`ws13 local resident: ${e.message}\n`); return 64; }
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const logFile = path.join(o.dir, 'decisions.jsonl');
  const stop = new AbortController();
  for (const s of ['SIGINT', 'SIGTERM']) process.once(s, () => stop.abort(s));
  const out = (step, extra = {}) => { const line = JSON.stringify(plain({ at: new Date().toISOString(), step, ...extra })); print(line); appendFileSync(logFile, `${line}\n`); };
  let key;
  try { key = o.newKey && !existsSync(o.key) ? createKeyFile(o.key) : loadKeyFile(o.key); } catch (e) { out('key', { outcome: 'refused', why: e.message }); return 2; }
  let store;
  try { store = openState({ dir: o.dir, wallet: key.address, goal: o.goal, nation: o.nation }); } catch (e) { out('state', { outcome: 'refused', why: e.message }); return 2; }
  const settledOnOpen = settleIntendedOnOpen(store.state); store.save();
  out('start', { brain: BRAIN_KIND, wallet: key.address, goal: o.goal, goalWords: GOALS[o.goal].words, nation: o.nation, decisions: store.state.decisions, acted: store.state.acted, restartSettled: settledOnOpen, openLines: Object.values(store.state.journal).filter(l => ['signed', 'sent', 'unknown'].includes(l.state)).length });
  const found = await discoverWorld({ launcher: o.launcher, wallet: key.address, admitWaitMs: o.admitWaitMs, signal: stop.signal, out });
  if (!found) return 3;
  const { herald, info, identity } = found;
  let mcp = null;
  if (o.mcp) {
    try { mcp = await connectMcp(o.mcp, key); const c = await mcp.call('get_connection'); out('mcp', { outcome: 'connected', tools: mcp.tools.map(t => t.name), scopes: c.value?.scopes ?? null, write: c.value?.write ?? null }); }
    catch (e) { out('mcp', { outcome: 'failed', why: String(e?.message ?? e).slice(0, 200) }); mcp = null; }
  }
  const signer = walletShaped(key);
  // (external-wide: a local wide-land world — the launcher's start answer says so as it says so to the page)
  const wide = !!found.world?.wideLand;
  if (wide) out('world', { what: 'wide-land', scale: found.world.wideLand.scale ?? null, firstVillage: 'outward, a rim site by request (FileTicket) past the heartland, as the page' });
  const observeRaw = createObserver({ base: herald, wallet: key.address, wide, identity });
  // (external-wide-orders: the wide land's own orders — wide.mjs — read through its own world proxy with the launcher's
  //  Origin, as its page posts: the herald's public reads and its own relay's read-only wide read)
  const originFetch = (url, init = {}) => globalThis.fetch(url, { ...init, headers: { ...(init.headers ?? {}), origin: o.launcher } });
  const wideRead = async addresses => {
    const j = await pagePost(o.launcher)(herald, LOCAL_ACT_CONTEXT_PATH, { schema: 'frontier-local-play-act-wide-read-v1', addresses });
    if (!Array.isArray(j?.accounts) || j.accounts.length !== addresses.length) throw Object.assign(new Error('WideReadUnavailable'), { code: 'WideReadUnavailable' });
    return j.accounts.map(a => (a ? fromBase64(a.data_b64) : null));
  };
  const wideEyes = wide ? createWideEyes({ herald, identity, wideTargets: found.world.wideLand.targets ?? [], read: wideRead, fetch: originFetch, getJson }) : null;
  if (wideEyes) out('world', { what: 'wide-orders', targets: (found.world.wideLand.targets ?? []).length, orders: 'WideClaim, WideTrain/WideMuster/WideDepart, Expedition (the page\'s own; one action per turn)' });
  // (ws13-territory: its own land and the tiles it could claim, in a wide world — the herald's captures and its own relay's
  //  read-only account read; whether the world plays player territory is read from the land itself)
  const territoryEyes = wide ? createTerritoryEyes({ herald, identity, read: wideRead, getJson }) : null;
  if (territoryEyes) out('world', { what: 'territory', orders: 'TerritoryClaim (a single tile: the site of my next village first, then growth at my own pace; one claim a turn, one action a turn)' });
  let lastObs = null;
  const observe = async () => { const x = await observeRaw(); if (!x.unreadable) lastObs = x; return x; };
  // the signing step: the page's own signer, and the signature saved (onSigned) before submitLocalAct's one submit
  // (an Expedition goes on the page's depart route: prepare (a read; the province's settle waited out), ONE signature —
  //  saved by onSigned before the one submit —, submit, status; a refusal before the signature is held as a refusal)
  const sendExpedition = async (order, { onSigned }) => {
    const x = await wideEyes.sendExpedition(order.plan, { signer, onSigned });
    if (x.ok) return { outcome: 'landed', code: null, signature: x.signature, detail: null };
    if (x.step === 'failed') return { outcome: 'failed', code: String(x.code ?? 'Failed').slice(0, 64), signature: x.signature ?? null, detail: null };
    if (x.signature) return { outcome: 'unknown', code: x.code ?? null, signature: x.signature, detail: null };
    return { outcome: 'refused', code: String(x.code ?? 'ExpeditionNotPrepared').slice(0, 64), signature: null, detail: `the depart route at ${x.step}${x.looks ? ` (${x.looks} look(s))` : ''}`, holdNotSent: true };
  };
  const send = async (order, opts) => (order.name === EXPEDITION ? sendExpedition(order, opts) : sendLocal(order, opts));
  const sendLocal = async (order, { onSigned }) => sendOrder(order, { herald, info, identity, signer, launcher: o.launcher, signal: stop.signal,
    sign: async unsigned => {
      const account = (await signer.wallet.features['standard:connect'].connect()).accounts[0];
      const [res] = await signer.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: unsigned });
      await onSigned(encode(parseTransaction(Uint8Array.from(res.signedTransaction)).signatures[0]));   // (a throw: nothing is submitted)
      return res.signedTransaction;
    } });
  const post = pagePost(o.launcher);
  const followDepart = async sig => {
    let st = null;
    try { st = localDepartStatus(await postLocalDepart(herald, LOCAL_DEPART_STATUS_PATH, { schema: LOCAL_DEPART_STATUS_SCHEMA, signature: sig }, { fetch: originFetch }), sig); } catch { return null; }
    return ['confirmed', 'finalized'].includes(st?.status) ? 'landed' : st?.status === 'failed' ? 'failed' : 'pending';
  };
  const follow = async (sig, order = null) => {
    if (order === EXPEDITION) return followDepart(sig);
    const f = await followLocalAct(sig, { origin: herald, still: () => !stop.signal.aborted, post, tries: 2, every: 500 }); return f.state ?? null;
  };
  const bellNow = async () => bellOf(lastObs?.genesisTs, chainSecondsOf(await getJson(`${herald}/h/status`)));
  const halted = () => existsSync(path.join(o.dir, 'HALT'));
  const plan = o.plan ? createPlanExecutor({ plans: createPlansClient({ bin: o.runexec, db: o.planDb }), owner: key.address, holder: `ws13-${process.pid}-${randomBytes(4).toString('hex')}`,
    goal: GOALS[o.goal], goalName: o.goal, limits: { ...PLAN_LIMITS, steps: o.planSteps }, log: out }) : null;
  if (plan) out('plan', { what: 'executor', store: o.planDb, holder: plan.holder, steps: o.planSteps, by: 'workstream 04 runexec plan' });
  let misses = 0, quietSince = null, round = 0;
  for (; !stop.signal.aborted && (o.rounds === 0 || round < o.rounds); round++) {
    let r;
    try { r = await localStep({ store, observe, send, follow, bellNow, halted, log: out, plan, wide: wideEyes, territory: territoryEyes }); } catch (e) { r = { did: 'error' }; out('error', { why: String(e?.stack ?? e).slice(0, 400) }); }
    if (r.did === 'unreadable' || r.did === 'error') { if (++misses >= 20) { out('stop', { why: 'world-gone' }); break; } } else misses = 0;
    // (quiet steps — asleep or blocked — are logged once per turn, not every round)
    if (r.did === 'blocked' || r.did === 'asleep') { if (quietSince !== r.bell) { quietSince = r.bell; out('quiet', { bell: r.bell, did: r.did, why: r.why ?? `asleep until turn ${r.until}` }); } }
    if (mcp && lastObs?.holding && round % 10 === 0 && mcp.tools.some(t => t.name === 'get_territory_status')) {
      try { const v = await mcp.call('get_territory_status'); const t = v.value ?? {}; out('mcp', { tool: 'get_territory_status', round, isError: v.isError, on: t.on ?? null, ...(t.own ? { tiles: t.own.tiles, nextClaimOre: t.own.nextClaimOre, upkeepFoodPerHour: t.own.upkeepFoodPerHour, unpaid: t.own.unpaid, canAskNow: t.claim?.canAskNow ?? null, provinces: (t.provinces ?? []).length } : { why: t.why ?? t.error?.message ?? null }) }); }
      catch (e) { out('mcp', { tool: 'get_territory_status', round, outcome: 'failed', why: String(e?.message ?? e).slice(0, 120) }); }
    }
    if (mcp && lastObs?.holding && round % 10 === 0) {
      try { const v = await mcp.call('get_village_status'); out('mcp', { tool: 'get_village_status', round, isError: v.isError, stores: (v.value?.village?.stores ?? []).slice(0, 6).map(s => `${s.resource}:${s.have}`) }); }
      catch (e) { out('mcp', { tool: 'get_village_status', round, outcome: 'failed', why: String(e?.message ?? e).slice(0, 120) }); }
    }
    await delay(o.cadenceMs, stop.signal);
  }
  await mcp?.close().catch(() => {});
  const st = store.state;
  out('stopped', { why: String(stop.signal.reason ?? 'done'), wallet: key.address, decisions: st.decisions, acted: st.acted, lines: Object.fromEntries(Object.entries(st.journal).map(([k, l]) => [k, `${l.order}:${l.state}`])) });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
