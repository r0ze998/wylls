// The owner's page for an agent (docs/agent-wallet/DESIGN.md §10; test USDC
// on the local test chain, no value): one village handed to an operator-run
// agent with a prepaid budget. Everything the page sends is one of two
// things — an owner command signed by the wallet's `signMessage` (create,
// policy, mode, withdraw, rotate) or a transaction the wallet signs
// (`SetSession`, the sponsored deposit) — and everything it shows comes from
// `GET /f/agent?id=` (the relay's ledger view plus the chain's delegation).
//
// Two states the page keeps apart on purpose:
//   * the relay's mode (manual / auto): a server-side stop; the agent's
//     requests are refused at once, nothing already sent is rolled back;
//   * the chain's delegation (`SetSession`): who may sign for the village.
//     Only the owner's wallet changes it; the page shows both, and the
//     "take the key back" button is the wallet-signed SetSession followed by
//     the chain's confirmation (GET /f/tx) and a re-read of the delegation.
//
// Money shown apart: available (withdrawable now), reserved (an action or a
// model call in flight), unresolved (a model call whose result never came
// back: waits for the operator), pending withdrawal, withdrawn, spent by
// category. Pure functions first (tested), the DOM at the end.
import { html, setHtml } from '../util.mjs';
import { L, fmtNum } from '../lang.mjs';
import { toBase64, toHex } from '../sdk/bytes.mjs';
import { compileMessage, wireTransaction } from '../sdk/solana-tx.mjs';
import { decode as fromBase58 } from '../sdk/base58.mjs';
import * as io from './fchainio.mjs';
import { tokenUnits, loadPrize, faucet } from './fprize.mjs';
import { submit, track, accountsFor } from './fplay.mjs';

export const PREFIX = 'Wylls agent wallet command v1\n';
export const GROUPS = Object.freeze(['economy', 'explore', 'military', 'vigil']);
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const DECIMALS = 6;

// ------------------------------------------------------------------ pure: models

/** Base units (string) → "12.5" test USDC. */
export const usdc = v => tokenUnits(v ?? '0', DECIMALS);
/** "12.5" → base units (BigInt) or null. */
export function parseUsdc(text) {
  const m = /^\s*(\d+)(?:\.(\d{1,6}))?\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  return BigInt(m[1]) * 10n ** 6n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** The six amounts the page shows, as display strings, and what can leave now. */
export function balanceModel(view) {
  const b = view?.balance ?? {};
  const spent = b.spent ?? {};
  return {
    deposited: usdc(b.deposited), available: usdc(b.available), reserved: usdc(b.reserved), unresolved: usdc(b.unresolved ?? '0'),
    pendingWithdraw: usdc(b.pendingWithdraw), withdrawn: usdc(b.withdrawn),
    spent: { inference: usdc(spent.inference), game: usdc(spent.game), network: usdc(spent.network) },
    withdrawable: usdc(b.available), inFlight: usdc(b.reserved), heldBack: BigInt(b.reserved ?? 0) > 0n,
  };
}

const CATEGORY = { inference: () => L`判断`, game: () => L`ゲーム内`, network: () => L`手数料` };
export const categoryName = c => CATEGORY[c]?.() ?? c;

/** Why the free autopilot played instead of the model, in the owner's words (a code the page does not know is shown as is). */
const CAUSE = {
  InsufficientBalance: () => L`残高が足りない`, BudgetExceeded: () => L`合計の上限に達した`, DailyLimitReached: () => L`1日の上限に達した`,
  CallLimitReached: () => L`1日の判断回数の上限に達した`, InferenceFailed: () => L`モデルの判断が失敗した（その1回は課金）`,
};
export const causeText = c => CAUSE[c]?.() ?? c;

/** One decision line: who decided, what came of it, and what it cost (a rest is still a paid call when the model made it). */
export function decisionText(h) {
  const who = h.driver === 'model' ? L`モデル` : h.cause ? L`無料の自動運転（${causeText(h.cause)}）` : L`無料の自動運転`;
  const what = h.outcome === 'rest' ? L`何もしない（休み）` : h.outcome === 'sent' ? L`${h.action ?? ''} を送信` : h.outcome === 'refused' ? L`${h.action ?? ''} は拒否（${h.code ?? ''}）` : L`${h.action ?? ''} は失敗（${h.code ?? ''}）`;
  const cost = h.charged && h.charged !== '0' ? L`判断料 ${usdc(h.charged)}` : L`無料`;
  return L`判断：${who} → ${what}・${cost}`;
}

/**
 * Who drives the village now (the relay's `view.driver`). A stop (the owner's manual) and the free
 * autopilot standing in for the model are different things and are said differently: the first sends
 * nothing new, the second keeps playing the economy without charging.
 */
export function driverModel(view) {
  const d = view?.driver ?? { state: view?.mode === 'auto' ? 'waiting' : 'stopped' };
  let text;
  let tone = '';
  switch (d.state) {
    case 'stopped': text = L`停止中：あなたが手動に戻しました。代理人からの新しい行動は送られません。`; break;
    case 'model': text = L`モデルが判断しています（変化があったときだけ呼び、1回ごとに判断料がかかります）。`; break;
    case 'autopilot': text = d.cause ? L`無料の自動運転が代わりに動いています（${causeText(d.cause)}）。停止ではありません。止めるには手動に戻してください。` : L`無料の自動運転（ルール）で動いています。`; tone = d.cause ? 'warn' : ''; break;
    default: text = L`自動です。まだ判断していません（村に変化があったときに判断します）。`;
  }
  return { state: d.state, cause: d.cause ?? null, text, tone };
}

/** The history as rows `{at, kind, category, amount, text}`; newest first. */
export function historyRows(view) {
  const rows = [];
  for (const h of view?.history ?? []) {
    let text = null;
    switch (h.type) {
      case 'deposit': text = L`預け入れ ${usdc(h.amount)}`; break;
      case 'spend': text = h.category === 'inference' ? (h.ok === false ? L`判断（失敗も1回分）` : h.late ? L`判断（遅れて届いた結果）` : L`判断`) : h.category === 'game' ? L`ゲーム内の支払い` : L`手数料`; break;
      case 'network': text = L`手数料は運営が負担（SOL ${fmtNum(h.lamports)} lamports）`; break;
      case 'action': text = L`行動 ${h.name}：${h.status === 'sent' ? L`送信` : h.status === 'refused' ? L`拒否（${h.code ?? ''}）` : L`失敗（${h.code ?? ''}）`}`; break;
      case 'release': text = h.reason === 'operator-refund' ? L`運営が返金` : L`予約を戻した（${h.reason}）`; break;
      case 'unresolved': text = L`判断の結果が届かず、運営の確認待ち`; break;
      case 'withdraw': text = L`引き出し ${usdc(h.amount)}`; break;
      case 'withdraw-failed': text = L`引き出しが失敗（残高に戻した）`; break;
      case 'mode': text = h.mode === 'auto' ? L`自動に切り替え` : L`手動に切り替え`; break;
      case 'policy': text = L`予算と許可行動を更新`; break;
      case 'capability': text = L`接続用トークンを発行`; break;
      case 'decision': text = decisionText(h); break;
      case 'created': text = L`代理人を作成`; break;
      default: text = h.type;
    }
    // A decision's fee is the `spend` line's amount; the decision line names it in its text only, so one call is never counted twice in the amount column.
    const amount = h.type !== 'decision' && h.amount != null && h.type !== 'network' ? usdc(h.amount) : null;
    rows.push({ at: h.at, kind: h.type, category: h.type === 'decision' ? null : h.category ?? null, amount, text, source: h.source ?? null, signature: h.signature ?? null, reason: h.reason ?? null });
  }
  return rows.reverse();
}

/**
 * What the two switches mean together. `mode` is the relay's; `delegation`
 * is the chain's (`{delegated, session, expiry}`); null while unknown.
 */
export function delegationModel(view) {
  const mode = view?.mode ?? 'manual';
  const d = view?.delegation ?? null;
  const onChain = d ? !!d.delegated : null;
  let text;
  if (onChain === null) text = L`チェーン上の委任を確認しています`;
  else if (mode === 'auto' && onChain) text = L`自動で動いています。村の署名は代理人の鍵です。`;
  else if (mode === 'auto' && !onChain) text = L`自動ですが、チェーン上の委任がないので何も送れません。先に鍵を渡してください。`;
  else if (mode === 'manual' && onChain) text = L`止まっています（サーバー側）。鍵はまだ代理人のものなので、あなたが手で動かすには鍵を取り戻してください。`;
  else text = L`止まっていて、鍵はあなたのものです。`;
  return { mode, onChain, session: d?.session ?? null, expiry: d?.expiry ?? null, text, canRevoke: onChain === true, canDelegate: onChain === false };
}

/** The policy form's fields from a view, and back. */
export function policyForm(view) {
  const allowed = new Set(view?.policy?.allowed ?? []);
  const groups = { economy: ['Harvest', 'Build', 'Train', 'Muster', 'Garrison'], explore: ['Explore'], military: ['Depart', 'Dissolve'], vigil: ['SetVigil'] };
  const calls = view?.policy?.budget?.callsPerDay;
  return { groups: Object.fromEntries(GROUPS.map(g => [g, groups[g].every(a => allowed.has(a))])), total: usdc(view?.policy?.budget?.total ?? '0'), perDay: usdc(view?.policy?.budget?.perDay ?? '0'), callsPerDay: Number.isInteger(calls) ? String(calls) : '' };
}
export function parsePolicyForm({ groups, total, perDay, callsPerDay = '' }) {
  const allowed = GROUPS.filter(g => groups?.[g]);
  const t = parseUsdc(total);
  const d = parseUsdc(perDay);
  if (!allowed.length) return { ok: false, error: L`許可する行動を1つ以上選んでください` };
  if (t === null || d === null) return { ok: false, error: L`予算は数字で入れてください（例 1.5）` };
  if (d > t) return { ok: false, error: L`1日の上限は合計以下にしてください` };
  const c = String(callsPerDay ?? '').trim();
  if (c !== '' && !/^\d{1,6}$/.test(c)) return { ok: false, error: L`判断の回数は0以上の整数で入れてください（空欄なら上限なし）` };
  return { ok: true, policy: { allowed, budget: { total: t.toString(), perDay: d.toString(), ...(c !== '' ? { callsPerDay: Number(c) } : {}) } } };
}

// ------------------------------------------------------------------ pure: what the wallet signs

/** Canonical JSON (keys sorted at every level), as the relay verifies it. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** An unsigned owner command (nonce, 5 minutes). */
export function commandFor(op, { owner, agentId = null, params = {}, now = Date.now(), nonce = randomNonce() }) {
  return { op, owner, nonce, expiresAt: now + 5 * 60_000, params, ...(agentId ? { agentId } : {}) };
}
const randomNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
export const commandBytes = command => new TextEncoder().encode(PREFIX + canonical(command));

/** `{command, signature}` for POST /f/agent/command, signed by the connected wallet's `signMessage`. */
export async function signCommand(command, signMessage) {
  const out = await signMessage(commandBytes(command));
  const sig = Uint8Array.from(out?.signature ?? out ?? []);
  if (sig.length !== 64) throw Object.assign(new Error('the wallet did not return an ed25519 signature'), { code: 'SignFailed' });
  return { command, signature: toBase64(sig) };
}

const ix = (programId, keys, data) => ({ programId, keys, data });
const W = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const R = (pubkey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });
const ataOf = (owner, mint, derive) => derive(owner, mint);

/**
 * The sponsored deposit's message: `[createAtaIdempotent(custody)?, TransferChecked(owner → custody)]`
 * paid by the relay's fee payer, for the wallet to sign (`signTransaction`).
 * `ata(owner, mint)` derives associated token accounts (sdk prize.mjs `ata`).
 */
export function depositMessage({ owner, terms, amount, feePayer, blockhash, ata, createAta = true }) {
  const mint = terms.mint;
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, BigInt(amount), true);
  data[9] = DECIMALS;
  const instructions = [
    ...(createAta ? [ix(ASSOCIATED_TOKEN_PROGRAM, [W(feePayer, true), W(terms.custodyAccount), R(terms.custodyAuthority), R(mint), R(SYSTEM_PROGRAM), R(TOKEN_PROGRAM)], Uint8Array.of(1))] : []),
    ix(TOKEN_PROGRAM, [W(ataOf(owner, mint, ata)), R(mint), W(terms.custodyAccount), R(owner, true)], data),
  ];
  return compileMessage({ feePayer, recentBlockhash: blockhash, instructions });
}

// ------------------------------------------------------------------ the relay

export const loadTerms = opts => io.request('GET', '/f/agent/terms', opts);
export const loadMine = (owner, opts) => io.request('GET', `/f/agent/by-owner?owner=${encodeURIComponent(owner)}`, opts);
export const loadAgent = (id, opts) => io.request('GET', `/f/agent?id=${encodeURIComponent(id)}`, opts);
export const sendCommand = (signed, opts) => io.request('POST', '/f/agent/command', { ...opts, body: signed });

/** Build, sign (wallet) and send a sponsored deposit; returns the relay's answer. */
export async function depositViaRelay({ owner, terms, amount, ata, signTransaction, agentId, fetch: f }) {
  const info = await io.relayInfo({ fetch: f });
  if (!info.ok) return info;
  const message = depositMessage({ owner, terms, amount, feePayer: info.feePayer, blockhash: info.blockhash, ata });
  let wire;
  try { wire = await signTransaction(wireTransaction(message)); } catch (e) { return io.fail(e?.code ?? 'SignFailed', String(e?.message ?? e)); }
  if (!io.sameMessage(message, wire)) return io.fail('WalletAlteredMessage');
  return io.request('POST', '/f/agent/deposit', { fetch: f, body: { agentId, tx: toBase64(wire), lastValidBlockHeight: info.lastValidBlockHeight } });
}

/** SetSession to `sessionKey` (base58) through the relay, signed by the wallet; waits for the chain. */
export async function setSessionOnChain({ addresses, wallet, sessionKey, expiry }) {
  const accounts = accountsFor('SetSession', { addresses, wallet: wallet.address, actor: wallet.address });
  const sent = await submit({ name: 'SetSession', accounts, fields: { session: fromBase58(sessionKey), expiry: BigInt(expiry) }, signer: { wallet } });
  if (!sent.ok) return sent;
  const landed = await track(sent.signature, { tries: 80, every: 500 });
  return { ...landed, signature: sent.signature };
}

// ------------------------------------------------------------------ markup

const chip = (label, value, tone = '') => html`<div class="agent-chip${tone ? ` tone-${tone}` : ''}"><span class="k">${label}</span><span class="v">${value}</span></div>`;

export function renderBalance(view) {
  const m = balanceModel(view);
  return html`<section class="agent-card" aria-labelledby="bal-title"><h3 id="bal-title">${L`残高`}</h3>
    <div class="agent-chips">
      ${chip(L`預け入れ合計`, m.deposited)}${chip(L`いま使える`, m.available, 'good')}${chip(L`処理中の予約`, m.reserved, m.heldBack ? 'warn' : '')}
      ${chip(L`運営の確認待ち`, m.unresolved, m.unresolved !== '0' ? 'warn' : '')}${chip(L`引き出し中`, m.pendingWithdraw)}${chip(L`引き出し済み`, m.withdrawn)}
    </div>
    <p class="muted">${L`支出：判断 ${m.spent.inference} · ゲーム内 ${m.spent.game} · 手数料 ${m.spent.network}（手数料は運営が SOL で負担し、ここでは記録だけです）`}</p>
    <p class="muted">${L`引き出せるのは「いま使える」分だけです。処理中の予約と運営の確認待ちは、結果が出てから戻るか確定します。`}</p>
  </section>`;
}

export function renderPolicy(view) {
  const f = policyForm(view);
  const names = { economy: L`経済（収穫・建設・訓練・集結・守備）`, explore: L`探索`, military: L`軍事（出陣・解散）`, vigil: L`夜番` };
  return html`<section class="agent-card" aria-labelledby="pol-title"><h3 id="pol-title">${L`予算と許可する行動`}</h3>
    <form class="agent-form" data-form="policy">
      ${GROUPS.map(g => html`<label class="agent-check"><input type="checkbox" name="g-${g}" ${f.groups[g] ? 'checked' : ''}> ${names[g]}</label>`)}
      <label>${L`合計の上限（テストUSDC）`} <input name="total" value="${f.total}" inputmode="decimal"></label>
      <label>${L`1日の上限（テストUSDC）`} <input name="perDay" value="${f.perDay}" inputmode="decimal"></label>
      <label>${L`1日の判断回数の上限（空欄なら上限なし）`} <input name="callsPerDay" value="${f.callsPerDay}" inputmode="numeric"></label>
      <button type="submit" class="btn">${L`予算と行動を保存（署名）`}</button>
      <span class="muted">${L`現在の版 ${fmtNum(view?.policy?.version ?? 0)}。保存すると版が上がり、古い版で決めた行動は拒否されます。`}</span>
      <span class="muted">${L`ここにない行動（新しいゲーム機能を含む）は、あなたが許可するまで代理人には使えません。`}</span>
    </form></section>`;
}

export function renderMode(view) {
  const d = delegationModel(view);
  const auto = d.mode === 'auto';
  return html`<section class="agent-card" aria-labelledby="mode-title"><h3 id="mode-title">${L`手動 ／ 自動`}</h3>
    <p><strong>${auto ? L`自動（代理人が動く）` : L`手動（止まっている）`}</strong> <span class="muted">${L`切り替え回数 ${fmtNum(view?.modeEpoch ?? 0)}`}</span></p>
    ${(() => { const dm = driverModel(view); return html`<p class="agent-driver${dm.tone ? ` tone-${dm.tone}` : ''}" data-driver="${dm.state}">${dm.text}</p>`; })()}
    <p><button type="button" class="btn" data-act="mode" data-mode="${auto ? 'manual' : 'auto'}">${auto ? L`手動に戻す（代理人を止める）` : L`自動にする（署名）`}</button></p>
    <p class="muted">${L`手動に戻すとサーバーは代理人の新しい要求を断ります。すでに送った行動は巻き戻しません。チェーン上の鍵は別です（下）。`}</p>
  </section>`;
}

export function renderDelegation(view) {
  const d = delegationModel(view);
  return html`<section class="agent-card" aria-labelledby="del-title"><h3 id="del-title">${L`チェーン上の委任（村の鍵）`}</h3>
    <p>${d.text}</p>
    <p class="muted">${d.session ? L`いまの鍵 ${d.session.slice(0, 8)}… ${d.onChain ? L`（代理人）` : L`（あなた）`}` : ''}</p>
    <p>
      ${d.canDelegate ? html`<button type="button" class="btn" data-act="delegate">${L`鍵を代理人に渡す（ウォレット署名）`}</button>` : ''}
      ${d.canRevoke ? html`<button type="button" class="btn" data-act="revoke">${L`鍵を取り戻す（ウォレット署名）`}</button>` : ''}
    </p>
    <p class="muted">${L`どちらもウォレットで署名する取引です。送ったあと、チェーンで確定するまで待ってから表示を更新します。`}</p>
  </section>`;
}

export function renderMoney(view, { walletBalance = null } = {}) {
  const m = balanceModel(view);
  return html`<section class="agent-card" aria-labelledby="money-title"><h3 id="money-title">${L`預け入れと引き出し`}</h3>
    ${walletBalance !== null ? html`<p class="muted">${L`ウォレットのテストUSDC：${usdc(walletBalance)}`} <button type="button" class="btn quiet" data-act="faucet">${L`テストUSDCを受け取る`}</button></p>` : ''}
    <form class="agent-form inline" data-form="deposit"><label>${L`預け入れる額`} <input name="amount" value="1" inputmode="decimal"></label><button type="submit" class="btn">${L`預け入れる（ウォレット署名）`}</button></form>
    <form class="agent-form inline" data-form="withdraw"><label>${L`引き出す額`} <input name="amount" value="${m.withdrawable}" inputmode="decimal"></label><button type="submit" class="btn">${L`引き出す（署名）`}</button>
      <button type="button" class="btn quiet" data-act="withdraw-all">${L`全額引き出す（代理人は止まります）`}</button></form>
    <p class="muted">${L`引き出せるのは「いま使える」${m.withdrawable} です。処理中の予約 ${m.inFlight} は結果が出てから戻ります。全額引き出すと代理人は手動に戻ります。`}</p>
  </section>`;
}

export function renderHistory(view) {
  const rows = historyRows(view);
  return html`<section class="agent-card" aria-labelledby="hist-title"><h3 id="hist-title">${L`履歴（費目別）`}</h3>
    ${rows.length ? html`<table class="agent-history"><thead><tr><th>${L`時刻`}</th><th>${L`費目`}</th><th>${L`額`}</th><th>${L`内容`}</th></tr></thead><tbody>
      ${rows.slice(0, 60).map(r => html`<tr class="row-${r.kind}"><td>${new Date(r.at).toLocaleTimeString()}</td><td>${r.category ? categoryName(r.category) : ''}</td><td>${r.amount ?? ''}</td><td>${r.text}${r.source ? html` <span class="muted">(${r.source})</span>` : ''}${r.reason ? html`<br><span class="agent-reason">${L`理由（モデルの説明・未検証）：${r.reason}`}</span>` : ''}</td></tr>`)}
    </tbody></table>` : html`<p class="muted">${L`まだ何もありません`}</p>`}
  </section>`;
}

export function renderCapability(capability) {
  return html`<section class="agent-card tone-warn" aria-labelledby="cap-title"><h3 id="cap-title">${L`接続用トークン（この一度だけ表示）`}</h3>
    <p><code class="agent-token">${capability.token}</code></p>
    <p class="muted">${L`外部の AI や MCP にこのトークンを渡すと、許可した行動を予算の中で要求できます。作成・入金・停止・引き出しはできません。無くしたら再発行してください。`}</p>
    <p><button type="button" class="btn quiet" data-act="rotate">${L`再発行（古いトークンは無効）`}</button></p>
  </section>`;
}

// ------------------------------------------------------------------ the page

export async function mountAgentPage({ root, wallet, fsession, herald, prize }) {
  const S = { wallet: null, pin: null, terms: null, mine: [], view: null, capability: null, note: null, busy: false, walletBalance: null, session: null };
  const say = (text, tone = '') => { S.note = { text, tone }; draw(); };
  const draw = () => setHtml(root, render());
  const render = () => {
    if (!S.terms) return html`<p class="muted">${L`代理人の機能はこの中継サーバーでは有効になっていません。`}</p>`;
    const parts = [S.note ? html`<p class="agent-note${S.note.tone ? ` tone-${S.note.tone}` : ''}" role="status">${S.note.text}</p>` : ''];
    if (!S.wallet) return [...parts, html`<p><button type="button" class="btn" data-act="connect">${L`テスト用ウォレットでつなぐ`}</button></p>`];
    parts.push(html`<p class="muted">${L`ウォレット ${S.wallet.address.slice(0, 8)}…`}</p>`);
    if (!S.view) {
      parts.push(html`<section class="agent-card"><h3>${L`代理人を作る`}</h3>
        ${S.mine.length ? html`<p>${S.mine.map(a => html`<button type="button" class="btn" data-act="open" data-id="${a.agentId}">${L`村 ${a.village.join(',')}（${a.mode === 'auto' ? L`自動` : L`手動`}）`}</button> `)}</p>` : ''}
        <form class="agent-form" data-form="create"><label>${L`村（p,q,site）`} <input name="village" placeholder="3,0,0"></label>
          <label>${L`合計の上限（テストUSDC）`} <input name="total" value="1"></label><label>${L`1日の上限（テストUSDC）`} <input name="perDay" value="0.5"></label>
          <button type="submit" class="btn">${L`作成（署名）`}</button></form></section>`);
      return parts;
    }
    if (S.capability) parts.push(renderCapability(S.capability));
    parts.push(renderBalance(S.view), renderMode(S.view), renderDelegation(S.view), renderMoney(S.view, { walletBalance: S.walletBalance }), renderPolicy(S.view), renderHistory(S.view));
    return parts;
  };
  const refresh = async () => {
    if (S.view) { const v = await loadAgent(S.view.agentId); if (v.ok) S.view = v; }
    if (S.wallet && prize) { const p = await prize.loadPrize(S.wallet.address); if (p.ok && p.pool?.wallet) S.walletBalance = p.pool.wallet.balance; }
    draw();
  };
  const command = async (op, params = {}, agentId = S.view?.agentId) => {
    const signed = await signCommand(commandFor(op, { owner: S.wallet.address, agentId, params }), wallet.signMessage);
    return sendCommand(signed);
  };
  const act = {
    async connect() {
      await wallet.enableDevWallet({ cluster: S.pin.cluster, allowed: true });
      const entry = wallet.list(wallet.chainOf(S.pin.cluster)).find(w => !w.why);
      if (!entry) return say(L`使えるウォレットがありません`, 'bad');
      await wallet.connect(entry, { chain: wallet.chainOf(S.pin.cluster) });
      S.wallet = wallet.connected();
      S.session = await fsession.restore({ cluster: S.pin.cluster, programId: S.pin.programId, seasonId: S.pin.seasonId }, S.wallet.address);
      const mine = await loadMine(S.wallet.address);
      if (mine.ok) S.mine = mine.agents;
      if (S.mine.length === 1) { const v = await loadAgent(S.mine[0].agentId); if (v.ok) S.view = v; }
      await refresh();
    },
    async open(d) { const v = await loadAgent(d.id); if (v.ok) { S.view = v; S.capability = null; } draw(); },
    async mode(d) { const r = await command('mode', { mode: d.mode }); if (!r.ok) return say(r.error, 'bad'); S.view = { ...S.view, ...r.agent }; say(d.mode === 'auto' ? L`自動にしました` : L`止めました（サーバー側）`); await refresh(); },
    async rotate() { const r = await command('rotate-capability'); if (!r.ok) return say(r.error, 'bad'); S.capability = r.capability; draw(); },
    async faucet() { const r = await prize.faucet(S.wallet.address); say(r.ok ? L`テストUSDCを受け取りました` : r.error, r.ok ? '' : 'bad'); await refresh(); },
    async 'withdraw-all'() { const r = await command('withdraw', { all: true }); if (!r.ok) return say(r.error, 'bad'); say(L`引き出しを送りました（${usdc(r.withdrawal.amount)}）。代理人は手動に戻りました。`); await refresh(); },
    async delegate() { await setSession(S.view.agentKey, L`鍵を代理人に渡しました`); },
    async revoke() {
      const own = S.session?.publicKey ?? S.wallet.address;
      await setSession(own, L`鍵を取り戻しました。代理人はもう村に署名できません。`);
    },
  };
  const setSession = async (sessionKey, done) => {
    say(L`ウォレットで署名して、チェーンの確定を待っています…`);
    // Seven days of the chain's own clock (the local test world's time is not the wall clock's).
    const now = await herald.season();
    if (!now.ok) return say(L`シーズンを読めませんでした`, 'bad');
    const expiry = Number(now.record.latestUnix) + 7 * 86_400;
    const r = await setSessionOnChain({ addresses: S.pin.addresses, wallet: S.wallet, sessionKey, expiry });
    if (!r.ok) return say(r.error ?? r.code, 'bad');
    const v = await loadAgent(S.view.agentId);
    if (v.ok) S.view = v;
    say(L`${done}（確定 ${r.signature.slice(0, 8)}…）`);
  };
  const forms = {
    async create(f) {
      const village = String(f.village.value).split(',').map(s => Number(s.trim()));
      if (village.length !== 3 || !village.every(Number.isInteger)) return say(L`村は p,q,site の3つの数で入れてください`, 'bad');
      const p = parsePolicyForm({ groups: { economy: true }, total: f.total.value, perDay: f.perDay.value });
      if (!p.ok) return say(p.error, 'bad');
      const r = await command('create', { village, policy: p.policy }, null);
      if (!r.ok) return say(r.error, 'bad');
      S.view = r.agent; S.capability = r.capability; say(L`代理人を作りました。次に預け入れと鍵の受け渡しをします。`); await refresh();
    },
    async policy(f) {
      const p = parsePolicyForm({ groups: Object.fromEntries(GROUPS.map(g => [g, f[`g-${g}`].checked])), total: f.total.value, perDay: f.perDay.value, callsPerDay: f.callsPerDay.value });
      if (!p.ok) return say(p.error, 'bad');
      const r = await command('policy', { policy: p.policy });
      if (!r.ok) return say(r.error, 'bad');
      say(L`保存しました（版 ${fmtNum(r.agent.policy.version)}）`); await refresh();
    },
    async deposit(f) {
      const amount = parseUsdc(f.amount.value);
      if (amount === null || amount <= 0n) return say(L`額は数字で入れてください（例 1.5）`, 'bad');
      say(L`ウォレットで署名して、チェーンの確定を待っています…`);
      const r = await depositViaRelay({ owner: S.wallet.address, terms: S.terms, amount, ata: prize.ata, signTransaction: wallet.signTransaction, agentId: S.view.agentId });
      if (!r.ok) return say(r.error ?? r.code, 'bad');
      say(r.credited ? L`預け入れました（${usdc(r.amount)}）` : L`この取引は預け入れ済みです`); await refresh();
    },
    async withdraw(f) {
      const amount = parseUsdc(f.amount.value);
      if (amount === null || amount <= 0n) return say(L`額は数字で入れてください（例 1.5）`, 'bad');
      const r = await command('withdraw', { amount: amount.toString() });
      if (!r.ok) return say(r.error, 'bad');
      say(r.withdrawal.state === 'done' ? L`引き出しました（${usdc(r.withdrawal.amount)}）` : L`引き出しを送りました。確定を待っています。`); await refresh();
    },
  };
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]');
    if (!b || S.busy) return;
    S.busy = true;
    try { await act[b.dataset.act]?.(b.dataset); } catch (err) { say(String(err?.message ?? err), 'bad'); } finally { S.busy = false; draw(); }
  });
  root.addEventListener('submit', async e => {
    const f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    if (S.busy) return;
    S.busy = true;
    try { await forms[f.dataset.form]?.(f.elements); } catch (err) { say(String(err?.message ?? err), 'bad'); } finally { S.busy = false; draw(); }
  });
  // Pin the season from the herald, point the relay at /gw, read the terms.
  const s = await herald.season();
  if (!s.ok) { setHtml(root, html`<p class="muted">${L`シーズンを読めませんでした`}</p>`); return S; }
  // The ruleset hash picks the protocol profile the shapes are built with (the conquest world is profile 2).
  const rulesetHash = s.season?.rulesetHash ? toHex(s.season.rulesetHash) : (s.record.rulesetHash ?? null);
  S.pin = io.setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash });
  herald.pin(s.record.season, S.pin.addresses);
  const t = await loadTerms();
  S.terms = t.ok ? t : null;
  draw();
  setInterval(() => { if (!S.busy) refresh().catch(() => {}); }, 5_000);
  return S;
}
