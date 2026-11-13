// The fresh ECONOMY test page's script (browser). TEST ONLY: served by live-connect-fresh-economy.mjs on a loopback
// test port. It makes the page's memory-only test wallet, hands its PUBLIC key to the entry once, follows the entry's
// state, and sends each of the six commands on the player's press — each at most once, in the runner's order.
import { makeTestWallet, createEconomyRun, announced, nationsOf, sitesOf, E_ORDER } from './live-connect-fresh-economy-steps.mjs';

/** The page's element id of each command. */
export const E_IDS = Object.freeze({ Join: 'join', PlaceHome: 'placehome', Build: 'build', Train: 'train', Muster: 'muster', Harvest: 'harvest' });
const PREREQUISITE = Object.freeze(['Join', 'PlaceHome']);

/** The text of a send's outcome (never a claim beyond what the relay said). */
export function sendText(r) {
  if (!r) return '';
  if (r.sent !== true) return `not sent (${r.code ?? 'refused'}). Nothing left this page, or the relay refused it before its send.`;
  if (r.outcome === 'unknown') return `handed to the relay — outcome unknown (${r.relayCode ?? 'no answer'}). It may not have reached the test chain (for example, refused at the relay's send). It is asked about by its signature and is never sent again.\nsignature ${r.signature}`;
  return `${r.again ? 'already sent — not sent again' : 'sent once'}. It is asked about by its signature and is never sent again.\nsignature ${r.signature}`;
}
/** The text of a status answer. `pending` is not a failure: the transaction is not seen on the test chain yet. */
export function statusText(r) {
  if (!r) return '';
  const sig = `\nsignature ${r.signature}`;
  if (r.ok !== true) return `no answer (${r.code ?? 'unknown'}): the outcome is still unknown. If the test world does not answer, it may have ended without completing; nothing is asked of any other node${sig}`;
  if (r.state === 'landed') return `landed on the test chain${Number.isInteger(r.slot) ? ` (slot ${r.slot})` : ''}${sig}`;
  if (r.state === 'failed') return `the test chain refused it${sig}`;
  return `not seen yet (pending)${sig}`;
}
/**
 * What the RUNNER reported for a command, in this page's words — only from its own announcement, never more:
 * Build "accepted and queued" (complete only when a step says so), Train "in reserve", Muster "accepted: a pending
 * entry" (never a host, an army, the roster or movement), Harvest "accepted" (no amount). '' when nothing is reported.
 */
export function reportText(name, steps) {
  const of = n => announced(steps, n);
  if (name === 'Join') { const s = of('prereq-join-landed'); return s ? `the runner reports it landed: nation ${s.faction} (prerequisite)` : ''; }
  if (name === 'PlaceHome') { const s = of('prereq-place-home-landed'); return s ? `the runner reports it landed: province (${s.p}, ${s.q}) site ${s.site} (prerequisite)` : ''; }
  if (name === 'Build') {
    const s = of('build-landed'); if (!s) return '';
    const done = [of('train-landed'), of('muster-accepted'), of('harvest-landed')].some(x => x?.build_complete === true);
    return `the runner reports: accepted and queued (item ${s.item}); it completes at the first command of the village at or after done-at ${s.done_at}.${done ? '\nthe runner reports: the Build is complete.' : '\nnot reported complete yet.'}`;
  }
  if (name === 'Train') { const s = of('train-landed'); return s ? `the runner reports: ${s.n} in reserve (unit ${s.unit}; reserve ${s.reserve}).` : ''; }
  if (name === 'Muster') { const s = of('muster-accepted'); return s ? `the runner reports: accepted: a pending entry (${s.troops} troops, tile ${s.tile}). Acceptance only — nothing more is shown by this test.` : ''; }
  if (name === 'Harvest') { const s = of('harvest-landed'); return s ? `the runner reports: accepted.${s.build_complete === true ? ` The Build is complete (completed by: ${s.completed_by}).` : ''}` : ''; }
  return '';
}
/**
 * WHICH CONTROLS ARE ENABLED: `{<name>: {send, status}}` from the entry's latest state `s`, this page's public key
 * (`undefined` when its key was dropped), what this page has sent, and `stale` (the last read of the state FAILED).
 * While stale, or without a key, or when the run's wallet is another, NOTHING is enabled. Otherwise: the send button
 * of the ONE current command (the entry's `current`), if not sent yet; the status button of what was sent.
 */
export function controls(s, { address, sent, stale }) {
  const out = Object.fromEntries(E_ORDER.map(([n]) => [n, { send: false, status: false }]));
  if (stale !== false || s === null || typeof s !== 'object' || s.phase !== 'ready' || typeof address !== 'string' || s.wallet !== address) return out;
  const open = s.send === 'open' && s.world === 'running';
  for (const [n] of E_ORDER) out[n] = { send: open && s.current === n && !sent?.[n], status: !!sent?.[n] };
  return out;
}
/** What the page says about sending, from the entry's state (`stale`: the last read of it failed). */
export function sendingText(s, stale = false) {
  if (stale) return 'disabled — the entry did not answer; nothing can be sent until it answers again';
  if (s?.world === 'ended-incomplete') return `closed — the test world ended without completing${s.ended_during ? `, during: ${s.ended_during}` : ''}; nothing is asked of any other node`;
  if (s?.phase !== 'ready') return '–';
  if (s.world === 'ended') return 'closed — the test world has ended';
  if (s.ruleset === 'refused') return 'closed — the test season\'s ruleset is not the one this page builds for; nothing is sent in this run';
  if (s.send === 'closed') return 'closed — the test runner produces no more blocks; a transaction sent now would not land';
  return 'open';
}
/** The one line "what now": the current command, or what the page waits for. */
export function nowText(s, stale = false) {
  if (stale || s?.phase !== 'ready' || s.send !== 'open' || s.world !== 'running') return '–';
  if (s.current) return `${s.current}${PREREQUISITE.includes(s.current) ? ' (prerequisite)' : ''} — announced by the runner; one press, within about a minute`;
  return 'waiting for the runner\'s next announcement';
}

async function start() {
  const $ = id => document.getElementById(id), origin = location.origin;
  const log = (...a) => { const el = $('log'); el.textContent += `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}\n`; el.scrollTop = el.scrollHeight; };
  const stop = text => { $('stop').textContent = text; $('stop').hidden = false; };
  // `stale`: the last read of the entry's state failed (or none has succeeded yet): the run is given NO state and every control is off
  let wallet = null, state = null, stale = true;
  const getState = async () => { const r = await fetch('/e/state', { cache: 'no-store' }); if (r.status === 410) return { phase: 'closed', remaining_ms: 0 }; if (!r.ok) throw new Error(`state ${r.status}`); return r.json(); };
  try { wallet = await makeTestWallet(); } catch (e) { stop(`The test wallet could not be made (${e?.code ?? 'error'}). This page cannot take part.`); return; }
  $('wallet').textContent = wallet.address; log('test wallet made in this page (public key only is shown or sent)');
  addEventListener('pagehide', () => wallet.destroy(), { once: true });
  try {
    const r = await fetch('/e/wallet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ public_key: wallet.address }) });
    if (r.status === 409) stop('This run already has a wallet, and it is not this page\'s key (the page was reloaded or opened twice). This page cannot continue the run; nothing was sent.');
    else if (r.status === 410) stop('The test run has ended.');
    else if (!r.ok) stop(`The entry refused the public key (${r.status}).`);
    else log('public key handed to the entry; waiting for the runner');
  } catch { stop('The entry did not answer.'); }
  const run = createEconomyRun({ state: () => (stale ? null : state), signer: () => wallet, origin });
  const busy = new Set(), outcome = {};
  const fill = (id, items, label, value) => { const el = $(id); if (el.options.length || !items.length) return; for (const it of items) { const o = document.createElement('option'); o.value = value(it); o.textContent = label(it); el.append(o); } };
  // the player's choice for each command, read from the page's own controls
  const choice = {
    Join: () => ({ faction: Number($('join-nation').value) }),
    PlaceHome: () => { const [p, q, site] = $('placehome-site').value.split(',').map(Number); return { p, q, site }; },
    Build: () => ({ item: Number($('build-item').value) }), Train: () => ({ unit: Number($('train-unit').value) }),
    Muster: () => ({ troops: Math.trunc(Number($('muster-troops').value)), tile: Number($('muster-tile').value) }), Harvest: () => ({}),
  };
  const inputs = { Join: ['join-nation'], PlaceHome: ['placehome-site'], Build: ['build-item'], Train: ['train-unit'], Muster: ['muster-troops', 'muster-tile'], Harvest: [] };
  const paint = () => {
    const gone = wallet.destroyed !== false;
    const s = state ?? {}, mine = s.wallet === wallet.address, sent = run.sent(), c = controls(state, { address: gone ? undefined : wallet.address, sent, stale });
    if (gone && $('stop').hidden) stop('This page\'s test key was dropped (the page was left). It cannot sign any more, and a new key would not be this run\'s. Nothing more can be sent from here.');
    $('phase').textContent = s.phase ?? '–'; $('left').textContent = Number.isFinite(s.remaining_ms) ? `${Math.floor(s.remaining_ms / 1000)} s` : '–';
    if (s.note) $('note').textContent = s.note;
    $('steps').textContent = Array.isArray(s.steps) && s.steps.length ? s.steps.map(x => x.e_step).join(' → ') : '–';
    $('send').textContent = sendingText(s, stale); $('now').textContent = nowText(s, stale);
    if (s.wallet && !mine && $('stop').hidden) stop('The run\'s wallet is not this page\'s key. This page cannot continue the run.');
    if (s.phase === 'closed' && $('stop').hidden) stop('The test run has ended. Nothing more can be sent.');
    if (!stale && s.world === 'ended-incomplete' && $('stop').hidden) stop(`The test world ended without completing${s.ended_during ? `, during: ${s.ended_during}` : ''}. Nothing more can be sent, and nothing is retried against any other node.`);
    const rj = announced(s.steps, 'prereq-ready-for-join'), rp = announced(s.steps, 'prereq-ready-for-place-home'), rb = announced(s.steps, 'ready-for-build'), rt = announced(s.steps, 'ready-for-train'), rm = announced(s.steps, 'ready-for-muster');
    fill('join-nation', nationsOf(rj), n => `nation ${n}`, n => String(n));
    fill('placehome-site', sitesOf(rp), x => `province (${x.p}, ${x.q}) site ${x.site}`, x => `${x.p},${x.q},${x.site}`);
    fill('build-item', rb?.items ?? [], i => `item ${i}`, i => String(i));
    fill('train-unit', rt?.units ?? [], u => `unit ${u} × ${rt?.min_n}`, u => String(u));
    fill('muster-tile', rm?.tiles ?? [], t => `tile ${t}`, t => String(t));
    if (rm && !$('muster-troops').dataset.set) { const el = $('muster-troops'); el.min = rm.min_troops; el.max = rm.max_troops; el.value = rm.min_troops; el.dataset.set = '1'; }
    for (const [name] of E_ORDER) {
      const id = E_IDS[name];
      $(id).disabled = !(c[name].send && !busy.has(id)); $(`${id}-status`).disabled = !(c[name].status && !busy.has(`${id}-status`));
      for (const i of inputs[name]) $(i).disabled = !c[name].send;
      const report = sent[name] ? reportText(name, s.steps) : '';
      $(`${id}-out`).textContent = [outcome[name] ?? '', report].filter(Boolean).join('\n');
    }
  };
  for (const [name] of E_ORDER) {
    const id = E_IDS[name];
    const press = (button, work, text) => $(button).addEventListener('click', async () => {
      if (busy.has(button)) return; busy.add(button); paint();
      try { const r = await work(); outcome[name] = text(r); log(button, r.sent === true ? (r.outcome === 'unknown' ? `handed to the relay, outcome unknown (${r.relayCode ?? 'no answer'}); not sent again: ${r.signature}` : `sent ${r.signature}`) : r.sent === false ? `not sent: ${r.code}` : r.ok === true ? r.state : `no answer: ${r.code}`); }
      catch (e) { outcome[name] = `not done: ${e?.code ?? 'error'}`; log(button, 'not done:', e?.code ?? String(e?.message ?? e)); }
      finally { busy.delete(button); paint(); }
    });
    press(id, () => run.send(name, choice[name]()), sendText);
    press(`${id}-status`, () => run.status(name), statusText);
  }
  const tick = async () => { try { state = await getState(); stale = false; } catch { stale = true; } paint(); if (stale || state?.phase !== 'closed') setTimeout(tick, 1000); };
  tick();
}
if (typeof document !== 'undefined') start();
