// 初期配置の比較（A・B・C）の試作。画面を持たない純粋なモジュール。
//
// これは比較検証のための模型で、本番の配置ルールではない。
// 地図の形は S1 の事実に合わせた［事実］：
//   - 州（province）は六角の格子。(p, q) は州の軸座標で、中心の州が Concord（リング0）。
//   - リング1は6か国の首都（Seat、奪えない）。国 k の Seat は (1,0) を k×60°回した州。
//   - 国 k の土地は州の格子の第 k 扇形（sextant）。
//   - 最初の村は、自国の扇形のリング 2〜heartland_max_ring（S1 は3）に置く。場所 (p, q, site) は
//     命令の引数で、プレイヤー側が指定する（permutation-frontier/src/proc/citizen.rs:1176-1188）。
//   - 1州に拠点（site）12。
//   出典：permutation-rules/src/frontier/geometry.rs（:1-21, 33, 47, 186-215, 415-432）、src/hex.rs（:31-77）。
// 試作の仮定［仮］：州ごとの「資源の豊かさ」は乱数で作る（本物の地形は種から作られ、扇形ごとに回転対称）。
// 道のり（ターン）は「州の距離 × 1州あたりのターン」で近似する（道路・地形・塔を無視）。

export const HEARTLAND_MAX_RING = 3;          // ［事実］geometry.rs:33 と S1 の季節設定
export const SITES_PER_PROVINCE = 12;         // ［事実］geometry.rs:47
export const NATIONS = 6;                     // ［事実］geometry.rs:57、structure.rs:54
export const MARCH_PROVINCES_MAX = 4;         // ［事実］一度の行軍で通れる州の数（docs/frontier/map-growth/README.ja.md 1.2）
export const TURNS_PER_PROVINCE = 3;          // ［仮］平地・道なしの荷車でおよそ（1マス≈0.3ターン×州の差し渡し約9マス）

export const NATION_NAMES = ['国0', '国1', '国2', '国3', '国4', '国5'];

// ------------------------------------------------------------------ 六角の計算（S1 の hex.rs と同じ）

export const hexDistance = (a, b) => {
  const dq = a.q - b.q, dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
};
const rotate = h => ({ q: -h.r, r: h.q + h.r });
const unrotate = h => ({ q: h.q + h.r, r: -h.q });
export const rotateBy = (h, k) => { let x = h; for (let i = 0; i < ((k % 6) + 6) % 6; i++) x = rotate(x); return x; };
/** S1 の Hex::sextant と同じ（hex.rs:68-77）。 */
export function sextant(h) {
  let w = h;
  for (let k = 0; k < 6; k++) {
    if (w.q > 0 && w.r >= 0) return k;
    w = unrotate(w);
  }
  return 0;
}
const CENTER = { q: 0, r: 0 };
export const ring = h => hexDistance(h, CENTER);
export const seatOf = k => rotateBy({ q: 1, r: 0 }, k);
const key = h => `${h.q},${h.r}`;
/** 扇形0に回し戻した座標（同じ点を、どの国から見ても同じ順に並べるため：S1 の Hex::turned と同じ考え方）。 */
const canon = h => (ring(h) === 0 ? h : rotateBy(h, 6 - sextant(h)));

/** リング rMax までの州。各州：{q, r, ring, wedge}。中心は wedge=null。 */
export function provinces(rMax) {
  const out = [];
  for (let q = -rMax; q <= rMax; q++) {
    for (let r = Math.max(-rMax, -q - rMax); r <= Math.min(rMax, -q + rMax); r++) {
      const h = { q, r };
      const d = ring(h);
      out.push({ q, r, ring: d, wedge: d === 0 ? null : sextant(h), kind: d === 0 ? 'concord' : d === 1 ? 'seat' : 'land' });
    }
  }
  return out;
}

// ------------------------------------------------------------------ 乱数（決定的）

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * 州の資源の豊かさ［仮］。扇形0で作った値を6回転に写すので、6か国は同じ条件（S1 の地形も回転対称）。
 * 値は 1〜5。リングが外ほど高い傾向（境の外の豊かな鉱脈、決定済みの方向）を入れる。
 */
export function richness(rMax, seed = 7) {
  const rand = rng(seed);
  const base = new Map();
  const out = new Map();
  for (const p of provinces(rMax)) {
    if (p.ring < 2 || p.wedge !== 0) continue;
    base.set(key(p), Math.min(5, 1 + Math.floor(rand() * 3) + (p.ring >= 4 ? 1 : 0) + (p.ring >= 5 ? 1 : 0)));
  }
  for (const p of provinces(rMax)) {
    if (p.ring < 2) { out.set(key(p), 0); continue; }
    const back = rotateBy(p, 6 - p.wedge);
    out.set(key(p), base.get(key(back)) ?? 1);
  }
  return out;
}

// ------------------------------------------------------------------ 配置

/**
 * プレイヤーの一覧を作る。sizes[k] は国 k の人数。join は参加の順（途中参加は大きい数）。
 */
export function makePlayers(sizes) {
  const out = [];
  let j = 0;
  const maxN = Math.max(...sizes);
  for (let i = 0; i < maxN; i++) {
    for (let k = 0; k < NATIONS; k++) if (i < sizes[k]) out.push({ id: `n${k}-${i}`, nation: k, join: j++ });
  }
  return out;
}

/** 州の中の空いた拠点を数えながら置く小さな台帳。 */
function slots() {
  const used = new Map();
  return {
    free: p => SITES_PER_PROVINCE - (used.get(key(p)) ?? 0),
    take: p => used.set(key(p), (used.get(key(p)) ?? 0) + 1),
  };
}

/**
 * A：同国がまとまる（現行の基準）。自国の扇形のリング2〜3に、参加順に置く。
 * 現行ではプレイヤーが (p,q,site) を指定するので、「良い場所から埋まる」を模して、
 * 中心に近い州・豊かな州を先に選ぶとした［仮：現行は選択だが、何を選ぶかは人しだい］。
 */
function placeA(players, opts) {
  const rich = opts.rich;
  const s = slots();
  const out = [];
  for (const pl of [...players].sort((a, b) => a.join - b.join)) {
    const cands = provinces(HEARTLAND_MAX_RING).filter(p => p.ring >= 2 && p.wedge === pl.nation && s.free(p) > 0)
      .sort((a, b) => a.ring - b.ring || rich.get(key(b)) - rich.get(key(a)) || canon(a).q - canon(b).q || canon(a).r - canon(b).r);
    const p = cands[0];
    if (!p) { out.push({ ...pl, at: null, why: '自国のリング2〜3に空きがない' }); continue; }
    s.take(p);
    out.push({ ...pl, at: { q: p.q, r: p.r } });
  }
  return out;
}

/**
 * 地図の上に、決まった数の「地域」の中心を等しく散らす。リング2〜rMax-1 の州から、
 * 回転対称になるよう扇形0で選んで6回転する（どの国にとっても同じ形になる）。
 */
function regionCentres(rMax, perWedge) {
  const inner = provinces(rMax - 1).filter(p => p.ring >= 2 && p.wedge === 0)
    .sort((a, b) => a.ring - b.ring || a.q - b.q || a.r - b.r);
  const pick = [];
  for (let i = 0; i < perWedge; i++) pick.push(inner[Math.floor(((i + 0.5) * inner.length) / perWedge)]);
  const out = [];
  for (let k = 0; k < 6; k++) for (const p of pick) { const h = rotateBy(p, k); out.push({ q: h.q, r: h.r, wedge: k }); }
  return out;
}

/** 地域の中心とその隣の州を、近い順に返す。 */
function around(c, rMax) {
  return provinces(rMax).filter(p => p.ring >= 2 && hexDistance(p, c) <= 1).sort((a, b) => hexDistance(a, c) - hexDistance(b, c) || a.q - b.q || a.r - b.r);
}

/**
 * B：同国が数人ずつの小集団に分かれ、各地に散る。
 * 国ごとに人数を groupSize ずつの小集団に分け（端数は最後の集団に足すか、1人の集団にしない）、
 * 小集団を地域へ順に配る。同じ地域に同じ国の小集団が二つ入らないようにし、
 * 一つの地域に複数の国が入るよう、国の順をずらして配る。地域の中では中心の州から埋める。
 */
function placeB(players, opts) {
  const { rMax, groupSize } = opts;
  const s = slots();
  const out = [];
  const byNation = Array.from({ length: NATIONS }, (_, k) => players.filter(p => p.nation === k).sort((a, b) => a.join - b.join));
  // 小集団を作る（1人だけの集団は作らない。前の集団に足す）
  const groups = [];
  for (let k = 0; k < NATIONS; k++) {
    const ps = byNation[k];
    for (let i = 0; i < ps.length; i += groupSize) {
      const g = ps.slice(i, i + groupSize);
      if (g.length === 1 && groups.length && groups.at(-1).nation === k && groups.at(-1).members.length < groupSize * 2) groups.at(-1).members.push(g[0]);
      else groups.push({ id: `${k}-${groups.length}`, nation: k, members: g, firstJoin: g[0].join });
    }
  }
  groups.sort((a, b) => a.firstJoin - b.firstJoin);
  // 地域の数：一つの地域に nationsPerRegion か国ほどが入るように決め、6の倍数に切り上げる（回転対称のため）
  const perWedge = opts.regionsPerWedge ?? Math.max(1, Math.ceil(groups.length / (opts.nationsPerRegion * 6)));
  const centres = regionCentres(rMax, perWedge);
  const regionNations = centres.map(() => new Set());
  const regionLoad = centres.map(() => 0);
  for (const g of groups) {
    // 同じ国のいない地域のうち、いちばん空いている所。同点なら自国の扇形から遠い所を避けて近い所
    const order = centres.map((c, i) => i)
      .filter(i => !regionNations[i].has(g.nation))
      .sort((a, b) => regionLoad[a] - regionLoad[b] || Math.abs(((centres[a].wedge - g.nation + 9) % 6) - 3) - Math.abs(((centres[b].wedge - g.nation + 9) % 6) - 3) || a - b);
    const ri = order[0] ?? regionLoad.indexOf(Math.min(...regionLoad));
    regionNations[ri].add(g.nation);
    regionLoad[ri] += g.members.length;
    for (const pl of g.members) {
      const p = around(centres[ri], rMax).find(x => s.free(x) > 0);
      if (!p) { out.push({ ...pl, at: null, group: ri, band: g.id, why: '地域に空きがない' }); continue; }
      s.take(p);
      out.push({ ...pl, at: { q: p.q, r: p.r }, group: ri, band: g.id });
    }
  }
  return out;
}

/** C：国に関係なく、各プレイヤーが散る。参加順に、いちばん空いている地域へ一人ずつ。 */
function placeC(players, opts) {
  const { rMax } = opts;
  const perWedge = opts.regionsPerWedge ?? Math.max(1, Math.ceil(players.length / (opts.groupSize * opts.nationsPerRegion * 6)));
  const centres = regionCentres(rMax, perWedge);
  const s = slots();
  const load = centres.map(() => 0);
  const out = [];
  const rand = rng(opts.seed);
  // 国に関係なく散らすため、参加の順に、空いている地域のうち乱数で一つを選ぶ（国の並びと地域が揃わないように）
  for (const pl of [...players].sort((a, b) => a.join - b.join)) {
    const least = Math.min(...load);
    const cands = centres.map((c, i) => i).filter(i => load[i] === least);
    const best = cands[Math.floor(rand() * cands.length)];
    const p = around(centres[best], rMax).find(x => s.free(x) > 0);
    if (!p) { out.push({ ...pl, at: null, why: '空きがない' }); continue; }
    s.take(p); load[best]++;
    out.push({ ...pl, at: { q: p.q, r: p.r }, group: best });
  }
  return out;
}

export const SCHEMES = {
  A: { title: 'A：同国がまとまる（現行の基準）', place: placeA },
  B: { title: 'B：同国が小集団で各地に散る（最初の試作候補）', place: placeB },
  C: { title: 'C：国に関係なく散る', place: placeC },
};

export const DEFAULTS = { rMax: 5, groupSize: 3, nationsPerRegion: 3, regionsPerWedge: null, seed: 7 };

/** 配置を作る。sizes は国ごとの人数。 */
export function place(scheme, sizes, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  o.rich = o.rich ?? richness(o.rMax, o.seed);
  const players = opts.players ?? makePlayers(sizes);
  const placed = SCHEMES[scheme].place(players, o);
  return { scheme, opts: o, placed };
}

// ------------------------------------------------------------------ 比べる数字

/**
 * プレイヤーごとの数字：中心までの距離、自国の首都までの距離、いちばん近い同国までの距離、
 * 半径 radius 州以内の同国・他国の人数、置かれた州の豊かさ、中心まで何回の行軍が要るか。
 */
export function metrics(result, radius = 1) {
  const ps = result.placed.filter(p => p.at);
  const rich = result.opts.rich;
  return ps.map(p => {
    const same = ps.filter(x => x !== p && x.nation === p.nation);
    const nearSame = same.length ? Math.min(...same.map(x => hexDistance(x.at, p.at))) : null;
    const within = ps.filter(x => x !== p && hexDistance(x.at, p.at) <= radius);
    // 自分の小集団の外にいる、いちばん近い同国（B で「遠くの同国」への道のり）。A・C では同国全体で測る
    const outside = same.filter(x => p.band == null || x.band !== p.band);
    const nearOutside = outside.length ? Math.min(...outside.map(x => hexDistance(x.at, p.at))) : null;
    return {
      id: p.id, nation: p.nation, join: p.join, at: p.at,
      toCenter: ring(p.at),
      marchesToCenter: Math.ceil(ring(p.at) / MARCH_PROVINCES_MAX),
      toSeat: hexDistance(p.at, seatOf(p.nation)),
      nearestSame: nearSame,
      nearestOtherBand: p.band == null ? null : nearOutside,
      sameNear: within.filter(x => x.nation === p.nation).length,
      otherNear: within.filter(x => x.nation !== p.nation).length,
      otherNationsNear: new Set(within.filter(x => x.nation !== p.nation).map(x => x.nation)).size,
      richness: rich.get(key(p.at)),
      inOwnWedge: sextant(p.at) === p.nation,
      // 今の S1 では、村の持ち主の国の扇形のリング2〜3にある村だけが包囲から守られる（siege.rs:711-713）
      inOwnHeartland: sextant(p.at) === p.nation && ring(p.at) >= 2 && ring(p.at) <= HEARTLAND_MAX_RING,
    };
  });
}

const stats = xs => {
  const v = xs.filter(x => x != null);
  if (!v.length) return { min: null, max: null, mean: null, spread: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { min: Math.min(...v), max: Math.max(...v), mean: Math.round(mean * 100) / 100, spread: Math.max(...v) - Math.min(...v) };
};

/** 全体と国ごとのまとめ。偏りの許容（tolerance）と比べて、超えた項目を返す。 */
export function summary(result, tolerance = TOLERANCE) {
  const m = metrics(result);
  const fields = ['toCenter', 'toSeat', 'nearestSame', 'nearestOtherBand', 'sameNear', 'otherNear', 'otherNationsNear', 'richness'];
  const all = Object.fromEntries(fields.map(f => [f, stats(m.map(x => x[f]))]));
  const perNation = Array.from({ length: NATIONS }, (_, k) => {
    const mk = m.filter(x => x.nation === k);
    return { nation: k, n: mk.length, ...Object.fromEntries(fields.map(f => [f, stats(mk.map(x => x[f])).mean])) };
  }).filter(x => x.n > 0);
  // 国の間の差（国ごとの平均の最大−最小）
  const between = Object.fromEntries(fields.map(f => {
    const v = perNation.map(x => x[f]).filter(x => x != null);
    return [f, v.length ? Math.round((Math.max(...v) - Math.min(...v)) * 100) / 100 : null];
  }));
  const over = Object.entries(tolerance).filter(([f, t]) => (t.within != null && all[f].spread > t.within) || (t.between != null && between[f] > t.between))
    .map(([f]) => f);
  const unplaced = result.placed.filter(p => !p.at).length;
  const alone = m.filter(x => x.sameNear === 0).length;
  const outsideHeartland = m.filter(x => !x.inOwnHeartland).length;
  return { all, perNation, between, over, unplaced, alone, outsideHeartland, n: m.length };
}

/**
 * 偏りの許容（提案）。within＝プレイヤーの間の最大差、between＝国ごとの平均の最大差。
 * 中心までの距離は B・C では揃えられない（散るため）ので、国の間の差だけを抑える。
 */
export const TOLERANCE = {
  toCenter: { between: 0.5 },
  richness: { between: 0.5 },
  otherNear: { between: 1 },
  sameNear: { between: 1 },
};

/**
 * 途中参加：すでに置いた人は動かさず（本番では動かせない）、新しい人だけを置く。
 * A：自国のリング2〜3の空き。B：同国の小集団で groupSize に満たないものがあればそこへ、
 * なければ同国のいない地域のうち空いている所に新しい小集団として。C：いちばん空いている地域。
 */
export function addLate(result, nation, count) {
  const o = result.opts;
  const placed = result.placed.map(p => ({ ...p }));
  const used = new Map();
  for (const p of placed) if (p.at) used.set(key(p.at), (used.get(key(p.at)) ?? 0) + 1);
  const free = p => SITES_PER_PROVINCE - (used.get(key(p)) ?? 0);
  const take = p => used.set(key(p), (used.get(key(p)) ?? 0) + 1);
  let join = Math.max(-1, ...placed.map(p => p.join));
  const groups = [...new Set(placed.map(p => p.group).filter(g => g != null))];
  const centreOf = g => {
    const ms = placed.filter(p => p.group === g && p.at);
    return ms.length ? ms[0].at : null;
  };
  for (let i = 0; i < count; i++) {
    const pl = { id: `n${nation}-late${i}`, nation, join: ++join, late: true };
    let spot = null, group = null, band = null;
    if (result.scheme === 'A') {
      spot = provinces(HEARTLAND_MAX_RING).filter(p => p.ring >= 2 && p.wedge === nation && free(p) > 0)
        .sort((a, b) => a.ring - b.ring || o.rich.get(key(b)) - o.rich.get(key(a)) || a.q - b.q || a.r - b.r)[0] ?? null;
    } else if (result.scheme === 'B') {
      const bands = new Map();
      for (const p of placed) if (p.nation === nation && p.band) bands.set(p.band, [...(bands.get(p.band) ?? []), p]);
      const open = [...bands.values()].filter(ms => ms.length < o.groupSize).sort((a, b) => a.length - b.length)[0];
      if (open) {
        band = open[0].band; group = open[0].group;
        spot = around(open[0].at, o.rMax).find(x => free(x) > 0) ?? null;
      } else {
        const load = g => placed.filter(p => p.group === g).length;
        const g = groups.filter(g => !placed.some(p => p.group === g && p.nation === nation)).sort((a, b) => load(a) - load(b) || a - b)[0];
        if (g != null) { group = g; band = `${nation}-late${i}`; spot = around(centreOf(g), o.rMax).find(x => free(x) > 0) ?? null; }
      }
    } else {
      const load = g => placed.filter(p => p.group === g).length;
      const g = groups.sort((a, b) => load(a) - load(b) || a - b)[0];
      group = g; spot = g != null ? around(centreOf(g), o.rMax).find(x => free(x) > 0) ?? null : null;
    }
    if (spot) take(spot);
    placed.push({ ...pl, at: spot ? { q: spot.q, r: spot.r } : null, group, band, why: spot ? undefined : '空きがない' });
  }
  return { ...result, placed };
}

/** 離脱：指定した人を外す（村は残るかは本番の規則しだい。ここでは「いなくなる」とする）。 */
export function remove(result, ids) {
  const out = new Set(ids);
  return { ...result, placed: result.placed.filter(p => !out.has(p.id)) };
}

/** 道のりのターン（近似）。 */
export const turnsBetween = (a, b) => hexDistance(a, b) * TURNS_PER_PROVINCE;

/**
 * 国の卓の作例（ケイ・ミラ・ソウタ・ハル）を、この配置の国0の4人に当てはめ、
 * 卓の試作で使う移動ターン（createWorld の opts.travel）を作る。
 * ケイ＝国0の最初の人、ミラ＝ケイと同じ小集団の人（いなければ次の人）、ソウタ・ハル＝残りから参加順。
 * 拠点はケイの州の隣（1州）、峠はその先（2州）とみなす［仮］。
 */
export function tableTravel(result) {
  const ns = result.placed.filter(p => p.nation === 0 && p.at).sort((a, b) => a.join - b.join);
  if (ns.length < 4) return null;
  const kei = ns[0];
  const rest = ns.slice(1);
  const mira = rest.find(p => p.band != null && p.band === kei.band) ?? rest[0];
  const others = rest.filter(p => p !== mira);
  const [sota, haru] = others;
  const who = { kei, mira, sota, haru };
  const t = d => Math.max(2, Math.round(d * TURNS_PER_PROVINCE));
  const travel = {};
  const ids = Object.keys(who);
  for (const a of ids) for (const b of ids) if (a < b) travel[`v:${a}|v:${b}`] = t(hexDistance(who[a].at, who[b].at));
  for (const a of ids) {
    const d = a === 'kei' ? 0 : hexDistance(who[a].at, kei.at);
    travel[`v:${a}|site`] = a === 'kei' ? 2 : t(d + 1);
    travel[`v:${a}|pass`] = a === 'kei' ? 3 : t(d + 2);
  }
  travel['site|pass'] = 2;
  const where = Object.fromEntries(ids.map(a => [a, { ...who[a].at, band: who[a].band ?? null, id: who[a].id }]));
  const note = `${SCHEMES[result.scheme].title}：ケイ(${kei.id})・ミラ(${mira.id})・ソウタ(${sota.id})・ハル(${haru.id})。ケイとソウタの距離 ${hexDistance(kei.at, sota.at)} 州`;
  return { travel, where, note };
}
