// The clickable prototype: one village is yours, the rest are AI villages
// choosing from the same options. Switching the case or the scenario restarts
// from the same initial state (same seed → same land, people and dice).
import { createSim, step, applyControlled, run, summarize, choose, optionsFor, stageFraction, relayActive, extend, DEFAULTS, CASES, CASE_NAMES, RES } from './model.mjs';
import { SCENARIOS, runTriple, meanOf } from './compare.mjs';
import { ringProvinces, sextant } from './geometry.mjs';

const $ = id => document.getElementById(id);
const CASE_TEXT = {
  A: { who: '誰も何もしない。塔は鐘の目印（4cd901de のコードどおり：中立・村も砦も置けない・状態を持たない）', gain: '—', cost: '—', out: '参加の概念がない。自分の村と、自国の依頼だけ', own: '所有者なし（中立）' },
  B: { who: '自国で応えてもらえない依頼を、他国の人にも見せたい人', gain: '他国の人が応えてくれる見込み。荷は村から村へ直接で、中央に集まらない', cost: '掲示の手数料（food）。必要なものが全国に知られ、荷車が狙われやすくなる', out: '掲げないで自国内で頼む／他国の掲示に応えない', own: '所有者なし。誰でも掲げ・応え・自分の掲示を下ろせる。掲示の規則は変えられない' },
  C: { who: '他国と物を交換したい人、塔を一緒に建てたい人', gain: '完成後、中央の倉に置いた申し出を誰でも交換できる（相手が同時にいなくてよい）', cost: '資材と輸送、中央付近での襲撃。期限までに集まらなければ返金分を中央まで取りに行く手間', out: '建設に加わらず使うだけ（ただ乗り）／使わない／自分の村だけ育てる', own: '所有者なし。設定は建設時に固定。役割：自分で運ぶ・差し出す・運び手・護衛・維持費' },
};
const NUM_PARAMS = [
  ['lossPerProvince', '1州ごとの荷の損失'], ['raidLoss', '中央で襲撃中の追加損失'], ['saboteurs', '妨害者の数'], ['leavers', '退出する村の数'],
  ['selfishShare', '協力しない人の割合'], ['lateShare', '途中参加の割合'], ['poorShare', '資源の少ない人の割合'], ['towerWill', 'C：塔に関わる気のある割合'],
  ['stageDays', 'C：1段階の期限（日）'], ['upkeepFood', 'C：1日の維持費 food'], ['escortCut', 'C：護衛1人あたりの損失削減'], ['boardExposure', 'B：掲示による追加損失'],
];
const SEL_PARAMS = [
  ['placement', '配置（⑧未受領）', [['compact', '輪2〜3（今のS1）'], ['dispersed', '輪2〜8（⑧の仮置き）']]],
  ['requestVisibility', '依頼の見え方（①未受領）', [['nation', '自国だけ'], ['world', '全国']]],
  ['refund', 'C：期限と返金', [['refund', '期限あり・返金'], ['keep', '期限なし・進捗が残る']]],
  ['access', 'C：中継の倉を使える人', [['open', '誰でも'], ['contributors', '出した人だけ']]],
  ['periodHours', '期間の区切り（未決定・⑧/④未受領。記録するだけで何も戻さない）', [['', 'なし'], ['168', '7日ごと（仮）'], ['336', '14日ごと（仮）']]],
];

let caseId = 'A', sim = null, opts = null;

function paramsNow() {
  const sc = SCENARIOS.find(s => s.id === $('scenario').value) ?? SCENARIOS[0];
  const P = { ...sc.over, seed: Number($('seed').value) || 1, days: Number($('days').value) || 14, case: caseId };
  for (const [k] of NUM_PARAMS) { const el = $(`p-${k}`); if (el && el.dataset.touched) P[k] = Number(el.value); }
  for (const [k] of SEL_PARAMS) { const el = $(`p-${k}`); if (el && el.dataset.touched) P[k] = k === 'periodHours' ? (el.value ? Number(el.value) : null) : el.value; }
  return P;
}

function buildControls() {
  $('cases').innerHTML = CASES.map(c => `<div class="case" role="button" tabindex="0" data-case="${c}" aria-pressed="${c === caseId}"><b>${c}　${CASE_NAMES[c]}</b><p>誰が：${CASE_TEXT[c].who}</p><p>利益：${CASE_TEXT[c].gain}</p><p>代償：${CASE_TEXT[c].cost}</p><p>参加しない選択：${CASE_TEXT[c].out}</p><p>所有・操作：${CASE_TEXT[c].own}</p></div>`).join('');
  for (const el of document.querySelectorAll('.case')) {
    const pick = () => { caseId = el.dataset.case; document.querySelectorAll('.case').forEach(x => x.setAttribute('aria-pressed', String(x === el))); reset(); };
    el.addEventListener('click', pick); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  }
  $('scenario').innerHTML = SCENARIOS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  $('params').innerHTML = NUM_PARAMS.map(([k, l]) => `<label for="p-${k}">${l}</label><input id="p-${k}" type="number" step="any" value="${DEFAULTS[k]}">`).join('')
    + SEL_PARAMS.map(([k, l, o]) => `<label for="p-${k}">${l}</label><select id="p-${k}">${o.map(([v, t]) => `<option value="${v}" ${String(DEFAULTS[k] ?? '') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`).join('');
  for (const el of $('params').querySelectorAll('input,select')) el.addEventListener('change', () => { el.dataset.touched = '1'; });
  $('scenario').addEventListener('change', reset);
  $('reset').addEventListener('click', reset);
  $('me').addEventListener('change', () => reset(Number($('me').value)));
  $('next').addEventListener('click', nextTurn);
  $('auto').addEventListener('click', () => { finish(); });
  $('more').addEventListener('click', () => { extend(sim, 7 * 24); nextTurn(); });
  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    $('tab-play').classList.toggle('hidden', b.dataset.tab !== 'play'); $('tab-compare').classList.toggle('hidden', b.dataset.tab !== 'compare');
  });
  $('crun').addEventListener('click', compareRun);
}

function describe(v) {
  const P = sim.P, size = P.nations[v.nation], big = Math.max(...P.nations), small = Math.min(...P.nations);
  return `${v.name}（国${v.nation}・${size === big ? '大国' : size === small ? '小国' : '中くらいの国'}・輪${v.ring}${v.late ? '・途中参加' : ''}${v.poor ? '・資源少' : ''}・1日${v.spd}回${v.profile === 'selfish' ? '・協力しない' : v.profile === 'saboteur' ? '・妨害者' : ''}${v.leaver ? '・途中で去る' : ''}・土地 ${v.land.join('/')}）`;
}

function reset(keep) {
  const prev = typeof keep === 'number' ? keep : Number($('me').value);
  sim = createSim(paramsNow());
  if (!$('me').options.length || typeof keep !== 'number') {
    $('me').innerHTML = sim.villages.map(v => `<option value="${v.id}">${describe(v)}</option>`).join('');
    const def = Number.isInteger(prev) && sim.villages[prev] ? prev : (sim.villages.find(v => v.poor && !v.late && v.profile === 'coop') ?? sim.villages[0]).id;
    $('me').value = String(def);
  }
  sim.control = Number($('me').value);
  $('medesc').textContent = describe(sim.villages[sim.control]);
  opts = null;
  nextTurn();
}

function nextTurn() {
  if (sim.pending) { while (sim.pending) applyControlled(sim, 'idle'); }
  opts = run(sim, { untilControl: true });
  render();
}
function finish() {
  if (sim.pending) { const v = sim.villages[sim.pending.v]; while (sim.pending) applyControlled(sim, choose(sim, v, optionsFor(sim, v)).id); }
  run(sim);
  opts = null; render();
}
function pick(id) {
  opts = applyControlled(sim, id);
  if (!opts) opts = run(sim, { untilControl: true });
  render();
}

function render() {
  const v = sim.villages[sim.control];
  const day = Math.floor(sim.tick / 24) + 1, hour = sim.tick % 24;
  $('clock').textContent = sim.tick >= sim.until && !sim.pending ? `${Math.floor(sim.until / 24)}日目まで観察（世界は続いています）：${CASE_NAMES[caseId]}` : `${day}日目 ${hour}時：${CASE_NAMES[caseId]}`;
  $('mine').innerHTML = `<div class="chips">${RES.map(r => `<span class="chip">${r} ${Math.floor(v.store[r])}</span>`).join('')}<span class="chip">村の育ち ${v.level}</span><span class="chip">取引 ${v.trades}（他国 ${v.crossTrades}）</span><span class="chip">失った荷 ${Math.round(v.lostGoods)}</span>${v.left ? '<span class="chip warn">去った</span>' : ''}${!v.present ? '<span class="chip warn">まだ参加していない</span>' : ''}</div>`
    + (sim.pending ? `<p class="note">この番の残り行動：${sim.pending.left}</p>` : '');
  $('opts').innerHTML = (sim.pending && opts ? opts : []).map(o => `<button class="opt" data-id="${o.id}">${o.label}${o.detail ? `<small>${o.detail}</small>` : ''}</button>`).join('') || '<p class="note">いまはあなたの番ではありません。</p>';
  for (const b of $('opts').querySelectorAll('button')) b.addEventListener('click', () => pick(b.dataset.id));
  renderTower(); renderLog(); renderMap(); renderRun();
}

function renderTower() {
  const t = sim.tower, P = sim.P;
  if (caseId === 'A') { $('tower').innerHTML = '<p class="note">塔は状態を持ちません（目印のみ）。中央付近の襲撃は案によらず起こりえます。</p>' + raidLine(); return; }
  if (caseId === 'B') {
    const open = sim.requests.filter(q => q.state === 'open' && q.scope === 'world');
    $('tower').innerHTML = `<p>掲示中の依頼：${open.length}件</p><div class="log">${open.slice(-12).map(q => `<div>${sim.villages[q.poster].name}：${q.want} を求め ${q.give} を渡す（${q.amount}）</div>`).join('') || '<div>なし</div>'}</div>` + raidLine();
    return;
  }
  const need = P.stageNeed[t.stage];
  const frac = stageFraction(sim);
  $('tower').innerHTML = `<p>完成した段階：${t.stage} / ${P.stageNeed.length}${relayActive(sim) ? '（中継の倉が動いている）' : t.stage > 0 ? '<span class="warn">（維持費が尽きて休止）</span>' : ''}</p>`
    + (need ? `<p>次の段階の集まり具合 ${Math.round(frac * 100)}%${P.refund === 'refund' ? `・期限 ${Math.floor(t.deadline / 24) + 1}日目 ${t.deadline % 24}時` : '・期限なし'}</p><div class="bar"><i style="width:${Math.round(frac * 100)}%"></i></div>` : '<p>すべての段階が完成</p>')
    + `<p class="note">倉の在庫 ${RES.map(r => `${r} ${Math.floor(t.stock[r])}`).join('・')}・期限切れ ${t.lapses}回・置かれた申し出 ${t.offers.filter(o => o.state === 'open').length}件</p>` + raidLine();
}
const raidLine = () => { const n = sim.raids.filter(r => r.until > sim.tick).length, e = sim.escorts.filter(r => r.until > sim.tick).length; return `<p class="note">いま中央付近で襲っている者 ${n}・護衛 ${e}</p>`; };

const FACT_TEXT = {
  'tower.stage_completed': f => `塔の段階${f.stage}が完成（出した村${f.contributors}・国${f.nations}）`,
  'tower.stage_lapsed': f => `塔の段階${f.stage}が期限切れ（${Math.round(f.fraction * 100)}%で）`,
  'tower.refund_claim': f => `返金分 ${Math.round(f.amount)} が中央に預けられた`,
  'tower.dormant': () => '中継の倉が維持費切れで休止', 'tower.awake': () => '中継の倉が再開',
  'tower.relay_swap': f => `中継の倉で交換${f.cross ? '（他国と）' : ''}${f.contributor ? '' : '（建設に加わっていない人）'}`,
  'tower.board_post': () => '依頼が塔に掲げられた', 'tower.board_fulfilled': f => `掲示の依頼が果たされた${f.cross ? '（他国と）' : ''}`,
  'centre.raid': f => `中央付近で襲撃（集まり具合 ${Math.round(f.fraction * 100)}%）`,
  'village.left': f => `村が去った（塔に出した量 ${Math.round(f.contributed)}）`,
  'period.boundary': f => `期間の区切り ${f.index}（記録のみ。村・物資・隊商・塔はそのまま続く）`, 'village.joined': f => (f.late ? '途中参加の村が来た' : null),
  'request.defaulted': () => '依頼が払われなかった',
};
const OWN_TEXT = {
  'village.grew': f => `村が育った（${f.level}）`, 'request.posted': f => `依頼を出した（${f.scope === 'world' ? '全国' : '自国'}）`,
  'request.taken': f => `依頼に応えて荷を送った${f.cross ? '（他国へ）' : ''}`, 'tower.board_taken': f => `掲示の依頼に応えて荷を送った${f.cross ? '（他国へ）' : ''}`,
  'request.fulfilled': f => `依頼が果たされた${f.cross ? '（他国と）' : ''}`, 'caravan.lost': () => '荷車を失った',
  'tower.sent': f => `塔へ ${f.res} ${f.amount} を送った（${f.role === 'upkeep' ? '維持費' : '建設'}）`, 'tower.contribution': f => `塔に ${Math.round(f.amount)} が届いた${f.carrier !== null && f.carrier !== undefined ? '（運び手が運んだ）' : ''}`,
  'tower.pledged': f => `塔のために ${f.res} ${f.amount} を差し出した`, 'tower.carried': () => '差し出された荷を塔へ運んだ', 'tower.escort': () => '中央への道を護衛した',
  'tower.claim_withdrawn': f => `返金分 ${Math.round(f.amount)} を引き取りに出た`, 'tower.relay_offer': () => '中継の倉に申し出を置いた', 'tower.upkeep_delivered': () => '維持費が届いた',
};
function renderLog() {
  const me = sim.control;
  const rows = sim.facts.filter(f => FACT_TEXT[f.kind] || f.actor === me).slice(-80).reverse().map(f => {
    const who = f.actor === null ? '' : sim.villages[f.actor].name + (f.actor === me ? '（あなた）' : '');
    const text = (f.actor === me ? OWN_TEXT[f.kind]?.(f) : null) ?? FACT_TEXT[f.kind]?.(f) ?? (f.actor === me ? f.kind : null);
    return text ? `<div>${Math.floor(f.t / 24) + 1}日${f.t % 24}時 ${who} ${text}</div>` : '';
  });
  $('log').innerHTML = rows.join('');
}

function renderMap() {
  const cv = $('map'), g = cv.getContext('2d'), css = getComputedStyle(document.documentElement);
  const maxRing = Math.max(...sim.villages.map(v => v.ring)) + 1;
  const W = cv.width, H = cv.height, s = Math.min(W, H) / (maxRing * 2 + 1.5) / 1.6;
  const at = (p, q) => ({ x: W / 2 + s * Math.sqrt(3) * (p + q / 2), y: H / 2 + s * 1.5 * q });
  g.clearRect(0, 0, W, H);
  const wedgeCol = k => css.getPropertyValue(`--w${k}`).trim();
  let maxT = 1; for (const n of Object.values(sim.traffic)) maxT = Math.max(maxT, n);
  const heat = css.getPropertyValue('--heat').trim();
  for (let d = 0; d <= maxRing; d++) for (const pv of ringProvinces(d)) {
    const c = at(pv.p, pv.q);
    g.beginPath();
    for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; const x = c.x + s * 0.97 * Math.cos(a), y = c.y + s * 0.97 * Math.sin(a); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.closePath();
    g.globalAlpha = d === 0 ? 1 : 0.22; g.fillStyle = d === 0 ? css.getPropertyValue('--concord').trim() : wedgeCol(sextant(pv.p, pv.q)); g.fill();
    const tr = sim.traffic[`${pv.p},${pv.q}`] ?? 0;
    if (tr) { g.globalAlpha = 0.15 + 0.75 * Math.sqrt(tr / maxT); g.fillStyle = `rgb(${heat})`; g.fill(); }
    g.globalAlpha = 1;
  }
  // the tower
  const c0 = at(0, 0); g.fillStyle = css.getPropertyValue('--ink').trim();
  g.beginPath(); g.moveTo(c0.x - s * 0.18, c0.y + s * 0.4); g.lineTo(c0.x + s * 0.18, c0.y + s * 0.4); g.lineTo(c0.x + s * 0.1, c0.y - s * 0.45); g.lineTo(c0.x, c0.y - s * 0.62); g.lineTo(c0.x - s * 0.1, c0.y - s * 0.45); g.closePath(); g.fill();
  // villages
  const seen = new Map();
  for (const v of sim.villages) {
    const k = `${v.prov.p},${v.prov.q}`, i = seen.get(k) ?? 0; seen.set(k, i + 1);
    const c = at(v.prov.p, v.prov.q), a = i * 2.1, r = s * 0.42 * (i ? 1 : 0.2);
    const x = c.x + Math.cos(a) * r, y = c.y + Math.sin(a) * r;
    g.beginPath(); g.arc(x, y, v.id === sim.control ? 6 : 3.5, 0, Math.PI * 2);
    g.fillStyle = v.id === sim.control ? '#ffffff' : wedgeCol(v.nation); g.globalAlpha = v.left || !v.present ? 0.3 : 1; g.fill();
    g.globalAlpha = 1; g.lineWidth = v.id === sim.control ? 2.5 : 1; g.strokeStyle = css.getPropertyValue('--ink').trim(); g.stroke();
  }
}

function renderRun() {
  const s = summarize(sim);
  const rows = [
    ['村の育ちの平均', s.level.all], ['塔に関わらなかった村の育ち', s.level.nonParticipants], ['近い村／遠い村', `${s.level.near ?? '—'} ／ ${s.level.far ?? '—'}`],
    ['小国／大国', `${s.level.smallNation} ／ ${s.level.bigNation}`], ['途中参加／資源少／協力しない', `${s.level.late} ／ ${s.level.poor} ／ ${s.level.selfish}`],
    ['他国との取引', s.trades.cross], ['中央の環（0〜1）を通った荷の割合（面積の割合）', `${s.logistics.innerShare}（${s.logistics.innerAreaShare}）`], ['失った荷車', s.logistics.lostCaravans],
  ];
  if (s.tower) rows.push(['塔：完成段階／期限切れ／休止', `${s.tower.stages} ／ ${s.tower.lapses} ／ ${s.tower.dormantEvents}`], ['塔：役割の内訳', Object.entries(s.tower.roles).map(([k, n]) => `${k} ${n}`).join('・')], ['塔：ただ乗りの交換の割合', s.tower.freeRideShare], ['塔：国ごとの出した量', s.tower.contributionByNation.shares.join(' / ')]);
  $('run').innerHTML = `<table><tbody>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</tbody></table>`;
}

// ---------------------------------------------------------------- compare tab

const METRICS = [
  ['村の育ちの平均', x => x.level.all],
  ['Aと比べた変化：塔に関わらなかった村', x => x.paired.nonParticipants],
  ['〃：関わった村', x => x.paired.participants],
  ['〃：近い／中／遠い村', x => [x.paired.near, x.paired.mid, x.paired.far].map(f).join(' ／ ')],
  ['〃：小国／大国', x => [x.paired.smallNation, x.paired.bigNation].map(f).join(' ／ ')],
  ['〃：途中参加／資源少／協力しない', x => [x.paired.late, x.paired.poor, x.paired.selfish].map(f).join(' ／ ')],
  ['他国との取引', x => x.trades.cross],
  ['中央の環を通った荷の割合（面積比）', x => `${x.logistics.innerShare}（${x.logistics.innerAreaShare}）`],
  ['大協約の州を通った荷の割合', x => x.logistics.centreShare],
  ['失った荷車', x => x.logistics.lostCaravans],
  ['払われなかった依頼', x => x.trades.defaulted],
  ['C：完成段階（平均）', x => x.tower?.stages],
  ['C：1段階以上／全段階が完成した割合', x => (x.completedStageShare ? `${x.completedStageShare.one} ／ ${x.completedStageShare.all}` : null)],
  ['C：期限切れ／休止', x => (x.tower ? `${x.tower.lapses} ／ ${x.tower.dormantEvents}` : null)],
  ['C：出した国の集中度 HHI（6国均等=0.17）', x => x.tower?.contributionByNation.hhi],
  ['C：役割の多様さ（bit、最大）', x => (x.tower ? `${x.tower.roleEntropyBits}（${x.tower.roleEntropyMaxBits}）` : null)],
  ['C：一人の仕事のうち同じ役割の割合', x => x.tower?.meanMonotony],
  ['C：ただ乗りの交換の割合', x => x.tower?.freeRideShare],
  ['C：中央での襲撃／うち達成目前', x => (x.tower ? `${x.tower.raids} ／ ${x.tower.raidsAtBrink}` : null)],
];
const f = x => (x === null || x === undefined ? '—' : x);

async function compareRun() {
  const n = Math.max(1, Math.min(60, Number($('cseeds').value) || 10));
  const list = $('cscope').value === 'all' ? SCENARIOS : [SCENARIOS.find(s => s.id === $('scenario').value)];
  $('crun').disabled = true;
  const out = [];
  for (const sc of list) {
    const triples = [];
    for (let s = 1; s <= n; s++) { $('cstatus').textContent = `${sc.id}：種 ${s}/${n}`; await new Promise(r => setTimeout(r, 0)); triples.push(runTriple(sc.over, s)); }
    const row = { sc };
    for (const c of CASES) row[c] = meanOf(triples.map(t => t[c]));
    row.C.completedStageShare = { one: Math.round(triples.filter(t => t.C.tower.stages >= 1).length / n * 100) / 100, all: Math.round(triples.filter(t => t.C.tower.stages >= 3).length / n * 100) / 100 };
    out.push(row);
  }
  $('cstatus').textContent = `種 1〜${n} の平均。模型の結果であり、人間の面白さの証拠ではありません。`;
  $('ctable').innerHTML = out.map(r => `<h2>${r.sc.name}</h2><table><thead><tr><th>測定</th>${CASES.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${METRICS.map(([l, g]) => `<tr><td>${l}</td>${CASES.map(c => `<td>${f(safe(g, r[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('');
  $('crun').disabled = false;
}
const safe = (g, x) => { try { return g(x); } catch { return null; } };

buildControls();
reset();
