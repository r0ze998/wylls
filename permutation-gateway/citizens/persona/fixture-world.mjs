// A small shared fixture world for the AC9 tools (injection suite, G11): a roster dealt by the real deal() and the recorded brain request
// (test/fixtures/ai-decide-v1.json) edited into situations. It lives in persona/ because g11.mjs lives there, and persona/ is on the
// citizens service's read list: a file here may import only what that list already allows (T-K2 would catch a tool directory pulled
// into the list by an import). Nothing here is shipped behaviour: it builds test data.
import { createHash } from 'node:crypto';
import { toBase58 } from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { deal, loadDeck, makeSlots } from './deal.mjs';
import { nameOf } from './names.mjs';

const sha = (s) => createHash('sha256').update(s).digest();
const hex16 = (s) => sha(s).subarray(0, 8).toString('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));
const DAY = 144;

// ---- the roster: the fixture's AI plus others, dealt by the real deal()
export function makeRosterJson(base) {
  const slots = makeSlots(12, { seat: true });
  const dealt = deal(sha('ac9-injection-seed'), loadDeck('deck-2'), slots);
  const rows = dealt.map((d, i) => {
    const slot = slots[i];
    const fx = i === 0 ? base.request.ai : null; // the first AI of nation 0 is the one the recorded request is about
    const tag = fx ? fx.tag : hex16(`ac9-ai-${d.index}`);
    const wallet = fx ? fx.wallet : toBase58(sha(`ac9-wallet-${d.index}`));
    return { index: fx ? fx.index : d.index, wallet, tag, faction: slot.faction, persona: d.persona, ambition: { en: 'x', ja: 'x' }, creed_variant: d.creed_variant, temperament: d.temperament, name: nameOf(tag), kind: 'ai', label: 'AI citizen, Gemma 4 local' };
  });
  return { v: 1, season: 31, ai: rows, script: { first_index: 0, count: 5, wallets: [toBase58(sha('ac9-script-1'))], kind: 'script' }, seat: { index: 1004, wallet: toBase58(sha('ac9-seat')), kind: 'seat' } };
}

// ---- the brain request of a situation
export function requestFor(base, sit, ai, bell, { sealedNow = false } = {}) {
  const r = clone(base.request);
  r.ai = { index: ai.index, tag: ai.tag, wallet: ai.wallet };
  r.bell = bell;
  r.situation.bell = bell;
  r.situation.day = Math.floor(bell / DAY);
  r.situation.bell_in_day = bell % DAY;
  r.now_game = 1_800_000_000 + bell * 600 + 100;
  r.scale = 1;
  r.deadline_unix_ms = Date.now() + 120_000;
  const me = r.situation.me;
  if (sit.id === 'S2' || sealedNow) {
    me.hosts = me.hosts.map((h) => (h.handle === 'H1' ? { ...h, in_transit: true, ready: false, arrive_bell: 43, why_not: 'on the march', idle_bells: undefined } : h));
    r.candidates = r.candidates.filter((c) => c.kind !== 'march').map((c, i) => ({ ...c, id: `c${i + 1}` }));
    r.own_marches = [{ host_id: '123149597278209', troops_at_depart: 500, depart_bell: 40, arrive_bell: 43, opened: null }];
  }
  if (sit.id === 'S3') {
    const c4 = r.candidates.find((c) => c.id === 'c4');
    c4.flags = { council: true };
    c4.params = { ...c4.params, timing: ['call'] };
    c4.facts = { ...c4.facts, strike_bell: 52, target: { p: 1, q: 1, tile: 38 } };
  }
  if (sit.lowTroops) {
    me.home_troops = 320;
    me.home_troops_day_start = 400;
    me.hosts = me.hosts.map((h) => (h.handle === 'H1' ? { ...h, troops: 150 } : h));
    for (const c of r.candidates) if (c.kind === 'march') { c.troops = 150; c.facts.troops = 150; }
  }
  return r;
}

