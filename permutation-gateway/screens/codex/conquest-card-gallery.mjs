// FIXTURE DISPLAY ONLY: the siege block of the expedition card (hud/hand.mjs localConquestView) in every state, drawn
// with the page's own render function and stylesheets from states WRITTEN BY HAND below. For looking at wording and
// layout on desktop and phone widths.
//
// No wallet, no key, no signature, no relay, no chain, no world: nothing here prepares, signs or sends anything, and
// no state shown was produced by a run. Run under the no-key guard:
//
//   node --import ./permutation-gateway/screens/codex/no-key-node.mjs \
//     permutation-gateway/screens/codex/conquest-card-gallery.mjs --port 47311
//
// It binds 127.0.0.1 only and answers GET only (anything else: 405): `/gallery?lang=ja|en` is the page, every other
// path is a static file of permutation-server/web (the real stylesheets and art). It writes no file.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localConquestView } from '../../../permutation-server/web/frontier/hud/hand.mjs';
import { siegeOrderModel, cityStateModel } from '../../../permutation-server/web/frontier/fconquest-order.mjs';
import { setLang } from '../../../permutation-server/web/lang.mjs';

const WEB = fileURLToPath(new URL('../../../permutation-server/web/', import.meta.url));
const TYPES = { '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.html': 'text/html; charset=utf-8' };

/** Stand-ins, written by hand. Not a capability, not an identity, not a result. */
const A = n => String(n).repeat(44).slice(0, 44);
const WORLD = { schema: 'frontier-local-play-conquest-world-v1', program: A('P'), season: A('S'), world_preset: 'local-conquest-test-v1', free_city: { p: '129', q: '0', site: 3, tile: 43 } };
const SIG = '5KtPn1LGuxhFiwjxErkxTb7XxtLVYUBe6Cn33ej2Uw1jZ8nG7yVxQwQq3oP4rXkS2mYh9cTzD1eB6fNaJ7uRgHpL';
const DIGEST = '18edf30c5b56d1be5231a494ece88a691a361e20e15d87fe9a89eabb927f4c0a';
const idle = { status: 'idle', busy: false, host: null, digest: null, site: null, entry: null, standing: null, lastValidBlockHeight: null, requestId: null, signature: null, code: null, error: null, sent: false, chain: null, slot: null };
const held = { ...idle, host: 'fixture', site: 3, entry: 2, standing: { p: '129', q: '0' }, requestId: 'cq_fixture' };
const sent = { ...held, digest: DIGEST, lastValidBlockHeight: '250', signature: SIG, sent: true };
const STAY = { phase: 'resident' };
/** Hand-written statements of a reserved siege's facts (decision B). NO such state can be read today: no contract is published. */
const order = more => siegeOrderModel({ phase: 'ordered', site: 3, standing: { p: '129', q: '0' }, order_bell: '41', decided_bell: null, reason: null, lapsed: null, source: null, stake: 'held', slot: 'held', capture: null, day: null, ...more });
const NOREAD = { status: 'idle', busy: false, error: null, contextSlot: null, table: null, standing: null, orders: [], city: null };
const READ_AT = slot => ({ ...NOREAD, status: 'read', contextSlot: slot, table: 'present', standing: { p: '129', q: '0' } });
const city = v => cityStateModel(v);
const NOT = { phase: 'not_applied', lapsed: false, decided_bell: '41' }, GONE = { phase: 'return-pending' };
/** [title, why it matters, world, returning, view] */
const CASES = [
  ['A. closed: no world capability (TODAY)', 'What a player sees now: one line, nothing to press.', null, STAY, { state: idle, spent: false, other: false }],
  ['B. host not staying', 'Nothing is shown at all (empty by design).', WORLD, { phase: 'return-pending' }, { state: idle, spent: false, other: false }],
  ['C. offered (stand-in world): prepare', 'The first of the two presses.', WORLD, STAY, { state: idle, spent: false, other: false }],
  ['D. closed: page condition not established', 'Pressed while the heap frame is unconfirmed: the reason, and that nothing was sent.', WORLD, STAY, { state: { ...idle, status: 'error', error: 'ConquestRouteClosed' }, spent: false, other: false }],
  ['E. closed: the city is in another province', 'A capability that names a city elsewhere.', WORLD, STAY, { state: { ...idle, status: 'error', error: 'ConquestNoFreeCityHere' }, spent: false, other: false }],
  ['F. preparing', 'In progress: the button is disabled.', WORLD, STAY, { state: { ...held, status: 'preparing', busy: true }, spent: false, other: false }],
  ['G. prepared: what would be signed', 'Province, site, message digest, last valid block height; then the explicit send.', WORLD, STAY, { state: { ...held, status: 'prepared', digest: DIGEST, lastValidBlockHeight: '250' }, spent: false, other: false }],
  ['H. signing', 'In progress.', WORLD, STAY, { state: { ...held, status: 'signing', busy: true, digest: DIGEST, lastValidBlockHeight: '250' }, spent: false, other: false }],
  ['I. submitting', 'In progress.', WORLD, STAY, { state: { ...sent, status: 'submitting', busy: true }, spent: true, other: false }],
  ['J. submitted, not confirmed', 'No word of success; the look-up only.', WORLD, STAY, { state: { ...sent, status: 'submitted', chain: 'pending' }, spent: true, other: false }],
  ['K. unknown outcome', 'Said as unknown; do not send again; the look-up only.', WORLD, STAY, { state: { ...sent, status: 'unknown', error: 'LocalPlayRpcUnavailable' }, spent: true, other: false }],
  ['L. failed (the chain\'s own error)', 'A failure, with the reason; nothing changed.', WORLD, STAY, { state: { ...sent, status: 'failed', code: '{"InstructionError":[4,{"Custom":6001}]}', chain: 'failed', slot: 91 }, spent: true, other: false }],
  ['M. confirmed: the transaction is recorded, nothing more', 'Reservation or immediate siege: not known without a read, and not claimed; no capture, no ownership; the reading is used up.', WORLD, STAY, { state: { ...sent, status: 'confirmed', chain: 'confirmed', slot: 88 }, spent: true, other: false }],
  ['N. blocked by the relay: not a Free City', 'The CLI\'s closed blocker in words.', WORLD, STAY, { state: { ...held, status: 'error', error: 'TargetNotFreeCity' }, spent: false, other: false }],
  ['O. blocked by the relay: host not on the tile', 'The CLI\'s closed blocker in words.', WORLD, STAY, { state: { ...held, status: 'error', error: 'HostNotOnTarget' }, spent: false, other: false }],
  ['P. another step of this host is in flight', 'A return step is being sent or unknown: disabled, with the reason.', WORLD, STAY, { state: idle, spent: false, other: true }],
  ['Q. reading already used', 'A step was sent on this reading: read again first.', WORLD, STAY, { state: idle, spent: true, other: false }],
  ['R. order: reserved, waiting for its turn', 'HAND-WRITTEN order state. Not started; cannot be cancelled.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ day: { used: 1, limit: 2 } }) }],
  ['S. order: the siege started', 'Outcome and capture are for later turns; the city is not the player\'s.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ phase: 'started', decided_bell: '41' }) }],
  ['T. order: did not start, nothing back yet (host no longer stays)', 'General sentence, no cause (none is stored). No button; the day\'s count stays used; both WAITING.', WORLD, GONE, { state: idle, spent: false, other: false, order: order({ ...NOT }) }],
  ['U. order: did not start, slot and rent released, resources still owed', 'A kept debt: said as waiting, NOT as settled.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ ...NOT, slot: 'released' }) }],
  ['V. order: did not start, everything returned', 'Settled: resources back, slot and rent released; the day\'s count 1 / 2.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ ...NOT, stake: 'returned', slot: 'released', day: { used: 1, limit: 2 } }) }],
  ['V2. order: did not start, with a DERIVED reason', 'Only if derived from authenticated state, and marked as derived; the head stays general.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ ...NOT, reason: 'HostNotLeading' }) }],
  ['Z1. order: lapsed with the season, nothing back yet', 'Only with a verified state difference or digest replay (the receipt has no readable lapse mark): ended or interrupted; no turn, no cause; not promised to return by itself.', WORLD, GONE, { state: idle, spent: false, other: false, order: order({ phase: 'not_applied', lapsed: true }) }],
  ['Z2. order: did not take effect, how is not known', 'No basis (a record alone): nothing is said of how it ended.', WORLD, GONE, { state: idle, spent: false, other: false, order: order({ phase: 'not_applied', lapsed: null }) }],
  ['Z3. order: lapsed, slot and rent released, source Holding absent', 'The deposit stays owed; when and where it returns is not decided; NOT settled.', WORLD, GONE, { state: idle, spent: false, other: false, order: order({ phase: 'not_applied', lapsed: true, source: 'absent', slot: 'released' }) }],
  // The reservation READ (hand-written read states; nothing was read from a relay or a chain). `read` is what
  // flocalplay-conquest.mjs `localConquestReadFor` would give the card.
  ['K1. read: a reservation waiting for its turn', 'What the read-only read can show: pending. Not started, not returned.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ order_bell: '19' }), read: { ...NOREAD, status: 'read', contextSlot: '658', table: 'present', standing: { p: '129', q: '0' } } }],
  ['K2. read: did not take effect, slot and rent released, resources owed', 'Only the record\'s facts: how it ended is NOT said (no basis).', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ phase: 'not_applied', slot: 'released' }), read: { ...NOREAD, status: 'read', contextSlot: '835', table: 'present', standing: { p: '129', q: '0' } } }],
  ['K3. read: no record of this wallet for this city', 'Said as exactly that: a missing record does not tell started / returned / never reserved.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, read: { ...NOREAD, status: 'read', contextSlot: '835', table: 'present', standing: { p: '129', q: '0' } } }],
  ['K4. after switching province or wallet: the earlier read is gone', 'The read state is idle for this city: no old order, no "no reservation" line; only the button.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, read: NOREAD }],
  ['K5. read pressed while the gate is closed (TODAY)', 'The closed reason and its code; the state is not known; nothing was asked of the relay.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, read: { ...NOREAD, status: 'error', error: 'ConquestRouteClosed' } }],
  ['K6. read: the relay refused or the answer was not believed', 'An error with its code; the state is not known.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, read: { ...NOREAD, status: 'error', error: 'ConquestPrepareScopeMismatch' } }],
  // The city's PRESENT state (hand-written; `city` is what `localConquestCityFor` would give the card). Facts of now, never history.
  ['M1. city: your siege under way', 'Its own progress of its own requirement; not yours yet. No "no reservation" sentence beside it.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, city: city({ state: 'siege', site: 3, progress: 7, required: 36, declared_bell: '19' }), read: READ_AT('837') }],
  ['M2. city: capture due', 'No progress figure: the turn it is due from. Still not yours.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, city: city({ state: 'capture_due', site: 3, due_bell: '55', declared_bell: '19' }), read: READ_AT('3440') }],
  ['M3. city: you hold it now', 'A present fact from four accounts. Not "captured", not "won"; the word territory is not used.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, city: city({ state: 'owned', site: 3, slot: 2, generation: 1 }), read: READ_AT('3462') }],
  ['M4. city: your siege with a later reservation waiting', 'Both: the record\'s line and the city\'s line.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ order_bell: '23' }), city: city({ state: 'siege', site: 3, progress: 1, required: 36, declared_bell: '19' }), read: READ_AT('900') }],
  ['M5. city: another player holds it', 'Never "your"; none of their numbers.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, city: city({ state: 'other', site: 3, what: 'holding' }), read: READ_AT('3462') }],
  ['M6. city: another player\'s siege', 'Said by its kind, neutrally.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, city: city({ state: 'other', site: 3, what: 'siege' }), read: READ_AT('837') }],
  ['M7. after switching wallet, Season or province: the city state is gone', 'Idle read, no city line, no "no reservation" either: only the button.', WORLD, STAY, { state: idle, spent: false, other: false, order: null, city: null, read: NOREAD }],
  ['M8. city: your siege, the host no longer stays', 'No rules, no prepare; the city line and the read button remain.', WORLD, GONE, { state: idle, spent: false, other: false, order: null, city: city({ state: 'siege', site: 3, progress: 12, required: 36, declared_bell: '19' }), read: READ_AT('1500') }],
  ['W. order: captured (three capture facts)', 'Only from the capture receipt, the new Holding and the Citizen slot together.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ phase: 'captured', decided_bell: '47', stake: 'returned', slot: 'used', capture: { receipt: true, holding: true, slot: true } }) }],
  ['X. order: the siege failed', 'No capture; what the deposit and slot did, as facts.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ phase: 'lost', decided_bell: '45', stake: 'burnt', slot: 'released' }) }],
  ['Y. order: unreadable', 'A statement that contradicts itself (a "capture" missing a fact): neither success nor failure.', WORLD, STAY, { state: idle, spent: false, other: false, order: order({ phase: 'captured', decided_bell: '47', slot: 'used', capture: { receipt: true, holding: false, slot: true } }) }],
];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function page(lang) {
  setLang(lang);
  const cards = CASES.map(([title, why, world, returning, view]) => {
    const markup = String(localConquestView({ localPlay: { conquestWorld: world } }, returning, view));
    return `<article class="fx-case"><h2>${esc(title)}</h2><p class="fx-why">${esc(why)}</p>
      <div class="hand-pop fx-pop" data-pop="expedition" data-mode="card" role="group">${markup || '<p class="fx-empty">(nothing is rendered)</p>'}</div></article>`;
  }).join('\n');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FIXTURE: siege card states (${lang})</title><base href="/frontier/">
<link rel="stylesheet" href="frontier.css"><link rel="stylesheet" href="proto-hand.css"><link rel="stylesheet" href="conquest-hand.css"><link rel="stylesheet" href="uplift.css">
<style>
  html, body { height: auto; overflow: auto; }
  body { margin: 0; padding: 12px; }
  .fx-banner { margin: 0 0 12px; padding: 8px 12px; background: #7a1f1f; color: #fff; font: 600 14px/1.4 system-ui, sans-serif; border-radius: 6px; }
  .fx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr)); gap: 16px; align-items: start; }
  .fx-case h2 { margin: 0 0 2px; font: 700 14px/1.3 system-ui, sans-serif; color: #f3e9cf; }
  .fx-why { margin: 0 0 6px; font: 12px/1.4 system-ui, sans-serif; color: #d8cfb6; }
  .fx-empty { margin: 0; font: italic 12px/1.4 system-ui, sans-serif; opacity: .6; }
  /* the card where the page puts it is fixed above the action bar; here it stands in the flow, at its own width */
  .fx-pop { position: static !important; inset: auto !important; transform: none !important; translate: none !important; width: auto !important; max-width: 100% !important; max-height: none !important; display: block !important; visibility: visible !important; opacity: 1 !important; }
</style></head>
<body data-mode="play" data-drawer="closed" data-stage="final">
<main class="fx-grid"><p class="fx-banner" style="grid-column: 1 / -1; position: static">FIXTURE DISPLAY — states written by hand. No wallet, no key, no signature, no relay, no chain. Nothing here was prepared, signed or sent. Language: ${lang} · <a style="color:#fff" href="/gallery?lang=${lang === 'ja' ? 'en' : 'ja'}">switch</a></p>
${cards}</main></body></html>`;
}

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
if (!Number.isInteger(port) || port < 47000 || port > 47999) { console.error('--port 47000-47999'); process.exit(2); }
http.createServer(async (req, res) => {
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-fixture-display': 'no-wallet no-network no-signature' }); res.end(body); };
  if (req.method !== 'GET') return send(405, 'text/plain', 'GET only');
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/gallery') return send(200, TYPES['.html'], page(url.searchParams.get('lang') === 'en' ? 'en' : 'ja'));
  const file = path.normalize(path.join(WEB, decodeURIComponent(url.pathname)));
  if (!file.startsWith(WEB)) return send(404, 'text/plain', 'not found');
  try { send(200, TYPES[path.extname(file)] ?? 'application/octet-stream', await readFile(file)); } catch { send(404, 'text/plain', 'not found'); }
}).listen(port, '127.0.0.1', () => console.log(`fixture display: http://127.0.0.1:${port}/gallery?lang=ja`));
