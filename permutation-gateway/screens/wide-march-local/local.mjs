import { createClient } from './local-client.mjs';
import { renderLocalMap, phaseMarker } from './local-map.mjs';
const $ = id => document.getElementById(id);
const labels = { depart:'出発 (Depart)', train:'この行軍元で槍兵10を訓練', settle_departure:'出発を決済', post_reveal:'到着時刻へ進めて公開 (Reveal)', resolve_arrival:'到着戦闘を解決', settle_transit:'到着を決済', dissolve_return:'解散して生存兵を帰還' };
const client = createClient({ fetchFn:(u,i)=>fetch(u,i), onChange:paint });
function paint(s) {
  const r=s.state, can=s.phase==='ready' && !s.busy;
  $('status').textContent = s.phase==='ready' ? `LOCAL · ${r.phase} · revision ${r.revision}${s.busy ? ' · 処理中…' : ''}` : s.phase === 'uncertain' ? 'ホストが不確実です。操作停止。自動再送・再起動はしません。' : s.phase==='error' ? '結果不明。表示を消しました。GET再取得で確認してください。自動再送はしません。' : '読み込み中…';
  $('notice').textContent = s.notice ? `${s.notice.kind}${s.notice.code ? ` (${s.notice.code})` : ''}` : s.error?.code ?? s.reason?.code ?? '';
  $('refresh').disabled = s.busy; $('reset').disabled=!can;
  $('controls').replaceChildren(); $('facts').replaceChildren(); $('positions').replaceChildren();
  const marker = phaseMarker(r);
  renderLocalMap($('map'),r?.map ?? null,marker);
  $('map-phase').textContent = marker?.text ?? '現在位置の状態なし';
  $('details').textContent = r ? JSON.stringify({ host:r.host, holding:r.holding, combat:r.combat, returned:r.returned, instructions:r.evidence.instructions, receiptCount:r.evidence.recordsHex.length, accountCount:r.evidence.accounts.length },null,2) : '状態なし';
  if(!r) return;
  for(const [name,value] of [['シミュレーション時刻',`${r.clock.unix} · bell ${r.clock.bell}`],['世界',r.map.worldHex],['行軍元の訓練',r.trained?'実行済み':'未実行'],['検証範囲','州座標・通行マスク、村の予備兵(兵種0)・預託・未決済数は返却バイトと照合。部隊・戦闘・帰還はRustホスト投影（ブラウザ独立検証なし）。'],['初期設定','敵部隊・初期口座・公開暗号素材は固定fixture。チェーン出自の証明なし。']]) { const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;$('facts').append(dt,dd); }
  for(const kind of r.allowed.filter(k=>k!=='reset')) { const b=document.createElement('button');b.type='button';b.textContent=labels[kind]??kind;b.disabled=!can;b.addEventListener('click',()=>client.submit({kind}));$('controls').append(b); }
  for(const [name,p,t] of [['出発',r.map.origin,r.host.originTile],['到着',r.map.destination,r.host.destinationTile],['村',r.map.origin,r.holding.tile]]) { const li=document.createElement('li');li.textContent=`${name}: P ${p.p}, Q ${p.q}, tile ${t}`;$('positions').append(li); }
}
$('refresh').addEventListener('click',()=>client.refresh());
$('reset').addEventListener('click',()=>client.submit({kind:'reset'}));
client.refresh();
