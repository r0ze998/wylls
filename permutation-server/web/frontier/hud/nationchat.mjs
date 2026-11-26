// Nation chat — the in-page talk space of one's own nation (owner Q-PT-11 (a), 2026-11-26: the production shape; Q-PT-12:
// operators review reports, personal mute, 3 messages per turn and 40 per day per player, no links, 7-day expiry,
// operators can delete). The herald keeps and checks everything (frontier-node/crates/herald/src/chat.rs); this file is
// the page's side:
//   - every message is signed by the player's WALLET over the herald's exact text (postText; byte for byte the herald's
//     `post_message`), with the herald's own current turn and a fresh nonce;
//   - reading takes one wallet signature for a read token of at most 12 hours (readText; the herald's `read_message`),
//     asked only when the player opens the chat and presses the button that says so; the token lives in memory only;
//   - only one's own nation is ever asked for, and the herald answers only its members (no other nation can read);
//   - mute is personal and local (this browser only, per world); report sends the message id and a reason;
//   - the panel is its own DOM (not the drawer's markup): a toggle in the header strip, a region with a heading, the
//     rules, a log (role="log", polite), a labelled composer (Enter sends, Shift+Enter a new line, Esc closes) and a
//     status line. Every text from a player is set as text, never as markup.
// Shown only when the herald says the chat is on (`/h/chat/info`; 404 = off: nothing drawn) and for the world this page
// is pinned to.
import { L, lang, onLangChange } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';

export const POST_DOMAIN = 'WYLLS nation chat message v1';
export const READ_DOMAIN = 'WYLLS nation chat read v1';
const READ_NOTE = 'Only members of this nation can read its chat. This signature lets this browser read and report messages there until the time above. It cannot post, move tokens or act in the game.';
export const MAX_CHARS = 280, MAX_BYTES = 1024, MAX_LINES = 6;
/** The read token asked for (the herald accepts at most 12 h). */
export const TOKEN_SECS = 6 * 3600;
export const MUTE_PREFIX = 'ps-nation-chat-mute:';
export const REASONS = Object.freeze(['spam', 'abuse', 'link', 'other']);

/** The exact text a wallet signs to post (the herald's `post_message`). */
export const postText = ({ world, program }, nation, turn, nonce, wallet, text) =>
  `${POST_DOMAIN}\nWorld: ${world}\nProgram: ${program}\nNation: ${nation}\nTurn: ${turn}\nNonce: ${nonce}\nWallet: ${wallet}\nText:\n${text}`;
/** The exact text a wallet signs for a read token (the herald's `read_message`). */
export const readText = ({ world, program }, nation, wallet, issued, expires) =>
  `${READ_DOMAIN}\nWorld: ${world}\nProgram: ${program}\nNation: ${nation}\nWallet: ${wallet}\nIssued: ${issued}\nExpires: ${expires}\n${READ_NOTE}`;

// ------------------------------------------------------------------ the text rules (as the herald's; it checks again)
const TLDS = new Set(['com', 'net', 'org', 'io', 'gg', 'me', 'co', 'xyz', 'app', 'dev', 'info', 'biz', 'jp', 'ru', 'cn', 'uk', 'de',
  'fr', 'tv', 'ly', 'link', 'site', 'online', 'top', 'club', 'shop', 'live', 'store', 'tech', 'pro', 'fun', 'icu',
  'vip', 'win', 'bid', 'page', 'art', 'cc', 'ws', 'to', 'sh', 'ai', 'gl', 'us', 'eu', 'kr', 'tw', 'hk', 'sg', 'in',
  'br', 'es', 'it', 'nl', 'pl', 'ch', 'se', 'no', 'fi', 'au', 'ca', 'mx', 'ar', 'id', 'ph', 'vn', 'th', 'my', 'nz',
  'ie', 'be', 'at', 'dk', 'cz', 'pt', 'gr', 'tr', 'ua', 'za', 'edu', 'gov', 'mil', 'int', 'mobi', 'name', 'one',
  'world', 'space', 'website', 'click', 'email', 'cloud', 'today', 'news', 'blog', 'game', 'games', 'lol', 'su']);
const SWAPS = [['(dot)', '.'], ['[dot]', '.'], ['{dot}', '.'], ['<dot>', '.'], ['(.)', '.'], ['[.]', '.'], ['{.}', '.'],
  [' dot ', '.'], ['\u30C9\u30C3\u30C8', '.'], ['(:)', ':'], ['[:]', ':'], ['(/)', '/'], ['[/]', '/'], [' . ', '.']];

function foldForLinks(t) {
  let s = '';
  for (const ch of String(t)) {
    const u = ch.codePointAt(0);
    let c = ch;
    if (u >= 0xFF01 && u <= 0xFF5E) c = String.fromCodePoint(u - 0xFEE0);
    else if ([0x3002, 0xFF61, 0x2024, 0xFE52, 0x2E31].includes(u)) c = '.';
    else if ((u >= 0x200B && u <= 0x200D) || [0x2060, 0xFEFF, 0x00AD, 0x180E].includes(u)) continue;
    else if (u === 0x3000) c = ' ';
    s += c.toLowerCase();
  }
  for (const [from, to] of SWAPS) while (s.includes(from)) s = s.split(from).join(to);
  return s;
}

/** Whether a text carries a link (the herald's `link_in`). */
export function linkIn(t) {
  const s = foldForLinks(t), tight = s.replace(/\s+/gu, '');
  for (const k of ['://', 'http:', 'https:', 'www.', 'ftp:', 'mailto:', 'javascript:', 'data:text']) if (s.includes(k) || tight.includes(k)) return true;
  for (let i = s.indexOf('.'); i >= 0; i = s.indexOf('.', i + 1)) {
    let a = i;
    while (a > 0 && /[A-Za-z0-9_-]/.test(s[a - 1])) a--;
    if (a === i) continue;
    let e = i + 1;
    while (e < s.length && /[A-Za-z0-9]/.test(s[e])) e++;
    const after = s.slice(i + 1, e);
    if (!after) continue;
    if (TLDS.has(after)) return true;
    if (/^\d+$/.test(s.slice(a, i))) {
      const quad = (s.slice(a).match(/^[\d.]+/)?.[0] ?? '').split('.');
      if (quad.length >= 4 && quad.slice(0, 4).every(x => x && x.length <= 3)) return true;
    }
  }
  return false;
}

/** Why a text would be refused (the herald's codes), or null. */
export function textProblem(t) {
  if (typeof t !== 'string' || !t.trim()) return 'EmptyText';
  if (t !== t.trim()) return 'UntrimmedText';
  if (new TextEncoder().encode(t).length > MAX_BYTES || [...t].length > MAX_CHARS) return 'TextTooLong';
  if (t.split('\n').length > MAX_LINES) return 'TooManyLines';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/u.test(t)) return 'ControlCharacter';
  if (linkIn(t)) return 'LinkNotAllowed';
  return null;
}

/** What a refusal code means to the player. */
export function codeText(code) {
  const T = {
    EmptyText: () => L`何か書いてから送ってください`,
    UntrimmedText: () => L`前後の空白を消してから送ってください`,
    TextTooLong: () => L`長すぎます（${MAX_CHARS} 文字まで）`,
    TooManyLines: () => L`行が多すぎます（${MAX_LINES} 行まで）`,
    ControlCharacter: () => L`使えない文字が入っています`,
    LinkNotAllowed: () => L`リンクは書けません（アドレスや「ドット」の書き換えも含みます）`,
    TurnLimit: () => L`このターンはもう 3 回話しました。次のターンにまた話せます`,
    DayLimit: () => L`今日はもう 40 回話しました。明日またどうぞ`,
    StaleTurn: () => L`ターンが変わりました。もう一度送ってください`,
    Replay: () => L`同じ発言がもう届いています`,
    BadSignature: () => L`署名を確かめられませんでした。もう一度試してください`,
    TokenExpired: () => L`読むための署名の期限が切れました。もう一度開いてください`,
    NotACitizen: () => L`この世界の住民ではありません。国に加わると話せます`,
    NotJoined: () => L`国に加わると話せます`,
    NoNation: () => L`国に加わると話せます`,
    NotThisNation: () => L`この国の住民ではなくなりました`,
    Expelled: () => L`国を追放されているため、国の話し合いには加われません`,
    ReportLimit: () => L`今日はこれ以上通報できません`,
    OwnMessage: () => L`自分の発言は通報できません`,
    NoSuchMessage: () => L`その発言はもうありません`,
    SlowDown: () => L`少し待ってから試してください`,
    NoClockYet: () => L`世界の時計がまだ読めません。少し待ってください`,
    WalletRefused: () => L`ウォレットで署名されませんでした`,
    WalletAlteredMessage: () => L`ウォレットが署名した文面が違います`,
    NoWallet: () => L`ウォレットをつなぐと話せます`,
    network: () => L`つながりませんでした。少し待ってから試してください`,
  };
  return (T[code] ?? (() => L`送れませんでした（${code ?? '?'}）`))();
}

/** `AbCd…WxYz`. */
export const shortWallet = w => (typeof w === 'string' && w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : String(w ?? ''));

// ------------------------------------------------------------------ mute (this browser only)
export const muteKey = ({ program, world }) => `${MUTE_PREFIX}${program}:${world}`;
export function loadMuted(storage, info) {
  try { const v = JSON.parse(storage?.getItem?.(muteKey(info)) ?? '[]'); return new Set(Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 64) : []); } catch { return new Set(); }
}
export function saveMuted(storage, info, set) { try { storage?.setItem?.(muteKey(info), JSON.stringify([...set].slice(0, 1000))); } catch { /* not kept */ } }

// ------------------------------------------------------------------ the client
const b64 = bytes => { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };
const hex = bytes => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');

/**
 * The herald's chat at `base` ('' = this origin): `{info, open, read, post, report}`. `wallet()` → `{address, signMessage}`
 * (signMessage(bytes) → {signature}), `nation()` → the page's nation for the viewer or null, `now()` → unix ms.
 */
export function createChatClient({ base = '', fetch: f = (...a) => globalThis.fetch(...a), wallet, nation, now = () => Date.now(), random = n => globalThis.crypto.getRandomValues(new Uint8Array(n)) }) {
  let token = null;
  const call = async (method, path, body) => {
    let r;
    try { r = await f(`${base}${path}`, method === 'GET' ? { cache: 'no-store' } : { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } catch { return { ok: false, code: 'network' }; }
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    if (r.status === 404 && j?.code === 'ChatOff') return { ok: false, code: 'ChatOff', off: true };
    if (!r.ok || !j || j.ok !== true) return { ok: false, code: j?.code ?? `HTTP${r.status}`, status: r.status };
    return j;
  };
  const sign = async text => {
    const w = wallet();
    if (!w?.address || typeof w.signMessage !== 'function') throw Object.assign(new Error('no wallet'), { code: 'NoWallet' });
    const bytes = new TextEncoder().encode(text);
    let out;
    try { out = await w.signMessage(bytes); } catch { throw Object.assign(new Error('refused'), { code: 'WalletRefused' }); }
    // (a wallet that signed something else than the text shown — a prefix, another encoding — is not used)
    const signed = out?.signedMessage?.length ? Uint8Array.from(out.signedMessage) : bytes;
    if (signed.length !== bytes.length || signed.some((x, i) => x !== bytes[i])) throw Object.assign(new Error('altered'), { code: 'WalletAlteredMessage' });
    const sig = Uint8Array.from(out?.signature ?? []);
    if (sig.length !== 64) throw Object.assign(new Error('refused'), { code: 'WalletRefused' });
    return { address: w.address, signature: b64(sig) };
  };
  const tokenValid = () => token && token.expires - 60 > now() / 1000 && token.wallet === wallet()?.address && token.nation === nation();
  return {
    info: () => call('GET', '/h/chat/info'),
    get token() { return tokenValid() ? token : null; },
    forget() { token = null; },
    /** One wallet signature for reading (asked only from a press). */
    async open(info) {
      if (tokenValid()) return token;
      const n = nation();
      if (!Number.isInteger(n)) throw Object.assign(new Error('no nation'), { code: 'NoNation' });
      const issued = Math.floor(now() / 1000), expires = issued + TOKEN_SECS;
      const w = wallet();
      const s = await sign(readText(info, n, w?.address, issued, expires));
      token = { wallet: s.address, nation: n, issued, expires, signature: s.signature };
      return token;
    },
    read: after => call('POST', '/h/chat/read', { token, ...(after ? { after } : {}) }),
    report: (id, reason) => call('POST', '/h/chat/report', { token, id, reason }),
    /** Post `text` (already checked): the herald's turn first, then the wallet's signature. */
    async post(info, text) {
      const n = nation();
      const fresh = await call('GET', '/h/chat/info');
      if (!fresh.ok) return fresh;
      if (!Number.isInteger(fresh.turn)) return { ok: false, code: 'NoClockYet' };
      const nonce = hex(random(16));
      let s;
      try { s = await sign(postText(info, n, fresh.turn, nonce, wallet()?.address, text)); } catch (e) { return { ok: false, code: e.code ?? 'WalletRefused' }; }
      return call('POST', '/h/chat/post', { wallet: s.address, nation: n, turn: fresh.turn, nonce, text, signature: s.signature });
    },
  };
}

/** The ws:// (wss://) address of the chat socket of `base` ('' = this page's origin). */
export function socketUrl(base, loc = globalThis.location) {
  const u = new URL('/h/chat/ws', base || loc?.href || 'http://localhost/');
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

// ------------------------------------------------------------------ the panel

function el(doc, tag, attrs = {}, text = null) {
  const e = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : String(v));
  if (text !== null) e.textContent = text;
  return e;
}

/**
 * (fix-loop24, loop-play24 BREAK-1) Where the chat may be shown now, from the page's own marks (app.mjs): never while
 * the title stands (`body[data-title="up"]`, the aria-modal title card at z 50 — the panel opened under it, unseen, and
 * the keyboard went in), and beside a wide document (a battle report, a practice battle: `body[data-doc="wide"]`) only
 * when the screen has room for both side by side (frontier.css: the document moves left by the panel's width) — the
 * panel stood over the practice sheet's result column. → `{toggle, panel}` booleans.
 */
export const CHAT_BESIDE_DOC_MIN = 1100;
export function chatPlacement(body, width) {
  const title = body?.dataset?.title === 'up', doc = body?.dataset?.doc === 'wide';
  return { toggle: !title, panel: !title && !(doc && !(Number(width) >= CHAT_BESIDE_DOC_MIN)) };
}

/**
 * Mount the chat: a toggle placed before `anchor` (the header's language box) and a panel in `host`. `state()` →
 * `{wallet, nation, world, program}` of the page (world = the page's pinned Season id, program its pinned program).
 * `placement()` → `{toggle, panel}`: whether each may be shown now (default chatPlacement of the page's body).
 * → `{stop, refresh, changed, place}`. Nothing is drawn until the herald says the chat is on for this page's world.
 */
export function installNationChat({ base = '', anchor, host, state, doc = globalThis.document, storage = globalThis.localStorage, fetch, WebSocket: WS = globalThis.WebSocket, timers = globalThis, every = 30_000,
  placement = () => chatPlacement(doc?.body, doc?.defaultView?.innerWidth ?? globalThis.innerWidth) } = {}) {
  if (!doc || !host) return { stop() {}, refresh() {}, changed() {}, place() {} };
  const client = createChatClient({ base, fetch, wallet: () => state().wallet, nation: () => state().nation });
  let info = null, messages = [], muted = new Set(), sock = null, poll = null, retry = null, stopped = false, open = false, unread = 0, lastId = null, reporting = null, busy = false;
  // (fix-loop24, BREAK-1: `on` — the herald offers the chat for this page's world; `parked` — the player left it open and
  //  the page now shows something it may not cover: set aside, and back when the page allows it again)
  let on = false, parked = false;

  // the toggle (in the header strip, before the language box)
  const toggle = el(doc, 'button', { type: 'button', class: 'hud-btn nchat-toggle', id: 'nchat-toggle', 'aria-expanded': 'false', 'aria-controls': 'nchat-panel', hidden: true });
  toggle.innerHTML = '<svg class="ic" aria-hidden="true" focusable="false"><use href="art/ui/icons.svg#quill"/></svg>';
  const toggleLabel = el(doc, 'span', { class: 'nchat-toggle-label' });
  const badge = el(doc, 'span', { class: 'nchat-badge', hidden: true });
  toggle.append(toggleLabel, badge);
  if (anchor?.parentNode) anchor.parentNode.insertBefore(toggle, anchor); else host.append(toggle);

  // the panel
  const panel = el(doc, 'section', { class: 'nchat-panel', id: 'nchat-panel', role: 'region', 'aria-labelledby': 'nchat-title', hidden: true });
  const head = el(doc, 'div', { class: 'nchat-head' });
  const title = el(doc, 'h2', { id: 'nchat-title', class: 'nchat-title', tabindex: '-1' });
  const closeBtn = el(doc, 'button', { type: 'button', class: 'nchat-close' });
  closeBtn.innerHTML = '<svg class="ic" aria-hidden="true" focusable="false"><use href="art/ui/icons.svg#close"/></svg>';
  head.append(title, closeBtn);
  const rules = el(doc, 'details', { class: 'nchat-rules' });
  const rulesSum = el(doc, 'summary');
  const rulesList = el(doc, 'ul');
  rules.append(rulesSum, rulesList);
  const gate = el(doc, 'div', { class: 'nchat-gate' });
  const gateText = el(doc, 'p');
  const gateBtn = el(doc, 'button', { type: 'button', class: 'nchat-open', hidden: true });
  gate.append(gateText, gateBtn);
  // (the live region is a plain box around the list: role="log" on the <ol> itself would take away its list semantics)
  const logBox = el(doc, 'div', { class: 'nchat-log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', tabindex: '0' });
  const log = el(doc, 'ol', { class: 'nchat-list' });
  logBox.append(log);
  const empty = el(doc, 'p', { class: 'nchat-empty', hidden: true });
  const form = el(doc, 'form', { class: 'nchat-form', hidden: true, novalidate: true });
  const label = el(doc, 'label', { for: 'nchat-text', class: 'nchat-label' });
  const text = el(doc, 'textarea', { id: 'nchat-text', rows: '2', maxlength: String(MAX_CHARS), 'aria-describedby': 'nchat-hint nchat-count', autocomplete: 'off' });
  const row = el(doc, 'div', { class: 'nchat-row' });
  const hint = el(doc, 'span', { id: 'nchat-hint', class: 'nchat-hint' });
  const count = el(doc, 'span', { id: 'nchat-count', class: 'nchat-count' });
  const send = el(doc, 'button', { type: 'submit', class: 'nchat-send' });
  row.append(hint, count, send);
  form.append(label, text, row);
  const status = el(doc, 'p', { class: 'nchat-status', role: 'status', 'aria-live': 'polite' });
  const mutedBox = el(doc, 'details', { class: 'nchat-muted', hidden: true });
  const mutedSum = el(doc, 'summary');
  const mutedList = el(doc, 'ul');
  mutedBox.append(mutedSum, mutedList);
  panel.append(head, rules, gate, logBox, empty, form, status, mutedBox);
  host.append(panel);

  const say = t => { status.textContent = t ?? ''; };
  const me = () => state().wallet?.address ?? null;
  const nationNow = () => state().nation;
  const isMember = () => Number.isInteger(nationNow()) && !!me();

  function labels() {
    toggle.setAttribute('aria-label', unread ? L`国の話し合い（新しい発言 ${unread} 件）` : L`国の話し合い`);
    toggle.title = L`国の話し合い`;
    toggleLabel.textContent = L`国の話`;
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = unread === 0;
    title.textContent = Number.isInteger(nationNow()) ? L`国の話し合い — ${factionName(nationNow())}` : L`国の話し合い`;
    closeBtn.setAttribute('aria-label', L`国の話し合いを閉じる`);
    rulesSum.textContent = L`この場のきまり`;
    rulesList.replaceChildren(...[
      L`読めるのは、あなたの国の住民だけです。ほかの国には見えません。`,
      L`話せるのは 1 ターンに 3 回、1 日に 40 回までです。`,
      L`リンク（アドレス）は書けません。${MAX_CHARS} 文字までです。`,
      L`発言は 7 日たつと消えます。`,
      L`困る発言は「通報」できます。運営が通報を確かめ、発言を消すことがあります。`,
      L`「ミュート」はその人の発言をこのブラウザで隠すだけです。相手には伝わりません。`,
      L`発言には、あなたのウォレットのアドレスが添えられます。名前や連絡先は書かないでください。`,
    ].map(t => el(doc, 'li', {}, t)));
    label.textContent = L`国への発言`;
    hint.textContent = L`Enter で送る・Shift+Enter で改行`;
    send.textContent = L`送る`;
    gateBtn.textContent = L`国の話し合いを開く（ウォレットで 1 回署名）`;
    empty.textContent = L`まだ発言はありません。国のみんなにあいさつしてみましょう。`;
    mutedSum.textContent = L`ミュート中の人（${muted.size}）`;
    counter();
    drawGate();
    drawLog();
    drawMuted();
  }
  function counter() {
    const n = [...text.value].length;
    count.textContent = `${n}/${MAX_CHARS}`;
    count.classList.toggle('over', n > MAX_CHARS);
  }
  function drawGate() {
    const have = !!client.token;
    if (!me()) { gateText.textContent = codeText('NoWallet'); gateBtn.hidden = true; }
    else if (!Number.isInteger(nationNow())) { gateText.textContent = L`国に加わると、その国の住民どうしで話せます。`; gateBtn.hidden = true; }
    else if (!have) { gateText.textContent = L`読むには、ウォレットで 1 回署名します（${TOKEN_SECS / 3600} 時間有効）。署名は読むためだけに使われ、トークンを動かすことはできません。`; gateBtn.hidden = false; }
    else { gateText.textContent = ''; gateBtn.hidden = true; }
    gate.hidden = have && isMember();
    form.hidden = !(have && isMember());
    logBox.hidden = !(have && isMember());
  }
  function drawMuted() {
    mutedBox.hidden = muted.size === 0;
    mutedList.replaceChildren(...[...muted].map(w => {
      const li = el(doc, 'li');
      const b = el(doc, 'button', { type: 'button', class: 'nchat-unmute', 'data-wallet': w }, L`${shortWallet(w)} のミュートを解く`);
      // (the pressed button goes away with the list: the keyboard is put back on the list's summary, else the composer)
      b.addEventListener('click', () => { muted.delete(w); saveMuted(storage, info, muted); say(L`${shortWallet(w)} のミュートを解きました`); labels(); (muted.size ? mutedSum : text).focus?.(); });
      li.append(b);
      return li;
    }));
  }
  // (keyed: only what changed is added, moved or removed — the log is a live region, and a screen reader announces each
  //  added item; redrawing the whole list would announce every message again)
  const nodes = new Map();
  function itemOf(m) {
    const li = el(doc, 'li', { class: 'nchat-msg', 'data-id': m.id, ...(m.wallet === me() ? { 'data-own': '1' } : {}) });
    const who = el(doc, 'span', { class: 'nchat-who', title: m.wallet }, m.wallet === me() ? L`あなた（${shortWallet(m.wallet)}）` : shortWallet(m.wallet));
    const when = el(doc, 'span', { class: 'nchat-turn' }, L`ターン ${m.turn}`);
    const body = el(doc, 'p', { class: 'nchat-text' }, m.text);
    li.append(who, when, body);
    if (m.wallet !== me()) {
      const acts = el(doc, 'span', { class: 'nchat-acts' });
      const mute = el(doc, 'button', { type: 'button', class: 'nchat-mute', 'aria-label': L`${shortWallet(m.wallet)} をミュート` }, L`ミュート`);
      mute.addEventListener('click', () => { muted.add(m.wallet); saveMuted(storage, info, muted); say(L`${shortWallet(m.wallet)} の発言を隠しました（このブラウザだけ）`); labels(); text.focus?.(); });
      const rep = el(doc, 'button', { type: 'button', class: 'nchat-report', 'aria-expanded': reporting === m.id ? 'true' : 'false', 'aria-label': L`${shortWallet(m.wallet)} の発言を通報` }, L`通報`);
      rep.addEventListener('click', () => { reporting = reporting === m.id ? null : m.id; drawLog(); (reporting ? doc.getElementById?.(`nchat-reason-${m.id}`) : rep)?.focus?.(); });
      acts.append(mute, rep);
      li.append(acts);
      if (reporting === m.id) li.append(reportForm(m));
    }
    return li;
  }
  function drawLog() {
    const shown = messages.filter(m => !muted.has(m.wallet));
    const want = new Set(shown.map(m => m.id));
    for (const [id, n] of nodes) if (!want.has(id)) { n.li.remove(); nodes.delete(id); }
    const near = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 48;
    let prev = null;
    for (const m of shown) {
      const key = `${m.wallet === me()}|${reporting === m.id}|${lang()}`;
      let n = nodes.get(m.id);
      if (n && n.key !== key) { const li = itemOf(m); n.li.replaceWith(li); n = { li, key }; nodes.set(m.id, n); }
      if (!n) { n = { li: itemOf(m), key }; nodes.set(m.id, n); }
      const at = prev ? prev.nextSibling : log.firstChild;
      if (n.li !== at) log.insertBefore(n.li, at);
      prev = n.li;
    }
    if (near) logBox.scrollTop = logBox.scrollHeight;
    empty.hidden = !(client.token && isMember()) || shown.length > 0;
  }
  // (a redrawn message replaces the pressed control: the keyboard goes back to that message's report button)
  const backTo = id => (nodes.get(id)?.li.querySelector('.nchat-report') ?? text).focus?.();
  function reportForm(m) {
    const f = el(doc, 'div', { class: 'nchat-reportbox', role: 'group', 'aria-label': L`通報の理由` });
    const lab = el(doc, 'label', { for: `nchat-reason-${m.id}` }, L`理由`);
    const sel = el(doc, 'select', { id: `nchat-reason-${m.id}` });
    const words = { spam: L`迷惑な連投`, abuse: L`暴言・いやがらせ`, link: L`リンクや宣伝`, other: L`そのほか` };
    for (const r of REASONS) sel.append(el(doc, 'option', { value: r }, words[r]));
    const go = el(doc, 'button', { type: 'button', class: 'nchat-report-go' }, L`運営に通報する`);
    const no = el(doc, 'button', { type: 'button', class: 'nchat-report-no' }, L`やめる`);
    go.addEventListener('click', async () => {
      go.disabled = true;
      const r = await client.report(m.id, sel.value);
      reporting = null; drawLog(); backTo(m.id);
      say(r.ok ? (r.already ? L`この発言はもう通報してあります` : L`通報しました。運営が確かめます。`) : codeText(r.code));
    });
    no.addEventListener('click', () => { reporting = null; drawLog(); backTo(m.id); });
    f.append(lab, sel, go, no);
    return f;
  }

  // reading
  function take(list) {
    let added = 0;
    for (const m of list ?? []) {
      if (!m || typeof m.id !== 'string' || messages.some(x => x.id === m.id)) continue;
      messages.push(m); added++;
      if (!open && m.wallet !== me() && !muted.has(m.wallet)) unread++;
    }
    messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (messages.length > 400) messages = messages.slice(-400);
    lastId = messages.at(-1)?.id ?? lastId;
    return added;
  }
  async function readAll() {
    if (!client.token) return;
    const r = await client.read(null);
    if (stopped) return;
    if (!r.ok) { if (['TokenExpired', 'NotThisNation', 'Expelled', 'NotACitizen', 'NotJoined'].includes(r.code)) { client.forget(); closeSocket(); } say(codeText(r.code)); labels(); return; }
    messages = []; take(r.messages);
    labels();
  }
  function closeSocket() { try { sock?.close(); } catch { /* gone */ } sock = null; if (retry !== null) { timers.clearTimeout(retry); retry = null; } }
  function connect(tries = 0) {
    closeSocket();
    if (!WS || !client.token || stopped) return;
    let s;
    try { s = new WS(socketUrl(base)); } catch { return; }
    sock = s;
    s.onopen = () => s.send(JSON.stringify({ op: 'auth', token: client.token }));
    s.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.op === 'ready') tries = 0;
      else if (m.op === 'msg') { if (take([m.message])) labels(); }
      else if (m.op === 'deleted') { messages = messages.filter(x => x.id !== m.id); labels(); }
      else if (m.op === 'resync') readAll();
      else if (m.op === 'error') { say(codeText(m.code)); if (m.code !== 'AuthFirst') { client.forget(); labels(); } }
    };
    s.onclose = () => {
      if (sock !== s || stopped || !client.token) return;
      sock = null;
      retry = timers.setTimeout(() => { retry = null; readAll().then(() => connect(tries + 1)); }, Math.min(60_000, 2_000 * 2 ** tries));
    };
  }
  const startPolling = () => { if (poll === null) poll = timers.setInterval(() => { if (client.token && (!sock || sock.readyState !== 1)) readAll(); }, every); };

  // opening and closing
  // (fix-loop24, BREAK-1: the panel opens only where it can be seen — `placement()` —; the keyboard goes in only then, and
  //  comes back to the toggle when the player closes it (or to the page's body when the toggle is not shown). Nothing
  //  holds the keyboard inside: Tab leaves the panel as from any region)
  const inside = () => { const a = doc.activeElement; return !!a && a !== doc.body && panel.contains?.(a); };
  function show(want, { focus = true } = {}) {
    const can = placement() ?? {};
    const shown = !!want && on && can.panel !== false;
    open = shown;
    panel.hidden = !shown;
    toggle.setAttribute('aria-expanded', shown ? 'true' : 'false');
    if (doc.body?.dataset) { if (shown) doc.body.dataset.nchat = 'open'; else delete doc.body.dataset.nchat; }
    if (shown) { unread = 0; labels(); if (focus) (client.token ? text : (gateBtn.hidden ? title : gateBtn)).focus?.(); logBox.scrollTop = logBox.scrollHeight; }
    else { labels(); if (focus) { if (toggle.hidden) doc.activeElement?.blur?.(); else toggle.focus?.(); } }
  }
  /** Follow the page: the toggle and the panel as `placement()` allows now; an open panel set aside comes back. */
  function place() {
    if (stopped) return;
    const can = placement() ?? {};
    toggle.hidden = !(on && can.toggle !== false);
    if (open && (!on || can.panel === false)) {
      // (set aside, not closed: the keyboard is not pulled out of what the page just opened — the title focuses its own
      //  button, a report its heading —; only a focus left inside the hidden panel is let go, to the page's body)
      const had = inside();
      parked = on;
      show(false, { focus: false });
      if (had) doc.activeElement?.blur?.();
    } else if (parked && on && can.panel !== false) { parked = false; show(true, { focus: false }); }
  }
  toggle.addEventListener('click', () => { parked = false; show(!open); });
  closeBtn.addEventListener('click', () => { parked = false; show(false); });
  panel.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (reporting) { const id = reporting; reporting = null; drawLog(); backTo(id); } else { parked = false; show(false); }
  });
  gateBtn.addEventListener('click', async () => {
    if (busy) return;
    busy = true; gateBtn.disabled = true; say(L`ウォレットの署名を待っています…`);
    try { await client.open(info); say(''); await readAll(); connect(); startPolling(); labels(); text.focus?.(); } catch (e) { say(codeText(e.code)); } finally { busy = false; gateBtn.disabled = false; }
  });
  text.addEventListener('input', counter);
  text.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.dispatchEvent(new (doc.defaultView?.Event ?? Event)('submit', { cancelable: true }));
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    const t = text.value.trim();
    const bad = textProblem(t);
    if (bad) { say(codeText(bad)); return; }
    busy = true; send.disabled = true; say(L`送っています…`);
    try {
      const r = await client.post(info, t);
      if (r.ok) { text.value = ''; counter(); say(L`送りました`); if (take([r.message])) labels(); }
      else say(codeText(r.code));
    } finally { busy = false; send.disabled = false; text.focus?.(); }
  });

  // is the chat on, for this page's world?
  async function refresh() {
    const r = await client.info();
    if (stopped) return;
    if (!r.ok) { on = false; parked = false; place(); return r; }
    const s = state();
    // (a herald of another world than the page's pin: never offered — nothing would be signed for the wrong world)
    if (s.world === null || s.world === undefined || String(s.world) !== r.world || (s.program && s.program !== r.program)) { on = false; parked = false; place(); return r; }
    info = { world: r.world, program: r.program };
    muted = loadMuted(storage, info);
    on = true;
    place();
    labels();
    return r;
  }
  const offLang = onLangChange?.(() => labels()) ?? (() => {});
  // (a window made narrower or wider moves the line between "beside the document" and "set aside")
  const win = doc.defaultView ?? null, onResize = () => place();
  win?.addEventListener?.('resize', onResize);
  refresh();
  return {
    refresh,
    /** The page's state changed (wallet, nation): a token of another wallet or nation is dropped. */
    changed() { if (!client.token && sock) closeSocket(); labels(); place(); },
    /** The page's screen changed (the title, a wide document): the toggle and the panel follow `placement()`. */
    place,
    stop() { stopped = true; closeSocket(); if (poll !== null) timers.clearInterval(poll); offLang(); win?.removeEventListener?.('resize', onResize); if (doc.body?.dataset) delete doc.body.dataset.nchat; toggle.remove(); panel.remove(); },
    get client() { return client; },
  };
}
