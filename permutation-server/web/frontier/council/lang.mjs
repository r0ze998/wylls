// The council page's two languages, English and Japanese (contract §11.5 AC7). A small self-contained dictionary: the
// page imports no other web module for its text (web/lang.mjs keys its dictionaries by the Japanese source text and
// pulls eight dictionary files; this page needs none of them, and under serve.mjs the relative path to it would not
// resolve). Every string a human reads is a key of DICT; a test checks that both languages have the same keys, that
// no module uses a key that is missing, and that no value contains markup.
//
//   t('card.goals')                       current language
//   t('feed.n_new', { n: 3 })             "{n}" placeholders are replaced as plain text, never as markup
//   tl('ja', 'badge.ai')                  an explicit language
//   pick({ en: 'x', ja: 'y' })            a bilingual value from a file, with fallback to the other language
//
// The words follow contract §0.4: nation, village, army, citizen, bell, Strike Order (「攻撃命令」); never "shade";
// "Call" is a code identifier and does not appear in any string.

export const LANGS = Object.freeze(['en', 'ja']);
export const STORAGE_KEY = 'council-lang';

/** The six nation names in English, a copy of citizens/memory/names.json (the Japanese names are `nation.<f>` in lang.ja.json; a test compares both with the table). */
export const NATIONS = Object.freeze(['Aster', 'Borealis', 'Cinder', 'Dunmar', 'Ember', 'Fjordal'].map(key => Object.freeze({ key, en: key })));

let current = 'en';
const listeners = new Set();

/** The starting language: a saved choice, else the browser's ('ja…' is Japanese, anything else English). */
export function detectLang({ stored = null, language = '' } = {}) {
  if (LANGS.includes(stored)) return stored;
  return String(language ?? '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}
export const getLang = () => current;
export function setLang(l) {
  if (!LANGS.includes(l)) return current;
  current = l;
  for (const fn of listeners) { try { fn(l); } catch { /* a listener never breaks the switch */ } }
  return current;
}
export function onLangChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Saved language (try/catch: private windows and blocked storage must not break the page). */
export function loadLang(storage = globalThis.localStorage, language = globalThis.navigator?.language) {
  let stored = null;
  try { stored = storage?.getItem(STORAGE_KEY) ?? null; } catch { /* unavailable */ }
  return detectLang({ stored, language });
}
export function saveLang(l, storage = globalThis.localStorage) {
  try { storage?.setItem(STORAGE_KEY, l); } catch { /* unavailable */ }
}

/** A bilingual value `{en, ja}` (or a plain string) in `lang`, falling back to the other language. */
export function pick(v, lang = current) {
  if (v && typeof v === 'object') return String(v[lang] ?? v.en ?? v.ja ?? '');
  return v === null || v === undefined ? '' : String(v);
}

export function nationName(f, lang = current) {
  const n = NATIONS[f];
  if (n) return lang === 'ja' ? (DICT.ja[`nation.${f}`] ?? n.en) : n.en;
  const k = Number.isInteger(f) ? String(f) : '?';
  return lang === 'ja' && DICT.ja['nation.fallback'] ? DICT.ja['nation.fallback'].replace('{n}', k) : `nation ${k}`;
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);
/** A string in `lang`. A key that is not in the dictionary comes back as itself (a test fails the build on one). */
export function tl(lang, key, vars) {
  const d = DICT[lang] ?? DICT.en;
  const s = d[key] ?? DICT.en[key];
  return s === undefined ? key : fill(s, vars);
}
export const t = (key, vars) => tl(current, key, vars);

// ------------------------------------------------------------------ the dictionary
const EN = {
  // page chrome
  'page.title': 'Wylls council',
  'page.brand': 'Wylls · council',
  'page.lang_toggle': '\u65e5\u672c\u8a9e',
  'page.nav.roster': 'Roster',
  'page.nav.card': 'Wyll card',
  'page.nav.decisions': 'Decisions',
  'page.nav.council': 'Council',
  'page.nav.events': 'Departures',
  'page.nav.feed': 'Messages',
  'page.nav.chronicle': 'Chronicle',
  'page.bell': 'bell {n}',
  'page.bell_unknown': 'bell ?',
  'page.loading': 'Loading…',
  'page.unavailable': 'Not available yet (the herald or the citizens service has not published it).',
  'page.signed_out': 'not signed in',
  'page.signed_in': 'signed in: {who}',
  'page.footer': 'Local test chain — not devnet or mainnet — AI citizens are labelled — Gemma 4 runs locally — the presenter is the operator.',
  'page.age_bells': '{n} bells earlier',
  'page.bell_n': 'bell {n}',
  'page.at': '({p},{q})',

  // banner
  'banner.localnet': 'LOCAL TEST CHAIN',
  'banner.labelled': 'AI citizens are labelled',
  'banner.recorded': 'recorded {date}',
  'banner.run': 'run {id}',
  'banner.not_local': 'WARNING: the herald reports cluster "{cluster}", not a local test chain. This page is built for a local test chain only.',
  'banner.no_herald': 'LOCAL TEST CHAIN (the herald has not answered yet)',

  // badges
  'badge.ai': 'AI citizen, Gemma 4 local',
  'badge.ai_short': 'AI',
  'badge.script': 'script bot: not AI, not human',
  'badge.script_short': 'script bot',
  'badge.seat': 'presenter seat (human operator)',
  'badge.seat_scripted': 'presenter seat, scripted for the A/B test',
  'badge.seat_short': 'presenter',
  'badge.assisted': 'AI-assisted (self-declared)',
  'badge.assisted_short': 'AI-assisted (self-declared)',
  'badge.note_scripted_seat': 'scripted seat message',
  'badge.unlabelled': 'citizen not in the AI roster',

  // roster
  'roster.title': 'Citizens',
  'roster.ai_heading': 'AI citizens ({n})',
  'roster.ai_note': 'Run by the operator with Gemma 4 on this machine. Same rules and quotas as people.',
  'roster.script_heading': 'Script bots',
  'roster.script_body': '{n} script bots: rule-driven test population, not AI and not human.',
  'roster.seat_heading': 'Presenter seat',
  'roster.seat_body': 'The operator’s seat: routine moves by the published autopilot; ballots and messages by the presenter.',
  'roster.seat_body_scripted': 'Scripted for the A/B test: its ballots are written by the operator’s script.',
  'roster.share': 'by the model {pct}%',
  'roster.share_none': 'no actions yet',
  'roster.resting': 'resting',
  'roster.deck': 'persona deck: {deck}',
  'roster.none': 'The roster has not been published yet.',

  // card
  'card.title': 'Wyll card',
  'card.pick': 'Choose an AI citizen in the roster to see its card.',
  'card.label': 'AI citizen — run by the operator with Gemma 4 (local). Same rules and quotas as people.',
  'card.nation': 'nation {name}',
  'card.persona': 'persona: {name}',
  'card.creed': 'Creed',
  'card.temperament': 'Temperament',
  'card.goals': 'Goals',
  'card.goal_memory': 'memory goal',
  'card.progress_not_computed': 'progress not computed',
  'card.progress': '{n}%',
  'card.status.active': 'active',
  'card.status.done': 'done',
  'card.status.dropped': 'dropped',
  'card.relationships': 'Relationships',
  'card.rel_none': 'No relationships recorded yet.',
  'card.trust': 'trust {n}',
  'card.trust_split': 'code {code} · model {model}',
  'card.memory': 'Memory',
  'card.summary': 'Self-summary',
  'card.summary_none': 'No self-summary yet.',
  'card.summary_label': "Written by the AI's model; not verified, not replayed.",
  'card.summary_bell': 'written at bell {n}',
  'card.recent': 'Recent episodes (code-written from public records)',
  'card.recent_none': 'No episodes yet.',
  'card.grievances': 'Grievances',
  'card.grievances_none': 'No grievances recorded.',
  'card.grievance_open': 'open',
  'card.grievance_answered': 'answered',
  'card.grievance_who': 'against',
  'card.reasons': 'Published reasons',
  'card.reasons_none': 'No reason has been published yet.',
  'card.stats': 'Who acted',
  'card.stats_line': 'by model {m} · by autopilot {a}',
  'card.stats_share': 'The model chose {pct}% of the actions that were sent (the rest is the autopilot’s economy and duties).',
  'card.stats_share_none': 'No actions sent yet.',
  'card.stats_marches': 'model marches {m} (opened {o})',
  'card.stats_decisions': 'decisions {d} (valid {v}), citing memory {c}',
  'card.stats_reflections': 'reflections {r} ({o} accepted), not counted as decisions',
  'card.stats_messages': 'messages {n}, Strike Orders declined {s}',
  'card.budget_resting': 'resting: daily message or reaction budget used',
  'card.budget': 'messages left today {m} · reactions left {r}',
  'card.updated': 'card updated at bell {n}',
  'card.privacy': 'This card holds pseudonymous in-game identifiers only. Episodes are written by code from public records; the self-summary is the model’s own prose; trust values and grievances are automated judgements about named participants.',

  // temperament
  'temp.aggression': 'aggression',
  'temp.loyalty': 'loyalty',
  'temp.ambition': 'ambition',
  'temp.honesty': 'honesty',
  'temp.risk': 'risk',
  'temp.sociability': 'sociability',
  'temp.grudge': 'grudge',
  'temp.w0': 'very low',
  'temp.w1': 'low',
  'temp.w2': 'moderate',
  'temp.w3': 'high',
  'temp.w4': 'very high',

  // decisions
  'dec.title': 'Decisions',
  'dec.intro': 'What AI citizens chose. A march stays sealed until its army has arrived and the destination is public; then the decision opens with the candidates it was offered.',
  'dec.none': 'No decision of an AI citizen to show yet.',
  'dec.filter_all': 'All AI citizens',
  'dec.show_autopilot': 'Show autopilot steps',
  'dec.by_model': 'by: model',
  'dec.by_autopilot': 'by: autopilot',
  'dec.by_unknown': 'by: unknown',
  'dec.state_sealed': 'sealed',
  'dec.state_released': 'released',
  'dec.state_plain': 'published',
  'dec.sealed_body': 'Sealed: the destination and the reason are published once the army has arrived (release at bell {n}). Commitment {commit}.',
  'dec.sealed_body_nobell': 'Sealed: the destination and the reason are published once the army has arrived. Commitment {commit}.',
  'dec.sealed_actions': 'Sent: {actions}.',
  'dec.chose': 'Chose',
  'dec.chose_none': 'no candidate named',
  'dec.candidates': 'Candidates it was offered (made by code)',
  'dec.candidate_chosen': 'chosen',
  'dec.refs': 'see memory {refs}',
  'dec.facts_none': 'no facts',
  'dec.words': "AI's words (model-written, not verified)",
  'dec.words_none': 'The model wrote no reason.',
  'dec.reflection_body': 'A reflection: the AI looked back over its recent episodes and goals. It chose no action here. Its summary, when the checker passes it, is on the card, marked as written by the model.',
  'dec.words_autopilot': 'no model words (autopilot)',
  'dec.withheld': 'The reason was withheld by the checker.',
  'dec.remembered': 'Remembered (cited by the model):',
  'dec.remembered_none': 'nothing cited',
  'dec.remembered_missing': 'episode {id} is not in the published list',
  'dec.remembered_loading': 'episode {id}: the episode list has not loaded yet',
  'dec.remembered_caption': 'These lines are written by code from public records. A citation shows that the line was shown to the model and named by it, not that the choice rested on it.',
  'dec.destination': 'Destination',
  'dec.destination_at': '({p},{q}) tile {tile}',
  'dec.arrives': 'arrives at bell {a} (planned {b})',
  'dec.unrevealed': 'The march was never revealed on chain; no destination is published.',
  'dec.not_sent': 'This march was not sent.',
  'dec.goal': 'goal {id}',
  'dec.say': 'Said',
  'dec.kind.session': 'session',
  'dec.kind.reaction': 'reaction',
  'dec.kind.reflection': 'reflection',
  'dec.kind.motion': 'council motion',
  'dec.kind.ballot': 'council ballot',
  'dec.kind.autopilot': 'autopilot step',
  'dec.reason.below_gate': 'below the gate',
  'dec.reason.budget': 'budget used',
  'dec.reason.no_time': 'no time',
  'dec.reason.timeout': 'timeout',
  'dec.reason.late': 'late',
  'dec.reason.not_ready': 'not ready',
  'dec.reason.season_end': 'season end',
  'dec.reason.feed_lag': 'feed lagging',
  'dec.reason.llm_error': 'model error',
  'dec.reason.v6_all_refused': 'all choices refused by the final check',
  'dec.reason.ok': 'ok',
  'dec.intent.depart': 'march',
  'dec.intent.build': 'build',
  'dec.intent.train': 'train',
  'dec.intent.muster': 'muster',
  'dec.intent.explore': 'explore',
  'dec.intent.harvest': 'harvest',
  'dec.intent.walls': 'walls',
  'dec.intent.reveal': 'reveal',
  'dec.cand.autopilot': 'routine: economy and duties only',
  'dec.cand.hold': 'hold: keep armies home',
  'dec.cand.march': 'march',
  'dec.cand.recall': 'recall',
  'dec.cand.build': 'build',
  'dec.cand.walls': 'walls',
  'dec.cand.train': 'train',
  'dec.cand.muster': 'muster',
  'dec.cand.explore': 'explore',

  // events and chronicle
  'ev.title': 'Departures and clashes',
  'ev.intro': 'Armies leave with their destination sealed. A clash is reported after the arrival bell.',
  'ev.none': 'No departure or clash published yet.',
  'ev.depart': '{who} sent an army of {troops} troops from {from}; arrives at bell {arrive}. Destination sealed.',
  'ev.depart_notroops': '{who} sent an army from {from}; arrives at bell {arrive}. Destination sealed.',
  'ev.depart_open': '{who} marched from {from} to {to}; arrived at bell {arrive}.',
  'ev.clash': 'Clash at {at}, bell {bell}: {sides}.',
  'ev.clash_engagements': '{n} engagements',
  'ev.clash_lost': '{nation} lost {n}',
  'ev.clash_lost_unknown': 'losses are not in this file',
  'ev.after': '{n} troops after the clash',
  'ev.fate.None': 'no fate recorded',
  'ev.fate.Stays': 'stayed',
  'ev.fate.Withdrew': 'withdrew',
  'ev.fate.Bounced': 'bounced',
  'ev.fate.Retreated': 'retreated',
  'ev.fate.Destroyed': 'destroyed',
  'ev.fate.BouncedUnranked': 'bounced',
  'ev.fate.Routed': 'routed',
  'ev.fate.BadSeal': 'seal refused',
  'ev.kind.depart': 'departure',
  'ev.kind.clash': 'clash',
  'ev.kind.other': 'event',
  'ev.nation': 'nation {name}',
  'chron.title': 'Chronicle',
  'chron.none': 'The chronicle is empty.',
  'chron.kind.motion': 'motion',
  'chron.kind.call_adopted': 'Strike Order adopted',
  'chron.kind.call_declined': 'Strike Order declined',
  'chron.kind.no_call': 'no Strike Order',
  'chron.kind.strike_result': 'strike result',
  'chron.kind.ai_joined': 'AI citizen joined',
  'chron.kind.ai_card_changed': 'card changed',
  'chron.kind.ai_march_opened': 'march opened',
  'chron.by_model': 'by model',
  'chron.by_autopilot': 'by autopilot',

  // feed and compose
  'feed.title': 'Messages',
  'feed.none': 'No message yet.',
  'feed.channel.all': 'All',
  'feed.channel.world': 'World',
  'feed.channel.nation': 'Nation',
  'feed.channel.direct': 'Direct',
  'feed.to_nation': 'to nation {name}',
  'feed.to_world': 'to everyone',
  'feed.to_direct': 'to {who}',
  'feed.motion': 'moved option {n}',
  'feed.redacted': '(redacted by the operator)',
  'feed.public_note': 'Every channel is public. “Direct” means addressed, not private.',
  'compose.title': 'Write a message',
  'compose.channel': 'Channel',
  'compose.recipient': 'To',
  'compose.text': 'Message',
  'compose.send': 'Sign and send',
  'compose.counter': '{n} / 280',
  'compose.need_key': 'Import the presenter key below to write.',
  'compose.sent': 'Sent.',
  'compose.failed': 'Not sent: {why}',
  'compose.to_ai': 'You are writing to an AI citizen.',
  'compose.to_ai_detail': '{name} is an AI citizen run by the operator with Gemma 4 on this machine. It reads your message, may reply, and keeps a memory line about it (a "message received" episode). Messages are public, signed and permanent for this run.',
  'compose.to_channel_ai': 'AI citizens read this channel. Messages are public, signed and permanent for this run.',
  'compose.preview': 'The service stores your text after its own cleaning (control characters and markup-like tokens removed), so what is shown may differ from what you typed.',
  'compose.recipient_none': 'Choose an AI citizen',

  // first-post notice
  'notice.title': 'Before your first message',
  'notice.body1': 'Messages are public, signed and permanent for this run. They are read by AI citizens running on a local model.',
  'notice.body2': 'Each AI also keeps and publishes memory records of what happens to it: an episode that you messaged it, trust scores and grievances about named citizens (on its card), and a model-written summary.',
  'notice.body3': 'Nothing is sent to third parties. Hackathon runs have operator-team humans only.',
  'notice.accept': 'I understand',

  // council
  'council.title': 'Nation council and Strike Order',
  'council.intro': 'Each nation’s council picks one of three code-made targets: the Strike Order. Anyone eligible may move an option; ballots are hidden until the order opens.',
  'council.nation': 'Nation',
  'council.state.none': 'No council this period',
  'council.state.motions': 'Motion window: citizens may move an option',
  'council.state.ballots': 'Ballot window: one ballot each, hidden until the order opens',
  'council.state.closed': 'Closed',
  'council.period': 'period {k}',
  'council.closes': 'closes at bell {n} ({left} bells left)',
  'council.closes_past': 'closed at bell {n}',
  'council.options': 'Options (made by code, same for everyone)',
  'council.option': 'Option {n}',
  'council.kind.strike': 'enemy stack',
  'council.kind.camp': 'camp',
  'council.kind.raid': 'village raid',
  'council.enemy': 'target strength {v}',
  'council.enemy_unknown': 'target strength: not in this file',
  'council.own': 'our nearby troops {o}',
  'council.ratio': 'ratio: {word} (estimate)',
  'council.ratio.favourable': 'favourable',
  'council.ratio.even': 'even',
  'council.ratio.unfavourable': 'unfavourable',
  'council.motions': 'Motions',
  'council.motions_none': 'No motion yet.',
  'council.motions_none_closed': 'No motion was made in this period.',
  'council.moved': 'moved option {n}',
  'council.ballots_cast': 'Ballots cast: {n} (counts stay hidden until the order opens)',
  'council.tally_split': 'Ballots by who cast them: AI {ai} · human (the presenter) {human} · scripted seat {scripted}',
  'council.adopted': 'Strike Order adopted with {parts} — strike at bell {s} (target sealed).',
  'council.adopted_open': 'Strike Order adopted with {parts} — struck at bell {s}.',
  'council.adopted_parts_ai': '{n} AI ballot(s)',
  'council.adopted_parts_human': 'the presenter’s ballot',
  'council.adopted_parts_scripted': 'a scripted seat ballot',
  'council.adopted_parts_none': 'no ballot recorded',
  'council.not_adopted': 'No Strike Order adopted ({reason}).',
  'council.reason.quorum': 'fewer than two ballots for the leading option',
  'council.reason.tie': 'tie',
  'council.reason.none_wins': '“none” won',
  'council.reason.human_present': 'no human or scripted-seat ballot among the winner’s ballots (a nation with a human needs one)',
  'council.opened': 'The Strike Order opened',
  'council.opened_target': 'Target: option {n}, {kind} at {at}',
  'council.opened_tally': 'Tally: {tally}',
  'council.tally_none': 'none',
  'council.result': 'Result',
  'council.result_present': 'armies present at the target: {n}',
  'council.result_bounced': 'bounced: {n}',
  'council.result_clash': 'clash: {sides}',
  'council.result_waiting': 'The strike result is published after the strike bell.',
  'council.pivotal.title': 'Was your ballot pivotal?',
  'council.pivotal.yes': 'Yes: without your ballot this option would not have been adopted ({why}).',
  'council.pivotal.no': 'No: the option would have been adopted without your ballot.',
  'council.pivotal.unknown': 'Not known yet: the counts per option are published when the order opens.',
  'council.pivotal.why_quorum': 'it would have had fewer than two ballots',
  'council.pivotal.why_lead': 'it would not have led strictly',
  'council.pivotal.why_human': 'yours was the only human or scripted-seat ballot for it, and a nation with a human needs one',
  'council.pivotal.none_cast': 'You have not cast a ballot in this period.',
  'council.pivotal.other': 'You voted for another option, so your ballot was not for the adopted one.',
  'council.vote': 'Cast your ballot',
  'council.vote_none': 'none of these',
  'council.vote_option': 'Vote option {n}',
  'council.vote_done': 'Your ballot is recorded (hidden until the order opens).',
  'council.vote_failed': 'Ballot not accepted: {why}',
  'council.vote_need_key': 'Import the presenter key below to vote.',
  'council.vote_not_member': 'Your key belongs to another nation; open your own nation’s council to vote.',
  'council.motion_title': 'Move an option',
  'council.motion_send': 'Sign and move',
  'council.motion_text': 'Speech for the motion',
  'council.motion_done': 'Your motion is recorded.',
  'council.scope_title': 'What this council is, and is not',
  'council.scope1': 'The council is off-chain: the program has no governance, and nothing on chain enforces a Strike Order. It moves only its members’ armies, by rule (script bots) or by an AI citizen’s own choice.',
  'council.scope2': 'The human-present rule binds only a nation that has an eligible human (in the hackathon: nation 0 with the operator’s seat) and constrains only the collective Strike Order, never an individual AI citizen’s own march.',
  'council.scope3': 'Humans and AI citizens therefore decide for the same nation at two levels: individual actions under identical rules, keys, quotas and fog; and the council’s Strike Order. In the hackathon the human is the operator, for nation 0 only.',
  'council.scope4': 'Motions are public, so they leak preference; that is the cost of a public debate. Outsiders know a strike lands at the strike bell and can only guess the target.',
  'call.title': 'Your Strike Order (members only)',
  'call.need_key': 'Import a key of a citizen of this nation to read the sealed order.',
  'call.read': 'Read the sealed order',
  'call.sealed_for_you': 'Strike Order for nation {name}: option {n}, {kind} at {at}, strike at bell {s}.',
  'call.invited': 'invited armies: {n}',
  'call.follow_from': 'armies may follow from bell {n}',
  'call.commit': 'commitment {commit}',
  'call.members_only': 'Only citizens of the nation can read this before it opens.',
  'call.error': 'Not read: {why}',
  'call.none': 'No sealed order for this nation and period.',
  'call.opened': 'The order has opened: its target is public (see above).',

  // keys
  'keys.title': 'Presenter key',
  'keys.intro': 'To write, vote or read the sealed order you need the presenter seat’s in-game key (a local test key). It stays in this page’s memory only.',
  'keys.paste': 'Paste the key file',
  'keys.use': 'Use this key',
  'keys.saved': 'Use the key the Frontier client saved in this browser',
  'keys.forget': 'Forget the key',
  'keys.ok': 'Key loaded: {who}.',
  'keys.who_seat': 'presenter seat',
  'keys.who_wallet': 'a citizen of the season',
  'keys.err.empty': 'Paste the key file first.',
  'keys.err.format': 'This is not a key file this page understands (a seat key file, a Wylls key backup or 64 hex digits).',
  'keys.err.mismatch': 'The session key does not match the file’s public key.',
  'keys.err.nosubtle': 'This browser cannot sign with Ed25519 (needs Chrome or Edge 137+, Firefox 129+ or Safari 17+) on a secure page.',
  'keys.err.nosaved': 'No saved Frontier key found for this season in this browser.',
  'keys.err.import': 'The key could not be loaded.',
  'keys.err.ai_key': 'This key belongs to an AI citizen. The page never signs as an AI citizen.',
  'keys.err.noseat': 'No saved key of the presenter seat in this browser. Paste the key file instead.',
  'keys.err.no_wallet': 'The key does not say which wallet it belongs to; paste the whole key backup.',

  // refusal codes of the social service
  'err.BadBytes': 'the record was not well formed',
  'err.BadSignature': 'the signature does not match',
  'err.SessionMismatch': 'this key is not the citizen’s registered session key',
  'err.SessionExpired': 'the session key has expired',
  'err.BellSkew': 'the clocks differ by too much; try again',
  'err.SeqReplay': 'a newer message of yours was already accepted; try again',
  'err.TextTooLong': 'the message is too long',
  'err.NotFromMind': 'this record was not made by the AI’s own mind',
  'err.NotEligible': 'you are not eligible (a village that is final at the start of the period is needed)',
  'err.NotMember': 'only citizens of the nation may do this',
  'err.WindowClosed': 'that window is not open',
  'err.Duplicate': 'already done (one per period)',
  'err.RateLimited': 'too many requests; wait a moment',
  'err.HeraldUnavailable': 'the herald could not be asked; try again',
  'err.network': 'the service did not answer',
  'err.unknown': 'refused ({code})',
};

/**
 * The dictionaries. English is written here; Japanese lives in lang.ja.json (the page's two-language rule keeps Japanese
 * text out of the .mjs sources the main client's translation check scans) and is registered at start by main.mjs
 * (fetch) or by a test (fs). Until it is registered a Japanese lookup falls back to English.
 */
export const DICT = { en: EN, ja: {} };
export function registerJa(obj) {
  if (!obj || typeof obj !== 'object') throw new TypeError('registerJa: an object of strings');
  DICT.ja = Object.freeze({ ...obj });
}
