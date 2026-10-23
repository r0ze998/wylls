// Wylls A/B prototype: looking back over a saved log.
(function () {
  'use strict';
  const E = window.WyllsEngine;
  const T = window.WyllsText;
  const M = window.WyllsMetrics;
  const MAP = window.WyllsMap;
  const $ = id => document.getElementById(id);
  // Neutral labels only: which version is which is in the facilitator's
  // documents, not on any page a participant might open.
  const VER_LABEL = { A: '版 K', B: '版 M' };
  let R = null;

  function pctOrDash(x) { return x == null ? '―' : `${Math.round(x * 100)}%`; }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function actText(a) {
    switch (a.type) {
      case 'build': return `建設：${T.BUILD_NAME[a.kind]}`;
      case 'train': return `訓練：${T.unit(a.unit)} ${a.troops}`;
      case 'garrison': return `守備へ：槍兵 ${a.troops}`;
      case 'muster': return `軍勢を作る：${T.unit(a.unit)} ${a.troops}`;
      case 'depart': return `出発：軍勢 #${a.host % 100000} → ${T.node(a.dest)}（${a.rounds} ラウンド後、退く条件 ${a.retreat || 'なし'}）`;
      case 'dissolve': return `解散：軍勢 #${a.host % 100000}`;
      default: return JSON.stringify(a);
    }
  }

  function load(log) {
    if (!log || log.app !== 'wylls-ab-proto') { $('body').innerHTML = '<p class="err">Wylls 比較試作の記録ではありません。</p>'; return; }
    const r = M.replay(log);
    const m = M.measure(log, r);
    R = { log, r, m, i: 0 };
    $('slider').max = String(r.states.length - 1);
    $('slider').value = '0';
    show(0);
  }

  function show(i) {
    const { log, r, m } = R;
    R.i = Math.max(0, Math.min(i, r.states.length - 1));
    const s = r.states[R.i];
    $('slider').value = String(R.i);
    $('pos').textContent = R.i < log.turns.length ? `ラウンド ${R.i + 1} / ${log.turns.length}` : '最後';
    $('info').textContent = `${log.participant || '名前なし'} · ${log.session && log.session.practice ? '練習' : VER_LABEL[log.variant]} · 条件 ${log.seed}`;
    $('score').innerHTML = s.nations.map(n => `<span style="background:${n.color}">${n.name} 砦 ${E.keepsHeld(s, n.id)}</span>`).join('');
    $('map').innerHTML = MAP.render(s, { viewer: 0, reveal: $('reveal').checked });
    let html = '';
    html += `<div class="box ${r.ok ? '' : 'sel'}">${r.ok ? '<span class="okc">計算し直した結果は、記録と一致しました。</span>' : `<span class="err">記録と一致しません：${esc(JSON.stringify(r.mismatch))}</span>`}</div>`;
    if (R.i < log.turns.length) {
      const t = log.turns[R.i];
      html += `<h2>ラウンド ${R.i + 1}</h2><div class="muted">考えた時間 ${(t.ms / 1000).toFixed(0)} 秒</div>`;
      html += '<h3>あなたの操作</h3>';
      html += t.actions.length ? `<ul class="rep">${t.actions.map(x => `<li>${(x.ms / 1000).toFixed(0)} 秒：${esc(actText(x.a))}${x.ok ? '' : ` <span class="err">（できなかった：${esc(x.err)}）</span>`}</li>`).join('')}</ul>` : '<p class="muted">操作なし</p>';
      const rep = r.reports[R.i];
      if (rep) {
        const sec = T.report(rep, r.states[R.i + 1], 0);
        const block = (title, xs) => xs.length ? `<h3>${title}</h3><ul class="rep">${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
        html += block('他国の出発（見えたこと）', sec.seen) + block('青の出発', sec.mine) + block('着いた軍勢', sec.opened) + block('戦い', sec.battles) + block('砦', sec.keeps) + block('戻った・なくなった軍勢', sec.home);
        html += `<h3>コンピューターの操作（このラウンド）</h3><ul class="rep">${rep.bot.filter(b => b.ok).map(b => `<li>${T.natShort(b.n)}：${esc(actText(b.a))}</li>`).join('') || '<li class="muted">なし</li>'}</ul>`;
      }
    } else {
      html += `<h2>結果</h2>`;
      if (log.result) html += `<p>勝ち：${log.result.nations.map(n => T.natShort(n)).join('・')}。砦：${log.result.score.map(x => `${T.natShort(x.n)} ${x.keeps}`).join('、')}</p>`;
      if (log.survey) {
        const q = ['どこで迷ったか', '判断が結果を変えたと感じた場面', '退屈・作業に感じた場面', 'もう一度試したいこと', '理由が分からなかった結果'];
        html += '<h3>終わった後の答え</h3>' + q.map((x, k) => `<div class="box"><b>${x}</b><div>${esc(log.survey['q' + (k + 1)] || '（空欄）')}</div></div>`).join('');
      }
    }
    html += '<h3>測った値（仮説の文書の定義どおり）</h3><table class="t">';
    const rows = [
      ['ラウンド数', m.rounds], ['操作の数', m.actions], ['できなかった操作', m.failedActions], ['操作のなかったラウンド', m.idleRounds],
      ['軍事の操作をしたラウンド', m.militaryRounds], ['軍勢を動かした（出発・解散）ラウンド', m.moveRounds],
      ['自分の場所が脅かされた次のラウンド', m.threatRounds],
      ['　そのとき軍勢を動かした割合', pctOrDash(m.threatMoveRate)], ['　それ以外のラウンドで動かした割合', pctOrDash(m.otherMoveRate)],
      ['　差（反応の大きさ）', m.reactionLift == null ? '―' : `${(m.reactionLift * 100).toFixed(0)} ポイント`],
      ['（参考）他国の出発が見えた次のラウンド', m.departRounds], ['　そのとき動かした割合／見えなかったとき', `${pctOrDash(m.departMoveRate)} ／ ${pctOrDash(m.quietMoveRate)}`],
      ['出発の数', m.marches], ['加わった戦い', m.battles], ['奪った砦', m.captures], ['奪われた砦', m.keepsLost], ['最後の砦', m.finalKeeps], ['勝った', m.won ? 'はい' : 'いいえ'],
      ['考えた時間の合計（分）', (m.planMsTotal / 60000).toFixed(1)], ['1 ラウンドの考えた時間の中央値（秒）', (m.planMsMedian / 1000).toFixed(1)],
    ];
    html += rows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('') + '</table>';
    html += `<div class="formrow"><button class="small" id="copycsv">結果シート用の 1 行をコピー</button><span class="muted" id="copied"></span></div>`;
    $('body').innerHTML = html;
    $('copycsv').addEventListener('click', () => {
      const line = M.csvRow(log, m);
      (navigator.clipboard ? navigator.clipboard.writeText(line) : Promise.reject()).then(
        () => { $('copied').textContent = 'コピーしました'; },
        () => { $('copied').textContent = line; });
    });
  }

  $('file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { load(JSON.parse(rd.result)); } catch (err) { $('body').innerHTML = `<p class="err">読めませんでした：${esc(err.message)}</p>`; } };
    rd.readAsText(f);
  });
  $('local').addEventListener('click', () => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('wylls-ab-proto:session') || 'null'); } catch (e) { /* ignore */ }
    if (saved && saved.log) load(saved.log); else $('body').innerHTML = '<p class="muted">この端末に記録がありません。</p>';
  });
  $('slider').addEventListener('input', e => R && show(Number(e.target.value)));
  $('prev').addEventListener('click', () => R && show(R.i - 1));
  $('nextb').addEventListener('click', () => R && show(R.i + 1));
  $('reveal').addEventListener('change', () => R && show(R.i));
})();
