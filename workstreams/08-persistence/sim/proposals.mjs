// The reference (current shape) and three candidate structures; B is split into B1 (the decision
// log's plan as written) and B2 (B1 + this workstream's disbanding rule). None is adopted;
// see ../03-proposals.ja.md.
//
// boundary:
//   'reset_world' – the competitive unit ends and the material world is rebuilt (villages,
//                   stock, troops, facilities, map rings). Identity and history persist.
//   'reset_war'   – the world persists; victory forts return to neutral, garrisons go home,
//                   scores restart. With rotateTheater the scoring forts move to a newly opened region
//                   ('underdog': the region opens nearest the nations that held least). With demobilize
//                   armies stand down to a home guard.
//   'none'        – the world and the forts persist; only the score ledger restarts.
//
// defeatMode:
//   'strip'     – the home cannot be taken (code: PlaceHome in the unbesiegeable heartland);
//                 outposts, stores and half the troops are lost, the village stays.
//   'eliminate' – the village is occupied and removed; the owner may re-found (rejoin rule).
//
// newcomer.onAttack: 'blocked' (code: a shielded holding cannot be a siege source)
//                    or 'ends' (design doc 19: attacking ends protection).

const CODE_PROTECTION = { protectionH: 24, lateAfterH: 12, lateExtraH: 36, onAttack: 'blocked', endsOnFarms: null };

export const P0 = {
  id: 'P0',
  name: '現行（参照）',
  boundary: 'reset_world',
  joinDeadlineDay: 10.5, // code: join_close_bell 1,512 of 2,016
  switching: false, // code: the faction is written once at Join
  defeatMode: 'strip',
  newcomer: { ...CODE_PROTECTION, placement: 'interior', catchUp: 0 },
  rejoin: { allowedInPeriod: false, delayH: 0, keepFarmsFrac: 0, salvageFrac: 0, protectionH: 0, placement: 'interior' },
  upkeep: null,
  cellarFrac: 0.5, // proxy: the home's stores cannot be sieged; raids stand for outposts and caravans
  forts: { rotateTheater: false },
  // code: caravans have no end_bell guard (inference), vault/structure have no post-end close
  rights: { caravans: 'void', fortSupply: 'void', standing: 'cancel' },
};

export const A = {
  id: 'A',
  name: '競争単位を区切る（身元・記録・創作定義は残す）',
  boundary: 'reset_world',
  joinDeadlineDay: null,
  switching: true,
  defeatMode: 'strip',
  // catch-up: a late joiner's starter goods grow with the elapsed share of the unit
  newcomer: { ...CODE_PROTECTION, placement: 'interior', catchUp: 1.0 },
  rejoin: { allowedInPeriod: true, delayH: 0, keepFarmsFrac: 0, salvageFrac: 0, protectionH: 0, placement: 'interior' },
  upkeep: null,
  cellarFrac: 0.5, // proxy: the home's stores cannot be sieged; raids stand for outposts and caravans
  forts: { rotateTheater: false },
  rights: { caravans: 'void', fortSupply: 'void', standing: 'cancel' },
};

// B1: the decision log's adopted plan (docs/design/redesign/23, 99: 2026-10-23) as written:
// the world continues; at each cut the victory forts return to neutral, their garrisons go home,
// war state and scores restart. Nothing else is reset. Newcomer protection follows doc 19 (decided
// mechanism; 72 h is the doc's example figure), "bigger is heavier" upkeep follows the decided idea
// (figures are this model's). The rotating region is NOT part of the decision; it is a sensitivity knob.
export const B1 = {
  id: 'B1',
  name: '世界は続き、砦の中立化と守備兵の帰還で区切る（文書23の既存決定どおり）',
  boundary: 'reset_war',
  joinDeadlineDay: null,
  switching: true,
  defeatMode: 'strip',
  newcomer: { protectionH: 72, onAttack: 'ends', endsOnFarms: 6, placement: 'interior', catchUp: 0 },
  rejoin: { allowedInPeriod: true, delayH: 0, keepFarmsFrac: 0, salvageFrac: 0, protectionH: 0, placement: 'interior' },
  upkeep: { freeFarms: 8, rate: 0.5, exp: 1.3 },
  cellarFrac: 0.5, // the home stays immune as today
  forts: { rotateTheater: false },
  demobilize: 0,
  // delivered supply belongs to the nation (gift); cargo still on the road stays its sender's
  rights: { caravans: 'deliver_or_return', fortSupply: 'nation', standing: 'keep' },
};

// B2: B1 plus a NEW rule this workstream proposes for testing only (not in any decision):
// at each cut every army stands down to a home guard of 2 troops per farm (at least the starter
// troops); the rest is disbanded with no refund. Figures are placeholders, not a spec.
export const B2 = {
  ...B1,
  id: 'B2',
  name: 'B1＋区切りで軍を解散（⑧の追加案、検証用）',
  demobilize: 2,
  demobRefund: 0,
};

export const C = {
  id: 'C',
  name: '蓄積を維持し、新人と敗者の参加経路を設ける',
  boundary: 'none',
  joinDeadlineDay: null,
  switching: true,
  defeatMode: 'eliminate',
  newcomer: { protectionH: 72, onAttack: 'ends', endsOnFarms: 6, placement: 'interior', catchUp: 0 },
  rejoin: { allowedInPeriod: true, delayH: 12, keepFarmsFrac: 0.25, salvageFrac: 0, protectionH: 48, oncePerPeriod: true, placement: 'interior' },
  upkeep: { freeFarms: 8, rate: 0.8, exp: 1.5 },
  cellarFrac: 0.2,
  forts: { rotateTheater: false },
  rights: { caravans: 'deliver_or_return', fortSupply: 'keep', standing: 'keep' },
};

export const PROPOSALS = { P0, A, B1, B2, C };
