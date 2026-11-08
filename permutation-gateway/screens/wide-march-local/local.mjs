import { createClient } from './local-client.mjs';
import { ECONOMY } from './local-model.mjs';
import { renderLocalMap, phaseMarker, marchRoute, boundDestination, cameraAt, panCamera, resizeCamera, jumpCamera, PAN_STEPS, DIRECTION_LABELS, VIEW_RADIUS_MAX } from './local-map.mjs';
import { formatCoord } from '../../../permutation-server/web/frontier/map/wide.mjs';
const $ = id => document.getElementById(id);
const labels = {
  depart:'記録された固定経路で出発 (Depart, recorded order)', settle_departure:'出発を決済', post_reveal:'到着時刻へ進めて公開 (Reveal)', resolve_arrival:'到着を解決', settle_transit:'到着を決済', dissolve_return:'解散して生存兵を帰還',
  harvest:'収穫 (Harvest)：村の生産を今のシミュレーション時刻まで決済', build_farm:'農場を建設 (Farm, item 0)', train:'槍兵10を訓練 (Train unit 0 ×10)',
};
// Labels for fixed tokens and the program's own stable error codes. The host decides; these only name its answer.
const errorText = { STALE_REVISION:'表示より新しい状態があります（再送しません）', BAD_PHASE:'このフェーズでは実行できません', INSTANT_BUDGET:'この時刻の経済操作は上限（8回）に達しました。デモ用の転送上限で、ゲーム規則ではありません。フェーズを進めると次の時刻になります。', REVISION_LIMIT:'セッションの上限に達しました', HANDLER_REFUSED:'ハンドラが拒否しました',
  LAND_NOT_RING_129:'リング129の州だけを開けます', LAND_DUPLICATE_OPEN:'その州はすでにあります', LAND_BUDGET:'この画面で開ける州の上限（4）に達しました', LAND_COORD_BOUNDS:'座標範囲外です', LAND_IMAGE_BOUND:'口座数の上限です', LAND_RING_UNSEEDED:'リングのシードが未設定です', LAND_TIME_BEFORE_GENESIS:'シーズン開始前です',
  ROUTE_UNREACHABLE:'ホストがこの経路を到達不可と判定しました（別の経路に置き換えて出発はしません）', ROUTE_DESTINATION_ORIGIN:'到着先が出発元の州です（未対応）', ROUTE_DESTINATION_FIXTURE:'到着先が固定fixtureの到着先です（そこへは記録された固定経路の出発を使います）', ROUTE_DESTINATION_UNSUPPORTED:'到着先がこの版で対応する開いた州ではありません（解決履歴・駐留がある等）', ROUTE_REHEARSAL_REFUSED:'捨てるコピー上での実ハンドラの予行（決済と公開）が拒否しました。出発は記録されていません', ARRIVAL_FATE_UNSUPPORTED:'到着の結果がこの版の対応外です（留まる以外）。何も確定していません',
  QuoteRequired:'選んだ経路の出発は、表示中のホストの検証結果からだけ送ります', NoReachableQuote:'到達可能な検証結果がありません。先に経路を検証してください' };
const programText = { 17:'行動バケット不足 (Bucket)', 21:'資源不足 (Insufficient)', 22:'建設キュー満杯 (QueueFull)', 24:'村が未確定 (NotFinal)', 5:'シーズン状態 (WrongStatus)' };
const RESOURCES = ['食料 Food','木材 Wood','石材 Stone','鉱石 Ore','武具 Arms (Horses slot)','金 Gold','学術 Science','影響力 Influence'];
const QUEUE_KIND = { 0:'空き', 1:'生産', 2:'維持費', 3:'村の昇格', 4:'城壁' };
const units = s => { const v = BigInt(s), sign = v < 0n ? '-' : '', a = v < 0n ? -v : v; return `${sign}${a / 1000n}.${String(a % 1000n).padStart(3, '0')}`; };
const client = createClient({ fetchFn:(u,i)=>fetch(u,i), onChange:paint });
let camera = null, cameraNote = '', last = null, chosen = '';
const ROUTE_REASON = { UNKNOWN_PROVINCE:'このホストが返していない州に入ります（未開の土地。遊べる生成地ではありません）', TOO_MANY_PROVINCES:'通過する州が多すぎます（上限4州）', IMPASSABLE:'通行不可タイルを通ります（州の通行マスクより）', OFF_WORLD:'座標範囲 ±2^62 の外です（無限ではありません）', NOT_ADJACENT:'隣接しない移動です', TOO_LONG:'手数が多すぎます（上限32）', EMPTY:'方向が選ばれていません', BOUNDS:'範囲外', WORLD:'別の世界', CLOSED_PROVINCE:'閉じた州', SOURCE:'照会不能', SOURCE_MISMATCH:'州の不一致' };
const MAX_DIRS = 32;
const short = h => `${h.slice(0, 10)}…${h.slice(-6)}`;

function row(cells, head = false) { const tr = document.createElement('tr'); for (const c of cells) { const td = document.createElement(head ? 'th' : 'td'); td.textContent = c; tr.append(td); } return tr; }
function fact(name, value) { const dt=document.createElement('dt'),dd=document.createElement('dd'); dt.textContent=name; dd.textContent=value; $('facts').append(dt,dd); }
const item = (list, text, cls = null) => { const li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; list.append(li); return li; };
function noticeText(s) {
  if (s.notice) {
    const code = s.notice.code, program = s.state?.refusalCode;
    const what = code ? `${errorText[code] ?? code}${(code === 'HANDLER_REFUSED' || code === 'ROUTE_REHEARSAL_REFUSED') && Number.isInteger(program) ? `：${programText[program] ?? `プログラムコード ${program}`}` : ''}` : '';
    return `${s.notice.kind}${what ? ` (${what})` : ''}`;
  }
  return s.error?.code ?? s.reason?.code ?? '';
}
function paintVillage(r) {
  $('stores').replaceChildren(row(['資源','保存値（t0時点）','増減/時','上限','t0からの経過'], true));
  const now = BigInt(r.clock.unix);
  r.village.stores.forEach((s, i) => $('stores').append(row([RESOURCES[i], units(s.value), units(s.rate), units(s.cap), `${now - BigInt(s.t0)} 秒`])));
  $('queue').replaceChildren(row(['枠','種類','対象','効果/時','完了予定 (unix)','状態'], true));
  r.village.queue.forEach((q, i) => {
    const due = q.kind !== 0 && BigInt(q.doneAt) <= now;
    $('queue').append(row([String(i), QUEUE_KIND[q.kind] ?? String(q.kind), q.kind === 1 || q.kind === 2 ? RESOURCES[q.arg] ?? String(q.arg) : '—', q.kind === 0 || q.kind === 3 ? '—' : q.kind === 4 ? q.delta : units(q.delta), q.kind === 0 ? '—' : q.doneAt, q.kind === 0 ? '—' : due ? '予定時刻を過ぎました。反映は次のホスト操作（収穫など）で行われます' : '建設中']));
  });
  $('production').textContent = r.village.production.map((p, i) => `${RESOURCES[i]} ${units(p)}/時`).join(' · ');
  $('reserve').textContent = r.village.reserve.map((n, i) => `兵種${i}: ${n}`).join(' · ');
  const e = r.economy;
  $('economy-facts').textContent = `この時刻の経済操作 ${e.usedThisInstant}/${e.perInstantBudget}（デモの転送上限） · 収穫 ${e.harvests} · 農場 ${e.farmBuilds} · 訓練 ${e.trains} · 村の段階 ${r.village.tier} · 最終操作 ${r.village.lastOwnerAction}`;
  const sel = r.horizon.selectedDestinationResolvedNext;
  $('horizon').textContent = `時計はフェーズ操作でのみ進みます（bell 6→8→21→22→23→${r.horizon.finalBell}）。経済操作は時計を進めません。記録された固定の到着先は bell ${r.horizon.destinationPreparedThroughBell} まで書き出し前に解決済み（RESOLVED_NEXT ${r.horizon.destinationResolvedNext}）、出発元は RESOLVED_NEXT ${r.horizon.originResolvedNext}。${sel === null ? '行軍は未バインド。' : `バインドされた到着先の RESOLVED_NEXT ${sel}（口座バイトから再読込）。`}同じ村・同じ時計ですが、全世界を同期したシミュレーションではありません。`;
}
function paintMap(r) {
  if (!r) { renderLocalMap($('map'), null); $('camera-facts').textContent = ''; $('map-phase').textContent = '現在位置の状態なし'; $('land-open').replaceChildren(); $('land-open-note').textContent = ''; return; }
  if (!camera) camera = cameraAt(r.map.origin.p, r.map.origin.q, 1);
  const marker = phaseMarker(r);
  // the line drawn is the bound march's own route (a chosen march's host-walked steps), else the recorded route
  const view = renderLocalMap($('map'), { ...r.map, route: marchRoute(r) }, marker, camera);
  $('map-phase').textContent = marker?.text ?? '現在位置の状態なし';
  const off = [view.offRoute ? `経路の ${view.offRoute} 点はカメラ範囲外` : '', view.markerOffCamera ? '部隊の位置はカメラ範囲外' : ''].filter(Boolean).join(' · ');
  $('map-route-kind').textContent = r.marchBinding?.kind === 'chosen' ? '線：選んだ経路（ホストが歩いた手順）' : '線：記録された固定経路（fixture）';
  $('camera-facts').textContent = `カメラ ${formatCoord(camera.centre.p, camera.centre.q)} · 半径 ${camera.radius} · 固定州 ${view.counts.known} · 開いた州 ${view.counts.opened} · 未知 ${view.counts.unknown} · 範囲外 ${view.counts.outside}${off ? ` · ${off}` : ''}${cameraNote ? ` · ${cameraNote}` : ''}`;
  paintOpenable(r, view);
}
// Opening land: only an unknown ring-129 cell in view can be asked for; the Rust host runs the real WideOpenProvince
// and decides ring, budget and duplicates. Nothing is drawn as land until the host returns its bytes.
function paintOpenable(r, view) {
  $('land-open').replaceChildren();
  const s = client.snapshot, can = s.phase === 'ready' && !s.busy && r.allowed.includes('open_province');
  if (!view.openable.length) { $('land-open-note').textContent = 'カメラ内に開けるリング129の未知の州はありません（カメラを動かしてください）。'; return; }
  $('land-open-note').textContent = r.allowed.includes('open_province') ? 'カメラ内の未知のリング129の州です。押すとホストが実ハンドラで開きます（成功するまで土地として表示しません）。' : `この画面での上限（${r.land.budget}州）に達しました。`;
  for (const c of view.openable) {
    const b = document.createElement('button'); b.type = 'button'; b.disabled = !can;
    b.textContent = `この州を開く ${c.label}`;
    b.addEventListener('click', () => client.submit({ kind: 'open_province', p: c.p, q: c.q }));
    $('land-open').append(b);
  }
}
const LAND_TEXT = {
  ringSeed: 'リング129のシード：書き出し済み州の末尾から写した合成リテラル（0x81…・ラウンド32547581）。検証済みビーコン出力ではありません。',
  rules: '規則：元のテスト用の候補（RuleBytes{1,2,2,1}）。製品の規則決定ではありません。',
  funds: '資金：ローカルの模擬資金（カウンタ0から）。書き出し元の資金状態の再現ではありません。',
  golden: '照合：実ハンドラで元の2州をbell 1で開き直し、地形・識別・末尾が書き出しと一致したときだけ導入。',
  opened: '新しい州：このセッションのシミュレーション時刻に、実ハンドラ WideOpenProvince が作成。事前計算ではありません。',
  resolveHistory: '解決履歴なし：開いた直後の州。選んだ経路の到着先にした場合だけ、公開時に合成の非到着ビーコン対で解決履歴が作られます（下の行軍の欄）。',
  auth: '署名なし：支払者の署名者フラグはローカルの模擬です。',
  budget: 'デモ上限：追加は4州まで（転送上限で、ゲーム規則ではありません）。',
};
const HISTORY_TEXT = { FIXTURE_EXPORT: '書き出しfixture', NONE: '解決履歴なし', PREPARED_FOR_SELECTED_MARCH: '選んだ行軍のために準備済み（合成の非到着ビーコン対・実Resolve）' };
function paintLand(r) {
  $('land-facts').replaceChildren();
  const l = r.land;
  item($('land-facts'), `開いた州 ${l.opened}/${l.budget} · リングシードの作成数 ${l.provincesCreated}（書き出し時3＋このセッション）`);
  for (const k of Object.keys(LAND_TEXT)) item($('land-facts'), `${LAND_TEXT[k]}（${l.provenance[k]}）`);
  for (const p of r.map.provinces.filter(p => p.source === 'opened')) item($('land-facts'), `開いた州 P ${p.p}, Q ${p.q} · bell ${p.openedBell} · RESOLVED_NEXT ${p.resolvedNext} · wedge ${p.wedge} · region ${p.region} · ${HISTORY_TEXT[p.history] ?? p.history}（${p.history}）`);
}
// The route chooser: the host validates a chosen path over the really-opened provinces (a non-mutating quote). A
// march is sent only by the one explicit button below, from the current reachable quote, never on a quote itself.
function routeNote(s) {
  $('route-path').textContent = chosen ? `選んだ方向: ${chosen}（${chosen.length}/${MAX_DIRS}）` : '方向を選ぶと、ホストが到達可否を検証します（検証は読み取りのみ。行軍は送りません）。';
  const can = s && s.phase === 'ready' && !s.busy;
  $('route-quote-btn').disabled = chosen.length === 0 || !can;
  $('route-clear').disabled = chosen.length === 0;
  $('route-back').disabled = chosen.length === 0;
  for (const b of $('route-dirs').children) b.disabled = chosen.length >= MAX_DIRS || !can;
  const send = chosenSend(s);
  $('route-depart-btn').disabled = !send.can;
  $('route-depart-note').textContent = send.why;
}
/** Whether the explicit chosen-march send is offered: ready, offered by the host, a reachable host quote of exactly
 * the directions now selected, ending in a session-opened province. The host still decides everything. */
function chosenSend(s) {
  const r = s?.state, q = s?.quote;
  if (!r || s.phase !== 'ready' || s.busy) return { can: false, why: '' };
  if (!r.allowed.includes('depart_route')) return { can: false, why: r.phase !== 'ready' ? '行軍中は新しい出発はできません。' : '選んだ経路の出発先は、このセッションで開いた州だけです。先にリング129の州を開いてください。' };
  if (!q) return { can: false, why: 'まず方向を選んで「この経路を検証」を押してください。検証だけでは出発しません。' };
  if (!q.reachable) return { can: false, why: '表示中の検証結果は到達不可です。' };
  if (s.quoteDirs !== chosen) return { can: false, why: '方向を変えました。もう一度検証してください（検証した方向だけを送ります）。' };
  const end = r.map.provinces.find(p => p.p === q.end.p && p.q === q.end.q);
  if (!end || end.source !== 'opened') return { can: false, why: '到着先がこのセッションで開いた州ではありません（出発元・固定fixtureの到着先へはこの操作では行けません）。' };
  return { can: true, why: `検証済みの方向 ${s.quoteDirs} で、P ${q.end.p}, Q ${q.end.q}, tile ${q.end.tile} へ出発します（revision ${r.revision}）。ホストが同じ経路を再検証し、違えば何も確定しません。` };
}
function paintQuote(s) {
  $('route-result').replaceChildren();
  const q = s.quote;
  if (!q) { $('route-summary').textContent = ''; return; }
  $('route-summary').textContent = q.reachable
    ? `到達可能：選んだ方向 ${s.quoteDirs} は開かれた州の通行可能タイルのみを通り、P ${q.end.p}, Q ${q.end.q}, tile ${q.end.tile} に着きます。入る州: ${q.provincesEntered.map(p=>`${p.p},${p.q}`).join(' / ') || '—'}。これは検証だけで、行軍はまだ送っていません。`
    : `到達不可：${ROUTE_REASON[q.reason] ?? q.reason}。未知の州・通行不可・範囲外は到達扱いにしません。`;
  const tbl = document.createElement('table');
  tbl.append(row(['歩','P','Q','tile','州','通行'], true));
  q.steps.forEach((st, i) => {
    const tr = row([String(i+1), st.p, st.q, String(st.tile), st.known ? 'ホスト返却' : '未知', st.passable === null ? '—' : st.passable ? '可' : '不可']);
    if (!st.known) tr.classList.add('step-unknown'); else if (st.passable === false) tr.classList.add('step-impassable');
    if (q.blockedStep === i) tr.classList.add('step-blocked');
    tbl.append(tr);
  });
  $('route-result').append(tbl);
}
// The bound march, verbatim from the host: every token shown as sent; nothing inferred.
function paintBinding(r) {
  const b = r?.marchBinding;
  for (const id of ['march-badges','march-facts','march-order-labels','march-prep-labels','march-accounts','march-trail']) $(id).replaceChildren();
  if (!b) { $('march-kind').textContent = r ? '行軍はバインドされていません（ready）。' : '状態なし'; return; }
  const badge = (text, cls = '') => item($('march-badges'), text, `badge ${cls}`.trim());
  badge('LOCAL SIMULATION'); badge('MOCK AUTH · 署名なし');
  if (b.kind === 'chosen') { badge('PUBLIC ORDER MATERIAL · 秘密性なし', 'badge-public'); badge('敵fixtureなし（開いた州）', 'badge-public'); }
  else badge('RECORDED FIXTURE ORDER');
  if (b.preparation) badge('SYNTHETIC PREPARATION · 合成の非到着ビーコン対', 'badge-synthetic');
  $('march-kind').textContent = b.kind === 'chosen'
    ? '選んだ経路の行軍（depart_route）：このセッションで開いた州へ、ホストが検証した経路で。公開素材から作り直した命令で、ローカルのシミュレーションです。チェーン実行・署名済み命令・秘匿命令・同期した世界ではありません。'
    : '記録された固定の行軍（depart）：fixtureの記録済み命令で固定の到着先へ。';
  const f = $('march-facts'), add = (k, v) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; f.append(dt, dd); };
  add('到着先', `P ${b.destination.p}, Q ${b.destination.q}, tile ${b.destination.tile} · ${b.destination.source === 'opened' ? 'このセッションで開いた州' : '固定fixtureの到着先'} · 口座 ${short(b.destination.accountKeyHex)}`);
  add('方向・手数', `${b.directions}（${b.steps.length}手・到着 bell ${b.arriveBell} のみ）`);
  add('経路（ホストが歩いた手順。ブラウザが方向から同じ手順を再計算して一致を確認）', b.steps.map(s => `${s.p},${s.q}#${s.tile}`).join(' → '));
  add('入る州', b.provincesEntered.map(e => `${e.p},${e.q}`).join(' / '));
  add('公開時の経路州（到着先を除く）', b.pathProvinces.map(e => `${e.p},${e.q}`).join(' / ') || '—');
  add('出発時の兵', `${units(String(b.departedMilli))}（ミリ単位 ${b.departedMilli}）`);
  add('命令', `${b.order.source} · commit ${short(b.order.commitHex)} · root ${short(b.order.rootHex)}。ブラウザは命令の封印を開かず認証もしません。照合するのは、移動中の転送記録（transit）の seal root がこの root と一致することだけです。命令素材の検証はホスト側です。`);
  for (const l of b.order.labels) item($('march-order-labels'), l, 'tokens');
  if (b.preparation) {
    const p = b.preparation;
    add('到着先の準備', `bell ${p.fromBell}–${p.toBell} を実WideResolveで ${p.resolves} 回解決（公開時 unix ${p.atUnix}、時計は戻していません）· RESOLVED_NEXT ${p.resolvedNext} · region ${p.region} · 既存対の流用 ${p.pairsAliased} · ${p.provenance}。ビーコン由来の履歴ではなく、合成の非到着ビーコン対による後付けのローカル履歴です。`);
    for (const l of p.labels) item($('march-prep-labels'), l, 'tokens');
  }
  for (const a of b.accounts) item($('march-accounts'), `${a.role} · ${short(a.keyHex)}`, 'tokens');
  for (const t of b.trail) item($('march-trail'), t, 'tokens');
}
function paint(s) {
  const r=s.state, can=s.phase==='ready' && !s.busy; last = r;
  $('status').textContent = s.phase==='ready' ? `LOCAL · ${r.phase} · revision ${r.revision}${s.busy ? ' · 処理中…' : ''}` : s.phase === 'uncertain' ? 'ホストが不確実です。操作停止。自動再送・再起動はしません。' : s.phase==='error' ? '結果不明。表示を消しました。GET再取得で確認してください。自動再送はしません。' : '読み込み中…';
  $('notice').textContent = noticeText(s);
  $('refresh').disabled = s.busy; $('reset').disabled=!can;
  for (const id of ['controls','economy','facts','positions','stores','queue']) $(id).replaceChildren();
  for (const id of ['production','reserve','economy-facts','horizon']) $(id).textContent = '';
  paintMap(r);
  routeNote(s);
  paintQuote(s);
  paintBinding(r);
  $('details').textContent = r ? JSON.stringify({ host:r.host, holding:r.holding, combat:r.combat, returned:r.returned, instructions:r.evidence.instructions, receiptCount:r.evidence.recordsHex.length, accountCount:r.evidence.accounts.length },null,2) : '状態なし';
  if(!r) { $('land-facts').replaceChildren(); return; }
  paintVillage(r);
  paintLand(r);
  for(const [name,value] of [['シミュレーション時刻',`${r.clock.unix} · bell ${r.clock.bell}`],['世界',r.map.worldHex],['検証範囲','村の資源・生産・建設キュー・予備兵・段階、州座標・通行マスク・解決カーソル・解決履歴の区分、預託・未決済数は返却バイトと照合。保有地とホストが持つ全州のイベントチェーン（seq・head）を受領記録から再計算して前後のバイトと照合（受領記録の中身の事実やダイジェストは再計算しません）。選んだ経路は方向から手順を再計算し、移動中の転送記録の seal root を照合。部隊・戦闘・帰還の数値はRustホストの投影（ブラウザ独立検証なし）。'],['初期設定','初期資源（各1,900）・固定の敵部隊・初期口座・公開暗号素材は固定fixture。チェーン出自の証明なし。']]) fact(name, value);
  // depart_route needs directions: it is sent only from the route section's explicit button, never as a generic step
  for(const kind of r.allowed.filter(k=>k!=='reset' && k!=='open_province' && k!=='depart_route')) { const b=document.createElement('button');b.type='button';b.textContent=labels[kind]??kind;b.disabled=!can;b.addEventListener('click',()=>client.submit({kind}));$(ECONOMY.includes(kind) ? 'economy' : 'controls').append(b); }
  const dest = boundDestination(r);
  for(const [name,p,t] of [['出発',r.map.origin,r.host.originTile],[r.marchBinding?.kind === 'chosen' ? '到着（選んだ経路）' : '到着（記録された固定経路）',dest,dest.tile],['村',r.map.origin,r.holding.tile]]) { const li=document.createElement('li');li.textContent=`${name}: P ${p.p}, Q ${p.q}, tile ${t}`;$('positions').append(li); }
}
// ------------------------------------------------------------------ camera controls (view only: never a request)
const step = () => PAN_STEPS[Number($('cam-step').value)] ?? 1n;
function setCamera(next, note = '') { if (next) { camera = next; cameraNote = note; } else cameraNote = note || '移動できません'; paintMap(last); }
DIRECTION_LABELS.forEach((label, dir) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', () => { if (!camera) return; const n = panCamera(camera, dir, step()); setCamera(n, n ? '' : '座標範囲 ±2^62 の外には移動できません（無限ではありません）'); }); $('pan').append(b); });
PAN_STEPS.forEach((s, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${s} 州ずつ`; $('cam-step').append(o); });
$('cam-wider').addEventListener('click', () => { if (camera && camera.radius < VIEW_RADIUS_MAX) setCamera(resizeCamera(camera, camera.radius + 1)); });
$('cam-narrower').addEventListener('click', () => { if (camera && camera.radius > 0) setCamera(resizeCamera(camera, camera.radius - 1)); });
$('cam-village').addEventListener('click', () => { if (last) setCamera(cameraAt(last.map.origin.p, last.map.origin.q, camera?.radius ?? 1)); });
$('cam-destination').addEventListener('click', () => { if (last) { const d = boundDestination(last); setCamera(cameraAt(d.p, d.q, camera?.radius ?? 1)); } });
$('cam-jump').addEventListener('click', () => { try { setCamera(jumpCamera($('cam-p').value.trim(), $('cam-q').value.trim(), camera?.radius ?? 1), '表示のみ（行軍先の指定ではありません）'); } catch { setCamera(null, '座標は ±2^62 以内の正規の10進整数で入力してください'); } });
// ------------------------------------------------------------------ route chooser (a non-mutating host quote) and the one explicit send
DIRECTION_LABELS.forEach((label, d) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = `${d}: ${label}`; b.addEventListener('click', () => { if (chosen.length < MAX_DIRS) chosen += String(d); routeNote(client.snapshot); }); $('route-dirs').append(b); });
$('route-back').addEventListener('click', () => { chosen = chosen.slice(0, -1); routeNote(client.snapshot); });
$('route-clear').addEventListener('click', () => { chosen = ''; routeNote(client.snapshot); });
$('route-quote-btn').addEventListener('click', () => { if (chosen) client.quote(chosen); });
$('route-depart-btn').addEventListener('click', () => { if (chosenSend(client.snapshot).can) client.departRoute(); });
$('refresh').addEventListener('click',()=>client.refresh());
$('reset').addEventListener('click',()=>client.submit({kind:'reset'}));
client.refresh();
