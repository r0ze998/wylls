// The village handed to the owner's agent (docs/agent-wallet/PLAN-NEXT-2026-10-23.ja.md, stage 2). While the
// Citizen's session key is the agent's (the owner's SetSession on the agent page), this device's own game key no
// longer signs for the village: the play page sees `SessionMismatch`. Without this module it then offers to
// "regenerate the key", which in fact takes the key back from the agent without saying so. Here the page tells
// the two apart: when the Citizen's session key is one of the owner's agents' keys (the relay's public
// `GET /f/agent/by-owner`), it says the village is handed to the agent, links the agent page, and says what
// taking the key back here does and does not do (the agent stays in auto on the server until stopped there).
// Reads public data only; nothing is signed here (taking the key back is the page's existing `session` action).
import { html } from '../util.mjs';
import { L } from '../lang.mjs';
import { encode as toBase58 } from '../sdk/base58.mjs';
import { isOnCurve } from '../sdk/solana-tx.mjs';
import * as io from './fchainio.mjs';
import { cardHead } from './screens/parts.mjs';
import { icon } from './hud/icons.mjs';

/** The agent page, next to the play page. */
export const AGENT_PAGE = 'agent.html';
/** The owner's agents are read again at most this often while the key does not match (ms). */
export const AGENTS_REFRESH_MS = 20_000;

const sessionOf = citizen => {
  const reg = citizen?.session;
  if (!reg || (reg.every && reg.every(x => x === 0))) return null;
  return typeof reg === 'string' ? reg : toBase58(reg);
};
/** The key the Citizen registered (base58), or null when none is. */
export const registeredKey = sessionOf;
const programHeld = key => { try { return !isOnCurve(key); } catch { return false; } };
const shortKey = k => `${String(k).slice(0, 4)}…${String(k).slice(-4)}`;

/**
 * Who holds the Citizen's one session slot when it is not this device's key (Q16-3: never "no key here"):
 *  - the owner's own agent: `{agentId, agentKey, mode: 'auto' | 'manual', village}`;
 *  - any other key — ③'s courier (its session PDA, set by the owner's SetSession), another app or device:
 *    `{agentId: null, agentKey, mode: 'foreign', village: null, foreign: true, program, expired}` (`program`: the key
 *    is off the curve, so a program holds it; `expired`: the registration has run out at chain time `now`);
 *  - null when nothing is known to be held elsewhere.
 * With a device key (`hasLocalKey`, the default) that is the page's `SessionMismatch`. Without one, only what is
 * certain before the wallet signs is claimed: an agent's key, or a program's key (this wallet's own game key is
 * always on the curve); any other registered key may be this wallet's own, and the `session` action finds out.
 */
export function delegatedTo({ sessionProblem, citizen, agents, hasLocalKey = true, now }) {
  const mismatch = sessionProblem === 'SessionMismatch';
  if (!mismatch && hasLocalKey) return null;
  const session = sessionOf(citizen);
  if (!session || !Array.isArray(agents)) return null;
  const a = agents.find(x => x?.agentKey === session);
  if (a) return { agentId: a.agentId, agentKey: a.agentKey, mode: a.mode === 'auto' ? 'auto' : 'manual', village: a.village ?? null };
  const program = programHeld(session);
  if (!mismatch && !program) return null;
  const expired = now !== undefined && now !== null && citizen.sessionExpiry !== undefined && BigInt(Math.floor(now)) >= BigInt(citizen.sessionExpiry);
  return { agentId: null, agentKey: session, mode: 'foreign', village: null, foreign: true, program, expired };
}

/**
 * The page's answer to "is the key held elsewhere?" at this moment: the controller's reading (with the owner's
 * agents), else what the Citizen's record alone says — so the warning never waits for the agents to be read.
 */
export function delegationOf(FS) {
  if (!FS || FS.resident) return null;
  if (FS.delegation && (FS.sessionProblem === 'SessionMismatch' || !FS.session)) return FS.delegation;
  return delegatedTo({ sessionProblem: FS.sessionProblem, citizen: FS.citizen, agents: [], hasLocalKey: !!FS.session, now: FS.chain?.now?.() ?? undefined });
}

/**
 * The owner's agents on this relay: `{enabled, agents}` — `enabled` false when the relay has no agent wallet (or it
 * cannot be read: nothing is claimed then, and the page keeps its usual card).
 */
export async function loadAgents(owner, opts) {
  if (!owner) return { enabled: false, agents: [] };
  const r = await io.request('GET', `/f/agent/by-owner?owner=${encodeURIComponent(owner)}`, opts);
  return r.ok && Array.isArray(r.agents) ? { enabled: true, agents: r.agents } : { enabled: false, agents: [] };
}

/** The consented replacement of the registered key `d.agentKey` (the controller's `session-replace`), as a button. */
const replaceButton = (d, cls, label) => html`<button type="button" class="${cls}" data-act="session-replace" data-key="${d.agentKey ?? ''}">${label}</button>`;

/**
 * The warning shown instead of "regenerate the game key" while another key — ③'s courier, another app or device —
 * holds the Citizen's session (Q16-3). Nothing is replaced from here without the owner's own choice: keeping the
 * delegation is the first button; replacing it says what stops and that this page cannot hand it back.
 */
function renderForeign(d, { kept = false } = {}) {
  const key = shortKey(d.agentKey);
  if (kept) return html`<section class="vcard" aria-labelledby="join-agent" data-key-held="kept">${cardHead({ id: 'join-agent', ic: 'lock', title: L`別の鍵に操作を任せています` })}
    <p>${L`委任を続けています。登録されている鍵（${key}）が引き続きこの住民を操作します。この端末では見るだけです。`}</p>
    <div class="actions"><button type="button" class="btn" data-act="session-keep">${L`選び直す`}</button></div></section>`;
  return html`<section class="vcard" aria-labelledby="join-agent" data-key-held="${d.program ? 'program' : 'other'}">${cardHead({ id: 'join-agent', ic: 'lock', title: L`別の鍵に操作を任せています` })}
    <p>${L`登録されている鍵は、この端末のゲーム内の鍵と異なります。別のアプリや端末に操作を任せている可能性があります。`}</p>
    <p>${L`登録されている鍵：${key}`}${d.program ? html` ${L`この鍵は、プログラムが持つ鍵です（配送の委任など）。`}` : ''}${d.expired ? html` ${L`この鍵の期限は切れています。いまは、この鍵も操作できません。`}` : ''}</p>
    <p class="callout" role="alert">${L`自分で操作するために鍵を変更すると、現在登録されている鍵は使えなくなります。`}${L`その鍵に任せていた操作（配送の委任など）は止まります。この画面から元には戻せません。もう一度任せるには、任せた先のアプリで委任し直してください。`}</p>
    <p>${L`何もしなければ、委任はそのまま続きます。この端末では見るだけになります。`}</p>
    <div class="actions">
      <button type="button" class="btn primary" data-act="session-keep">${L`委任を続ける（鍵を変えない）`}</button>
      ${replaceButton(d, 'btn danger', L`委任を止めて自分で操作する（登録鍵を変更）`)}
    </div></section>`;
}

/** The line under "re-make the key" while a key is registered that may or may not be this wallet's own (Q16-3). */
export function keyHint() {
  return html`<p class="muted" data-key-hint="1">${L`登録されている鍵がこのウォレットのゲーム内の鍵でなければ（別のアプリや端末、配送の委任など）、置き換える前に確認します。黙って置き換えることはありません。`}</p>`;
}

/** The card shown instead of "regenerate the game key" while the agent (or another key) holds the village's key. */
export function renderDelegated(d, opts = {}) {
  if (d.foreign) return renderForeign(d, opts);
  const auto = d.mode === 'auto';
  return html`<section class="vcard" aria-labelledby="join-agent">${cardHead({ id: 'join-agent', ic: 'lock', title: L`代理人に任せています` })}
    <p>${auto ? L`この村の操作は、いま代理人（自動）が行っています。この端末のゲーム内の鍵では送れません。` : L`この村の鍵は、まだ代理人が持っています（代理人は停止中）。この端末のゲーム内の鍵では送れません。`}</p>
    <p>${L`自分で操作するには、鍵を取り戻します（ウォレットで署名）。`}${auto ? L`代理人はサーバー上では自動のままなので、止めるには代理人のページで「手動に戻す」を押してください。` : ''}</p>
    <div class="actions">
      ${replaceButton(d, 'btn primary', L`鍵を取り戻して自分で操作する`)}
      <a class="btn" href="${AGENT_PAGE}" data-agent-link="1">${L`代理人のページを開く`}</a>
    </div></section>`;
}

/**
 * The line on the action bar (hud/hand.mjs) while the agent holds the key. A player who already has a village never
 * sees the drawer's join card (it opens only before land is held), so the bar they act from says it, with the same
 * take-back (the page's `session` action) and the agent page link.
 */
export function handNote(d, { review = false, kept = false } = {}) {
  // (another key — the courier, another app or device. A village owner never sees the drawer's key card, so the bar
  //  carries the same choice: one line and "look and choose"; that opens the whole warning, with keep first and the
  //  replacement bound to the key shown. Nothing on the bar replaces the key in one press — verify-pr61 F2)
  if (d.foreign && kept) return html`<span class="hand-agent" data-key-held="kept">${icon('lock')}<span>${L`委任を続けています。登録されている鍵（${shortKey(d.agentKey)}）が引き続きこの住民を操作します。この端末では見るだけです。`}</span>
    <button type="button" class="btn small" data-act="session-keep">${L`選び直す`}</button></span>`;
  if (d.foreign && review) return html`<span class="hand-agent hand-agent-review" data-key-held="${d.program ? 'program' : 'other'}">${icon('lock')}<span><strong>${L`別の鍵に操作を任せています`}</strong> ${L`登録されている鍵：${shortKey(d.agentKey)}`}${d.program ? html` ${L`この鍵は、プログラムが持つ鍵です（配送の委任など）。`}` : ''}${d.expired ? html` ${L`この鍵の期限は切れています。いまは、この鍵も操作できません。`}` : ''}</span>
    <span class="hand-agent-warn" role="alert">${L`自分で操作するために鍵を変更すると、現在登録されている鍵は使えなくなります。`}${L`その鍵に任せていた操作（配送の委任など）は止まります。この画面から元には戻せません。もう一度任せるには、任せた先のアプリで委任し直してください。`}</span>
    <span>${L`何もしなければ、委任はそのまま続きます。この端末では見るだけになります。`}</span>
    <button type="button" class="btn small primary" data-act="session-keep">${L`委任を続ける（鍵を変えない）`}</button>
    ${replaceButton(d, 'btn small danger', L`委任を止めて自分で操作する（登録鍵を変更）`)}</span>`;
  if (d.foreign) return html`<span class="hand-agent" data-key-held="${d.program ? 'program' : 'other'}">${icon('lock')}<span>${L`別の鍵に操作を任せています（配送の委任など）。この端末の鍵では送れません。`}</span>
    <button type="button" class="btn small" data-act="session-review">${L`鍵について確かめて選ぶ`}</button></span>`;
  return html`<span class="hand-agent">${icon('lock')}<span>${d.mode === 'auto' ? L`代理人に任せています（自動）。この端末の鍵では送れません。` : L`鍵はまだ代理人が持っています（代理人は停止中）。この端末の鍵では送れません。`}</span>
    ${replaceButton(d, 'btn small primary', L`鍵を取り戻す`)}
    <a class="btn small" href="${AGENT_PAGE}" data-agent-link="1">${L`代理人のページ`}</a></span>`;
}

/** A sentence added to a refusal while the agent holds the key (the relay answers Auth: this device's key is not the session). */
export function refusalNote(delegation, code) {
  if (!delegation || (code !== 'Auth' && code !== 'SessionMismatch')) return null;
  if (delegation.foreign) return L`この住民の鍵は別の鍵（別のアプリや端末、配送の委任など）が持っているため、この端末の鍵では送れません。委任を続けるか、鍵を変更して自分で操作するかを選んでください。`;
  return L`この村は代理人に任せているため、この端末の鍵では送れません。代理人のページ（「その他」）で止めるか、鍵を取り戻してから操作してください。`;
}

/** What to say after the key was taken back here while the agent is still in auto on the server. */
export function takenBackNote(delegation) {
  if (delegation?.foreign) return L`鍵を置き換えました。これまで登録されていた鍵（${shortKey(delegation.agentKey)}）は、この住民を操作できなくなりました。もう一度任せるには、任せた先のアプリで委任し直してください。`;
  return delegation?.mode === 'auto' ? L`鍵を取り戻しました。代理人はサーバー上ではまだ自動です（鍵がないので何も送れず、判断料もかかりません）。止めるには代理人のページで「手動に戻す」を押してください。` : L`鍵を取り戻しました。`;
}
