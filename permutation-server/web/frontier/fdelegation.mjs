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

/**
 * `{agentId, agentKey, mode, village}` when the key mismatch is the owner's own agent holding the village's key,
 * otherwise null (another key, or no agent wallet on this relay: the page's usual "game key" card stays).
 */
export function delegatedTo({ sessionProblem, citizen, agents }) {
  if (sessionProblem !== 'SessionMismatch') return null;
  const session = sessionOf(citizen);
  if (!session || !Array.isArray(agents)) return null;
  const a = agents.find(x => x?.agentKey === session);
  return a ? { agentId: a.agentId, agentKey: a.agentKey, mode: a.mode === 'auto' ? 'auto' : 'manual', village: a.village ?? null } : null;
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

/** The card shown instead of "regenerate the game key" while the agent holds the village's key. */
export function renderDelegated(d) {
  const auto = d.mode === 'auto';
  return html`<section class="vcard" aria-labelledby="join-agent">${cardHead({ id: 'join-agent', ic: 'lock', title: L`代理人に任せています` })}
    <p>${auto ? L`この村の操作は、いま代理人（自動）が行っています。この端末のゲーム内の鍵では送れません。` : L`この村の鍵は、まだ代理人が持っています（代理人は停止中）。この端末のゲーム内の鍵では送れません。`}</p>
    <p>${L`自分で操作するには、鍵を取り戻します（ウォレットで署名）。`}${auto ? L`代理人はサーバー上では自動のままなので、止めるには代理人のページで「手動に戻す」を押してください。` : ''}</p>
    <div class="actions">
      <button type="button" class="btn primary" data-act="session">${L`鍵を取り戻して自分で操作する`}</button>
      <a class="btn" href="${AGENT_PAGE}" data-agent-link="1">${L`代理人のページを開く`}</a>
    </div></section>`;
}

/**
 * The line on the action bar (hud/hand.mjs) while the agent holds the key. A player who already has a village never
 * sees the drawer's join card (it opens only before land is held), so the bar they act from says it, with the same
 * take-back (the page's `session` action) and the agent page link.
 */
export function handNote(d) {
  return html`<span class="hand-agent">${icon('lock')}<span>${d.mode === 'auto' ? L`代理人に任せています（自動）。この端末の鍵では送れません。` : L`鍵はまだ代理人が持っています（代理人は停止中）。この端末の鍵では送れません。`}</span>
    <button type="button" class="btn small primary" data-act="session">${L`鍵を取り戻す`}</button>
    <a class="btn small" href="${AGENT_PAGE}" data-agent-link="1">${L`代理人のページ`}</a></span>`;
}

/** A sentence added to a refusal while the agent holds the key (the relay answers Auth: this device's key is not the session). */
export function refusalNote(delegation, code) {
  if (!delegation || (code !== 'Auth' && code !== 'SessionMismatch')) return null;
  return L`この村は代理人に任せているため、この端末の鍵では送れません。代理人のページ（「その他」）で止めるか、鍵を取り戻してから操作してください。`;
}

/** What to say after the key was taken back here while the agent is still in auto on the server. */
export function takenBackNote(delegation) {
  return delegation?.mode === 'auto' ? L`鍵を取り戻しました。代理人はサーバー上ではまだ自動です（鍵がないので何も送れず、判断料もかかりません）。止めるには代理人のページで「手動に戻す」を押してください。` : L`鍵を取り戻しました。`;
}
