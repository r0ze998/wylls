// LOCAL PLAY, TEST-ONLY — the world's goals (first slice: the flag keeps) judged for each world of the local-play
// launcher, with `--world-goals flag-keeps-v2` (the older word `flag-keeps-v1` still turns it on). The judge (world-goals.mjs) runs in the launcher's process over the
// world's own chain (its runner's loopback RPC) and its herald (the world's proxy, for the keep files the contribution
// ledger cites), and keeps its state in the world's directory (`world-goals.json`). It is served on the launcher's
// origin, read only:
//
//   GET /goals-world/<world proxy port>/goals/state     the posting, the progress, the achievements and the
//                                                       SIMULATED prize breakdown (no money moves: there is no vault)
//
// Nothing here signs, sends or holds a key. The operator AI residents' wallets come from the world's `operators.json`
// (the launcher's own record of whom it started), the external residents' from `externals.json`.
import fs from 'node:fs/promises';
import path from 'node:path';
import { encode as base58 } from '../../client/src/base58.mjs';
import { FrontierAddresses, ringOf } from '../../client/src/frontier/addresses.mjs';
import { decodeAccount, layoutOf } from '../../client/src/frontier/codec.mjs';
import { profileForSeason } from '../../client/src/frontier/profile.mjs';
import { Deriver } from './achievements.mjs';
import { FLAG_KEEPS_DEFAULTS, FLAG_KEEPS_RULESET, FLAG_KEEPS_RULESET_V1, GOAL_KINDS, NATIONS, WORLD_GOALS_KIND, WORLD_GOALS_VERSION, keepFromProvince, pointsOf, simulatedVault, splitPrize, step, units } from './world-goals.mjs';
import { RESEARCH_DEFAULTS, RESEARCH_RULESET, receiptsOfLogs, researchStep, settleFirst, viewOf } from './world-research.mjs';
import { decodeNationResearch, decodeResearchWorld, nationResearchAddress, researchWorldAddress } from '../../../permutation-server/web/frontier/flocalplay-research.mjs';

export const WORLD_GOALS_MODE = FLAG_KEEPS_RULESET;
/** The words `--world-goals` takes: the ruleset, and its older name (scripts written before the v2 count; the judge is the same one). */
export const WORLD_GOALS_MODES = Object.freeze([FLAG_KEEPS_RULESET, FLAG_KEEPS_RULESET_V1]);
export const GOALS_MOUNT_PREFIX = '/goals-world/';
export const goalsMount = port => `${GOALS_MOUNT_PREFIX}${port}`;
export const WORLD_GOALS_FILE = 'world-goals.json';
export const GOALS_EVERY_MS = 3000;
export const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const SHIELD = Object.freeze({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });

/** `/goals-world/<port>/<rest>` → `{port, rest}`, or null. */
export function goalsRouteOf(pathname) {
  const m = /^\/goals-world\/(\d{5})(\/[A-Za-z0-9/_-]*)?$/.exec(pathname ?? '');
  return m ? { port: Number(m[1]), rest: m[2] ?? '/' } : null;
}

/** A JSON-RPC caller of a loopback RPC. */
export const rpcCaller = url => async (method, params) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message ?? j.error.code}`);
  return j.result;
};
const bytesOf = row => (row?.data?.[1] === 'base64' ? Uint8Array.from(Buffer.from(row.data[0], 'base64')) : null);

/**
 * The chain reader of one world: `{season(), bell(), keeps(), members(), io}` — every value read from the world's RPC
 * (and, for the keep files only, its herald). `call(method, params)` = the RPC.
 */
export function chainReader({ call, programId, seasonId, herald, fetchImpl = globalThis.fetch }) {
  const A = new FrontierAddresses({ programId, seasonId: BigInt(seasonId) });
  let profile = null, genesis = null;
  const account = async a => bytesOf((await call('getAccountInfo', [a, { encoding: 'base64', commitment: 'confirmed' }]))?.value);
  const many = async list => {
    const out = [];
    for (let i = 0; i < list.length; i += 100) out.push(...((await call('getMultipleAccounts', [list.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }]))?.value ?? []).map(bytesOf));
    return out;
  };
  return {
    addresses: A,
    get profile() { return profile; },
    async season() {
      const S = decodeAccount('Season', await account(A.season), { seasonId: A.seasonId, profile: 2 });
      profile = profileForSeason(S);
      genesis = { ts: Number(S.GENESIS_TS), bellSecs: Number(S.BELL_SECS) || 600, seed: Uint8Array.from(S.GENESIS_SEED), round: String(S.GENESIS_ROUND) };
      return genesis;
    },
    /** The chain's bell now (Clock sysvar against the Season's genesis), or null before it. */
    async bell() {
      const g = genesis ?? await this.season();
      const c = await account(CLOCK_SYSVAR);
      const unix = Number(Buffer.from(c).readBigInt64LE(32));
      return unix < g.ts ? null : Math.floor((unix - g.ts) / g.bellSecs);
    },
    /** Every keep of the opened rings, from the Province accounts. */
    async keeps() {
      if (profile === null) await this.season();
      const fr = await account(A.frontier);
      const rings = fr ? fr[64] | (fr[65] << 8) : 0;
      const at = [];
      for (let p = -rings; p <= rings; p++) for (let q = -rings; q <= rings; q++) if (ringOf(p, q) < rings) at.push([p, q]);
      const data = await many(at.map(([p, q]) => A.province(p, q)));
      const out = [], provinces = new Map();
      data.forEach((d, i) => {
        if (!d) return;
        const province = decodeAccount('Province', d, { seasonId: A.seasonId, profile });
        const k = keepFromProvince(province);
        if (k) { out.push(k); provinces.set(`${k.p},${k.q}`, { address: A.province(at[i][0], at[i][1]), province }); }
      });
      return { keeps: out, provinces };
    },
    /** Every Citizen of the season: `[{wallet, nation, joinBell}]`. */
    async members() {
      if (profile === null) await this.season();
      const L = layoutOf('Citizen', profile);
      const sid = Buffer.alloc(8); sid.writeBigUInt64LE(A.seasonId);
      const rows = await call('getProgramAccounts', [A.programId, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: base58(new TextEncoder().encode(L.magic)) } }, { memcmp: { offset: 8, bytes: base58(sid) } }] }]);
      const out = [];
      for (const r of rows ?? []) {
        try {
          const C = decodeAccount('Citizen', bytesOf(r.account), { seasonId: A.seasonId, profile });
          const wallet = base58(C.WALLET);
          if (A.citizen(wallet) !== r.pubkey) continue;
          out.push({ wallet, nation: Number(C.FACTION), joinBell: Number(C.JOIN_BELL) });
        } catch { /* not a Citizen this code reads */ }
      }
      return out.sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
    },
    /**
     * World goal ② (research): the world's research record and the six nations', or null when research was never
     * started in this world (no record).
     */
    async research() {
      const at = [researchWorldAddress(A.season, A.programId), ...Array.from({ length: NATIONS }, (_, f) => nationResearchAddress(A.season, A.programId, f))];
      const [w, ...ns] = await many(at);
      const world = w ? decodeResearchWorld(w) : null;
      if (!world) return null;
      return { world, nations: ns.map(b => (b ? decodeNationResearch(b) : null)), addresses: at };
    },
    /** The PSR1 receipts of every transaction that wrote a nation's research record (newest 1,000), oldest first. */
    async researchReceipts(address) {
      const sigs = ((await call('getSignaturesForAddress', [address, { limit: 1000, commitment: 'confirmed' }])) ?? []).filter(s => !s.err).map(s => s.signature).reverse();
      const out = [];
      for (const sig of sigs) {
        const t = await call('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
        if (t && !t.meta?.err) out.push(...receiptsOfLogs(t.meta?.logMessages ?? []));
      }
      return out;
    },
    /** The ledger reader of achievements.mjs (Deriver). */
    io: {
      account,
      transaction: async sig => { const t = await call('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); return t ? { err: t.meta?.err ?? null, slot: t.slot, logs: t.meta?.logMessages ?? [] } : null; },
      signatures: async (address, limit) => ((await call('getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }])) ?? []).map(s => s.signature),
      keep: async (p, q) => { try { const r = await fetchImpl(`${herald}/h/keep/${p},${q}.json`, { signal: AbortSignal.timeout(5000) }); return r.ok ? r.json() : null; } catch { return null; } },
    },
  };
}

const readJson = async f => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return null; } };
const jsonOut = x => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

/**
 * Settle an achievement: the contribution ledger over the counted flag keeps, the members, the SIMULATED vault and its
 * split. → the history entry (BigInts as decimal strings).
 */
export async function settle({ achieved, reader, provinces, members, operators, externals, paidOut, rules }) {
  const deriver = new Deriver({ io: reader.io, addresses: reader.addresses, profile: reader.profile ?? 3 });
  const lines = [];
  for (const k of achieved.counted) {
    const x = provinces.get(`${k.p},${k.q}`);
    if (!x) continue;
    try { lines.push(...await deriver.captureLines(x.province), ...await deriver.reinforcementLines(x.province, x.address)); } catch { /* a keep whose records cannot be read: no line */ }
  }
  const { byWallet } = pointsOf(lines, { nations: achieved.nations, rules });
  const tagged = members.map(m => ({ ...m, operator: operators.includes(m.wallet), external: externals.includes(m.wallet) }));
  const people = tagged.filter(m => !m.operator && !m.external).length;
  const vault = simulatedVault({ people, paidOut, rules });
  const split = splitPrize({ vault, nations: achieved.nations, members: tagged, points: byWallet, bell: achieved.bell, rules });
  return {
    round: achieved.round, bell: achieved.bell, readBell: achieved.readBell, nations: achieved.nations,
    counted: achieved.counted.map(k => ({ p: k.p, q: k.q, nation: k.nation, since: k.since, from: k.from, longAt: k.longAt })),
    ledger: [...byWallet].map(([wallet, w]) => ({ wallet, nation: w.nation, points: w.points, operator: operators.includes(wallet), lines: w.lines })),
    prize: { simulated: true, asset: rules.prize.asset, decimals: rules.prize.decimals, people, vaultBefore: vault, payout: split.payout, nationPart: split.nationPart, paid: split.paid, returned: split.returned, vaultAfter: vault - split.paid,
      rows: split.rows.map(r => ({ ...r, amountText: units(r.amount) })) },
  };
}

/**
 * One world's judge: reads every `every` ms, keeps its state in `<dir>/world-goals.json`. → `{answer(), tick(), stop(),
 * ports}`. `deps.call` / `deps.fetch` / `deps.now` for tests.
 */
export async function openWorldGoals({ dir, stateDir = dir, meta, heraldPort, pairPort = null, rules = FLAG_KEEPS_DEFAULTS, every = GOALS_EVERY_MS, deps = {} }) {
  if (typeof meta?.program !== 'string' || !Number.isSafeInteger(meta?.season_id) || typeof meta?.rpc_url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(meta.rpc_url)) throw Object.assign(new Error('WorldGoalsNotReady'), { code: 'WorldGoalsNotReady', status: 503 });
  const reader = chainReader({ call: deps.call ?? rpcCaller(meta.rpc_url), programId: meta.program, seasonId: meta.season_id, herald: `http://127.0.0.1:${heraldPort}`, fetchImpl: deps.fetch ?? globalThis.fetch });
  // (verify-pr198: the state lives in `stateDir` — a kept world's own home, which every start of that world shares; `dir`
  //  is this start's directory (operators.json, externals.json). A file of another world — another program or Season —
  //  is never adopted: that world's rounds and achievements are not this one's)
  const file = path.join(stateDir, WORLD_GOALS_FILE);
  const world = { program: meta.program, seasonId: String(meta.season_id) };
  const kept = await readJson(file);
  let state = kept && kept.world?.program === world.program && kept.world?.seasonId === world.seasonId ? kept.state ?? null : null;
  // (world goal ②: the research judge's own kept state — its settled world firsts)
  let rstate = kept && kept.world?.program === world.program && kept.world?.seasonId === world.seasonId ? kept.research ?? null : null;
  let research = null;
  let last = null, error = null, busy = false, stopped = false;
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const g = await reader.season();
      const bell = await reader.bell();
      if (bell === null) { error = 'BeforeGenesis'; return; }
      // (world goal ②, research: judged before the keeps and whatever they say — a world first is settled once)
      try {
        const rr = await reader.research();
        if (rr) {
          const st = researchStep(rstate, rr);
          let hist = st.state.history;
          if (st.fresh.length) {
            const ops = (await readJson(path.join(dir, 'operators.json')))?.wallets ?? [];
            const ext = (await readJson(path.join(dir, 'externals.json')))?.wallets ?? [];
            const members = await reader.members();
            const byCitizen = new Map(members.map(m => [reader.addresses.citizen(m.wallet), m.wallet]));
            const citizenWallet = c => byCitizen.get(base58(c)) ?? null;
            for (const first of st.fresh) {
              const receipts = [];
              for (const n of first.nations) receipts.push(...await reader.researchReceipts(rr.addresses[1 + n]));
              const paidOut = hist.reduce((a, h) => a + BigInt(h.prize.paid), 0n);
              hist = [...hist, JSON.parse(jsonOut(settleFirst({ first, receipts, members, operators: ops, externals: ext, paidOut, citizenWallet, rules: RESEARCH_DEFAULTS })))];
            }
          }
          rstate = { history: hist };
          research = { rr, posting: st.posting, firsts: st.firsts, problems: st.problems };
        } else research = null;
      } catch (e) { research = research ? { ...research, error: String(e?.code ?? e?.message ?? e).slice(0, 200) } : null; }
      const { keeps, provinces } = await reader.keeps();
      if (!keeps.length) { error = 'NoKeeps'; return; }
      const r = step(state, { bell, keeps, genesisSeed: g.seed }, rules);
      let next = r.state;
      if (r.achieved) {
        const ops = (await readJson(path.join(dir, 'operators.json')))?.wallets ?? [];
        const ext = (await readJson(path.join(dir, 'externals.json')))?.wallets ?? [];
        const paidOut = (state?.history ?? []).reduce((a, h) => a + BigInt(h.prize.paid), 0n);
        // (design 01 §7.2: with research judged in this world, the hegemony vault is 80 % of the prize, science 20 %)
        const frules = research ? { ...rules, prize: { ...rules.prize, hegemonyBps: RESEARCH_DEFAULTS.prize.hegemonyBpsWithScience } } : rules;
        const entry = await settle({ achieved: r.achieved, reader, provinces, members: await reader.members(), operators: ops, externals: ext, paidOut, rules: frules });
        next = { ...next, history: [...(next.history ?? []), JSON.parse(jsonOut(entry))] };
      }
      state = next;
      last = { bell, keeps, progress: r.progress, at: (deps.now ?? Date.now)(), genesisRound: g.round };
      error = null;
      await fs.writeFile(file + '.tmp', jsonOut({ v: 1, kind: WORLD_GOALS_KIND, ruleset: FLAG_KEEPS_RULESET, world, rules, state, ...(rstate ? { research: rstate } : {}) }));
      await fs.rename(file + '.tmp', file);
    } catch (e) { error = String(e?.code ?? e?.message ?? e).slice(0, 200); } finally { busy = false; }
  };
  const timer = deps.noTimer ? null : setInterval(() => { tick(); }, every);
  timer?.unref?.();
  if (!deps.noTimer) tick();
  const answer = (viewer = null) => answerOf({ meta, rules, state, last, error, research: research ? { ...research, history: rstate?.history ?? [] } : null, viewer });
  return Object.freeze({ answer, tick, ports: Object.freeze([heraldPort, ...(pairPort !== null ? [pairPort] : [])]), stop: () => { stopped = true; if (timer) clearInterval(timer); } });
}

/** The public answer (`GET …/goals/state`). */
export function answerOf({ meta, rules, state, last, error, research = null, viewer = null }) {
  const cur = state?.rounds?.at(-1) ?? null;
  const byKey = new Map((last?.keeps ?? []).map(k => [`${k.p},${k.q}`, k]));
  const flags = (cur?.flags ?? []).map(f => {
    const k = byKey.get(`${f.p},${f.q}`) ?? null;
    // (flag-keeps-v2: only a CAPTURED flag keep counts — one held by a nation it was not drawn for; a flag keep in its
    //  starting nation's hands, or without a nation, has no hold timer)
    const captured = !!k && k.holder >= 0 && k.holder < NATIONS && k.holder !== f.nation;
    const from = captured ? Math.max(k.since, cur.postedBell) : null;
    return { p: f.p, q: f.q, nation: f.nation, border: f.border, holder: k?.holder ?? null, since: k?.since ?? null, captured, from, longAt: from === null ? null : from + cur.holdBells,
      contender: k && k.contender < NATIONS ? k.contender : null, progress: k?.progress ?? 0, required: k?.required ?? 0 };
  });
  return JSON.parse(jsonOut({
    ok: true, v: WORLD_GOALS_VERSION, kind: WORLD_GOALS_KIND, ruleset: FLAG_KEEPS_RULESET, testOnly: true,
    season: { programId: meta.program, seasonId: String(meta.season_id) },
    effects: { money: 'none', chain: 'none' },
    bell: last?.bell ?? null, error,
    rules: { perNation: rules.perNation, need: rules.need, holdBells: rules.holdBells, memberBells: rules.memberBells, contribution: rules.contribution, prize: rules.prize },
    goals: GOAL_KINDS.map(g => ({ id: g.id, kind: g.kind, live: g.live || (g.id === 'world-first-tech' && !!research) })),
    // (world goal ②: null in a world where research never started. Q-RS-9 (1) (b): the pledged totals only for `?nation=`)
    research: research ? { ruleset: RESEARCH_RULESET, posting: research.posting, firsts: research.firsts, problems: research.problems, ...(research.error ? { error: research.error } : {}),
      view: viewOf(research.rr.world, research.rr.nations, viewer, { bell: last?.bell ?? null }), viewer, history: research.history } : null,
    flagKeeps: cur ? { round: cur.round, postedBell: cur.postedBell, seed: cur.seed, hash: cur.hash, need: cur.need, holdBells: cur.holdBells, flags, progress: (last?.progress ?? []).map(x => ({ nation: x.nation, held: x.held, own: x.own, captured: x.captured, capturedLong: x.capturedLong, need: x.need, reachAt: x.reachAt })) } : null,
    achievements: state?.history ?? [],
  }));
}

const reply = (res, status, body) => { res.writeHead(status, { ...SHIELD, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

/** Answer one request under a world's goals mount: GET `/goals/state` only. `entry`: openWorldGoals' answer for the world behind `port`, or null. */
export function answerWorldGoals(req, res, { entry, rest, origin }) {
  if (!entry) return reply(res, 404, { error: 'NoWorldGoals' });
  const o = req.headers.origin;
  if (o !== undefined && o !== origin) return reply(res, 403, { error: 'OriginDenied' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'MethodNotAllowed' });
  if (rest !== '/goals/state') return reply(res, 404, { error: 'NotFound' });
  // (world goal ②: `?nation=<0-5>` — the asking nation's research totals, Q-RS-9 (1) (b); anything else is refused)
  let viewer = null;
  const q = String(req.url ?? '').split('?')[1];
  if (q !== undefined) {
    const m = /^nation=([0-5])$/.exec(q);
    if (!m) return reply(res, 400, { error: 'BadQuery' });
    viewer = Number(m[1]);
  }
  return reply(res, 200, entry.answer(viewer));
}

/** Parse the launcher's TEST-only overrides: `--flag-keeps-hold <bells>`, `--flag-keeps-need <n>`, `--flag-keeps-member <bells>`. */
export function goalRulesOf({ hold, need, member } = {}) {
  const int = (v, lo, hi, code) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw Object.assign(new Error(code), { code }); return n; };
  const h = int(hold, 1, 100_000, 'InvalidFlagKeepsHold'), n = int(need, 1, NATIONS * 2, 'InvalidFlagKeepsNeed'), m = int(member, 0, 100_000, 'InvalidFlagKeepsMember');
  return Object.freeze({ ...FLAG_KEEPS_DEFAULTS, ...(h !== undefined ? { holdBells: h } : {}), ...(n !== undefined ? { need: n } : {}), ...(m !== undefined ? { memberBells: m } : {}) });
}
