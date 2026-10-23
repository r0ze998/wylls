// Wylls A/B prototype: the game screen.
//
// Order of a round (the same in the replay): the bots decide from the
// state at the start of the round; the player acts; then the round's 12
// turns resolve with both sets of orders. Neither side sees the other's
// orders of the same round before it resolves.
(function () {
  'use strict';
  const E = window.WyllsEngine;
  const B = window.WyllsBots;
  const T = window.WyllsText;
  const M = window.WyllsMetrics;
  const MAP = window.WyllsMap;
  const ME = 0;
  const SAVE_KEY = 'wylls-ab-proto:session';
  // Red defends and retakes; yellow attacks. In the bot round robin
  // (logs/TOURNAMENT.ja.md) no single policy wins most games from the
  // player's seat against this pair.
  const POLICIES = [null, 'counter', 'raider'];
  const VER = { K: 'A', M: 'B' }; // the facilitator's sheet has this key
  const PRACTICE_ROUNDS = 6;

  const $ = id => document.getElementById(id);
  let G = null;

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function costText(c) {
    return Object.keys(c).filter(r => c[r]).map(r => `${E.RES_NAME[r]} ${T.num(c[r])}`).join('・') || 'なし';
  }
  function now() { return performance.now(); }

  // ---- Persistence -------------------------------------------------------
  function save() {
    if (!G) return;
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ cfg: G.cfg, log: G.log, cur: G.cur, roundMs: G.cur ? now() - G.roundStart : 0, elapsed: elapsedMs() }));
    } catch (e) { /* storage may be unavailable; the game still runs */ }
  }
  function loadSaved() {
    try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { return null; }
  }
  function clearSaved() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ } }
  function download(obj, name) {
    const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function fileName() {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const p = (G.cfg.participant || 'anon').replace(/[^\w-]/g, '_');
    return `wylls-ab_${p}_${G.cfg.game}_${G.cfg.label}_${stamp}.json`;
  }

  // ---- Start -------------------------------------------------------------
  function elapsedMs() { return G ? G.elapsedBase + (now() - G.sessionStart) : 0; }

  function start(cfg, resume) {
    const variant = cfg.variant;
    const s = E.newGame({ variant, seed: cfg.seed, policies: POLICIES });
    const log = resume ? resume.log : M.newLog({
      variant, seed: cfg.seed, policies: POLICIES, participant: cfg.participant,
      rounds: cfg.practice ? PRACTICE_ROUNDS : E.ROUNDS,
      session: { game: cfg.game, label: cfg.label, practice: !!cfg.practice },
      startedAt: new Date().toISOString(),
    });
    G = { cfg, s, log, cur: null, bots: null, tab: 'report', sel: null, form: null, last: null, msg: '', elapsedBase: resume ? resume.elapsed || 0 : 0, sessionStart: now(), ended: false };
    if (resume) {
      // Rebuild the state by replaying the saved rounds.
      const r = M.replay(log, { keepStates: false });
      G.s = r.final;
      G.last = r.reports[r.reports.length - 1] || null;
    }
    $('start').classList.add('hidden');
    $('app').classList.remove('hidden');
    beginRound(resume && resume.cur ? resume : null);
    if (G.s.over || G.s.round >= G.log.rounds) finish();
  }

  // `restore`: the saved round in progress (its actions keep their times,
  // and the round's clock continues from where it stopped).
  function beginRound(restore) {
    G.bots = B.decideAll(G.s);
    G.cur = { round: G.s.round, ms: 0, actions: [] };
    G.roundStart = now();
    G.form = null;
    if (restore && restore.cur.round === G.s.round) {
      for (const x of restore.cur.actions) E.apply(G.s, ME, x.a);
      G.cur.actions = restore.cur.actions.slice();
      G.roundStart = now() - (restore.roundMs || 0);
    }
    render();
    save();
  }

  function act(a) {
    if (G.ended) return;
    const r = E.apply(G.s, ME, a);
    G.cur.actions.push({ ms: Math.round(now() - G.roundStart), a, ok: r.ok, err: r.err || null });
    G.msg = r.ok ? '' : r.err;
    if (r.ok && a.type === 'depart') G.form = null;
    render();
    save();
  }

  function nextRound() {
    if (G.ended) return;
    $('next').disabled = true;
    G.cur.ms = Math.round(now() - G.roundStart);
    G.log.turns.push(G.cur);
    const rep = E.advance(G.s, G.bots);
    G.log.hashes[G.cur.round] = M.stateHash(G.s);
    G.last = rep;
    G.tab = 'report';
    G.sel = null;
    G.msg = '';
    $('next').disabled = false;
    if (G.s.over || G.s.round >= G.log.rounds) { G.cur = null; render(); save(); finish(); return; }
    beginRound(null);
  }

  function finish() {
    G.ended = true;
    G.log.endedAt = new Date().toISOString();
    if (!G.cfg.practice) G.log.result = G.s.winner;
    G.log.playMs = Math.round(elapsedMs());
    save();
    const s = G.s;
    if (G.cfg.practice) {
      $('endtitle').textContent = '練習はここまでです';
      $('endresult').textContent = 'ここまでで、操作の流れはひととおりです。進行役に声をかけてください。';
      $('survey').classList.add('hidden');
    } else {
      const w = s.winner;
      const names = w.nations.map(n => T.nat(n)).join('・');
      $('endtitle').textContent = 'シーズンが終わりました';
      $('endresult').textContent = `勝ったのは ${names}。砦の数：${w.score.map(x => `${T.natShort(x.n)} ${x.keeps}`).join('、')}。`;
      $('survey').classList.remove('hidden');
    }
    render();
    $('end').showModal();
  }

  // ---- Rendering -----------------------------------------------------------
  function render() {
    const s = G.s;
    const view = E.publicView(s, ME);
    const label = G.cfg.practice ? '練習' : `版 ${G.cfg.label}`;
    $('hdrver').textContent = `${label}${G.cfg.game === '1' || G.cfg.game === '2' ? ` · ${G.cfg.game} 回目` : ''}${G.cfg.participant ? ` · ${G.cfg.participant}` : ''}`;
    $('hdrclock').textContent = G.ended ? `終了（${G.log.rounds} ラウンド）` : `ラウンド ${s.round + 1} / ${G.log.rounds} · ${T.clock(s.round)}`;
    $('score').innerHTML = s.nations.map(n => `<span style="background:${n.color}">${n.name}${n.id === ME ? '（あなた）' : ''} 砦 ${E.keepsHeld(s, n.id)}</span>`).join('');
    const marks = {};
    if (G.form) for (let i = 0; i < E.RING; i++) {
      const h = s.hosts.find(x => x.id === G.form.host);
      if (h && !h.transit && i !== h.loc && E.ringDist(h.loc, i) <= E.MAX_REACH) marks[i] = true;
    }
    $('map').innerHTML = MAP.render(view, { viewer: ME, selected: G.form ? G.form.dest : G.sel, marks });
    for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b.dataset.tab === G.tab);
    let html = '';
    if (G.sel != null && !G.form) html += nodeCard(view, G.sel);
    html += ({ report: tabReport, village: tabVillage, army: tabArmy, hosts: tabHosts })[G.tab](view);
    $('tabbody').innerHTML = html;
    $('msg').innerHTML = G.msg ? `<span class="err">${esc(G.msg)}</span>` : '';
    const n = G.cur ? G.cur.actions.filter(x => x.ok).length : 0;
    $('acts').textContent = G.ended ? '終わりました。「記録を保存」でファイルに残せます。' : `このラウンドの操作：${n} 件`;
    $('next').disabled = G.ended;
    $('next').classList.toggle('hidden', G.ended);
    $('reopen').classList.toggle('hidden', !G.ended);
  }

  function surveyAnswers() {
    const a = { q1: $('q1').value, q2: $('q2').value, q3: $('q3').value, q4: $('q4').value, q5: $('q5').value };
    return Object.values(a).some(v => v.trim()) ? Object.assign(a, { at: new Date().toISOString() }) : null;
  }

  function nodeCard(s, i) {
    const k = E.keepAt(s, i);
    const lines = [];
    if (E.isHome(i)) {
      const n = s.nations[E.homeNation(i)];
      lines.push(`${T.nat(n.id)}の村。守備 ${T.troops(n.garrison)}${n.walls ? `、城壁 ${n.walls}` : '、城壁なし'}。村は奪えません。`);
      if (s.bell < E.SHIELD_BELLS) lines.push(`守りの期間：ラウンド ${E.SHIELD_BELLS / E.BELLS_PER_ROUND + 1} の始めまで、攻められません。`);
    } else if (k) {
      lines.push(`${T.nat(k.holder)}の砦。守備 ${T.troops(k.troops)}（城壁あり。守備は増えません）。${E.ROUGH[i] ? '丘：そこにいた側への攻めは ×0.8。' : ''}`);
      if (k.contender >= 0) lines.push(`${T.nat(k.contender)}が占拠中：${k.progress}/${E.KEEP_BELLS} ターン。`);
      if (s.bell < k.consolidatedUntil) lines.push(`奪われたばかりの砦です。ラウンド ${T.roundOfBell(k.consolidatedUntil - 1) + 1} まで、占拠が数えられません。`);
    }
    const here = s.hosts.filter(h => h.loc === i && !h.transit);
    if (here.length) lines.push('いる軍勢：' + here.map(h => `${T.natShort(h.owner)} ${T.unit(h.unit)} ${T.troops(h.troops)}`).join('、'));
    lines.push(`あなたの村から ${E.ringDist(E.homeOf(ME), i)} 州。`);
    return `<div class="box sel"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(T.node(i))}</b><button class="small" data-act="unsel">×</button></div>${lines.map(l => `<div>${esc(l)}</div>`).join('')}</div>`;
  }

  function list(title, items) {
    if (!items.length) return '';
    return `<h3>${title}</h3><ul class="rep">${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }

  function tabReport(s) {
    if (!G.last) {
      return `<h2>最初のラウンド</h2>
        <p>あなたは<b style="color:${E.NATIONS[ME].color}">青</b>の国の村を任されました。赤と黄の国も、同じ条件で始めます。</p>
        <p>「村」で建物を建て、「兵」で兵を訓練し、「軍勢」で兵を出します。準備ができたら「次のラウンドへ」を押すと、12 ターンが進み、ここに結果が出ます。</p>
        <p class="muted">ルールはいつでも上の「ルール」で読めます。</p>
        <ul class="rules">${T.rulesText(G.cfg.practice ? 'practice' : G.s.variant).filter(l => !(G.cfg.practice && l.startsWith('この版の規則'))).map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
    }
    const sec = T.report(G.last, G.s, ME);
    let html = `<h2>ラウンド ${G.last.round + 1} の結果</h2>`;
    html += list('他国の出発（見えたこと）', sec.seen);
    html += list('あなたの出発', sec.mine);
    html += list('着いた軍勢（封が開いた）', sec.opened);
    html += list('戦い', sec.battles);
    html += list('砦', sec.keeps);
    html += list('戻った軍勢・なくなった軍勢', sec.home);
    html += list('建設', sec.built);
    const p = G.last.production[ME];
    html += `<h3>このラウンドに増えた資源</h3><div class="muted">${E.RES.filter(r => p[r]).map(r => `${E.RES_NAME[r]} ${p[r] >= 0 ? '+' : ''}${T.num(p[r])}`).join('・') || 'なし（倉が満杯かもしれません）'}</div>`;
    const quiet = !sec.seen.length && !sec.opened.length && !sec.battles.length && !sec.keeps.length && !sec.home.length;
    if (quiet) html += '<p class="muted">このラウンドに、目に見える動きはありませんでした。</p>';
    return html;
  }

  function perRound(s) {
    const p = E.productionPerRound(s, ME);
    const w = E.workshopPerRound(s.nations[ME]);
    return { p, w };
  }

  function tabVillage(s) {
    const me = s.nations[ME];
    const tier = E.TIERS[me.tier];
    const { p, w } = perRound(s);
    let html = `<h2>${T.node(E.homeOf(ME))}（${tier.name}）</h2>`;
    html += '<table class="t"><tr><th>資源</th><th class="num">いま</th><th class="num">1 ラウンドに</th></tr>';
    for (const r of E.RES) {
      let rate = p[r];
      let note = '';
      if (r === 'arms') rate = w.arms;
      if (r === 'ore') rate -= w.ore;
      if (r === 'wood') rate -= w.wood;
      // Both versions carry a note on the same rows, so neither draws more
      // attention to the keeps by layout alone.
      if (E.KEEP_TIED[r] && !G.cfg.practice) {
        note = s.variant === 'B'
          ? `<div class="cost">基本の分は砦 ${E.keepsHeld(s, ME)}/3 で決まる</div>`
          : '<div class="cost">基本の分は砦の数に関係しない</div>';
      }
      html += `<tr><td>${E.RES_NAME[r]}${note}</td><td class="num">${T.num(me.res[r])} <span class="cost">/ ${T.num(tier.cap)}</span></td><td class="num">${rate >= 0 ? '+' : ''}${T.num(rate)}</td></tr>`;
    }
    html += '</table>';
    if (me.bld.workshop) html += `<div class="cost">工房は 1 ラウンドに 鉱石 ${w.ore}・木材 ${w.wood} を使って 兵器 ${w.arms} を作ります（材料が足りないと減ります）。</div>`;
    html += `<h3>建設（枠 ${me.queue.length}/${tier.slots}。順番に 1 つずつ進む）</h3>`;
    if (me.queue.length) html += `<ul class="rep">${me.queue.map(q => `<li>${T.BUILD_NAME[q.kind]}：ラウンド ${T.roundOfBell(q.doneBell - 1) + 1} の中でできる（ターン ${q.doneBell}）</li>`).join('')}</ul>`;
    const effect = {
      farm: '食料 +24/ラウンド', lumber: '木材 +20/ラウンド', quarry: '石 +16/ラウンド', mine: '鉱石 +12/ラウンド', mint: '金 +12/ラウンド',
      workshop: '兵器 +8/ラウンド（鉱石 16・木材 8 を使う）',
      walls: '城壁 +100。城壁のある村の守備は、攻めを ×0.67 に減らす',
      tier: E.TIERS[me.tier + 1] ? `${E.TIERS[me.tier + 1].name}へ：基本生産 +${E.TIERS[me.tier + 1].bonus}%、倉 ${T.num(E.TIERS[me.tier + 1].cap)}、枠 ${E.TIERS[me.tier + 1].slots}` : 'これ以上は上がりません',
    };
    html += '<table class="t"><tr><th>建物</th><th>数</th><th>費用・時間</th><th></th></tr>';
    for (const kind of ['farm', 'lumber', 'quarry', 'mine', 'mint', 'workshop', 'walls', 'tier']) {
      const have = kind === 'walls' ? me.walls : kind === 'tier' ? '' : me.bld[kind];
      const can = kind !== 'tier' || E.TIERS[me.tier].up;
      const cost = can ? E.buildCost(me, kind) : {};
      const bells = can ? E.buildBells(me, kind) : 0;
      const ok = can && E.canPay(me, cost) && me.queue.length < tier.slots;
      html += `<tr><td><b>${T.BUILD_NAME[kind]}</b><div class="cost">${esc(effect[kind])}</div></td><td>${have}</td><td class="cost">${can ? `${costText(cost)}<br>${bells} ターン` : ''}</td><td><button class="small" data-act="build" data-kind="${kind}" ${ok ? '' : 'disabled'}>建てる</button></td></tr>`;
    }
    html += '</table>';
    return html;
  }

  function maxTrain(me, u) {
    const c = E.UNITS[u].cost;
    let lots = Infinity;
    for (const r in c) lots = Math.min(lots, Math.floor(me.res[r] / c[r]));
    return lots * 100;
  }

  function tabArmy(s) {
    const me = s.nations[ME];
    const f = G.armyForm || (G.armyForm = { unit: 'spear', troops: 100, gtroops: 100, munit: 'spear', mtroops: 100 });
    let html = '<h2>兵</h2><table class="t"><tr><th>兵種</th><th>種類</th><th class="num">強さ/人</th><th class="num">控え</th></tr>';
    for (const u of E.UNIT_KEYS) {
      html += `<tr><td>${E.UNITS[u].name}</td><td>${E.CLASS_NAME[E.UNITS[u].cls]}</td><td class="num">${E.UNITS[u].str}</td><td class="num">${T.troops(me.reserve[u])}</td></tr>`;
    }
    html += `</table><div class="cost">相性：近接は騎馬に、射撃は近接に、騎馬は射撃に ×1.5。射撃の兵は、守るときの反撃が ×0.5。</div>`;
    html += '<h3>訓練（すぐ終わる。100 人ごとの費用）</h3><div class="formrow">';
    html += `<select data-f="unit">${E.UNIT_KEYS.map(u => `<option value="${u}" ${f.unit === u ? 'selected' : ''}>${E.UNITS[u].name}（${costText(E.UNITS[u].cost)}）</option>`).join('')}</select>`;
    html += `<input type="number" min="100" step="100" value="${f.troops}" data-f="troops" style="width:90px"> 人`;
    html += `<button class="small" data-act="trainmax">最大 ${T.num(maxTrain(me, f.unit))}</button><button data-act="train">訓練する</button></div>`;
    html += `<div class="cost">${f.troops} 人の費用：${costText(E.trainCost(f.unit, Math.max(100, f.troops)))}</div>`;
    html += `<h3>村の守備（いま ${T.troops(me.garrison)}。控えの槍兵だけ入れられ、出せません）</h3><div class="formrow">`;
    html += `<input type="number" min="100" step="100" value="${f.gtroops}" data-f="gtroops" style="width:90px"> 人 <button data-act="garrison">守備に入れる</button></div>`;
    html += `<h3>軍勢を作る（控えの兵から。1 つの軍勢は 1 つの兵種、100 人以上。いま ${E.hostsOf(s, ME).length}/${E.MAX_HOSTS}）</h3><div class="formrow">`;
    html += `<select data-f="munit">${E.UNIT_KEYS.map(u => `<option value="${u}" ${f.munit === u ? 'selected' : ''}>${E.UNITS[u].name}（控え ${T.troops(me.reserve[u])}）</option>`).join('')}</select>`;
    html += `<input type="number" min="100" step="100" value="${f.mtroops}" data-f="mtroops" style="width:90px"> 人 <button class="small" data-act="mustermax">控え全部</button><button data-act="muster">軍勢を作る</button></div>`;
    return html;
  }

  function hostLine(s, h) {
    const where = h.transit
      ? `移動中：${T.node(h.transit.from)} → ${T.node(h.transit.dest)}（ラウンド ${T.roundOfBell(h.transit.arriveBell) + 1} の始めに着く）`
      : `${T.node(h.loc)}にいる`;
    const wait = h.stamina >= E.DEPART_STAMINA ? '出発できる' : `出発できるまで あと ${E.DEPART_STAMINA - h.stamina} ターン`;
    const dis = G.s.pending.some(p => p.host === h.id);
    return `<div class="box ${G.form && G.form.host === h.id ? 'sel' : ''}">
      <div><b>${T.unit(h.unit)} ${T.troops(h.troops)}</b> <span class="muted">（強さ ${T.num(E.hostStrength(h) / E.MILLI)}）</span></div>
      <div>${esc(where)}${dis ? '・<b>次のターンに解散</b>' : ''}</div>
      <div class="muted" style="font-size:13px">体力 ${h.stamina}/${E.STAMINA_CAP} · ${wait}</div>
      <div class="bar"><i style="width:${Math.round(h.stamina / E.STAMINA_CAP * 100)}%"></i></div>
      ${h.transit || dis ? '' : `<div class="formrow"><button class="small" data-act="openform" data-host="${h.id}" ${h.stamina >= E.DEPART_STAMINA ? '' : 'disabled'}>出発…</button><button class="small" data-act="dissolve" data-host="${h.id}">解散（兵を控えに戻す）</button></div>`}
      ${G.form && G.form.host === h.id ? departForm(s, h) : ''}
    </div>`;
  }

  function departForm(s, h) {
    const f = G.form;
    const opts = [];
    for (let i = 0; i < E.RING; i++) {
      if (i === h.loc || E.ringDist(h.loc, i) > E.MAX_REACH) continue;
      const k = E.keepAt(s, i);
      const who = E.isHome(i) ? `${T.natShort(E.homeNation(i))}の村` : `${T.natShort(k.holder)}の砦・守備 ${T.troops(k.troops)}`;
      opts.push(`<option value="${i}" ${f.dest === i ? 'selected' : ''}>${T.node(i)}（${who}、${E.ringDist(h.loc, i)} 州）</option>`);
    }
    const maxK = Math.min(6, G.log.rounds - 1 - s.round, E.ROUNDS - 1 - s.round);
    const arr = [];
    for (let k = 1; k <= maxK; k++) arr.push(`<option value="${k}" ${f.rounds === k ? 'selected' : ''}>ラウンド ${s.round + k + 1} の始め（${k * E.BELLS_PER_ROUND} ターン後）</option>`);
    const ret = [[0, '退かずに戦う'], [1, '相手の強さが自分より上なら退く'], [1.5, '相手が自分の 1.5 倍より上なら退く'], [2, '相手が自分の 2 倍より上なら退く']];
    return `<div style="margin-top:8px;border-top:1px dashed var(--line);padding-top:8px">
      <div class="formrow">行き先 <select data-f="dest"><option value="">選ぶ（地図でも選べます）</option>${opts.join('')}</select></div>
      <div class="formrow">着く時 <select data-f="rounds">${arr.join('') || '<option value="">もう間に合いません</option>'}</select></div>
      <div class="formrow">退く条件 <select data-f="retreat">${ret.map(([v, t]) => `<option value="${v}" ${f.retreat === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="cost">着いた時に、その場所にいる相手の強さで判断します。出発すると体力 ${E.DEPART_STAMINA} を使います。</div>
      <div class="formrow"><button class="primary small" data-act="depart" ${f.dest == null || !arr.length ? 'disabled' : ''}>出発する</button><button class="small" data-act="closeform">やめる</button></div>
    </div>`;
  }

  function tabHosts(s) {
    const mine = E.hostsOf(s, ME);
    let html = `<h2>あなたの軍勢（${mine.length}/${E.MAX_HOSTS}）</h2>`;
    if (!mine.length) html += '<p class="muted">軍勢はまだありません。「兵」で訓練し、軍勢を作ります。</p>';
    for (const h of mine) html += hostLine(s, h);
    const foes = s.hosts.filter(h => h.owner !== ME && h.transit);
    html += '<h3>他国の、移動中の軍勢</h3>';
    html += foes.length ? `<ul class="rep">${foes.map(h => `<li>${T.natShort(h.owner)} ${T.unit(h.unit)} ${T.troops(h.troops)}：${T.node(h.transit.from)} から。ラウンド ${T.roundOfBell(h.transit.arriveBell) + 1} の始めに着く。行き先は分からない</li>`).join('')}</ul>` : '<p class="muted">いません。</p>';
    const standing = s.hosts.filter(h => h.owner !== ME && !h.transit);
    html += '<h3>他国の、止まっている軍勢</h3>';
    html += standing.length ? `<ul class="rep">${standing.map(h => `<li>${T.natShort(h.owner)} ${T.unit(h.unit)} ${T.troops(h.troops)}：${T.node(h.loc)}（体力 ${h.stamina}）</li>`).join('')}</ul>` : '<p class="muted">いません。</p>';
    return html;
  }

  // ---- Events --------------------------------------------------------------
  function onTabClick(e) {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    G.tab = b.dataset.tab;
    render();
  }
  function onMapClick(e) {
    const g = e.target.closest('[data-node]');
    if (!g || !G) return;
    const i = Number(g.dataset.node);
    if (G.form) {
      const h = G.s.hosts.find(x => x.id === G.form.host);
      if (h && i !== h.loc && E.ringDist(h.loc, i) <= E.MAX_REACH) { G.form.dest = i; render(); return; }
    }
    G.sel = G.sel === i ? null : i;
    render();
  }
  function onBodyChange(e) {
    const el = e.target.closest('[data-f]');
    if (!el) return;
    const k = el.dataset.f;
    if (G.form && (k === 'dest' || k === 'rounds' || k === 'retreat')) {
      G.form[k] = el.value === '' ? null : Number(el.value);
    } else {
      const f = G.armyForm;
      f[k] = (k === 'unit' || k === 'munit') ? el.value : Math.max(0, Number(el.value) || 0);
    }
    render();
  }
  function onBodyClick(e) {
    const b = e.target.closest('button[data-act]');
    if (!b || G.ended) return;
    const f = G.armyForm;
    switch (b.dataset.act) {
      case 'unsel': G.sel = null; render(); break;
      case 'build': act({ type: 'build', kind: b.dataset.kind }); break;
      case 'train': act({ type: 'train', unit: f.unit, troops: Math.round(f.troops / 100) * 100 }); break;
      case 'trainmax': f.troops = Math.max(100, maxTrain(G.s.nations[ME], f.unit)); render(); break;
      case 'garrison': act({ type: 'garrison', troops: f.gtroops }); break;
      case 'muster': act({ type: 'muster', unit: f.munit, troops: f.mtroops }); break;
      case 'mustermax': f.mtroops = Math.floor(G.s.nations[ME].reserve[f.munit] / E.MILLI); render(); break;
      case 'openform': G.form = { host: Number(b.dataset.host), dest: G.sel, rounds: 1, retreat: 0 }; G.sel = null; render(); break;
      case 'closeform': G.form = null; render(); break;
      case 'depart': act({ type: 'depart', host: G.form.host, dest: G.form.dest, rounds: G.form.rounds || 1, retreat: G.form.retreat || 0 }); break;
      case 'dissolve': act({ type: 'dissolve', host: Number(b.dataset.host) }); break;
    }
  }

  function readStart() {
    const game = $('game').value;
    const practice = game === 'practice';
    const label = practice ? 'P' : $('ver').value;
    if (!practice && !VER[label]) { $('starterr').textContent = '版を選んでください。'; return null; }
    const seed = $('seed').value.trim();
    if (!seed) { $('starterr').textContent = '条件番号を入れてください（割り当て表にあります）。'; return null; }
    return { participant: $('pid').value.trim(), game, practice, label, variant: practice ? 'A' : VER[label], seed };
  }

  function init() {
    const saved = loadSaved();
    if (saved && saved.log && !saved.log.endedAt) {
      $('resume').classList.remove('hidden');
      $('resume').textContent = `続きから（${saved.cfg.participant || '名前なし'}・${saved.cfg.practice ? '練習' : '版 ' + saved.cfg.label}・ラウンド ${saved.log.turns.length + 1}）`;
    }
    // Practice always uses condition 7. For the two games the facilitator
    // types the condition from sheets/assignment.csv, where it is crossed
    // with version and order (playtest/PROTOCOL.ja.md).
    $('game').addEventListener('change', () => {
      const g = $('game').value;
      const p = g === 'practice';
      $('ver').disabled = p;
      $('verhint').classList.toggle('hidden', !p);
      $('seed').value = p ? '7' : (g === 'free' ? '101' : '');
    });
    $('ver').disabled = true;
    $('seed').value = '7';
    $('go').addEventListener('click', () => {
      const cfg = readStart();
      if (!cfg) return;
      clearSaved();
      start(cfg, null);
    });
    $('resume').addEventListener('click', () => { const sv = loadSaved(); if (sv) start(sv.cfg, sv); });
    $('tabs').addEventListener('click', onTabClick);
    $('map').addEventListener('click', onMapClick);
    $('map').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMapClick(e); } });
    $('tabbody').addEventListener('click', onBodyClick);
    $('tabbody').addEventListener('change', onBodyChange);
    $('next').addEventListener('click', nextRound);
    $('btnrules').addEventListener('click', () => {
      $('ruleslist').innerHTML = T.rulesText(G.cfg.practice ? 'practice' : G.s.variant)
        .filter(l => !(G.cfg.practice && l.startsWith('この版の規則')))
        .map(l => `<li>${esc(l)}</li>`).join('');
      $('rules').showModal();
    });
    $('btnsave').addEventListener('click', () => {
      // Answers typed into the end questions are kept even if the dialog
      // was closed without its own save button.
      if (G.ended && !G.cfg.practice && surveyAnswers()) { G.log.survey = surveyAnswers(); save(); }
      const log = JSON.parse(JSON.stringify(G.log));
      if (G.cur && !G.ended) log.unfinishedRound = G.cur;
      download(log, fileName());
    });
    $('btnrestart').addEventListener('click', () => {
      if (!confirm('同じ条件で最初からやり直します。いまの記録は消えます（残すなら先に「記録を保存」）。よろしいですか。')) return;
      clearSaved();
      start(G.cfg, null);
    });
    $('btnhome').addEventListener('click', () => {
      if (!G.ended && !confirm('最初の画面へ戻ります。途中の記録は「続きから」で再開できます。')) return;
      location.reload();
    });
    $('endsave').addEventListener('click', () => {
      if (!G.cfg.practice) G.log.survey = surveyAnswers() || { q1: '', q2: '', q3: '', q4: '', q5: '', at: new Date().toISOString() };
      save();
      download(G.log, fileName());
      $('end').close();
    });
    $('endclose').addEventListener('click', () => $('end').close());
    $('reopen').addEventListener('click', () => $('end').showModal());
    setInterval(() => {
      if (!G || G.ended) return;
      const t = Math.floor(elapsedMs() / 1000);
      $('hdrtime').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    }, 1000);
  }

  init();
})();
