// AC6: the Wyll cards job (contract section 2.4): PUB/cards/<tag>.json for every AI citizen and PUB/cards/index.json, rendered with AC2's
// `renderCard` from the AI's own ledger, episodes and summary (public by design: the card says so), the mind's counters and the
// reasons that are PUBLISHED: the `why` of an unsealed decision at once, the `why` of a sealed decision only after its release.
//
// `revealed_reasons` carry the cited episodes ("Remembered") as code-templated text rendered from the episode store, never from model
// text; a citation proves that the line was shown and named, not that the choice rested on it (section 5.7).
//
// The job rewrites a card only when its content changed; `updated_bell` is the bell of that change. A new self-summary or a goal that
// changed state is reported through `onChanged` (the chronicle's `ai_card_changed` line).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { renderCard, rememberedFor } from '../memory/cards.mjs';
import { messagesCap } from '../mind/validate.mjs';

const DAY_BELLS = 144;
const KEEP_REASONS = 20;
const SKIP_KINDS = new Set(['reflection']);

export function createCardsJob({ roster, stores, records, mind = () => null, personaOf, nameOf, nationName, config = {}, pubDir, onChanged = () => {}, onError = () => {} } = {}) {
  const dir = `${pubDir}/cards`;
  const reasons = new Map(); // tag -> [{bell, decision_id, by, why, mem}]
  const seen = new Set(); // decision ids already turned into a reason
  const opened = new Map(); // tag -> number of model marches whose destination is public
  const sigs = new Map(); // tag -> sha of the card without updated_bell
  const watch = new Map(); // tag -> {summary, goals}
  let scanned = -1;

  const addReason = (tag, r) => {
    if (seen.has(r.decision_id)) return;
    seen.add(r.decision_id);
    const l = reasons.get(tag) ?? [];
    l.push(r);
    l.sort((a, b) => a.bell - b.bell);
    if (l.length > KEEP_REASONS) l.splice(0, l.length - KEEP_REASONS);
    reasons.set(tag, l);
  };

  /** A sealed decision after its release (the release job hands it here): its reason becomes public with its destinations. */
  function addOpened(o) {
    if (o.mode === 'model' && o.public?.why && !SKIP_KINDS.has(o.kind)) addReason(o.ai, { bell: o.bell, decision_id: o.id, by: 'model', why: o.public.why, mem: o.choice?.mem ?? [] });
    const n = (o.destinations ?? []).filter(d => d.state === 'revealed' && d.via === 'model').length;
    if (n && o.mode === 'model') opened.set(o.ai, (opened.get(o.ai) ?? 0) + n);
  }

  /** Rebuild the opened part from PUB/open/*.json after a restart. */
  function loadOpened() {
    try {
      const idx = JSON.parse(readFileSync(`${pubDir}/open/index.json`, 'utf8'));
      for (const b of idx.bells ?? []) {
        try {
          for (const o of JSON.parse(readFileSync(`${pubDir}/open/${b}.json`, 'utf8')).records ?? []) addOpened(o);
        } catch (e) { onError(e); }
      }
    } catch { /* nothing opened yet */ }
  }

  function scan(bell) {
    for (let b = Math.max(0, scanned - 1); b <= bell; b++) {
      for (const r of records.recordsOf(b)) {
        if (r.sealed || r.mode !== 'model' || SKIP_KINDS.has(r.kind) || !r.public?.why) continue;
        addReason(r.ai, { bell: r.bell, decision_id: r.id, by: 'model', why: r.public.why, mem: r.choice?.mem ?? [] });
      }
    }
    scanned = bell;
  }

  function stateOf(entry, bell) {
    const tag = entry.tag;
    const persona = { ...personaOf(entry), name: entry.name ?? nameOf(tag), nation: nationName(entry.faction) };
    const ledgerObj = stores.ledger(tag, { goals: persona.goals, bell });
    const ledger = ledgerObj.snapshot();
    const episodes = stores.episodes(tag);
    const summary = stores.summary?.latest?.(tag) ?? null;
    const sameDay = ledger.counters?.day === Math.floor(bell / DAY_BELLS);
    const budget = {
      messages_left: Math.max(0, messagesCap(persona) - (sameDay ? ledger.counters?.messages ?? 0 : 0)),
      reactions_left: Math.max(0, (config.budgets?.reactions ?? 6) - (sameDay ? ledger.counters?.reactions ?? 0 : 0)),
    };
    const stats = { ...(mind()?.statsOf?.(tag) ?? {}), model_marches_opened: opened.get(tag) ?? 0 };
    const revealed = (reasons.get(tag) ?? []).map(r => ({ bell: r.bell, decision_id: r.decision_id, by: r.by, why: r.why, remembered: rememberedFor(episodes, r.mem, r.bell) }));
    return { tag, wallet: entry.wallet, faction: entry.faction, index: entry.index, bell, persona, ledger, episodes, summary, revealed, budget, stats };
  }

  const atomic = (path, text) => {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  };

  /** Render and write the cards that changed at `bell`. Returns the tags written. */
  function update(bell) {
    scan(bell);
    const written = [];
    const index = [];
    for (const entry of roster.ai) {
      let card;
      try { card = renderCard(stateOf(entry, bell)); } catch (e) { onError(e); continue; }
      const { updated_bell, ...rest } = card;
      const sig = createHash('sha256').update(JSON.stringify(rest)).digest('hex');
      const file = `${dir}/${entry.tag}.json`;
      let outCard = card;
      if (sigs.get(entry.tag) === sig && existsSync(file)) {
        try { outCard = JSON.parse(readFileSync(file, 'utf8')); } catch { outCard = card; }
      } else {
        sigs.set(entry.tag, sig);
        atomic(file, JSON.stringify(card));
        written.push(entry.tag);
        const now = { summary: card.memory.summary?.sha256 ?? null, goals: card.goals.map(g => `${g.id}:${g.status}`).join(',') };
        const was = watch.get(entry.tag);
        watch.set(entry.tag, now);
        if (was) {
          const s = was.summary !== now.summary && now.summary !== null;
          const g = was.goals !== now.goals;
          if (s || g) onChanged({ tag: entry.tag, bell, what: s && g ? 'both' : s ? 'summary' : 'goals' });
        }
      }
      index.push({ tag: entry.tag, name: outCard.name, faction: outCard.faction, index: outCard.index, persona: outCard.persona.id, updated_bell: outCard.updated_bell });
    }
    if (written.length || !existsSync(`${dir}/index.json`)) atomic(`${dir}/index.json`, JSON.stringify({ v: 1, bell, cards: index }));
    return written;
  }

  return { update, addOpened, loadOpened, reasonsOf: tag => (reasons.get(tag) ?? []).slice(), openedCount: tag => opened.get(tag) ?? 0 };
}
