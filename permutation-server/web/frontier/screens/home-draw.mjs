// The provisional first-village draw, as text for a screen (2026-11-18): NOT PRODUCTION, NOT ENABLED.
// Pure: the view's state (fhome-draw-view.mjs) → an HTML string, every value escaped. English only for now (no keys
// added to the shared language tables). The play screen's banned words are kept out (no bell, tick, settle, keeper,
// beacon, seed, secret, site ticket, lamport, minutes, next turn).
import { DRAW, PROVISIONAL } from '../fhome-draw.mjs';
import { GROWTH } from '../fhome-draw-frontier.mjs';
import { VIEW } from '../fhome-draw-view.mjs';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const li = items => items.map(t => `<li>${esc(t)}</li>`).join('');

export const LIMITS_TEXT = Object.freeze([
  'A test of a new rule: not the real join, not on the public world, not switched on.',
  'Predictable: anyone who knows the world can work out any wallet\'s place before it joins.',
  'Not protected against many accounts: wallets can be made until one lands where wanted.',
  'The real join still checks the home rings, the nation and the place itself, and would refuse a place outside them.',
]);

const GROWTH_TEXT = Object.freeze({
  ceiling: 'Room to grow',
  end: 'The world has not ended',
  opened: 'Every ring up to the edge is open',
  sinceLast: 'Time since the last ring opened',
  crowding: 'Some nation\'s land is crowded enough',
});
const mark = met => (met === true ? 'yes' : met === false ? 'no' : 'not read');

function chainText(chain) {
  if (!chain) return 'Whether the current world would take this place is not checked here.';
  const out = [];
  if (chain.ring !== null && chain.reasons.some(r => r.startsWith('ring '))) out.push(`It lies beyond the home rings, where the current world places no first village.`);
  if (chain.reasons.some(r => r.startsWith('the place is of nation'))) out.push(`It is in another nation's home land than this citizen's.`);
  if (chain.placeHome === 'refused-by-rule') return `The current world would refuse this place today. ${out.join(' ')}`;
  return 'Whether the current world would take this place is not checked here.';
}

function answerHtml(a) {
  if (!a) return '<p>No draw yet.</p>';
  switch (a.kind) {
    case DRAW.assigned: {
      const p = a.place;
      const nation = a.chain?.nation;
      return `<p class="draw-place">Your village would be placed in province ${esc(p.p)}, ${esc(p.q)} (ring ${esc(p.ring)}), place ${esc(p.site)}.</p>`
        + (Number.isInteger(nation) ? `<p>That land is nation ${esc(nation)}'s; nations are mixed in this draw.</p>` : '')
        + `<p>${esc(chainText(a.chain))}</p>`
        + `<p class="draw-note">Drawn from the map as last read. The place can be taken by someone else before a real join.</p>`;
    }
    case DRAW.full: return '<p>No free place in the open map right now.</p>';
    case DRAW.unread: return `<p>Part of the map could not be read, so no place is drawn. Land that is not read is never counted as free.</p>${Array.isArray(a.unreadRings) && a.unreadRings.length ? `<p>Rings not read: ${esc(a.unreadRings.join(', '))}</p>` : ''}`;
    case DRAW.otherWorld: return '<p>An answer came from another world; nothing of it is shown.</p>';
    case DRAW.contested: return '<p>The places drawn first were taken since the map was read. Read the map again.</p>';
    case DRAW.held: return `<p>Not ready: ${esc(a.why)}.</p>`;
    default: return '<p>No draw.</p>';
  }
}

function growthHtml(g) {
  if (!g) return '';
  const head = g.state === GROWTH.none ? 'This world\'s map does not grow further.'
    : g.state === GROWTH.unmet ? `The map could grow to ring ${esc(g.nextRing)}, but not now.`
    : g.state === GROWTH.maybe ? `The map may grow to ring ${esc(g.nextRing)}; not every condition can be read here.`
    : 'Whether the map can grow is not read.';
  const rows = g.conditions.map(c => `<li>${esc(GROWTH_TEXT[c.id] ?? c.id)}: ${esc(mark(c.met))}</li>`).join('');
  return `<section class="draw-growth"><h3>Map growth</h3><p>${head}</p>${rows ? `<ul>${rows}</ul>` : ''}`
    + `<p class="draw-note">Not connected here: who opens a ring and who pays, any limit beyond the world's own, growth by exploring (exploring finds things on open land and opens no ring), and any announcement.</p></section>`;
}

/** The whole card. `state` = createDrawView().state(). */
export function homeDrawHtml(state) {
  const s = state ?? { status: VIEW.empty };
  const body = s.status === VIEW.reading && !s.answer ? '<p>Reading the map…</p>' : answerHtml(s.answer);
  return `<section class="home-draw" data-kind="${esc(PROVISIONAL.kind)}" data-production="false">`
    + `<h2>First village: provisional draw</h2>`
    + `<p class="draw-banner">Test only. Nothing is joined, placed, signed or sent from this page.</p>`
    + body
    + (Array.isArray(s.answer?.rings?.near) && s.answer.rings.near.length ? `<p class="draw-note">Rings past the edge, not land yet and never drawn: ${esc(s.answer.rings.near.join(', '))}</p>` : '')
    + growthHtml(s.growth)
    + `<details><summary>Limits of this draw</summary><ul>${li(LIMITS_TEXT)}</ul></details>`
    + `</section>`;
}
