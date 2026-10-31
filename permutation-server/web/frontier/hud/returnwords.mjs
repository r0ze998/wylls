// The away summary in words (hud/returnsum.mjs is the model): one sentence per
// item, and the head that says what the summary covers and what it cannot.
// An amount is only ever the record's own.
import { L, fmtNum, lang } from '../../lang.mjs';
import { RESOURCES, factionName } from '../fi18n.mjs';
import { RESOURCE_ORDER } from '../resources.mjs';
import { FIRST_LOOK_BELLS } from './returnsum.mjs';
import { arrivalView } from './statusview.mjs';

const cargo = c => (c ? c.map((n, i) => (n > 0 ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(n)}` : null)).filter(Boolean).join(L`・`) : '');
const nation = f => (Number.isInteger(f) && f >= 0 && f <= 6 ? factionName(f) : L`他国`);
const stance = v => [() => L`戦争`, () => L`通行`, () => L`同盟`][v]?.() ?? '';
const what = w => ({ vault: () => L`貯蔵庫`, tower: () => L`物見櫓`, palisade: () => L`柵`, fort: () => L`要塞` }[w]?.() ?? L`建物`);
const OUTCOME = { Stays: () => L`着いた場所に残りました`, Withdrew: () => L`退きました`, Bounced: () => L`押し戻されました`, Retreated: () => L`退却しました`, Destroyed: () => L`全滅しました`, BouncedUnranked: () => L`押し戻されました`, Routed: () => L`敗走しました（体力 0 で戻ります）`, BadSeal: () => L`封が正しくなく失われました` };

/** One item of the summary as a sentence. */
export function itemText(i) {
  const f = i.facts, c = cargo(f.cargo);
  switch (i.kind) {
    case 'CARAVAN_RAIDED':
      if (i.tone === 'uncertain') return f.choice === 'burn' ? L`あなたが送った隊商が略奪され、積荷は焼かれました（ターン ${fmtNum(i.bell)}）。その前に別の誰かに奪われていたかは、読み込んだ記録からはわかりません${c ? L`：${c}` : ''}` : L`あなたが送った隊商が奪われました（ターン ${fmtNum(i.bell)}）。その前に別の誰かに奪われていたかは、読み込んだ記録からはわかりません${c ? L`：${c}` : ''}`;
      if (i.tone === 'loss') return f.choice === 'burn' ? L`隊商が略奪され、積荷は焼かれました（ターン ${fmtNum(i.bell)}）${c ? L`：${c}` : ''}` : L`隊商が積荷ごと奪われました（ターン ${fmtNum(i.bell)}）${c ? L`：${c}` : ''}`;
      return f.choice === 'burn' ? L`あなたの軍勢が隊商を焼きました${c ? L`：${c}` : ''}` : L`あなたの軍勢が隊商を奪いました${c ? L`：${c}` : ''}`;
    case 'RAID_OPENED': return i.tone === 'uncertain' ? L`あなたが送った隊商が襲われました（ターン ${fmtNum(i.bell)}）。いまの持ち主があなたかどうかは、読み込んだ記録からはわかりません` : L`隊商が襲われ、相手が奪うか焼くかを決めるところです（ターン ${fmtNum(i.bell)}）`;
    case 'CARAVAN_SETTLED':
      if (i.tone === 'uncertain') return L`あなたが送った隊商の到着が記録されました（ターン ${fmtNum(i.bell)}）。途中で奪われていたなら、受け取ったのは奪った側です（読み込んだ記録からは確かめられません）${c ? L`：${c}` : ''}`;
      // (a settlement of the viewer's: its arrival as statussources.mjs judges it, never "arrived" without the amount verified;
      // the state's own words say what happened, so the lead names only the caravan and the turn)
      if (f.arrival) { const v = arrivalView(f.arrival); return L`隊商（ターン ${fmtNum(i.bell)}）：${[v.text, ...v.details].join(L`。`)}`; }
      return f.lost ? L`隊商の行き先がなくなり、積荷が失われました${c ? L`：${c}` : ''}` : L`隊商が着きました${c ? L`：${c}` : ''}`;
    case 'VAULT_SEIZED': case 'STRUCTURE_SEIZED': return i.tone === 'loss' ? L`${what(f.what)}を奪われました（ターン ${fmtNum(i.bell)}）` : L`${what(f.what)}を奪いました（ターン ${fmtNum(i.bell)}）`;
    case 'SIEGE_DECLARED': return L`${nation(f.attacker)}があなたの村の包囲を宣言しました（ターン ${fmtNum(i.bell)}）。陥落には、包囲側がマスを保つターンが ${fmtNum(f.required)} 要ります（夜番の時間と、守り手がいるターンは数えません）`;
    case 'CAPTURE_SETTLED': return i.tone === 'loss' ? L`村を奪われました（ターン ${fmtNum(i.bell)}）` : L`村を奪いました（ターン ${fmtNum(i.bell)}）`;
    case 'NATION_DECIDED': {
      const w = f.proposal === 'stance' ? L`${nation(f.target)}への方針を「${stance(f.value)}」に` : f.proposal === 'expel' ? (f.aboutMe ? L`あなたの村の追放` : L`村の追放`) : L`村を国に戻すこと`;
      return f.passed ? L`国の議題が可決されました：${w}（賛成 ${fmtNum(f.yes)}・反対 ${fmtNum(f.no)}）` : L`国の議題が否決されました：${w}（賛成 ${fmtNum(f.yes)}・反対 ${fmtNum(f.no)}）`;
    }
    case 'NATION_PROPOSED': return !f.aboutMe ? L`国の議題が出ています（ターン ${fmtNum(f.closeBell)} まで）` : f.proposal === 'readmit' ? L`あなたの村を国に戻すことが国の議題に出ています（ターン ${fmtNum(f.closeBell)} まで）` : L`あなたの村の追放が国の議題に出ています（ターン ${fmtNum(f.closeBell)} まで）`;
    case 'TRANSIT_SETTLED': return L`進軍の結果：${OUTCOME[f.outcome]?.() ?? f.outcome}（残る兵 ${fmtNum(f.troops)}）`;
    case 'CLASH': return L`あなたの村のある州で戦いがありました（ターン ${fmtNum(i.bell)}）`;
    default: return i.kind;
  }
}

/** The head: what the summary covers (the player's own mark, or a stated window) and what it cannot (a gap, a read that stopped). */
export function headText(s) {
  const range = s.read.n ? L`第${fmtNum(s.read.fromBell)}〜${fmtNum(s.read.toBell)}ターンの記録 ${fmtNum(s.read.n)} 件を読みました。` : L`新しい記録はありません。`;
  const mode = {
    sinceConfirmed: () => L`あなたが確認したのは第${fmtNum(s.since?.bell ?? 0)}ターンまでです。`,
    firstOnDevice: () => L`この端末では、このシーズンとウォレットで確認した記録がありません（初めてか、別の端末か、ブラウザの記録が消えた場合）。直近 ${fmtNum(FIRST_LOOK_BELLS)} ターンだけを見ています。`,
    otherWallet: () => L`この端末で前に使ったウォレットとは別です。そのウォレットの記録は使いません。直近 ${fmtNum(FIRST_LOOK_BELLS)} ターンだけを見ています。`,
    newSeason: () => L`前に見ていたものとは別のシーズン記録（ID が違う記録）です。前の記録の出来事は、ここには含めていません。`,
    markAhead: () => L`この端末に残っていた確認の位置は、いまのシーズンの記録より先を指していたため使いません。直近 ${fmtNum(FIRST_LOOK_BELLS)} ターンだけを見ています。`,
  }[s.mode]?.() ?? '';
  const horizon = s.mode === 'sinceConfirmed' && Number.isFinite(s.horizonBell) && s.horizonBell > 0 ? L`この端末では第${fmtNum(s.horizonBell)}ターンより前の出来事は見ていません。` : '';
  const short = s.windowFrom !== null && s.windowFrom !== undefined ? L`読めたのは第${fmtNum(s.windowFrom)}ターンからです。` : '';
  const gap = s.gap ? L`確認した位置のあとの記録の一部を読めていません。欠けた分の出来事は推測しません。` : '';
  const stop = s.failed ? L`記録の読み込みが途中で失敗しました。読めた分だけを出しています。` : s.incomplete ? L`記録はまだ続きがあります。読めた分だけを出しています。` : '';
  // (Japanese sentences sit together; English ones need a space between them)
  return [mode, horizon, range, short, gap, stop].filter(Boolean).join(lang() === 'en' ? ' ' : '');
}

/** What "確認した" will do, or why it is not offered (the mark never moves over records this page did not read). */
export function confirmText(s) {
  const c = s.confirm;
  if (!c?.ok) return c?.why === 'gap' ? L`欠けた記録を読めるまで、確認の位置は進めません（× で閉じても位置は動きません）` : L`新しく確認する記録はありません`;
  return c.partial ? L`確認すると、読めた第${fmtNum(c.toBell)}ターンまでを確認済みにします（その先は次に読みます）` : L`確認すると、第${fmtNum(c.toBell)}ターンまでを確認済みにします`;
}

/** The answer to "確認した": the mark moved, stayed (another tab was ahead), or could not be saved. */
export function confirmedText(r) {
  if (!r) return L`確認の位置を保存できませんでした。次に開いたときも同じ範囲が出ます`;
  return r.moved ? L`第${fmtNum(r.marks.confirmedBell)}ターンまでを確認済みにしました` : L`この端末ではすでに第${fmtNum(r.marks.confirmedBell)}ターンまで確認済みです`;
}
