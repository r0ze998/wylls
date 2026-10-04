// The nation council (contract §6.5; user-facing name "Strike Order", code name Call): options made by code with the
// ratio word, motions with a speech, the hidden ballot, the tally split by who cast the ballots, whether the viewer's
// ballot was pivotal, the sealed order's opening and result, and the §6.5 scope statement.
//
// Sources: `GET /f/ai/council?faction=<f>` (live state: options, motions, ballots_cast, adopted, tally_split) and
// `/h/ai/council/<k>-<f>.json` (the same period's file, which also carries `open` once the order opened). Ballots stay
// hidden until the order opens (or the close, when nothing was adopted), so a pivotal verdict needs the opened ballots;
// before that the page can only say "not known yet".
import { decodeBallot, encodeBallot, fromBase64, toBase58, toHex } from './aisocial.mjs';
import { actorEl, int, placeText } from './parts.mjs';
import { lostText } from './events.mjs';
import { nationName, NATIONS } from './lang.mjs';
import { sendRecord } from './feed.mjs';

const str = v => (typeof v === 'string' ? v : '');
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Number(v) : null);
const arr = v => (Array.isArray(v) ? v : []);

// ------------------------------------------------------------------ normalising
/** The ratio word of an option (§4.3: own/enemy ≥ 2 favourable, ≥ 1 even, else unfavourable); a word in the file wins. */
export function ratioWord(o) {
  if (['favourable', 'even', 'unfavourable'].includes(o?.ratio)) return o.ratio;
  const own = num(o?.own), value = num(o?.value);
  const r = num(o?.ratio) ?? (own !== null && value ? own / value : null);
  if (r === null) return null;
  return r >= 2 ? 'favourable' : r >= 1 ? 'even' : 'unfavourable';
}

const normOption = o => ({ option: num(o?.option), kind: ['strike', 'camp', 'raid'].includes(o?.kind) ? o.kind : '', p: num(o?.p), q: num(o?.q), value: num(o?.value), own: num(o?.own), ratio: ratioWord(o) });

/** `{period, state, options, motions, …}` (live) or the period file (`candidates`, `open`, `result`) → the council view's input. */
export function normalizeCouncil(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const split = raw.tally_split && typeof raw.tally_split === 'object' ? { ai: num(raw.tally_split.ai) ?? 0, human: num(raw.tally_split.human) ?? 0, scripted: num(raw.tally_split.scripted) ?? 0 } : null;
  const o = raw.open && typeof raw.open === 'object' ? raw.open : null;
  const ballots = o ? arr(o.ballots).map(b => {
    try { const d = decodeBallot(fromBase64(str(b.bytes_b64))); return { wallet: toBase58(d.wallet), option: d.option, origin: d.origin, faction: d.faction, period: d.period, candidates_hash: toHex(d.candidates_hash) }; } catch { return null; }
  }).filter(Boolean) : null;
  const tally = o?.tally && typeof o.tally === 'object' ? { 0: num(o.tally[0]) ?? 0, 1: num(o.tally[1]) ?? 0, 2: num(o.tally[2]) ?? 0, 3: num(o.tally[3]) ?? 0 } : null;
  return {
    period: num(raw.period), faction: num(raw.faction), state: ['none', 'motions', 'ballots', 'closed'].includes(raw.state) ? raw.state : null,
    closesBell: num(raw.closes_bell), c0: num(raw.c0),
    options: arr(raw.options ?? raw.candidates).map(normOption).filter(x => x.option !== null && x.option >= 1 && x.option <= 3),
    motions: arr(raw.motions).map(m => ({ id: num(m?.id), wallet: str(m?.wallet), tag: str(m?.tag), name: m?.name && typeof m.name === 'object' ? { en: str(m.name.en), ja: str(m.name.ja) } : null, option: num(m?.option), text: str(m?.text).slice(0, 400), origin: num(m?.origin) ?? 0 })).filter(m => m.option !== null),
    ballotsCast: num(raw.ballots_cast) ?? 0, adopted: !!raw.adopted, reason: str(raw.reason) || null,
    strikeBell: num(raw.strike_bell), followFrom: num(raw.follow_from), callCommit: str(raw.call_commit) || null, candidatesHash: str(raw.candidates_hash), tallySplit: split,
    open: o ? { option: num(o.option), kind: str(o.kind), p: num(o.p), q: num(o.q), tile: num(o.tile), tally, ballots, adopted: o.adopted !== false } : null,
    result: raw.result && typeof raw.result === 'object' ? { present: num(raw.result.present), bounced: num(raw.result.bounced), clash: raw.result.clash ?? null } : null,
  };
}

// ------------------------------------------------------------------ pivotal
/** The §6.5 step 5 decision over a list of ballots `[{option, origin}]`; `humansPresent` as the service computes it. */
export function decideTally(ballots, humansPresent, humanPresentRule = true) {
  const per = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const b of ballots) per[b.option]++;
  const top = Math.max(per[1], per[2], per[3]);
  if (top < 2) return { adopted: false, reason: 'quorum', per };
  const leaders = [1, 2, 3].filter(o => per[o] === top);
  if (leaders.length > 1) return { adopted: false, reason: 'tie', per };
  if (per[0] > top) return { adopted: false, reason: 'none_wins', per };
  if (per[0] === top) return { adopted: false, reason: 'tie', per };
  const option = leaders[0];
  if (humanPresentRule && humansPresent && !ballots.some(b => b.option === option && (b.origin === 0 || b.origin === 2))) return { adopted: false, reason: 'human_present', per, option };
  return { adopted: true, reason: 'adopted', option, per };
}

/**
 * Was the viewer's ballot pivotal for the adopted option?
 *   council   normalizeCouncil output of the closed period
 *   wallet    the viewer's wallet (never printed)
 *   humanSeatHere  the roster's seat belongs to this nation (the human-present rule applies)
 *   mine      {option, origin} when this page cast the ballot (used while the ballots are still hidden)
 * Returns `{state: 'yes'|'no'|'other'|'none_cast'|'not_adopted'|'unknown', why: 'quorum'|'lead'|'human'|null}`.
 * `yes` means: remove the viewer's ballot and the §6.5 rule would not have adopted this option.
 */
export function pivotal({ council, wallet, humanSeatHere = false, mine = null }) {
  if (!council || council.state !== 'closed') return { state: 'unknown', why: null };
  if (!council.adopted) return { state: 'not_adopted', why: null };
  const open = council.open;
  const all = open?.ballots ?? null;
  if (all && open.option !== null) {
    const mineB = all.find(b => b.wallet === wallet);
    if (!mineB) return { state: 'none_cast', why: null };
    if (mineB.option !== open.option) return { state: 'other', why: null };
    const rest = all.filter(b => b !== mineB);
    const humansPresent = humanSeatHere || all.some(b => b.origin === 0 || b.origin === 2);
    const d = decideTally(rest, humansPresent);
    if (d.adopted && d.option === open.option) return { state: 'no', why: null };
    const why = d.reason === 'human_present' ? 'human' : d.reason === 'quorum' ? 'quorum' : 'lead';
    return { state: 'yes', why };
  }
  // Ballots still hidden: only the human-present reading is possible, and only for a ballot this page cast.
  const sp = council.tallySplit;
  if (mine && sp && (mine.origin === 0 || mine.origin === 2) && humanSeatHere && sp.human + sp.scripted === 1) return { state: 'yes', why: 'human' };
  return { state: 'unknown', why: null };
}

// ------------------------------------------------------------------ writing ballots and motions
/** The ballot's bytes (origin 0: cast by a person). `nonce16` is 16 random bytes. */
export function buildBallot({ season, period, wallet, faction, option, candidatesHash, nonce16 }) {
  return encodeBallot({ season, period, wallet, faction, option, candidates_hash: candidatesHash, nonce: nonce16, origin: 0 });
}
export async function castBallot({ signer, post, season, period, faction, option, candidatesHash, nonce16 }) {
  const bytes = buildBallot({ season, period, wallet: signer.wallet, faction, option, candidatesHash, nonce16 });
  return sendRecord({ bytes, signer, post, path: '/f/ai/ballot' });
}

/** What the adoption sentence says about who cast the ballots (§6.5 step 5: "adopted with 1 AI ballot and the presenter's ballot"). */
export function adoptionParts(t, split) {
  if (!split) return t('council.adopted_parts_none');
  const parts = [];
  if (split.ai > 0) parts.push(t('council.adopted_parts_ai', { n: split.ai }));
  if (split.human > 0) parts.push(t('council.adopted_parts_human'));
  if (split.scripted > 0) parts.push(t('council.adopted_parts_scripted'));
  return parts.length ? parts.join(' + ') : t('council.adopted_parts_none');
}

// ------------------------------------------------------------------ render
const SCOPE_KEYS = ['council.scope1', 'council.scope2', 'council.scope3', 'council.scope4'];

export function renderScope(ctx) {
  const { h, t } = ctx;
  return h('details', { class: 'scope', open: true }, h('summary', null, t('council.scope_title')), SCOPE_KEYS.map(k => h('p', null, t(k))));
}

function optionRow(ctx, o, { adopted = false } = {}) {
  const { h, t } = ctx;
  const kind = o.kind ? t(`council.kind.${o.kind}`) : '?';
  return h('li', { class: `option${adopted ? ' adopted' : ''}` },
    h('span', { class: 'option-n' }, t('council.option', { n: o.option })), ' ',
    h('strong', null, `${kind} ${o.p !== null ? placeText(t, o.p, o.q) : ''}`),
    o.value !== null ? h('span', { class: 'muted' }, ` · ${t('council.value', { v: int(o.value) })}`) : null,
    o.own !== null ? h('span', { class: 'muted' }, ` · ${t('council.own', { o: int(o.own) })}`) : null,
    o.ratio ? h('span', { class: `chip chip-ratio-${o.ratio}` }, t('council.ratio', { word: t(`council.ratio.${o.ratio}`) })) : null);
}

/**
 * The council panel's body for one nation. `view` carries: `council` (normalizeCouncil output or null), `bell`,
 * `faction`, `me` ({signer, faction, wallet} or null), `mine` ({option, origin}|null), `slots` ({call: Node}), and the
 * handlers `onNation`, `onVote(option)`, `onMotion(option, text)`.
 */
export function renderCouncil(ctx, view) {
  const { h, t, lang, index } = ctx;
  const c = view.council;
  const box = h('div', { class: 'council' });
  box.appendChild(h('p', { class: 'muted' }, t('council.intro')));

  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': t('council.nation') });
  for (let f = 0; f < NATIONS.length; f++) {
    tabs.appendChild(h('button', { type: 'button', class: `tab${view.faction === f ? ' selected' : ''}`, 'aria-pressed': view.faction === f ? 'true' : 'false', on: { click: () => view.onNation(f) } }, nationName(f, lang)));
  }
  box.appendChild(tabs);

  if (!c || c.state === null || c.state === 'none' || !c.options.length) {
    box.appendChild(h('p', { class: 'state' }, t('council.state.none')));
    box.appendChild(renderScope(ctx));
    return box;
  }

  const left = c.closesBell !== null && view.bell !== null ? c.closesBell - view.bell : null;
  box.appendChild(h('p', { class: `state state-${c.state}` }, h('strong', null, t(`council.state.${c.state}`)), ' ',
    h('span', { class: 'muted' }, c.period !== null ? `${t('council.period', { k: int(c.period) })} · ` : '',
      c.closesBell !== null ? (c.state === 'closed' ? t('council.closes_past', { n: int(c.closesBell) }) : t('council.closes', { n: int(c.closesBell), left: left !== null ? Math.max(0, left) : '?' })) : '')));

  const adoptedOpt = c.open?.adopted && c.open.option !== null ? c.open.option : null;
  box.appendChild(h('h4', null, t('council.options')));
  const ol = h('ul', { class: 'options' });
  for (const o of c.options) ol.appendChild(optionRow(ctx, o, { adopted: adoptedOpt === o.option }));
  box.appendChild(ol);

  box.appendChild(h('h4', null, t('council.motions')));
  if (!c.motions.length) box.appendChild(h('p', { class: 'empty' }, t('council.motions_none')));
  else {
    const ul = h('ul', { class: 'motions' });
    for (const m of c.motions) {
      ul.appendChild(h('li', { class: 'motion' },
        actorEl(ctx, { tag: m.tag, wallet: m.wallet }, { origin: m.origin, fallback: m.name }), ' ',
        h('span', { class: 'chip chip-motion' }, t('council.moved', { n: m.option })),
        m.text ? h('p', { class: 'motion-text' }, m.text) : null));
    }
    box.appendChild(ul);
  }

  box.appendChild(h('p', { class: 'ballots' }, t('council.ballots_cast', { n: c.ballotsCast })));
  if (c.state === 'closed') {
    if (c.tallySplit) box.appendChild(h('p', { class: 'split' }, t('council.tally_split', { ai: c.tallySplit.ai, human: c.tallySplit.human, scripted: c.tallySplit.scripted })));
    if (c.adopted) {
      box.appendChild(h('p', { class: 'adopted-line' }, h('strong', null, t(c.open?.adopted ? 'council.adopted_open' : 'council.adopted', { parts: adoptionParts(t, c.tallySplit), s: c.strikeBell !== null ? int(c.strikeBell) : '?' }))));
    } else box.appendChild(h('p', { class: 'adopted-line' }, t('council.not_adopted', { reason: c.reason ? t(`council.reason.${c.reason}`) : '?' })));
  }

  if (c.open && c.open.adopted) {
    const o = c.open;
    box.appendChild(h('div', { class: 'opened' },
      h('h4', null, t('council.opened')),
      o.option !== null ? h('p', null, t('council.opened_target', { n: o.option, kind: o.kind ? t(`council.kind.${o.kind}`) : '?', at: o.p !== null ? placeText(t, o.p, o.q) : '?' })) : null,
      o.tally ? h('p', { class: 'muted' }, t('council.opened_tally', { tally: [1, 2, 3].map(k => `${k}: ${o.tally[k]}`).join(' · ') + ` · ${t('council.tally_none')}: ${o.tally[0]}` })) : null));
  }
  if (c.adopted && c.state === 'closed') {
    const r = c.result;
    const res = h('div', { class: 'result' }, h('h4', null, t('council.result')));
    if (r) {
      if (r.present !== null) res.appendChild(h('p', null, t('council.result_present', { n: int(r.present) })));
      if (r.bounced !== null) res.appendChild(h('p', null, t('council.result_bounced', { n: int(r.bounced) })));
      const lost = [];
      const cl = r.clash;
      if (cl && typeof cl === 'object') {
        const lm = cl.lost ?? cl.troops_lost ?? null;
        if (lm && typeof lm === 'object') for (const [f, n] of Object.entries(lm)) if (num(f) !== null && num(n) !== null) lost.push({ faction: num(f), n: num(n) });
        res.appendChild(h('p', null, t('council.result_clash', { sides: `${cl.engagements !== undefined ? `${t('ev.clash_engagements', { n: int(cl.engagements) })}; ` : ''}${lostText(ctx, lost)}` })));
      }
    } else res.appendChild(h('p', { class: 'muted' }, t('council.result_waiting')));
    box.appendChild(res);
  }

  // pivotal indicator for the viewer's ballot
  if (view.me && c.state === 'closed' && c.adopted) {
    const humanSeatHere = !!(index.seat && index.seat.faction === c.faction);
    const pv = pivotal({ council: c, wallet: view.me.wallet, humanSeatHere, mine: view.mine ?? null });
    const line = pv.state === 'yes' ? t('council.pivotal.yes', { why: t(`council.pivotal.why_${pv.why}`) })
      : pv.state === 'no' ? t('council.pivotal.no')
        : pv.state === 'other' ? t('council.pivotal.other')
          : pv.state === 'none_cast' ? t('council.pivotal.none_cast')
            : t('council.pivotal.unknown');
    box.appendChild(h('div', { class: `pivotal pivotal-${pv.state}` }, h('strong', null, `${t('council.pivotal.title')} `), line));
  }

  // writing: motion form and ballot buttons (members only; the service decides)
  if (view.slots?.call) box.appendChild(view.slots.call);
  if (c.state === 'ballots') {
    if (!view.me) box.appendChild(h('p', { class: 'muted' }, t('council.vote_need_key')));
    else if (view.me.faction !== null && view.me.faction !== c.faction) box.appendChild(h('p', { class: 'muted' }, t('council.vote_not_member')));
    else {
      const row = h('div', { class: 'vote', role: 'group', 'aria-label': t('council.vote') }, h('strong', null, `${t('council.vote')}: `));
      for (const o of c.options) row.appendChild(h('button', { type: 'button', class: 'btn', on: { click: () => view.onVote(o.option) } }, t('council.vote_option', { n: o.option })));
      row.appendChild(h('button', { type: 'button', class: 'btn btn-quiet', on: { click: () => view.onVote(0) } }, t('council.vote_none')));
      box.appendChild(row);
    }
  }
  if (c.state === 'motions' && view.me && (view.me.faction === null || view.me.faction === c.faction)) {
    const sel = h('select', { id: 'motion-option', 'aria-label': t('council.motion_title'), on: { change: e => view.onDraft?.({ option: Number(e.target.value) }) } }, c.options.map(o => h('option', { value: String(o.option) }, t('council.option', { n: o.option }))));
    const ta = h('textarea', { id: 'motion-text', rows: 2, maxlength: 280, placeholder: t('council.motion_text'), 'aria-label': t('council.motion_text'), on: { input: e => view.onDraft?.({ text: e.target.value }) } });
    if (view.draft) { ta.value = view.draft.text ?? ''; if (view.draft.option) sel.value = String(view.draft.option); }
    box.appendChild(h('div', { class: 'motion-form' }, h('strong', null, `${t('council.motion_title')}: `), sel, ta,
      h('button', { type: 'button', class: 'btn', on: { click: () => view.onMotion(Number(sel.value), ta.value) } }, t('council.motion_send'))));
  }
  if (view.note) box.appendChild(h('p', { class: 'status-line', role: 'status' }, view.note));
  box.appendChild(renderScope(ctx));
  return box;
}
