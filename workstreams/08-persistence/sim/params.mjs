// Model parameters. Each carries where it comes from:
//   code       – the current value in the repository at the base commit (see ../01-current-rules.ja.md)
//   design     – a figure named in docs/design/redesign (a proposal or "例" there, not a measured fact)
//   assumption – chosen for this model only; results that hinge on it are listed in ../05-results.ja.md
//
// Time unit: 1 tick = 1 hour.

export const BASE = {
  // ---- time
  periodDays: 14, // code: 14-day season (current setting, not a principle)
  periods: 4, // assumption: long enough to see carry-over between competitive units

  // ---- population
  nations: 6, // code + design: six nations, fixed
  humansPerNation: 8, // assumption
  aiPerNation: 2, // assumption
  sessionLadder: [1, 1, 2, 2, 3, 4, 6, 12], // assumption: sessions/day of the 8 day-1 humans in each nation

  // ---- economy (abstract "goods" = food+wood+ore; abstract, not the production figures)
  starterGoods: 200, // assumption
  starterTroops: 10, // assumption
  starterFarms: 2, // assumption
  farmYield: 4, // goods / farm / hour, assumption
  collectCapHours: 12, // uncollected production stops accruing after this, assumption
  farmBaseCost: 60, // assumption
  farmCostGrowth: 1.35, // assumption: each extra copy of a building costs more (code has duplicate_cost; shape only)
  towerCost: 150, // assumption
  workshopCost: 250, // assumption
  troopPrice: 5, // goods per troop, assumption
  troopUpkeep: 0.04, // goods / troop / hour, assumption
  cellarFrac: 0.0, // share of stock raiders cannot take, assumption (proposals may override)

  // ---- conflict
  forts: 4, // victory forts in the scoring theater, assumption
  neutralGarrison: 40, // assumption
  fortDefence: 1.3, // assumption
  opWindowHours: 6, // a nation's joint operation accepts commitments for this long; it resolves once the farthest march can land, assumption
  supplyLot: 40, // minimum supply caravan, assumption
  minTroopsToSend: 5, // assumption
  travelInterior: 5, // hours from an interior village to the theater, assumption
  travelBorder: 3,
  travelRing: 3,
  raidMinTroops: 8, // assumption
  raidCarryPerTroop: 10, // assumption
  raidLootFrac: 0.5, // assumption
  occupyMinAttackers: 15, // assumption
  occupyProb: 0.3, // assumption
  interceptBase: 0.15, // assumption
  raidPower: 1.0, // global multiplier on raid propensity (sensitivity)

  // ---- map
  interiorSlots: 8, // per nation, assumption
  borderSlots: 8, // per nation, assumption
  ringSlots: 4, // per nation per opened ring, assumption
  ringThetaEarly: 0.55, // code: theta_early_bps 5,500 during the first 3 days
  ringThetaLate: 0.65, // code: theta_late_bps 6,500 afterwards (per wedge = per nation)

  // ---- presence
  dormantAfterH: 120, // code: dormant after 5 days without an owner action
  dormantProduction: 0.5, // code: dormant production x50 %, and the shield stops protecting

  // ---- AI
  aiActsPerDay: 24, // always-on agents act every hour; code bucket is 30 actions/h for humans and AIs alike (sensitivity: 8 = the AI config's session cap)

  // ---- behaviour levers applied equally to every proposal (sensitivity, not proposals)
  behaviourMix: 'mixed', // 'mixed' | 'coop' | 'raider'
  newcomerNation: 'assigned', // 'assigned' | 'bandwagon' | 'balanced'
  switchProb: 0.0, // chance a defeated village re-founds in the leading nation instead
  standingOrders: false, // pre-committed supply sent at window open even when offline (stage-3 idea; not ⑧'s)
  receiptEndsProtection: false, // a protected village that receives goods from others loses protection
  sessionSkip: 0.15, // chance a human skips a planned session, assumption
  sessionJitter: 2, // a planned session moves by up to ±2 h from day to day, assumption

  // ---- leaving and coming back (assumptions only; nothing here is measured, see run.mjs 'retention')
  quitOnDefeat: 0, // chance a human leaves when their village is defeated
  quitBase: 0, // daily chance any human leaves
  quitHazard: 0, // extra daily chance, times a 0..1 gap (see quitModel)
  quitModel: 'relative', // 'relative': gap below the median human village; 'decline': gap below the village's own peak
  quitPeakAcrossResets: false, // 'decline' only: does a world reset count as the person's own loss?
  freqDrop: 0, // daily chance, times the same gap, that a human halves their sessions
  returnProb: 0, // chance someone who left comes back
  returnMinDays: 7,
  returnMaxDays: 21,

  // ---- other levers used only in sensitivity runs
  rushHours: 0, // in the last N hours before a cut, operations always attack and non-turtles send all troops
  altFoundCost: 0, // goods the owner pays (from the main village) when an extra village is founded
};

export const MIXES = {
  mixed: { coop: 0.6, raider: 0.25, turtle: 0.15 },
  coop: { coop: 0.85, raider: 0.05, turtle: 0.1 },
  raider: { coop: 0.35, raider: 0.5, turtle: 0.15 },
};

export const BEHAVIOURS = {
  // fraction of troops sent to an operation, raid chance per action, troop target per farm, supply fraction
  coop: { sendTroops: 0.5, raid: 0.04, troopsPerFarm: 6, supplyFrac: 0.4 },
  raider: { sendTroops: 0.25, raid: 0.35, troopsPerFarm: 10, supplyFrac: 0.15 },
  turtle: { sendTroops: 0.1, raid: 0.01, troopsPerFarm: 5, supplyFrac: 0.1 },
};
