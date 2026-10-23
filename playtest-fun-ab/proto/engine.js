// Wylls A/B prototype: rules engine.
//
// A small, deterministic re-implementation of the current Wylls rules
// (permutation-rules at d789ee3d), cut down to one village per nation and
// a ring of 12 provinces. Version A follows the current rules. Version B
// changes one thing: a nation's base food, ore and gold scale with the
// keeps it holds (3 keeps = exactly the current amount).
//
// Time: the engine runs turn by turn (10 game minutes each, as in the
// game); the player acts once per round of 12 turns (2 game hours).
// Everything here is plain JavaScript with no dependencies, so the same
// file runs in the browser (file://) and in Node for the tests.
(function (root) {
  'use strict';

  const RULES_VERSION = 'proto-1';

  // ---- Time --------------------------------------------------------------
  const BELLS_PER_ROUND = 12; // 12 turns = 2 game hours
  const ROUNDS = 36; // 432 turns = 3 game days
  const END_BELL = ROUNDS * BELLS_PER_ROUND;
  // The prototype plays a whole season in 3 game days instead of 14. Timers
  // that shape the season (the newcomer shield, a captured keep's
  // immunity) are scaled by 3/14 and rounded to whole rounds; timers that
  // shape a fight (march stamina, 72 turns to take a keep, arrival within
  // 72 turns) keep the game's values. See docs/03-AB-DESIGN.ja.md.
  const SEASON_SCALE = 3 / 14;
  const SHIELD_BELLS = 36; // game: 144 (24 h, MC_LOCAL_14D) × 3/14 ≈ 31 → 3 rounds

  // ---- Hosts and keeps (permutation-rules/src/frontier/host.rs, keep.rs) --
  const MILLI = 1000;
  const STAMINA_CAP = 120;
  const DEPART_STAMINA = 74;
  const ENGAGE_STAMINA = 20;
  const MIN_HOST = 100; // troops
  const MAX_HOST_TROOPS = 30000; // host.rs MAX_HOST_TROOPS
  const MAX_HOSTS = 6; // per nation (prototype limit)
  const MAX_TRANSIT = 4; // transit slots per village
  const MAX_ARRIVAL_BELLS = 72;
  const MAX_REACH = 4; // provinces per march
  const DESTROYED_BELOW = 500; // milli-troops
  const KEEP_BELLS = 72;
  const KEEP_CONSOLIDATE = 60; // game: 288 (48 h) × 3/14 ≈ 62 → 5 rounds
  const KEEP_HOME_GUARD = 100;
  const KEEP_GARRISON_BPS = 5000;

  // ---- Combat (permutation-rules/src/combat.rs) --------------------------
  const COMBAT_K_BPS = 5500;
  const BPS = 10000;
  const MOD = {
    COUNTER: 15000,
    TERRAIN: 8000,
    EXHAUSTED: 8500,
    WALLS: 6667,
    RANGED_RETALIATION: 5000,
    CITY_RETALIATION: 5000,
  };
  const F = [
    0, 1000, 1149, 1246, 1320, 1380, 1431, 1476, 1516, 1552, 1585, 1615, 1644, 1670, 1695, 1719,
    1741, 1762, 1783, 1802, 1821, 1838, 1856, 1872, 1888, 1904, 1919, 1933, 1947, 1961, 1974, 1987,
    2000, 2012, 2024, 2036, 2048, 2059, 2070, 2081, 2091, 2102, 2112, 2122, 2132, 2141, 2151, 2160,
    2169, 2178, 2187, 2195, 2204, 2212, 2221, 2229, 2237, 2245, 2253, 2260, 2268, 2275, 2283, 2290,
    2297,
  ];

  // Units (units.rs UNIT_STATS, catalog.rs costs per started 100, arms.rs).
  const UNITS = {
    spear: { name: '槍兵', cls: 'melee', str: 10, cost: { food: 60, ore: 20, gold: 10 } },
    archer: { name: '弓兵', cls: 'ranged', str: 10, cost: { food: 60, ore: 23, gold: 11 } },
    horse: { name: '騎兵', cls: 'mounted', str: 10, cost: { food: 60, ore: 20, gold: 10 } },
    pike: { name: '長槍兵', cls: 'melee', str: 22, cost: { food: 60, ore: 40, gold: 20, arms: 50 } },
    xbow: { name: '弩兵', cls: 'ranged', str: 22, cost: { food: 60, ore: 46, gold: 23, arms: 70 } },
    knight: { name: '騎士', cls: 'mounted', str: 22, cost: { food: 60, ore: 53, gold: 26, arms: 40 } },
  };
  const UNIT_KEYS = Object.keys(UNITS);
  const CLASS_NAME = { melee: '近接', ranged: '射撃', mounted: '騎馬' };

  function counters(a, d) {
    if (!a || !d) return false;
    const x = UNITS[a].cls;
    const y = UNITS[d].cls;
    return (x === 'melee' && y === 'mounted') || (x === 'ranged' && y === 'melee') || (x === 'mounted' && y === 'ranged');
  }

  // ---- Economy (catalog.rs, holding.rs, arms.rs) -------------------------
  const RES = ['food', 'wood', 'stone', 'ore', 'gold', 'arms'];
  const RES_NAME = { food: '食料', wood: '木材', stone: '石', ore: '鉱石', gold: '金', arms: '兵器' };
  // Base production per hour of a Hamlet.
  const BASE_PER_HOUR = { food: 40, wood: 30, stone: 20, ore: 15, gold: 15, arms: 0 };
  const TIERS = [
    { name: '集落', bonus: 0, cap: 2000, slots: 2, up: { wood: 1000, stone: 600, gold: 300 }, upBells: 36 },
    { name: '町', bonus: 50, cap: 6000, slots: 3, up: { wood: 4000, stone: 3000, gold: 1500 }, upBells: 72 },
    { name: '都市', bonus: 100, cap: 15000, slots: 4, up: null, upBells: 0 },
  ];
  const BUILDINGS = {
    farm: { name: '農場', per: { food: 12 }, cost: { wood: 80, stone: 40 } },
    lumber: { name: '伐採場', per: { wood: 10 }, cost: { food: 40, stone: 40 } },
    quarry: { name: '石切り場', per: { stone: 8 }, cost: { food: 40, wood: 80 } },
    mine: { name: '鉱山', per: { ore: 6 }, cost: { food: 40, wood: 80, stone: 20 } },
    mint: { name: '造幣所', per: { gold: 6 }, cost: { food: 40, wood: 60, stone: 40 } },
    workshop: { name: '工房', per: { arms: 4 }, cost: { food: 60, wood: 120, stone: 80, ore: 40 } },
  };
  const WORKSHOP_INPUT_PER_HOUR = { ore: 8, wood: 4 };
  const WALLS = { name: '城壁', cost: { stone: 300 }, bells: 24, points: 100, cap: 1200 };
  const STARTER = { food: 300, wood: 300, stone: 200, ore: 100, gold: 100, arms: 0 };
  // Version B: these base productions scale with keeps held (3 = as in A).
  // Food, ore and gold are what troops cost; wood and stone (buildings) are
  // left alone. (First draft tied ore and gold only; see the change log in
  // docs/01-HYPOTHESES.ja.md.)
  const KEEP_TIED = { food: true, ore: true, gold: true };

  // ---- Map ---------------------------------------------------------------
  // A ring of 12 provinces. Nation k's village is at 4k; it holds the keeps
  // at 4k+1, 4k+2 (a hill keep between two nations) and 4k-1. The map is
  // the same for every nation up to rotation.
  const NATIONS = [
    { name: '青', color: '#3b6fd8' },
    { name: '赤', color: '#c8463d' },
    { name: '黄', color: '#c99a1a' },
  ];
  const NODE_NAMES = ['青の村', '柳の砦', '峠の砦', '葦の砦', '赤の村', '樫の砦', '岩の砦', '楡の砦', '黄の村', '桐の砦', '丘の砦', '梅の砦'];
  const ROUGH = { 2: true, 6: true, 10: true }; // hills: a defender that is not arriving takes ×0.8
  const RING = 12;
  function ringDist(a, b) {
    const d = Math.abs(a - b) % RING;
    return Math.min(d, RING - d);
  }
  function homeOf(n) { return n * 4; }
  function isHome(node) { return node % 4 === 0; }
  function homeNation(node) { return isHome(node) ? node / 4 : -1; }
  function initialKeepHolder(node) {
    const r = node % 4;
    if (r === 1 || r === 2) return (node - r) / 4;
    if (r === 3) return ((node + 1) % RING) / 4;
    return -1;
  }

  // ---- Deterministic hash ------------------------------------------------
  function h32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }
  function variance(seed, bell, node, a, b, side) {
    return 9000 + (h32(`${seed}|${bell}|${node}|${a}|${b}|${side}`) % 2001);
  }

  // ---- State -------------------------------------------------------------
  function newGame(opts) {
    const variant = opts.variant === 'B' ? 'B' : 'A';
    const seed = String(opts.seed == null ? 1 : opts.seed);
    const policies = opts.policies || [null, 'balanced', 'raider'];
    const nations = NATIONS.map((n, i) => ({
      id: i,
      name: n.name,
      color: n.color,
      policy: policies[i] || null,
      res: Object.assign({}, STARTER),
      acc: { food: 0, wood: 0, stone: 0, ore: 0, gold: 0, arms: 0 },
      tier: 0,
      bld: { farm: 0, lumber: 0, quarry: 0, mine: 0, mint: 0, workshop: 0 },
      walls: 0,
      queue: [],
      reserve: { spear: 0, archer: 0, horse: 0, pike: 0, xbow: 0, knight: 0 },
      garrison: 0, // milli-troops of spearmen
      nextHost: 1,
      keepBells: 0,
      stats: { captures: 0, lost: 0, battles: 0, trained: 0, killed: 0, died: 0, marches: 0 },
    }));
    const keeps = [];
    for (let node = 0; node < RING; node++) {
      if (isHome(node)) continue;
      keeps.push({ node, holder: initialKeepHolder(node), lastFrom: -1, troops: KEEP_HOME_GUARD * MILLI, contender: -1, progress: 0, consolidatedUntil: 0 });
    }
    return {
      rulesVersion: RULES_VERSION,
      variant,
      seed,
      bell: 0,
      round: 0,
      over: false,
      nations,
      hosts: [],
      keeps,
      pending: [], // ops applied at the next turn (dissolve)
      reports: [], // one per resolved round
      winner: null,
    };
  }

  function clone(s) { return JSON.parse(JSON.stringify(s)); }

  function keepAt(s, node) { return s.keeps.find(k => k.node === node) || null; }
  function keepsHeld(s, n) { return s.keeps.filter(k => k.holder === n).length; }
  function shielded(s, n) { return s.bell < SHIELD_BELLS; }
  function hostsOf(s, n) { return s.hosts.filter(h => h.owner === n); }

  // Production of one nation for one round, per resource.
  function productionPerRound(s, n) {
    const nat = s.nations[n];
    const t = TIERS[nat.tier];
    const out = {};
    for (const r of RES) {
      let base = BASE_PER_HOUR[r] * (100 + t.bonus) / 100;
      if (s.variant === 'B' && KEEP_TIED[r]) base = base * keepsHeld(s, n) / 3;
      let add = 0;
      for (const b in BUILDINGS) {
        if (b === 'workshop') continue;
        add += (BUILDINGS[b].per[r] || 0) * nat.bld[b];
      }
      out[r] = Math.floor((base + add) * BELLS_PER_ROUND / 6);
    }
    return out;
  }
  function workshopPerRound(nat) {
    const w = nat.bld.workshop;
    return {
      arms: 4 * w * BELLS_PER_ROUND / 6,
      ore: WORKSHOP_INPUT_PER_HOUR.ore * w * BELLS_PER_ROUND / 6,
      wood: WORKSHOP_INPUT_PER_HOUR.wood * w * BELLS_PER_ROUND / 6,
    };
  }

  function buildCount(nat, kind) {
    let n = kind === 'walls' ? nat.walls / WALLS.points : nat.bld[kind] || 0;
    n += nat.queue.filter(q => q.kind === kind).length;
    return n;
  }
  function buildCost(nat, kind) {
    if (kind === 'tier') return Object.assign({}, TIERS[nat.tier].up || {});
    if (kind === 'walls') return Object.assign({}, WALLS.cost);
    const n = buildCount(nat, kind) + 1;
    const f = 1 + 0.5 * (n - 1) * (n - 1);
    const out = {};
    for (const r in BUILDINGS[kind].cost) out[r] = Math.floor(BUILDINGS[kind].cost[r] * f);
    return out;
  }
  function buildBells(nat, kind) {
    if (kind === 'tier') return TIERS[nat.tier].upBells;
    if (kind === 'walls') return WALLS.bells;
    return 6 + 3 * (buildCount(nat, kind) + 1);
  }
  function trainCost(unit, troops) {
    const lots = Math.ceil(troops / 100);
    const out = {};
    for (const r in UNITS[unit].cost) out[r] = UNITS[unit].cost[r] * lots;
    return out;
  }
  function canPay(nat, cost) { return Object.keys(cost).every(r => nat.res[r] >= cost[r]); }
  function pay(nat, cost) { for (const r in cost) nat.res[r] -= cost[r]; }

  function hostStrength(h) { return h.troops * UNITS[h.unit].str; }
  function earliestRound(s) { return s.round + 1; }

  // ---- Actions -----------------------------------------------------------
  // Every action is validated here; the UI and the bots go through the same
  // function. Returns { ok: true } or { ok: false, err }.
  function apply(s, n, a) {
    if (s.over) return { ok: false, err: 'シーズンは終わっています' };
    const nat = s.nations[n];
    switch (a.type) {
      case 'build': {
        const kind = a.kind;
        if (kind !== 'tier' && kind !== 'walls' && !BUILDINGS[kind]) return { ok: false, err: '不明な建物' };
        if (nat.queue.length >= TIERS[nat.tier].slots) return { ok: false, err: '建設の枠が空いていません' };
        if (kind === 'tier') {
          if (!TIERS[nat.tier].up) return { ok: false, err: 'これ以上は上がりません' };
          if (nat.queue.some(q => q.kind === 'tier')) return { ok: false, err: 'すでに格上げ中です' };
        }
        if (kind === 'walls' && nat.walls + WALLS.points * (1 + nat.queue.filter(q => q.kind === 'walls').length) > WALLS.cap) return { ok: false, err: '城壁は上限です' };
        const cost = buildCost(nat, kind);
        if (!canPay(nat, cost)) return { ok: false, err: '資源が足りません' };
        const bells = buildBells(nat, kind);
        pay(nat, cost);
        const start = nat.queue.length ? nat.queue[nat.queue.length - 1].doneBell : s.bell;
        nat.queue.push({ kind, doneBell: start + bells });
        return { ok: true };
      }
      case 'train': {
        const unit = a.unit;
        const troops = a.troops | 0;
        if (!UNITS[unit]) return { ok: false, err: '不明な兵種' };
        if (troops < 100 || troops % 100) return { ok: false, err: '100 単位で訓練します' };
        const cost = trainCost(unit, troops);
        if (!canPay(nat, cost)) return { ok: false, err: cost.arms ? '資源か兵器が足りません' : '資源が足りません' };
        pay(nat, cost);
        nat.reserve[unit] += troops * MILLI;
        nat.stats.trained += troops;
        return { ok: true };
      }
      case 'garrison': {
        const troops = a.troops | 0;
        if (troops <= 0) return { ok: false, err: '数が正しくありません' };
        if (nat.reserve.spear < troops * MILLI) return { ok: false, err: '守備に入れられるのは控えの槍兵だけです' };
        nat.reserve.spear -= troops * MILLI;
        nat.garrison += troops * MILLI;
        return { ok: true };
      }
      case 'muster': {
        const unit = a.unit;
        const troops = a.troops | 0;
        if (!UNITS[unit]) return { ok: false, err: '不明な兵種' };
        if (troops < MIN_HOST) return { ok: false, err: '軍勢は 100 以上です' };
        if (troops > MAX_HOST_TROOPS) return { ok: false, err: `1 つの軍勢は ${MAX_HOST_TROOPS.toLocaleString('ja-JP')} 人までです` };
        if (nat.reserve[unit] < troops * MILLI) return { ok: false, err: '控えの兵が足りません' };
        if (hostsOf(s, n).length >= MAX_HOSTS) return { ok: false, err: `軍勢は ${MAX_HOSTS} つまでです` };
        nat.reserve[unit] -= troops * MILLI;
        // Ids are numbered per nation, so one nation's musters never shift
        // another's (bots plan from a snapshot taken before anyone acts).
        s.hosts.push({ id: n * 100000 + nat.nextHost++, owner: n, unit, troops: troops * MILLI, stamina: STAMINA_CAP, loc: homeOf(n), transit: null, arrival: false });
        return { ok: true };
      }
      case 'depart': {
        const h = s.hosts.find(x => x.id === a.host && x.owner === n);
        if (!h) return { ok: false, err: '軍勢がありません' };
        if (h.transit) return { ok: false, err: 'この軍勢は移動中です' };
        if (s.pending.some(p => p.type === 'dissolve' && p.host === h.id)) return { ok: false, err: '解散する軍勢です' };
        if (h.stamina < DEPART_STAMINA) return { ok: false, err: `体力が足りません（${h.stamina}/${DEPART_STAMINA}）` };
        const dest = a.dest | 0;
        if (dest < 0 || dest >= RING) return { ok: false, err: '行き先が正しくありません' };
        if (dest === h.loc) return { ok: false, err: 'いまいる場所です' };
        if (ringDist(h.loc, dest) > MAX_REACH) return { ok: false, err: `一度に行けるのは ${MAX_REACH} 州までです` };
        const k = a.rounds | 0;
        if (k < 1) return { ok: false, err: '到着は次のラウンド以降です' };
        const arriveBell = (s.round + k) * BELLS_PER_ROUND;
        if (arriveBell - s.bell > MAX_ARRIVAL_BELLS) return { ok: false, err: '到着は 72 ターン（6 ラウンド）以内です' };
        if (arriveBell >= END_BELL) return { ok: false, err: 'シーズンの終わりより後には着けません' };
        const target = homeNation(dest);
        if (target >= 0 && target !== n && (shielded(s, n) || shielded(s, target))) return { ok: false, err: '守りの期間中は、他国の村へは行けません' };
        if (s.hosts.filter(x => x.owner === n && x.transit).length >= MAX_TRANSIT) return { ok: false, err: '移動中の軍勢が多すぎます' };
        const retreat = Math.max(0, Number(a.retreat) || 0);
        h.stamina -= DEPART_STAMINA;
        h.transit = { from: h.loc, dest, arriveBell, departBell: s.bell, retreat };
        h.loc = -1;
        nat.stats.marches += 1;
        return { ok: true };
      }
      case 'dissolve': {
        const h = s.hosts.find(x => x.id === a.host && x.owner === n);
        if (!h) return { ok: false, err: '軍勢がありません' };
        if (h.transit) return { ok: false, err: '移動中の軍勢は解散できません' };
        if (s.pending.some(p => p.type === 'dissolve' && p.host === h.id)) return { ok: false, err: 'すでに解散を指示しました' };
        s.pending.push({ type: 'dissolve', host: h.id });
        return { ok: true };
      }
      default:
        return { ok: false, err: '不明な操作' };
    }
  }

  // ---- Resolution --------------------------------------------------------
  function damage(nA, strA, nB, strB, mods, v) {
    if (nA === 0 || strA === 0 || strB === 0) return 0;
    const n = Math.min(64, Math.max(1, Math.floor((nA + nB) / 1000)));
    let x = Math.floor(Math.floor(nA * strA * COMBAT_K_BPS / BPS) / strB);
    x = Math.floor(x * 1000 / F[n]);
    for (const m of mods) x = Math.floor(x * m / BPS);
    x = Math.floor(x * v / BPS);
    return x;
  }

  // One engagement both ways (combat.rs `resolve_engagement`, modifiers in
  // its fixed order). `a`/`d`: { unit (null for a garrison), troops, str,
  // city }. Returns [damage to the defender, damage to the attacker].
  function engagement(a, d, sit, va, vd) {
    const am = [];
    if (counters(a.unit, d.unit)) am.push(MOD.COUNTER);
    if (sit.rough) am.push(MOD.TERRAIN);
    if (sit.exhausted) am.push(MOD.EXHAUSTED);
    if (d.city && sit.walls) am.push(MOD.WALLS);
    const toDef = damage(a.troops, a.str, d.troops, d.str, am, va);
    const dm = [];
    if (counters(d.unit, a.unit)) dm.push(MOD.COUNTER);
    if (d.unit && UNITS[d.unit].cls === 'ranged') dm.push(MOD.RANGED_RETALIATION);
    if (d.city) dm.push(MOD.CITY_RETALIATION);
    const toAtt = damage(d.troops, d.str, a.troops, a.str, dm, vd);
    return [toDef, toAtt];
  }

  function returnHome(s, h, why, rep) {
    const nat = s.nations[h.owner];
    nat.reserve[h.unit] += h.troops;
    rep.events.push({ t: 'home', owner: h.owner, host: h.id, unit: h.unit, troops: h.troops, why });
    s.hosts = s.hosts.filter(x => x !== h);
  }

  // Fighters at a node: hosts there plus the village garrison or the keep.
  function fightersAt(s, node) {
    const out = [];
    for (const h of s.hosts) {
      if (h.loc === node && !h.transit && h.troops > 0) {
        out.push({ kind: 'host', id: 'h' + h.id, ref: h, faction: h.owner, unit: h.unit, troops: h.troops, str: UNITS[h.unit].str, arrival: !!h.arrival, city: false, stamina: h.stamina });
      }
    }
    const hn = homeNation(node);
    if (hn >= 0 && s.nations[hn].garrison > 0) {
      out.push({ kind: 'village', id: 'v' + hn, ref: s.nations[hn], faction: hn, unit: null, troops: s.nations[hn].garrison, str: 10, arrival: false, city: true, walls: s.nations[hn].walls > 0 });
    }
    const k = keepAt(s, node);
    if (k && k.troops > 0 && k.holder >= 0) {
      out.push({ kind: 'keep', id: 'k' + node, ref: k, faction: k.holder, unit: null, troops: k.troops, str: 10, arrival: false, city: true, walls: true });
    }
    return out;
  }

  function clashAt(s, node, rep, agg) {
    const fs = fightersAt(s, node);
    const factions = [...new Set(fs.map(f => f.faction))];
    if (factions.length < 2) {
      for (const f of fs) if (f.kind === 'host') f.ref.arrival = false;
      return;
    }
    const count = i => fs.filter(j => j.faction !== fs[i].faction).length;
    const dmg = fs.map(() => 0);
    const engaged = fs.map(() => false);
    const dealt = {}; const taken = {};
    const rough = !!ROUGH[node];
    const used = new Set();
    for (let i = 0; i < fs.length; i++) {
      for (let j = i + 1; j < fs.length; j++) {
        if (fs[i].faction === fs[j].faction) continue;
        const ui = fs[i]; const uj = fs[j];
        let pairs;
        if (uj.city) pairs = [[i, j, 1]];
        else if (ui.city) pairs = [[j, i, 1]];
        else if (ui.arrival !== uj.arrival) pairs = ui.arrival ? [[i, j, 1]] : [[j, i, 1]];
        else pairs = [[i, j, 2], [j, i, 2]];
        for (const [ai, di, half] of pairs) {
          const a = fs[ai]; const d = fs[di];
          const sit = {
            rough: rough && !d.arrival,
            exhausted: !a.city && a.stamina < ENGAGE_STAMINA,
            walls: !!(d.city && d.walls),
          };
          if (counters(a.unit, d.unit) || counters(d.unit, a.unit)) used.add('counter');
          if (sit.rough) used.add('terrain');
          if (sit.exhausted) used.add('exhausted');
          if (sit.walls) used.add('walls');
          const va = variance(s.seed, s.bell, node, a.id, d.id, 'a');
          const vd = variance(s.seed, s.bell, node, a.id, d.id, 'd');
          const [toDef, toAtt] = engagement(a, d, sit, va, vd);
          const xDef = Math.floor(toDef / count(ai) / half);
          const xAtt = Math.floor(toAtt / count(di) / half);
          dmg[di] += xDef; dmg[ai] += xAtt;
          engaged[ai] = engaged[di] = true;
          dealt[a.faction] = (dealt[a.faction] || 0) + xDef;
          taken[d.faction] = (taken[d.faction] || 0) + xDef;
          dealt[d.faction] = (dealt[d.faction] || 0) + xAtt;
          taken[a.faction] = (taken[a.faction] || 0) + xAtt;
        }
      }
    }
    // Aggregate for the round report.
    if (!agg[node]) agg[node] = { node, bells: 0, start: {}, loss: {}, mods: new Set(), holder: null };
    const g = agg[node];
    g.bells += 1;
    for (const f of fs) {
      const key = f.faction;
      if (g.start[key] == null) g.start[key] = 0;
      if (g.bells === 1) g.start[key] += f.troops;
    }
    for (const m of used) g.mods.add(m);
    // Apply all damage at once.
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      const lost = Math.min(f.troops, dmg[i]);
      g.loss[f.faction] = (g.loss[f.faction] || 0) + lost;
      s.nations[f.faction].stats.died += lost;
      if (f.kind === 'host') {
        const h = f.ref;
        h.troops -= lost;
        if (engaged[i]) {
          const d = dealt[f.faction] || 0; const t = taken[f.faction] || 0;
          const refund = d > 0 && d >= 10 * t; // clash.rs `refunded`
          if (!refund) h.stamina = Math.max(0, h.stamina - ENGAGE_STAMINA);
        }
        if (h.troops < DESTROYED_BELOW) {
          rep.events.push({ t: 'destroyed', owner: h.owner, host: h.id, unit: h.unit, node });
          s.nations[f.faction].stats.died += h.troops;
          h.troops = 0;
        }
      } else if (f.kind === 'village') {
        f.ref.garrison -= lost;
        if (f.ref.garrison < DESTROYED_BELOW) { s.nations[f.faction].stats.died += f.ref.garrison; f.ref.garrison = 0; }
      } else {
        f.ref.troops -= lost;
        if (f.ref.troops < DESTROYED_BELOW) { s.nations[f.faction].stats.died += f.ref.troops; f.ref.troops = 0; }
      }
    }
    for (const fac of factions) s.nations[fac].stats.killed += dealt[fac] || 0;
    s.hosts = s.hosts.filter(h => h.troops > 0);
    // One side holds the field.
    const alive = fightersAt(s, node);
    const strengthOf = {};
    for (const f of alive) strengthOf[f.faction] = (strengthOf[f.faction] || 0) + f.troops * f.str;
    const fac2 = Object.keys(strengthOf).map(Number);
    let winner = fac2.length ? fac2[0] : null;
    if (fac2.length > 1) {
      // clash.rs: strength, then a side with a unit that was already
      // there (not arriving this turn), then a seeded draw.
      const defends = f => alive.some(u => u.faction === f && !u.arrival);
      fac2.sort((x, y) => {
        if (strengthOf[y] !== strengthOf[x]) return strengthOf[y] - strengthOf[x];
        if (defends(x) !== defends(y)) return defends(x) ? -1 : 1;
        return h32(`${s.seed}|${s.bell}|${node}|tie|${x}`) - h32(`${s.seed}|${s.bell}|${node}|tie|${y}`);
      });
      winner = fac2[0];
      for (const h of s.hosts.slice()) {
        if (h.loc === node && !h.transit && h.owner !== winner) returnHome(s, h, 'lost_field', rep);
      }
    }
    g.holder = winner;
    for (const h of s.hosts) if (h.loc === node) h.arrival = false;
  }

  function advanceKeeps(s, rep) {
    for (const k of s.keeps) {
      const here = s.hosts.filter(h => h.loc === k.node && !h.transit && h.troops > 0);
      if (k.holder >= 0) s.nations[k.holder].keepBells += 1;
      if (s.bell < k.consolidatedUntil) { k.contender = -1; k.progress = 0; continue; }
      const defender = here.some(h => h.owner === k.holder);
      const hostile = [...new Set(here.filter(h => h.owner !== k.holder).map(h => h.owner))];
      if (defender || hostile.length === 0) {
        if (k.contender >= 0) rep.events.push({ t: 'contest_broken', node: k.node, contender: k.contender, holder: k.holder });
        k.contender = -1; k.progress = 0;
        continue;
      }
      if (hostile.length >= 2) continue; // cannot happen after the field rule
      const f = hostile[0];
      if (k.contender === f) k.progress += 1;
      else {
        k.contender = f; k.progress = 1;
        rep.events.push({ t: 'contest', node: k.node, contender: f, holder: k.holder });
      }
      if (k.progress >= KEEP_BELLS) {
        const mine = here.filter(h => h.owner === f).sort((x, y) => y.troops - x.troops || x.id - y.id);
        const donor = mine[0];
        // ⌊troops × 50%⌋ whole troops stay; the donor goes home with the
        // rest, or joins the keep too if the rest is under 100 troops.
        let g = Math.floor(Math.floor(donor.troops / MILLI) * KEEP_GARRISON_BPS / BPS) * MILLI;
        let rest = donor.troops - g;
        if (rest < MIN_HOST * MILLI) { g = donor.troops; rest = 0; }
        const from = k.holder;
        if (from >= 0) s.nations[from].stats.lost += 1;
        // What is left of the old garrison does not survive the capture.
        if (from >= 0) s.nations[from].stats.died += k.troops;
        s.nations[f].stats.captures += 1;
        k.holder = f; k.lastFrom = from; k.troops = g; k.contender = -1; k.progress = 0;
        k.consolidatedUntil = s.bell + 1 + KEEP_CONSOLIDATE;
        rep.events.push({ t: 'captured', node: k.node, by: f, from, garrison: g });
        if (rest === 0) s.hosts = s.hosts.filter(h => h !== donor);
        else { donor.troops = rest; returnHome(s, donor, 'donor_rest', rep); }
      }
    }
  }

  // Production accrues turn by turn (the game settles lazily, which gives
  // the same totals): a building that completes mid-round produces only
  // from then on. Fractions carry over in `acc`.
  function settleBell(s) {
    for (const nat of s.nations) {
      const p = productionPerRound(s, nat.id);
      const cap = TIERS[nat.tier].cap;
      if (!nat.acc) nat.acc = { food: 0, wood: 0, stone: 0, ore: 0, gold: 0, arms: 0 };
      for (const r of RES) {
        nat.acc[r] += p[r] / BELLS_PER_ROUND;
        const whole = Math.floor(nat.acc[r] + 1e-9);
        nat.acc[r] -= whole;
        nat.res[r] = Math.min(cap, nat.res[r] + whole);
      }
      // The workshop turns 2 ore + 1 wood into 1 arms, slowing down when
      // either runs short (arms.rs).
      const w = workshopPerRound(nat);
      if (w.arms > 0) {
        const want = w.arms / BELLS_PER_ROUND;
        const can = Math.min(want, nat.res.ore / 2, nat.res.wood);
        if (can > 0) {
          nat.acc.arms += can;
          const whole = Math.min(Math.floor(nat.acc.arms + 1e-9), Math.floor(nat.res.ore / 2), nat.res.wood);
          nat.acc.arms -= whole;
          nat.res.ore -= 2 * whole;
          nat.res.wood -= whole;
          nat.res.arms = Math.min(cap, nat.res.arms + whole);
        }
      }
    }
  }

  function completeBuilds(s, rep) {
    for (const nat of s.nations) {
      while (nat.queue.length && nat.queue[0].doneBell <= s.bell) {
        const q = nat.queue.shift();
        if (q.kind === 'tier') nat.tier += 1;
        else if (q.kind === 'walls') nat.walls = Math.min(WALLS.cap, nat.walls + WALLS.points);
        else nat.bld[q.kind] += 1;
        rep.events.push({ t: 'built', owner: nat.id, kind: q.kind });
      }
    }
  }

  function frozenHostileStrength(s, node, owner) {
    let x = 0;
    for (const f of fightersAt(s, node)) if (f.faction !== owner) x += f.troops * f.str;
    return x;
  }

  // Resolve one round: 12 turns. `botActions` are applied first (they were
  // chosen from the same view the player saw at the start of the round).
  function advance(s, botActions) {
    if (s.over) return null;
    const rep = { round: s.round, events: [], clashes: [], production: {}, bot: [], player: [] };
    if (botActions) {
      for (const [n, acts] of botActions) {
        for (const a of acts) {
          const r = apply(s, n, a);
          rep.bot.push({ n, a, ok: r.ok, err: r.err || null });
        }
      }
    }
    // Public departures this round (what the others see).
    for (const h of s.hosts) {
      if (h.transit && h.transit.departBell === s.bell) {
        rep.events.push({ t: 'departed', owner: h.owner, host: h.id, unit: h.unit, troops: h.troops, from: h.transit.from, arriveBell: h.transit.arriveBell });
      }
    }
    const agg = {};
    const before = s.nations.map(n => Object.assign({}, n.res));
    for (let i = 0; i < BELLS_PER_ROUND; i++) {
      // Pending dissolves settle at the first turn.
      if (i === 0) {
        for (const p of s.pending) {
          const h = s.hosts.find(x => x.id === p.host);
          if (h && !h.transit) returnHome(s, h, 'dissolved', rep);
        }
        s.pending = [];
      }
      completeBuilds(s, rep);
      settleBell(s);
      // Arrivals (the seal opens): retreat orders are checked against the
      // strength standing there at the start of the turn.
      for (const h of s.hosts.slice()) {
        if (h.transit && h.transit.arriveBell === s.bell) {
          const dest = h.transit.dest;
          const hostile = frozenHostileStrength(s, dest, h.owner);
          const dk = keepAt(s, dest);
          const destHolder = isHome(dest) ? homeNation(dest) : (dk ? dk.holder : -1);
          rep.events.push({ t: 'arrived', owner: h.owner, host: h.id, unit: h.unit, troops: h.troops, from: h.transit.from, dest, destHolder });
          if (h.transit.retreat > 0 && hostile > h.transit.retreat * hostStrength(h)) {
            h.transit = null;
            returnHome(s, h, 'retreated', rep);
            continue;
          }
          h.loc = dest; h.transit = null; h.arrival = true;
        }
      }
      for (let node = 0; node < RING; node++) clashAt(s, node, rep, agg);
      for (const h of s.hosts) h.stamina = Math.min(STAMINA_CAP, h.stamina + 1);
      advanceKeeps(s, rep);
      s.bell += 1;
    }
    s.nations.forEach((n, i) => {
      const g = {};
      for (const r of RES) g[r] = n.res[r] - before[i][r];
      rep.production[n.id] = g;
    });
    for (const node in agg) {
      const g = agg[node];
      rep.clashes.push({ node: g.node, bells: g.bells, start: g.start, loss: g.loss, mods: [...g.mods], holder: g.holder });
      for (const f in g.start) s.nations[f].stats.battles += 1;
    }
    s.round += 1;
    s.reports.push(rep);
    if (s.round >= ROUNDS) finish(s);
    return rep;
  }

  function finish(s) {
    s.over = true;
    const score = s.nations.map(n => ({ n: n.id, keeps: keepsHeld(s, n.id), keepBells: n.keepBells }));
    score.sort((a, b) => b.keeps - a.keeps || b.keepBells - a.keepBells);
    const top = score.filter(x => x.keeps === score[0].keeps && x.keepBells === score[0].keepBells).map(x => x.n);
    s.winner = { nations: top, score };
  }

  // What nation `n` may see: other nations' marches lose their destination.
  function publicView(s, n) {
    const v = clone(s);
    for (const h of v.hosts) {
      if (h.owner !== n && h.transit) h.transit.dest = null;
    }
    v.reports = [];
    return v;
  }

  const api = {
    RULES_VERSION, BELLS_PER_ROUND, ROUNDS, END_BELL, SHIELD_BELLS, SEASON_SCALE, STAMINA_CAP, DEPART_STAMINA, MAX_REACH,
    MAX_HOSTS, MAX_TRANSIT, MAX_ARRIVAL_BELLS, KEEP_BELLS, KEEP_CONSOLIDATE, MILLI, MIN_HOST,
    UNITS, UNIT_KEYS, CLASS_NAME, RES, RES_NAME, TIERS, BUILDINGS, WALLS, NATIONS, NODE_NAMES, ROUGH, RING,
    BASE_PER_HOUR, STARTER, KEEP_TIED, MOD, F,
    ringDist, homeOf, isHome, homeNation, counters, h32, damage, engagement,
    newGame, clone, apply, advance, publicView, keepAt, keepsHeld, shielded, hostsOf,
    productionPerRound, workshopPerRound, buildCost, buildBells, trainCost, canPay, hostStrength, earliestRound,
  };
  root.WyllsEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
