// The three connections this workstream needs from other workstreams, as
// PROVISIONAL adapters. None of the three contracts had been received when
// this was written (2026-10-29, base 4cd901de): no workstreams/02-*, 03-*,
// 04-* exists on any branch. So each adapter below is built only from what
// the shared code already enforces, says so in its `status`, and is meant to
// be replaced by the real contract, not extended into one:
//
//   ② rights   → grantFrom(view, mandate)    over the agent wallet's policy, mode and on-chain delegation
//   ③ commands → CommandContract              over the program's instruction list and the agent gateway's paths
//   ④ Run      → RunJournal                    an append-only record of one participation, over the ActionResult
//
// No new authority is created here. The owner's mandate can only NARROW what
// the relay's policy already allows (an intersection); the relay stays the
// party that refuses (DESIGN.md §5.1). The journal records; it never decides
// that something happened without the chain's or the world's answer.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { AGENT_ACTIONS, CANDIDATES, CATALOG_S1, NEVER_DELEGATED, ixOf } from './deps.mjs';
import { GATEWAY_SOURCE } from './deps.mjs';

export const ADAPTER_STATUS = Object.freeze({
  grant: 'provisional: ② rights contract not received; reads the agent wallet policy + mode + delegation, narrowed by the owner\'s local mandate',
  command: 'provisional: ③ command contract not received; derived from the program ABI (ixOf) and the agent gateway (accountsFor)',
  run: 'provisional: ④ Run contract not received; a local append-only journal over the gateway\'s ActionResult and GET /f/tx',
});

// ------------------------------------------------------------------ ③ commands

/** Stable reasons a command cannot be carried out by the proxy agent. */
export const CMD = Object.freeze({
  UNKNOWN: 'UnknownCommand',
  NOT_DELEGABLE: 'NotDelegable',
  DECIDED_NOT_PROXY: 'DecidedNotForProxy',
  NO_AGENT_PATH: 'NoAgentPath',
  WALLET_REQUIRED: 'WalletRequired',
  NOT_IMPLEMENTED: 'NotImplemented',
  BAD_FIELDS: 'BadFields',
});

/**
 * Owner decisions recorded in docs/design/redesign/99-decisions.ja.md that
 * keep a command away from a proxy, whatever a policy says.
 */
export const DECIDED_NOT_FOR_PROXY = Object.freeze({
  Vote: '2026-10-23 決定（29-remaining-decisions E2 を採用）：代理に投票は任せない。国の投票は村の持ち主本人が行う',
});

/**
 * Things players talk about that are not commands of the program today. A
 * request for them is answered "not implemented", never mapped to a guess.
 */
export const NOT_IMPLEMENTED = Object.freeze({
  UseFacility: '施設の利用権（段階2の使用権の札）は、試遊甲では紙の札と台帳で手動運用。プログラムの命令はない',
  JoinOperation: '共同作戦への参加登録は、プログラムにも herald にもない（国の卓は未実装）',
});

/** Field ranges the proxy accepts (the runner's strict schema ranges; the program stays the rule). */
const FIELD_RANGES = Object.freeze({
  Train: { unit: [0, 5], n: [1, 10_000] },
  Build: { item: [0, 8] },
  SetVigil: { start_min: [0, 1439] },
  Harvest: {},
});

/**
 * The commands the agent gateway can build: the `case` labels of its accountsFor, read from the gateway's SOURCE TEXT.
 * Not by calling accountsFor: that derives the game's account addresses (PDAs and seeded addresses), and nothing in
 * this workstream's checks may derive an address (no key or address derivation in tests or set-up).
 */
export const GATEWAY_BUILDS = (() => {
  const at = GATEWAY_SOURCE.indexOf('export function accountsFor(');
  if (at < 0) throw new Error('the agent gateway has no accountsFor: deps.mjs must follow it');
  const body = GATEWAY_SOURCE.slice(at, GATEWAY_SOURCE.indexOf('\n}\n', at));
  return Object.freeze(new Set([...body.matchAll(/case '([A-Za-z]+)':/g)].map(m => m[1])));
})();

/** Whether the agent gateway can build this command at all (its accountsFor has a case for it). */
export function gatewayBuilds(name) { return GATEWAY_BUILDS.has(name); }

/**
 * The provisional command contract. `describe(name)` says what exists and
 * who may send it; `check(command, ctx)` says whether the proxy may send it
 * through the agent gateway now, and if not, why and what the owner would
 * have to decide. It never adds a command: an unknown name is UnknownCommand.
 */
export class CommandContract {
  constructor({ profile = 3, catalog = CATALOG_S1 } = {}) {
    this.profile = profile;
    this.catalog = catalog;
    this.status = ADAPTER_STATUS.command;
  }

  describe(name) {
    if (NOT_IMPLEMENTED[name]) return { name, exists: false, notImplemented: NOT_IMPLEMENTED[name] };
    const ix = typeof name === 'string' ? ixOf(name, this.profile) : null;
    if (!ix) return { name, exists: false };
    return {
      name, exists: true, tag: ix.tag,
      fields: (ix.data ?? []).map(f => f.name),
      agentAction: AGENT_ACTIONS.includes(name),
      neverDelegated: NEVER_DELEGATED.includes(name),
      decidedNotForProxy: DECIDED_NOT_FOR_PROXY[name] ?? null,
      agentGateway: gatewayBuilds(name, this.profile),
      proxyCandidate: Object.hasOwn(CANDIDATES, name),
    };
  }

  /**
   * @param {{name: string, fields?: object}} command
   * @param {{toOtherPlayer?: boolean}} [ctx]  for SendCaravan: whether the destination is another player's place
   * @returns {{ok: true, command} | {ok: false, code, reason, ownerDecision}}
   */
  check(command, ctx = {}) {
    const no = (code, reason, ownerDecision) => ({ ok: false, code, reason, ownerDecision });
    const name = command?.name;
    if (typeof name !== 'string' || !name) return no(CMD.UNKNOWN, '命令の名前がない', null);
    const d = this.describe(name);
    if (d.notImplemented) return no(CMD.NOT_IMPLEMENTED, `${name}: ${d.notImplemented}`, '本人が試遊の手順（札・台帳）で行うか、実装を待つ');
    if (!d.exists) return no(CMD.UNKNOWN, `${name} という命令はプログラムにない（生成しない）`, null);
    if (d.decidedNotForProxy) return no(CMD.DECIDED_NOT_PROXY, `${name}: ${d.decidedNotForProxy}`, `本人が自分の財布で ${name} するか決める`);
    if (d.neverDelegated) return no(CMD.NOT_DELEGABLE, `${name} は委任できない命令（contract.mjs NEVER_DELEGATED）`, `本人が自分の財布で ${name} するか決める`);
    if (name === 'SendCaravan' && ctx.toOtherPlayer) {
      // permutation-frontier/src/proc/caravan.rs: a send to another player needs the wallet (WalletRequired); a session key cannot.
      return no(CMD.WALLET_REQUIRED, '他のプレイヤーの村・倉への隊商は、チェーンが財布の署名を求める（caravan.rs WalletRequired）。代理の鍵では送れない', '本人がプレイ画面の隊商の欄で、宛先・荷・量を確かめて財布で署名する');
    }
    if (!d.agentAction || !d.agentGateway) {
      return no(CMD.NO_AGENT_PATH, `${name} は代理の経路（AgentGateway.accountsFor / ACTION_GROUPS）に入っていない`, `本人がプレイ画面で ${name} するか、代理の経路の拡張を判断する`);
    }
    const ranges = FIELD_RANGES[name];
    if (!ranges) return no(CMD.NO_AGENT_PATH, `${name} は代理の判断の候補（runner CANDIDATES）にない`, `本人がプレイ画面で ${name} するか決める`);
    const fields = command.fields ?? {};
    if (typeof fields !== 'object' || Array.isArray(fields)) return no(CMD.BAD_FIELDS, 'fields がオブジェクトでない', null);
    for (const k of Object.keys(fields)) if (!Object.hasOwn(ranges, k)) return no(CMD.BAD_FIELDS, `${name}: 知らない欄 ${k}`, null);
    const out = {};
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      const v = fields[k];
      if (!Number.isInteger(v) || v < lo || v > hi) return no(CMD.BAD_FIELDS, `${name}.${k} は ${lo}〜${hi} の整数`, null);
      out[k] = v;
    }
    return { ok: true, command: { name, fields: out } };
  }

  /** What a command costs from the village's stores, by the catalog (informational: the program decides). */
  costOf(command) {
    if (command?.name === 'Train') {
      const u = this.catalog.train.find(x => x.unit === command.fields?.unit);
      if (!u) return null;
      const k = Math.ceil(command.fields.n / 100);
      return Object.fromEntries(Object.entries(u.cost_per_100).map(([r, v]) => [r, v * k]));
    }
    if (command?.name === 'Build') return { ...(this.catalog.build.find(b => b.item === command.fields?.item)?.cost ?? {}) };
    return {};
  }
}

// ------------------------------------------------------------------ ② rights

/** Why the proxy holds no usable grant now. */
export const GRANT = Object.freeze({
  STOPPED: 'AgentStopped',
  NOT_DELEGATED: 'SessionNotDelegated',
  DELEGATION_UNREAD: 'DelegationUnread',
  MANDATE_MISSING: 'MandateMissing',
  MANDATE_EXPIRED: 'MandateExpired',
  MANDATE_REVOKED: 'MandateRevoked',
  MANDATE_STALE: 'MandatePolicyChanged',
  MANDATE_OTHER: 'MandateNotForThisAgent',
  VILLAGE_NOT_IN_MANDATE: 'VillageNotInMandate',
});

/**
 * The owner's mandate (目的と上限), as the owner writes it for their own
 * runner. Provisional: ② will define the real Grant. It can only narrow the
 * relay's policy, and it names the policy version it was written against so
 * that a change of the policy stops the proxy until the owner looks again.
 *
 *   { mandateId, version, agentId, basedOnPolicyVersion, purpose, nation,
 *     from: [request authors the owner follows; empty = any member of the nation],
 *     allowed: [command names], partial: bool,
 *     limits: { perRequest: {Resource: n}, perDay: {Resource: n}, troopsPerRequest },
 *     expiresAt (unix s), revokedAt (unix s | null) }
 */
export function normaliseMandate(m) {
  if (!m || typeof m !== 'object') return null;
  const nums = o => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => Number.isInteger(v) && v >= 0));
  return {
    mandateId: String(m.mandateId ?? ''), version: Number.isInteger(m.version) ? m.version : 1, agentId: String(m.agentId ?? ''),
    basedOnPolicyVersion: m.basedOnPolicyVersion, purpose: String(m.purpose ?? '').slice(0, 200), nation: m.nation ?? null,
    from: Array.isArray(m.from) ? m.from.filter(x => typeof x === 'string').slice(0, 32) : [],
    allowed: Array.isArray(m.allowed) ? m.allowed.filter(x => typeof x === 'string') : [], partial: m.partial === true,
    limits: { perRequest: nums(m.limits?.perRequest), perDay: nums(m.limits?.perDay), troopsPerRequest: Number.isInteger(m.limits?.troopsPerRequest) ? m.limits.troopsPerRequest : 0 },
    expiresAt: Number.isFinite(m.expiresAt) ? m.expiresAt : 0, revokedAt: Number.isFinite(m.revokedAt) ? m.revokedAt : null,
    // AI staking (provisional, the executor's layer): test-USDC caps per category, and the places the agent may act on.
    budget: ['perCall', 'perDay', 'total'].reduce((o, k) => ({ ...o, [k]: Object.fromEntries(Object.entries(m.budget?.[k] ?? {}).filter(([c, v]) => ['inference', 'game'].includes(c) && /^\d{1,20}$/.test(String(v))).map(([c, v]) => [c, String(v)])) }), {}),
    targets: { villages: Array.isArray(m.targets?.villages) ? m.targets.villages.filter(v => Array.isArray(v) && v.length === 3 && v.every(Number.isInteger)) : null,
      facilities: Array.isArray(m.targets?.facilities) ? m.targets.facilities.map(String).slice(0, 16) : [] },
    onBudgetLimit: m.onBudgetLimit === 'rules' ? 'rules' : 'stop',
  };
}

/**
 * The grant the proxy acts under now: the relay's view (mode, policy,
 * on-chain delegation) intersected with the owner's mandate. `ok: false`
 * carries every reason and what the owner would have to do.
 * @param {object} view     agent_view's answer (GET /f/agent: view + delegation)
 * @param {object} mandate  the owner's mandate (normaliseMandate)
 * @param {number} nowSec   the world's clock (unix seconds)
 */
export function grantFrom(view, mandate, nowSec) {
  const m = normaliseMandate(mandate);
  const reasons = [];
  const say = (code, ownerDecision) => reasons.push({ code, ownerDecision });
  if (view.mode !== 'auto') say(GRANT.STOPPED, '本人が停止した。再開するかは本人が決める');
  // The relay reads the delegation from the chain; when it could not (null), nothing decided now could be sent: wait.
  if (!view.delegation) say(GRANT.DELEGATION_UNREAD, '中継が鎖の委任を読めなかった。次の回に読み直す');
  else if (view.delegation.delegated !== true) say(GRANT.NOT_DELEGATED, '鍵の委任（SetSession）がない、または期限切れ。続けるなら本人が財布で委任し直す');
  if (!m) say(GRANT.MANDATE_MISSING, '本人が目的と上限を書く');
  else {
    if (m.agentId !== view.agentId) say(GRANT.MANDATE_OTHER, '別の代理のための委任条件。本人が書き直す');
    if (m.revokedAt !== null && m.revokedAt <= nowSec) say(GRANT.MANDATE_REVOKED, '本人が委任条件を取り消した');
    if (!(m.expiresAt > nowSec)) say(GRANT.MANDATE_EXPIRED, '委任条件の期限が切れた。続けるなら本人が期限を延ばす');
    if (m.targets.villages && !m.targets.villages.some(v => v.every((x, i) => x === view.village?.[i]))) say(GRANT.VILLAGE_NOT_IN_MANDATE, `委任条件の対象の村に、この代理の村 ${view.village?.join(',')} がない。本人が対象を書き直す`);
    if (m.basedOnPolicyVersion !== view.policy?.version) say(GRANT.MANDATE_STALE, `中継の方針が版 ${m.basedOnPolicyVersion} から ${view.policy?.version} に変わった。本人が委任条件を見直す`);
  }
  const policyAllowed = new Set(view.policy?.allowed ?? []);
  const allowed = m ? m.allowed.filter(a => policyAllowed.has(a)) : [];
  return {
    ok: reasons.length === 0, reasons, status: ADAPTER_STATUS.grant,
    allowed, deniedByPolicy: m ? m.allowed.filter(a => !policyAllowed.has(a)) : [],
    limits: m?.limits ?? { perRequest: {}, perDay: {}, troopsPerRequest: 0 }, partial: m?.partial ?? false,
    purpose: m?.purpose ?? '', nation: m?.nation ?? null, from: m?.from ?? [],
    budget: m?.budget ?? { perCall: {}, perDay: {}, total: {} }, targets: m?.targets ?? { villages: null, facilities: [] }, onBudgetLimit: m?.onBudgetLimit ?? 'stop',
    versions: { policyVersion: view.policy?.version, modeEpoch: view.modeEpoch, mandateId: m?.mandateId ?? null, mandateVersion: m?.version ?? null },
  };
}

// ------------------------------------------------------------------ ④ Run

/** The states of one contribution, in the order they can happen. Only `contributed` is a success. */
export const OUTCOME = Object.freeze({
  NEEDS_OWNER: 'needs_owner', REFUSED: 'refused', SKIPPED: 'skipped',
  ACTING: 'acting', SENT: 'sent', LANDED: 'landed', FAILED: 'failed', EXPIRED: 'expired', UNKNOWN: 'unknown',
  CONTRIBUTED: 'contributed',
});

/**
 * An append-only journal of participation runs (one JSON object per line
 * when a file is given). It is the record a restart resumes from: a step
 * written as `act-begin` without its `act-result` is an action that may
 * have been sent, and is retried under the same requestId (the gateway
 * returns the recorded result instead of sending twice).
 */
export class RunJournal {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.entries = [];
    this.status = ADAPTER_STATUS.run;
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) this.entries.push(JSON.parse(line));
    }
  }

  append(entry) {
    const e = { seq: this.entries.length + 1, at: this.now(), ...entry };
    this.entries.push(e);
    if (this.file) appendFileSync(this.file, JSON.stringify(e) + '\n');
    return e;
  }

  /** The last recorded state of a contribution (by its dedupe key), or null. */
  stateOf(key) {
    let s = null;
    for (const e of this.entries) if (e.key === key && e.outcome) s = e;
    return s;
  }

  /** Contributions that began an action and have no result: what a restart must finish. */
  unfinished() {
    const begun = new Map();
    for (const e of this.entries) {
      if (e.step === 'act-begin') begun.set(e.key, e);
      if (e.step === 'act-result' || e.step === 'verify') begun.delete(e.key);
    }
    return [...begun.values()];
  }

  /**
   * Resources committed today: every attempt begun today, unless the relay refused it or it failed before sending
   * (nothing left then). An attempt whose outcome is unknown counts (it may land), and so does one that later
   * failed on chain (conservative: the day's limit also bounds retries).
   */
  committedToday(nowSec) {
    const day = Math.floor(nowSec / 86_400);
    const nothingSent = new Set(this.entries.filter(e => e.step === 'act-result' && (e.outcome === 'refused' || e.outcome === 'failed')).map(e => e.attemptId));
    const out = {};
    for (const e of this.entries) {
      if (e.step !== 'act-begin' || !e.cost || nothingSent.has(e.attemptId)) continue;
      if (Math.floor((e.worldSec ?? 0) / 86_400) !== day) continue;
      for (const [r, v] of Object.entries(e.cost)) out[r] = (out[r] ?? 0) + v;
    }
    return out;
  }

  /**
   * The agent's memory of what it did: written only from a verified result.
   * A success that was not verified is refused here, so it cannot be
   * remembered as one by mistake.
   */
  remember(key, { outcome, verified, ...rest }) {
    if (outcome === OUTCOME.CONTRIBUTED && verified !== true) throw new Error('a contribution is remembered only once the chain and the world confirm it');
    return this.append({ step: 'memory', key, outcome, verified: verified === true, ...rest });
  }

  memory() { return this.entries.filter(e => e.step === 'memory'); }
}
