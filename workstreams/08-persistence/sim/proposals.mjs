// The reference (current shape) and up to three candidate structures.
// None of the candidates is adopted; see ../03-proposals.ja.md.
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

export const B = {
  id: 'B',
  name: '世界は続き、地域と目標を区切る',
  boundary: 'reset_war',
  joinDeadlineDay: null,
  switching: true,
  defeatMode: 'strip',
  newcomer: { protectionH: 72, onAttack: 'ends', endsOnFarms: 6, placement: 'interior', catchUp: 0 },
  rejoin: { allowedInPeriod: true, delayH: 0, keepFarmsFrac: 0, salvageFrac: 0, protectionH: 0, placement: 'interior' },
  upkeep: { freeFarms: 8, rate: 0.5, exp: 1.3 },
  cellarFrac: 0.5, // the home stays immune as today
  forts: { rotateTheater: true },
  // armies stand down at the boundary to a home guard of 2 troops per farm (at least the starter troops);
  // without this, B's lock-in matched C's (see 05-results, "B without demobilisation")
  demobilize: 2,
  rights: { caravans: 'deliver_or_return', fortSupply: 'return', standing: 'keep' },
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

export const PROPOSALS = { P0, A, B, C };
