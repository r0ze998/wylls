// Wylls A/B prototype: the words the player reads (shared by the game and
// the replay). Both versions use exactly the same sentences; version B adds
// only the lines about keep income.
(function (root) {
  'use strict';
  const E = root.WyllsEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const ME = 0;

  function troops(m) { return Math.round(m / E.MILLI).toLocaleString('ja-JP'); }
  function num(x) { return Math.round(x).toLocaleString('ja-JP'); }
  function nat(n, viewer) {
    if (n == null || n < 0) return '中立';
    return E.NATIONS[n].name + (n === (viewer == null ? ME : viewer) ? '（あなた）' : '');
  }
  function natShort(n) { return n == null || n < 0 ? '中立' : E.NATIONS[n].name; }
  function node(i) { return E.NODE_NAMES[i]; }
  function unit(u) { return E.UNITS[u].name; }
  function roundOfBell(b) { return Math.floor(b / E.BELLS_PER_ROUND); }
  function clock(round) {
    const day = Math.floor(round / 12) + 1;
    const hour = (round % 12) * 2;
    return `${day}日目 ${String(hour).padStart(2, '0')}:00`;
  }
  function reach(from) {
    const out = [];
    for (let i = 0; i < E.RING; i++) if (i !== from && E.ringDist(from, i) <= E.MAX_REACH) out.push(node(i));
    return out;
  }
  const MOD_TEXT = {
    counter: '兵種の相性（相性の良い側の攻め ×1.5）',
    terrain: '丘（場所にいた側への攻め ×0.8）',
    walls: '城壁（守備への攻め ×0.67）',
    exhausted: '疲れ（体力 20 未満の攻め ×0.85）',
  };
  const HOME_WHY = {
    retreated: '退く条件に当たり、戦わずに村へ戻った',
    lost_field: '戦いで場所を押さえられず、村へ戻った（兵は控えに戻る）',
    dissolved: '解散して、兵が控えに戻った',
    donor_rest: '砦に半分を残し、残りが村へ戻った',
  };
  const BUILD_NAME = Object.assign({ walls: '城壁', tier: '村の格上げ' }, Object.fromEntries(Object.entries(E.BUILDINGS).map(([k, v]) => [k, v.name])));

  // A round report as sections of lines. `after` is the state after the
  // round (for ongoing contests).
  function report(rep, after, viewer) {
    const v = viewer == null ? ME : viewer;
    const sec = { seen: [], mine: [], opened: [], battles: [], keeps: [], home: [], built: [] };
    for (const e of rep.events) {
      if (e.t === 'departed') {
        const ar = roundOfBell(e.arriveBell);
        if (e.owner === v) {
          // own departures are listed from the state below (with destination)
        } else {
          sec.seen.push(`${nat(e.owner, v)}の ${unit(e.unit)} ${troops(e.troops)} が ${node(e.from)} を出発。ラウンド ${ar + 1} の始めに着く。行き先は封じられている（届く場所：${reach(e.from).join('・')}）`);
        }
      } else if (e.t === 'arrived') {
        if (e.owner !== v) sec.opened.push(`${nat(e.owner, v)}の ${unit(e.unit)} ${troops(e.troops)} の行き先が開いた：${node(e.from)} → ${node(e.dest)}`);
        else sec.opened.push(`あなたの ${unit(e.unit)} ${troops(e.troops)} が ${node(e.dest)} に着いた`);
      } else if (e.t === 'contest') {
        sec.keeps.push(`${node(e.node)}：${nat(e.contender, v)}が占拠を始めた（${nat(e.holder, v)}の砦。${E.KEEP_BELLS} ターン居続けると奪われる）`);
      } else if (e.t === 'contest_broken') {
        sec.keeps.push(`${node(e.node)}：${nat(e.contender, v)}の占拠が途切れた（守り手が入ったか、占拠していた軍勢がいなくなった。進み具合は 0 に戻る）`);
      } else if (e.t === 'captured') {
        sec.keeps.push(`★ ${node(e.node)}：${nat(e.by, v)}が ${nat(e.from, v)}から奪った。守備 ${troops(e.garrison)} を残した。この砦はこれから ${E.KEEP_CONSOLIDATE / E.BELLS_PER_ROUND} ラウンド、奪われない`);
      } else if (e.t === 'home') {
        if (e.owner === v) sec.home.push(`あなたの ${unit(e.unit)} ${troops(e.troops)}：${HOME_WHY[e.why] || e.why}`);
        else if (e.why === 'retreated' || e.why === 'lost_field') sec.home.push(`${nat(e.owner, v)}の ${unit(e.unit)} ${troops(e.troops)}：${HOME_WHY[e.why]}`);
      } else if (e.t === 'destroyed') {
        sec.home.push(`${e.owner === v ? 'あなた' : nat(e.owner, v)}の ${unit(e.unit)} の軍勢が ${node(e.node)} で全滅した`);
      } else if (e.t === 'built' && e.owner === v) {
        sec.built.push(`${BUILD_NAME[e.kind]} ができた`);
      }
    }
    for (const c of rep.clashes) {
      const sides = Object.keys(c.start).map(Number);
      if (!sides.includes(v) && !sides.some(f => f !== v)) continue;
      const parts = sides.map(f => `${natShort(f)} ${troops(c.start[f])} → 失った ${troops(c.loss[f] || 0)}`).join('、');
      const mods = c.mods.length ? `効いたもの：${c.mods.map(m => MOD_TEXT[m]).join('、')}。` : '';
      const who = c.holder == null ? '誰も残らなかった' : `${nat(c.holder, v)}が場所を押さえた`;
      sec.battles.push(`${node(c.node)}：${c.bells} ターン戦った。${parts}。${mods}${who}`);
    }
    if (after) {
      for (const h of after.hosts) {
        if (h.owner === v && h.transit && h.transit.departBell === rep.round * E.BELLS_PER_ROUND) {
          sec.mine.push(`あなたの ${unit(h.unit)} ${troops(h.troops)}：${node(h.transit.from)} → ${node(h.transit.dest)}（ラウンド ${roundOfBell(h.transit.arriveBell) + 1} の始めに着く）`);
        }
      }
      for (const k of after.keeps) {
        if (k.contender >= 0) sec.keeps.push(`${node(k.node)}：${nat(k.contender, v)}が占拠中 ${k.progress}/${E.KEEP_BELLS} ターン`);
      }
    }
    return sec;
  }

  function rulesText(variant) {
    const lines = [
      '3 つの国（青・赤・黄）が、12 の州の輪で砦を取り合います。あなたは青です。赤と黄はコンピューターです。',
      `1 ラウンドは 12 ターン（ゲームの中の 2 時間）です。全部で ${E.ROUNDS} ラウンド（3 日）です。`,
      '勝ち負け：最後のラウンドが終わったとき、砦を一番多く持つ国の勝ち。同じ数なら、砦を持っていた時間の長い国の勝ち。',
      '村で建物を建て、兵を訓練し、兵をまとめた「軍勢」を出します。訓練はすぐ終わります。',
      `軍勢の出発には体力 ${E.DEPART_STAMINA} が要ります（上限 ${E.STAMINA_CAP}、1 ターンに 1 回復）。一度に行けるのは ${E.MAX_REACH} 州までです。`,
      '出発は誰にでも見えます（どこから、何が、何人、いつ着くか）。行き先だけは、着くまで封じられています。',
      `砦を奪うには、守り手のいない砦に ${E.KEEP_BELLS} ターン（6 ラウンド）居続けます。持ち主の軍勢が 1 つでも入ると、進み具合は 0 に戻ります。奪った砦は、その後 ${E.KEEP_CONSOLIDATE / E.BELLS_PER_ROUND} ラウンド奪われません。`,
      '兵種の相性：近接（槍兵・長槍兵）は騎馬に、射撃（弓兵・弩兵）は近接に、騎馬（騎兵・騎士）は射撃に強い（×1.5）。長槍兵・弩兵・騎士は強い（1 人あたり 2.2 倍）が、工房で作る兵器が要ります。',
      `最初の ${E.SHIELD_BELLS / E.BELLS_PER_ROUND} ラウンドは、どの村も攻められず、他国の村へも行けません。砦は最初から取り合えます。`,
      '村は奪えません。他国の村を攻めると、そこの守備兵や軍勢と戦うだけです。守備に入れられるのは槍兵だけです。',
      '戦いに勝っても、資源や兵は手に入りません。',
    ];
    if (variant === 'B') {
      lines.splice(4, 0, 'この版の規則：村の基本生産のうち、食料・鉱石・金の量は、自分の国が持つ砦の数で決まります。砦 3 つで基本どおり、4 つなら 4/3 倍、2 つなら 2/3 倍、0 なら 0 です（農場・鉱山・造幣所の分と、木材・石は変わりません）。');
    } else {
      lines.splice(4, 0, 'この版の規則：村の基本生産は、自分の国が持つ砦の数に関係なく一定です。砦が 4 つでも、2 つでも、0 でも、食料・鉱石・金・木材・石の基本の量は同じです（農場・鉱山・造幣所などの建物の分も変わりません）。');
    }
    return lines;
  }

  const api = { troops, num, nat, natShort, node, unit, clock, reach, report, rulesText, MOD_TEXT, BUILD_NAME, roundOfBell };
  root.WyllsText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
