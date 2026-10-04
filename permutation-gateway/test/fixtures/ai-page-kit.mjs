// Fixtures for the council page's tests (unit AC7). SYNTHETIC: every value is made up in the real shapes (the roster of
// §8.3, the card of §2.4 as AC2's renderCard writes it, the decision records of §7.2, the council state of AC4's
// routes). Nothing here was produced by a run; tests that use it say "synthetic" in their titles.
export const W = {
  ai0: '7ChGBztTvT1ymVk43AgTyaAcWcwkcHPjGRFWAE2d7Ceb',
  ai1: '9VUWXMvPqqBvcQj47oE5VkSvEAqaz8zDkTgXkrcXziS6',
  ai2: 'D2vEqQ5EEVYZ7z8RorZvNjfYsq2oCrtQTnSzseyYHvVT',
  seat: 'GLnqPhGTAzXQNyiuA8vYSrMMHfyArjEHBfEsT5x7R7UY',
  s0: '57ACoYGGRcCyx4Qwfbdkk5k7ESmih5B2xG87xyEF2LaP',
  s1: 'GHAw5eAE28B4JLUyRARvT1HiSxTkmyBPS2AtvQc9zHUC',
  human: '4Nd1mYQq8KqM6bVx3dEo7rLw9XkTzPcFhJ2uAaYsRbGv',
};
export const T = {
  ai0: 'f3f2eb157c6ae029', ai1: 'daa181a1a18653f8', ai2: '9475f24b4c8db2cb', seat: '7b809f81ebbc9a00',
  s0: '24e5e39dc7e743d3', s1: '9a01474897088a66', human: '0123456789abcdef', stranger: 'aaaaaaaaaaaaaaaa',
};

export const roster = (over = {}) => ({
  v: 1, season: 41, program_id: '7sFcyZJVFYk1JZwkXUFWqgh92xL4Zdf1JRrwwGfnRG2c', genesis_round: '30942083', genesis_seed: '5a'.repeat(32), deck: 'deck-2', commitments_sha256: 'ab'.repeat(32),
  ai: [
    { index: 1000, wallet: W.ai0, tag: T.ai0, faction: 0, persona: 'avenger', ambition: { en: 'Avenger', ja: '復讐者' }, creed_variant: 1, temperament: { aggression: 66, loyalty: 70, ambition: 50, honesty: 60, risk: 61, sociability: 44, grudge: 90 }, name: { en: 'Toa Festead', ja: 'トア・フェステッド' }, kind: 'ai', label: 'AI citizen, Gemma 4 local' },
    { index: 1001, wallet: W.ai1, tag: T.ai1, faction: 1, persona: 'diplomat', ambition: { en: 'Diplomat', ja: '外交官' }, creed_variant: 3, temperament: { aggression: 25, loyalty: 60, ambition: 55, honesty: 75, risk: 35, sociability: 90, grudge: 30 }, name: { en: 'Elrin Somere', ja: 'エルリン・ソメア' }, kind: 'ai', label: 'AI citizen, Gemma 4 local' },
    { index: 1002, wallet: W.ai2, tag: T.ai2, faction: 0, persona: 'diplomat', ambition: { en: 'Diplomat', ja: '外交官' }, creed_variant: 0, temperament: { aggression: 30, loyalty: 61, ambition: 54, honesty: 76, risk: 34, sociability: 88, grudge: 29 }, name: { en: 'Vanasha Soridge', ja: 'ヴァナシャ・ソリッジ' }, kind: 'ai', label: 'AI citizen, Gemma 4 local' },
  ],
  script: { first_index: 0, count: 120, wallets: [W.s0, W.s1], kind: 'script', label: 'script bot: not AI, not human' },
  seat: { index: 1003, wallet: W.seat, tag: T.seat, faction: 0, kind: 'seat', label: 'Presenter (operator, human)', scripted: false },
  sig: 'x',
  ...over,
});

export const episodeText = {
  attacked: { en: 'At bell 388 Elrin Somere (nation Borealis) attacked your army at (-2,3); you lost 120 troops.', ja: '鐘388で、エルリン・ソメア（国ボレアリス）があなたの軍を(-2,3)で攻撃し、あなたは兵120を失った。' },
  camp: { en: 'At bell 205 nation Ember cleared the camp at (-2,3) first.', ja: '鐘205で、国エンバーが野営地(-2,3)を先に制圧した。' },
};

export const card = (tag = T.ai0, over = {}) => ({
  v: 1, ai: true,
  label: { en: 'AI citizen — run by the operator with Gemma 4 (local). Same rules and quotas as people.', ja: 'AI市民（運営がローカルのGemma 4で動かしています）。人と同じルールと回数制限で遊びます。' },
  tag, wallet: W.ai0, faction: 0, index: 1000, name: { en: 'Toa Festead', ja: 'トア・フェステッド' },
  persona: { id: 'avenger', ambition: 'Avenger', creed: { en: 'Every wrong done to my people is answered.', ja: '同胞が受けた仕打ちには、必ず報いる。' }, temperament: { aggression: 66, loyalty: 70, ambition: 50, honesty: 60, risk: 61, sociability: 44, grudge: 90 } },
  goals: [
    { id: 'G1', text: { en: 'Answer every grievance with a march that reaches the wrongdoer within 12 bells', ja: '遺恨には12鐘以内の進軍で応える' }, progress: 50, status: 'active', memory: true },
    { id: 'G2', text: { en: 'Keep at least half of the home troops', ja: '本拠の兵の半数以上を保つ' }, progress: 100, status: 'active', memory: false },
    { id: 'G3', text: { en: 'Move a council option whose target nation has an open grievance against it', ja: '遺恨のある国を狙う選択肢を評議会で動議する' }, progress: null, status: 'active', memory: true },
    { id: 'G4', text: { en: 'Keep two combat armies', ja: '戦闘軍を2つ保つ' }, progress: 0, status: 'active', memory: false },
  ],
  relationships: [
    { who: T.ai1, name: { en: 'Elrin Somere', ja: 'エルリン・ソメア' }, kind: 'citizen', trust: -35, trust_code: -30, trust_model: -5, last_event_bell: 388 },
    { who: 'nation:1', name: { en: 'Borealis', ja: 'ボレアリス' }, kind: 'nation', trust: -10, trust_code: -10, trust_model: 0, last_event_bell: 388 },
  ],
  memory: {
    summary: { bell: 432, text: 'I was attacked at bell 388 and lost troops. I want the camp that Ember took.', sha256: 'cd'.repeat(32), label: { en: "Written by the AI's model; not verified, not replayed.", ja: 'AIのモデルが書いた文章です。確認も再現もされていません。' } },
    recent: [
      { id: 'a1e34dee94bb1e02', bell: 388, kind: 'attacked_own', text: episodeText.attacked },
      { id: '5f1471ffff624f49', bell: 205, kind: 'camp_taken_by', text: episodeText.camp },
    ],
    grievances: [{ against: T.ai1, name: { en: 'Elrin Somere', ja: 'エルリン・ソメア' }, episode: 'a1e34dee94bb1e02', bell: 388, weight: 8, answered: false }],
  },
  revealed_reasons: [{ bell: 402, decision_id: 'd'.repeat(64), by: 'model', why: 'The camp is close and my army is idle.', remembered: [{ id: '5f1471ffff624f49', bell: 205, age_bells: 197, text: episodeText.camp }] }],
  budget: { messages_left: 3, reactions_left: 2, resting: false },
  stats: { decisions: 41, valid: 40, actions_by_model: 9, actions_by_autopilot: 112, model_marches: 3, model_marches_opened: 2, messages: 7, strikes_declined: 1, decisions_citing_memory: 6, mem_dropped: 0 },
  updated_bell: 431,
  ...over,
});

export const episodesFile = (tag = T.ai0) => ({
  v: 1, tag, sha256: 'ee'.repeat(32),
  episodes: [
    { v: 1, id: 'a1e34dee94bb1e02', bell: 388, created_bell: 390, kind: 'attacked_own', entities: [T.ai0, T.ai1, 'nation:1', 'pq:-2,3'], text: episodeText.attacked, importance: 8, src: ['event:1'] },
    { v: 1, id: '5f1471ffff624f49', bell: 205, created_bell: 206, kind: 'camp_taken_by', entities: ['nation:4', 'pq:-2,3'], text: episodeText.camp, importance: 5, src: ['event:2'] },
  ],
});

/** A sealed march decision record as `minds/<b>.json` publishes it (§7.2: commitment only), and its opened record. */
export const sealedRecord = (over = {}) => ({
  v: 2, sealed: true, release_bell: 410, commit: 'b91b270ca5d76338e8b744f33f64b950fccfefbe06a508efec4036afd287e962',
  tx: [{ intent: 'depart', sig: 's'.repeat(64), status: 'sent', code: null }, { intent: 'muster', sig: 't'.repeat(64), status: 'sent', code: null }],
  ai: T.ai0, index: 1000, bell: 402, kind: 'session', mode: 'model', reason: 'ok', wake: ['W-PULSE'], gate_score: 3, id: 'e'.repeat(64), ...over,
});
export const openedRecord = (over = {}) => ({
  id: 'e'.repeat(64), nonce: '00'.repeat(16), ai: T.ai0, bell: 402, index: 1000, mode: 'model', release_bell: 410,
  choice: { ids: ['c3'], params: { c3: { stance: 'assault' } }, council: null, goal_id: 'G1', mem: ['5f1471ffff624f49'] },
  retrieved: ['a1e34dee94bb1e02', '5f1471ffff624f49'],
  public: { say: [], why: 'The camp near home is weakly held and my army has been idle.', why_withheld: null },
  candidates: [
    { id: 'c1', kind: 'autopilot', label: 'routine: economy and duties only', facts: { summary: 'build farm; train 300 Spearman' }, entities: [], refs: [] },
    { id: 'c2', kind: 'hold', label: 'hold: keep armies home', facts: { note: 'duties only' }, entities: [], refs: [] },
    { id: 'c3', kind: 'march', label: 'march 600 troops at the camp at (-2,3)', facts: { distance_hexes: 7, target_troops: 240, ratio: 'favourable (estimate)', reward: '10 Works (points, no use yet)' }, entities: ['pq:-2,3'], refs: ['M2'], troops: 600 },
  ],
  remembered: [{ id: '5f1471ffff624f49', bell: 205, text: episodeText.camp }],
  destinations: [{ host_id: '1234', p: -2, q: 3, tile: 5, planned_arrive_bell: 409, arrive_bell: 410 }],
  ...over,
});

export const councilState = (over = {}) => ({
  v: 1, period: 2, faction: 0, c0: 48, closes_bell: 54, state: 'ballots',
  options: [
    { option: 1, kind: 'camp', p: -2, q: 3, value: 120, own: 400, enemy: 200, ratio: 'favourable' },
    { option: 2, kind: 'strike', p: 1, q: 4, value: 500, own: 600, enemy: 500, ratio: 'even' },
    { option: 3, kind: 'raid', p: 3, q: -1, value: 800, own: 700, enemy: 1000, ratio: 'unfavourable' },
  ],
  candidates_hash: 'ab'.repeat(32), options_hash: 'cd'.repeat(32),
  motions: [{ id: 5, wallet: W.ai2, tag: T.ai2, name: { en: 'Vanasha Soridge', ja: 'ヴァナシャ・ソリッジ' }, option: 1, text: 'The camp is close; let us take it.', origin: 1, ai_written: true, ai_roster: true, bell: 49 }],
  ballots_cast: 1, adopted: false, strike_bell: null, call_commit: null, tally_split: null,
  ...over,
});
