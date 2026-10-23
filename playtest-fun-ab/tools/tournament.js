// Bot-only round robin for versions A and B.
// Run: node tools/tournament.js [seeds]   (default 20)
// Writes logs/tournament.json and logs/TOURNAMENT.ja.md.
//
// What this can show: whether one bot policy always wins, whether the seat
// (position on the map) decides games, and whether the first capture or the
// mid-game leader almost always wins (a snowball). What it cannot show:
// anything about how people feel. The bots are three fixed rule sets, not
// players; a policy no bot plays (for example dissolving and re-mustering
// to skip the stamina wait) is not tested here.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const E = require('../proto/engine.js');
const B = require('../proto/bots.js');

const SEEDS = Number(process.argv[2]) || 20;
const POL = ['turtle', 'balanced', 'raider', 'counter'];
// The playtest's opponents (red, yellow); index.html uses the same pair.
const OPP = (process.env.OPP || 'counter,raider').split(',');
// The player's seat is also tried with the F2 shortcut (dissolve and
// muster again) and with seizing a keep early, to look for exploits.
const SEAT_POL = POL.concat(['exploiter']);
const OUT = path.join(__dirname, '..', 'logs');

function leaderAt(s) {
  const sc = s.nations.map(n => ({ n: n.id, k: E.keepsHeld(s, n.id), b: n.keepBells }));
  sc.sort((a, b) => b.k - a.k || b.b - a.b);
  if (sc[0].k === sc[1].k && sc[0].b === sc[1].b) return -1;
  return sc[0].n;
}

function play(variant, policies, seed) {
  const s = E.newGame({ variant, seed, policies });
  let mid = -1;
  let dissolves0 = 0;
  while (!s.over) {
    const rep = E.advance(s, B.decideAll(s));
    dissolves0 += rep.bot.filter(b => b.n === 0 && b.ok && b.a.type === 'dissolve').length;
    if (s.round === 18) mid = leaderAt(s);
  }
  const caps = [];
  s.reports.forEach(r => r.events.forEach(e => { if (e.t === 'captured') caps.push({ round: r.round, by: e.by, from: e.from, node: e.node }); }));
  const battles = s.reports.reduce((a, r) => a + r.clashes.length, 0);
  return { variant, seed, policies, winners: s.winner.nations, final: s.winner.score, caps, battles, mid, dissolves0 };
}

function run() {
  const games = [];
  for (const variant of ['A', 'B']) {
    for (const a of POL) for (const b of POL) for (const c of POL) {
      for (let seed = 1; seed <= SEEDS; seed++) games.push(play(variant, [a, b, c], seed));
    }
  }
  // The playtest's own setting: seat 0 (the human's seat) against the
  // playtest's two opponents. Which bot policy does best there?
  const seat = [];
  for (const variant of ['A', 'B']) for (const p of SEAT_POL) for (let seed = 1; seed <= SEEDS * 3; seed++) {
    seat.push(play(variant, [p, OPP[0], OPP[1]], 1000 + seed));
  }
  // A larger seat-bias check: mirror games on 100 more condition numbers.
  const mirror = [];
  for (const variant of ['A', 'B']) for (const p of POL) for (let seed = 5001; seed <= 5100; seed++) {
    mirror.push(play(variant, [p, p, p], seed));
  }
  return { games, seat, mirror };
}

function share(g, n) { return g.winners.includes(n) ? 1 / g.winners.length : 0; }
function pct(x) { return (100 * x).toFixed(1) + '%'; }

function summarize({ games, seat, mirror: bigMirror }) {
  const out = {};
  for (const v of ['A', 'B']) {
    const G = games.filter(g => g.variant === v);
    // Policy win share in mixed games (at least two different policies).
    const mixed = G.filter(g => new Set(g.policies).size > 1);
    const pol = {};
    for (const p of POL) {
      let seats = 0; let wins = 0;
      for (const g of mixed) g.policies.forEach((q, i) => { if (q === p) { seats += 1; wins += share(g, i); } });
      pol[p] = { seats, winShare: wins / seats };
    }
    // Head-to-head: in games with exactly policies {p, q}, who wins more.
    const h2h = {};
    for (const p of POL) for (const q of POL) if (p < q) {
      const gs = mixed.filter(g => g.policies.every(x => x === p || x === q) && g.policies.includes(p) && g.policies.includes(q));
      let wp = 0; let wq = 0;
      for (const g of gs) g.policies.forEach((x, i) => { if (x === p) wp += share(g, i); else wq += share(g, i); });
      h2h[`${p}-${q}`] = { games: gs.length, [p]: wp / gs.length, [q]: wq / gs.length };
    }
    // Seat bias: mirror games (all three the same policy).
    const mirror = G.filter(g => new Set(g.policies).size === 1);
    const seatShare = [0, 1, 2].map(i => mirror.reduce((a, g) => a + share(g, i), 0) / mirror.length);
    // Snowball: does the first capturer, or the leader at round 18, win?
    const withCap = G.filter(g => g.caps.length);
    const firstWins = withCap.filter(g => g.winners.includes(g.caps[0].by)).length / withCap.length;
    const withMid = G.filter(g => g.mid >= 0);
    const midWins = withMid.filter(g => g.winners.includes(g.mid)).length / withMid.length;
    const capsPerGame = G.reduce((a, g) => a + g.caps.length, 0) / G.length;
    const noCap = G.filter(g => !g.caps.length).length / G.length;
    const battles = G.reduce((a, g) => a + g.battles, 0) / G.length;
    const lateCaps = G.reduce((a, g) => a + g.caps.filter(c => c.round >= 18).length, 0) / G.length;
    // The playtest seat.
    const S = seat.filter(g => g.variant === v);
    const seat0 = {};
    for (const p of SEAT_POL) {
      const gs = S.filter(g => g.policies[0] === p);
      seat0[p] = { games: gs.length, winShare: gs.reduce((a, g) => a + share(g, 0), 0) / gs.length, keeps: gs.reduce((a, g) => a + g.final.find(x => x.n === 0).keeps, 0) / gs.length, dissolves: gs.reduce((a, g) => a + g.dissolves0, 0) };
    }
    const BM = (bigMirror || []).filter(g => g.variant === v);
    const seatShareBig = BM.length ? [0, 1, 2].map(i => BM.reduce((a, g) => a + share(g, i), 0) / BM.length) : null;
    out[v] = { games: G.length, policy: pol, h2h, seatShare, seatShareBig, bigMirrorGames: BM.length, firstCaptureWins: firstWins, midLeaderWins: midWins, capturesPerGame: capsPerGame, gamesWithoutCapture: noCap, lateCapturesPerGame: lateCaps, battleNodesPerGame: battles, playtestSeat: seat0 };
  }
  return out;
}

function markdown(sum, seeds) {
  const L = [];
  L.push('# ボット同士の総当たり（自動検証）');
  L.push('');
  L.push(`- 生成：\`node tools/tournament.js ${seeds}\`（同じコマンドで同じ数字が出ます）`);
  L.push(`- 版ごとに、${POL.length} つの方針（守り重視 turtle・釣り合い balanced・攻め重視 raider・取り返し counter）の ${POL.length ** 3} 通りの並び × 条件番号 ${seeds} = ${sum.A.games} 試合`);
  L.push('- 方針の中身は `proto/bots.js`。条件番号ごとに、攻めに出る強さの基準・攻め始めるラウンド・村の守備の目標が少しずつ変わります。');
  L.push('- **これはボットの結果です。人間にとって面白いかの証拠にはなりません。** 分かるのは、ルールに「いつも勝つ一つの方針」や「席の有利」や「雪だるま」があるかどうかだけです。');
  L.push('');
  L.push('| 項目 | A 版（現行） | B 版（砦で食料・鉱石・金） |');
  L.push('|---|---|---|');
  const row = (k, f) => L.push(`| ${k} | ${f(sum.A)} | ${f(sum.B)} |`);
  for (const p of POL) row(`方針 ${p} の勝ち分（混合の試合）`, x => pct(x.policy[p].winShare));
  row('席ごとの勝ち分（同じ方針どうし：青・赤・黄）', x => x.seatShare.map(pct).join(' / '));
  if (sum.A.seatShareBig) row(`同上、別の条件番号 100 個 × ${POL.length} 方針（${sum.A.bigMirrorGames} 試合）`, x => x.seatShareBig.map(pct).join(' / '));
  row('1 試合の砦の奪取の数', x => x.capturesPerGame.toFixed(2));
  row('奪取が一度もない試合', x => pct(x.gamesWithoutCapture));
  row('後半（ラウンド 19 以降）の奪取の数', x => x.lateCapturesPerGame.toFixed(2));
  row('最初に砦を奪った国が勝った割合', x => pct(x.firstCaptureWins));
  row('ラウンド 18 の首位が勝った割合', x => pct(x.midLeaderWins));
  row('1 試合で戦いが起きた場所×ラウンドの数', x => x.battleNodesPerGame.toFixed(1));
  L.push('');
  L.push('## 2 つの方針だけの試合（どちらが勝つか）');
  L.push('');
  L.push('| 組 | A 版 | B 版 |');
  L.push('|---|---|---|');
  for (const k of Object.keys(sum.A.h2h)) {
    const [p, q] = k.split('-');
    L.push(`| ${p} 対 ${q} | ${pct(sum.A.h2h[k][p])} 対 ${pct(sum.A.h2h[k][q])} | ${pct(sum.B.h2h[k][p])} 対 ${pct(sum.B.h2h[k][q])} |`);
  }
  L.push('');
  L.push(`## 人間の席（青）に各方針を置いた場合（相手は 赤＝${OPP[0]}、黄＝${OPP[1]}。試作と同じ。条件番号 ${seeds * 3} 個）`);
  L.push('');
  L.push('| 青の方針 | A 版 勝ち分 | A 版 最後の砦 | B 版 勝ち分 | B 版 最後の砦 |');
  L.push('|---|---|---|---|---|');
  for (const p of SEAT_POL) L.push(`| ${p} | ${pct(sum.A.playtestSeat[p].winShare)} | ${sum.A.playtestSeat[p].keeps.toFixed(2)} | ${pct(sum.B.playtestSeat[p].winShare)} | ${sum.B.playtestSeat[p].keeps.toFixed(2)} |`);
  L.push('');
  L.push(`exploiter（抜け道）は、攻め重視に「疲れた軍勢を解散してすぐ作り直す」（いまのルールの性質 F2）を足したもの。人間の席でこの抜け道が勝ちを決めてしまうかを見るためで、試作の相手には使いません。**実際に解散を使った回数：A 版 ${sum.A.playtestSeat.exploiter.dissolves} 回、B 版 ${sum.B.playtestSeat.exploiter.dissolves} 回**（それぞれ ${sum.A.playtestSeat.exploiter.games} 試合）。このボットの動き方では、疲れた軍勢が村の外に取り残される場面が生まれず、抜け道は試せていません。人間の記録（解散の操作）で見ます。`);
  L.push('');
  L.push('勝ち分：引き分けで勝った国が 2 つなら、それぞれ 0.5 として数えます。');
  return L.join('\n') + '\n';
}

if (require.main === module) {
  const t0 = Date.now();
  const res = run();
  const sum = summarize(res);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'tournament.json'), JSON.stringify({ seeds: SEEDS, rulesVersion: E.RULES_VERSION, summary: sum, games: res.games.map(g => ({ v: g.variant, seed: g.seed, p: g.policies, w: g.winners, k: g.final.map(x => x.keeps), caps: g.caps, mid: g.mid })) }, null, 0));
  fs.writeFileSync(path.join(OUT, 'TOURNAMENT.ja.md'), markdown(sum, SEEDS));
  console.log(markdown(sum, SEEDS));
  console.log(`(${res.games.length + res.seat.length + res.mirror.length} games, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

module.exports = { run, summarize, play };
