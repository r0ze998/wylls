// Who is who (contract §8.3 "Badges (MUST for every consumer)"). The badge comes from the signed roster and from
// nothing else: not from a record's `origin`, not from an `ai_written` or `ai_roster` flag in a file, not from a
// `kind` the events panel carries. A citizen whose tag or wallet is in `roster.ai` is an AI citizen; a wallet in
// `roster.script.wallets` (or a tag derived from one) is a script bot; the roster's seat is the presenter seat. A
// human record that sets `origin = 1` is shown as "AI-assisted (self-declared)" in its own style, never as an AI
// citizen. Everything else carries no badge at all (the page does not guess "human").
//
// Pure: no DOM, no network, no imports.

/** Lower-case 16-digit hex of a citizen tag, or null when the value is not one. */
export function tagKey(tag) {
  if (typeof tag === 'bigint') return BigInt.asUintN(64, tag).toString(16).padStart(16, '0');
  if (typeof tag !== 'string') return null;
  const s = tag.trim().toLowerCase();
  return /^[0-9a-f]{16}$/.test(s) ? s : null;
}

const str = v => (typeof v === 'string' ? v : '');
const nameObj = n => {
  if (n && typeof n === 'object') return { en: str(n.en) || str(n.ja), ja: str(n.ja) || str(n.en) };
  const s = str(n);
  return { en: s, ja: s };
};

/**
 * `makeRosterIndex(roster, {scriptTags})`: lookups over `roster.json` (§8.3). `scriptTags` (optional) is an iterable of
 * the 16-hex citizen tags derived from `roster.script.wallets` by the caller (the page derives them with faddr.mjs).
 */
export function makeRosterIndex(roster, { scriptTags = null } = {}) {
  const r = roster && typeof roster === 'object' ? roster : {};
  const ai = (Array.isArray(r.ai) ? r.ai : []).filter(a => a && typeof a === 'object').map(a => ({
    index: Number.isInteger(a.index) ? a.index : null,
    wallet: str(a.wallet),
    tag: tagKey(a.tag),
    faction: Number.isInteger(a.faction) ? a.faction : null,
    persona: str(a.persona),
    ambition: nameObj(a.ambition),
    name: nameObj(a.name),
    temperament: a.temperament && typeof a.temperament === 'object' ? a.temperament : null,
  })).filter(a => a.tag);
  const byTag = new Map(ai.map(a => [a.tag, a]));
  const byWallet = new Map(ai.filter(a => a.wallet).map(a => [a.wallet, a]));
  const s = r.seat && typeof r.seat === 'object'
    ? { wallet: str(r.seat.wallet), tag: tagKey(r.seat.tag), faction: Number.isInteger(r.seat.faction) ? r.seat.faction : null, scripted: !!r.seat.scripted, index: r.seat.index ?? null }
    : null;
  const scriptWallets = new Set(Array.isArray(r.script?.wallets) ? r.script.wallets.filter(w => typeof w === 'string') : []);
  const scriptTagSet = new Set();
  for (const t of scriptTags ?? []) { const k = tagKey(t); if (k) scriptTagSet.add(k); }
  for (const t of Array.isArray(r.script?.tags) ? r.script.tags : []) { const k = tagKey(t); if (k) scriptTagSet.add(k); } // optional, not pinned by the contract

  /** `{kind: 'ai'|'seat'|'script'|null, entry}`: by tag first, then by wallet. Nothing but the roster decides. */
  function identify(who = {}) {
    const tag = tagKey(who.tag);
    const wallet = str(who.wallet);
    if (tag && byTag.has(tag)) return { kind: 'ai', entry: byTag.get(tag) };
    if (wallet && byWallet.has(wallet)) return { kind: 'ai', entry: byWallet.get(wallet) };
    if (s && ((tag && s.tag === tag) || (wallet && s.wallet === wallet))) return { kind: 'seat', entry: s };
    if ((wallet && scriptWallets.has(wallet)) || (tag && scriptTagSet.has(tag))) return { kind: 'script', entry: null };
    return { kind: null, entry: null };
  }
  return {
    ready: ai.length > 0 || !!s || scriptWallets.size > 0,
    season: r.season ?? null,
    programId: str(r.program_id),
    deck: str(r.deck),
    commitments_sha256: str(r.commitments_sha256),
    ai,
    seat: s,
    scriptCount: Number.isInteger(r.script?.count) ? r.script.count : scriptWallets.size,
    scriptTagCount: scriptTagSet.size,
    scriptTags: [...scriptTagSet],
    identify,
    aiByTag: tag => byTag.get(tagKey(tag)) ?? null,
    aiByWallet: w => byWallet.get(str(w)) ?? null,
  };
}

/**
 * The badge of one actor: `{look, labelKey, shortKey, noteKey}`.
 *   look: 'ai' | 'script' | 'seat' | 'seat-scripted' | 'assisted' | 'none'
 * `origin` only ever adds the self-declared "AI-assisted" look to an actor the roster does not list, and the
 * "scripted seat message" note to the seat. It never creates an AI badge.
 */
export function badgeOf(index, who = {}, { origin = null } = {}) {
  const id = index.identify(who);
  if (id.kind === 'ai') return { look: 'ai', labelKey: 'badge.ai', shortKey: 'badge.ai_short', noteKey: null };
  if (id.kind === 'seat') {
    const scripted = !!id.entry?.scripted;
    return { look: scripted ? 'seat-scripted' : 'seat', labelKey: scripted ? 'badge.seat_scripted' : 'badge.seat', shortKey: 'badge.seat_short', noteKey: Number(origin) === 2 ? 'badge.note_scripted_seat' : null };
  }
  if (id.kind === 'script') return { look: 'script', labelKey: 'badge.script', shortKey: 'badge.script_short', noteKey: null };
  if (Number(origin) === 1) return { look: 'assisted', labelKey: 'badge.assisted', shortKey: 'badge.assisted_short', noteKey: null };
  return { look: 'none', labelKey: null, shortKey: null, noteKey: null };
}

/**
 * The name to print for an actor: the roster's name for an AI, `resolve(tag, lang, full)` (the derived name from
 * identity.mjs, supplied by the page) for anyone else, then the record's own `name` object if it has one, then the
 * first six hex digits of the tag. The seat has no name here: the caller prints the seat label.
 */
export function displayNameOf(index, who = {}, lang = 'en', { resolve = null, fallback = null } = {}) {
  const id = index.identify(who);
  const pick = n => (n && typeof n === 'object' ? (n[lang] || n.en || n.ja || '') : str(n));
  if (id.kind === 'ai') return pick(id.entry.name);
  if (id.kind === 'seat') return null;
  const tag = tagKey(who.tag);
  if (tag && resolve) { const n = resolve(tag, lang, true); if (n) return n; }
  const fb = pick(fallback);
  if (fb) return fb;
  return tag ? tag.slice(0, 6) : '';
}

const fullNameCache = new WeakMap(); // resolve fn → Map(`tag|lang` → full derived name): the roster scan below asks for ~200 names per line

/**
 * Split a code-templated line (an episode's text) into text and badge segments: after every occurrence of the name
 * of a citizen that the line names, a badge segment of that actor's roster style follows (`{badge: look, tag}`).
 * Names come from the roster for AI citizens and from `resolve` for the rest; `pq:` and `nation:` entities are not
 * citizens and get no badge. Longest names first, no overlaps.
 *
 * Which citizens are looked for (FB4, G9: "every citizen name in a cited line carries its roster badge"): the 16-hex
 * citizen tags in `entities`, AND every citizen the roster knows (all AI citizens by their roster names, the seat and
 * the script bots by their full derived names), so a line still gets its badges when `entities` is missing (the
 * opened record's `remembered[]` carries none, and the episode list may not have loaded or may have evicted the
 * episode). `scanRoster: false` restores the entities-only reading.
 */
export function badgedSegments(text, entities, index, lang, { resolve = null, scanRoster = true } = {}) {
  const line = str(text);
  const cands = [];
  const seenTag = new Set();
  const addTag = (tag, { full = false } = {}) => {
    if (!tag || seenTag.has(tag)) return;
    seenTag.add(tag);
    const names = new Set();
    const a = index.aiByTag(tag);
    if (a) { names.add(a.name.en); names.add(a.name.ja); }
    if (resolve) {
      if (full) {
        let cache = fullNameCache.get(resolve);
        if (!cache) fullNameCache.set(resolve, (cache = new Map()));
        for (const l of ['en', 'ja']) {
          const k = `${tag}|${l}`;
          if (!cache.has(k)) { let n = null; try { n = resolve(tag, l, true) || null; } catch { n = null; } cache.set(k, n); }
          if (cache.get(k)) names.add(cache.get(k));
        }
      } else for (const f of [false, true]) for (const l of ['en', 'ja']) { const n = resolve(tag, l, f); if (n) names.add(n); }
    }
    for (const n of names) if (n && n.length >= 2) cands.push({ tag, name: n });
  };
  for (const e of Array.isArray(entities) ? entities : []) addTag(tagKey(e));
  if (scanRoster) {
    for (const a of index.ai ?? []) addTag(a.tag, { full: true });
    if (index.seat?.tag) addTag(index.seat.tag, { full: true });
    for (const tg of index.scriptTags ?? []) addTag(tg, { full: true });
  }
  cands.sort((x, y) => y.name.length - x.name.length || (x.name < y.name ? -1 : 1));
  const hits = [];
  for (const c of cands) {
    let from = 0;
    for (;;) {
      const i = line.indexOf(c.name, from);
      if (i < 0) break;
      const end = i + c.name.length;
      if (!hits.some(x => i < x.end && end > x.start)) hits.push({ start: i, end, tag: c.tag });
      from = end;
    }
  }
  hits.sort((x, y) => x.start - y.start);
  const out = [];
  let pos = 0;
  for (const hit of hits) {
    if (hit.start > pos) out.push({ text: line.slice(pos, hit.start) });
    out.push({ text: line.slice(hit.start, hit.end) });
    const b = badgeOf(index, { tag: hit.tag });
    if (b.look !== 'none') out.push({ badge: b.look, tag: hit.tag, shortKey: b.shortKey, labelKey: b.labelKey });
    pos = hit.end;
  }
  if (pos < line.length) out.push({ text: line.slice(pos) });
  return out;
}

/** Wallets → script-bot tags through a caller-supplied `deriveTag(wallet) → 16-hex tag` (a wallet that does not derive is skipped). */
export function deriveScriptTags(wallets, deriveTag) {
  const out = [];
  for (const w of Array.isArray(wallets) ? wallets : []) {
    try { const t = tagKey(deriveTag(w)); if (t) out.push(t); } catch { /* skipped */ }
  }
  return out;
}
