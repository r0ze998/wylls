// The workstream 07 prototype: the return summary, the shortfall comparison,
// the caravan preview, the forecast check and the season's terms, on the
// recommended "atlas" map. Every number comes from ../src (pinned by
// ../tests against the rules crate and the S1 kernel); the world is mock
// data (world.mjs) and says so. Back, cancel, a double press, a failed send
// and a reload are handled on purpose (see the checks in ../shots).
import { setLang } from '../../../permutation-server/web/lang.mjs';
import { setS1 } from '../../../permutation-server/web/frontier/fs1.mjs';
import { factionName } from '../../../permutation-server/web/frontier/fi18n.mjs';
import { DIRECTIONS, locate, tileHex } from '../../../permutation-server/web/frontier/fgeo.mjs';
import { Kernel } from '../../../permutation-server/web/frontier/wasm.mjs';
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { forecast } from '../../../permutation-server/web/frontier/hud/forecast.mjs';
import * as Wd from './world.mjs';
import { renderMap, emblem, glyph, NATION_COLOR, TERRAIN_NAME } from './mapview.mjs';
import { caravanPreview } from '../src/caravan-preview.mjs';
import { compareRemedies } from '../src/shortfall.mjs';
import * as RS from '../src/return-summary.mjs';
import { seasonTimes, turnText, deadlineText, whyWrongStatus, s1Terms, spanText } from '../src/season-terms.mjs';
import { modelForecast } from '../src/forecast-model.mjs';
import { wearBps, wear, TOWER_WEAR_CAP_BPS } from '../src/s1walk.mjs';
import { SIEGE_WORDS, SIEGE_UNJUDGED } from '../src/siege-precheck.mjs';

setS1(Wd.SEASON);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = (() => { try { const s = globalThis.localStorage; s.setItem('ws07-probe', '1'); s.removeItem('ws07-probe'); return s; } catch { return null; } })();
const memory = new Map();
const storage = store ?? { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: k => memory.delete(k) };

// ------------------------------------------------------------------ the prototype's own words (ja is the source)
const S = {
  terrain: { ja: ['草地', '平原', '森', '丘', '山', '水'], en: ['grassland', 'plains', 'forest', 'hills', 'mountain', 'water'] },
  rel: { own: ['あなたの国', 'your nation'], war: ['戦争中', 'at war'], pass: ['通行', 'passage'] },
  tone: { loss: ['損失', 'Loss'], threat: ['脅威', 'Threat'], gain: ['得たもの', 'Gain'], nation: ['国', 'Nation'], result: ['結果', 'Result'] },
  kind: { 1: ['物見櫓', 'watchtower'], 2: ['柵', 'palisade'], 3: ['要塞', 'fort'] },
  tier: { ja: ['集落', '町', '都市', '城塞'], en: ['hamlet', 'town', 'city', 'stronghold'] },
  res: { ja: ['食料', '木材', '石材', '鉱石', '兵器', '金', '学術', '影響力'], en: ['food', 'wood', 'stone', 'ore', 'arms', 'gold', 'science', 'influence'] },
};
let LANG = (() => { try { return storage.getItem('ws07-lang') === 'en' ? 'en' : 'ja'; } catch { return 'ja'; } })();
const ja = () => LANG === 'ja';
const t = (j, e) => (ja() ? j : e);
const n = x => Number(x).toLocaleString(ja() ? 'ja' : 'en');
const resName = r => S.res[LANG][r];
const nationName = f => factionName(f);

// ------------------------------------------------------------------ state (the URL hash keeps the panel and the selection: back and reload)
const state = { rate: 1, focus: '0,0,30', sel: { p: 0, q: 0, tile: 30 }, panel: 'tile', drawer: null, cargo: [0, 600, 900, 0, 0, 0, 0, 0], send: null, failNext: false, scenario: 'normal', wearSecs: 0 };
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const sel = (h.get('sel') ?? '').split(',').map(Number);
  if (sel.length === 3 && sel.every(Number.isInteger)) state.sel = { p: sel[0], q: sel[1], tile: sel[2] };
  state.panel = ['tile', 'shortfall', 'caravan', 'forecast'].includes(h.get('panel')) ? h.get('panel') : 'tile';
  state.drawer = ['away', 'terms'].includes(h.get('drawer')) ? h.get('drawer') : null;
}
function writeHash(push = true) {
  const h = new URLSearchParams();
  h.set('panel', state.panel); h.set('sel', `${state.sel.p},${state.sel.q},${state.sel.tile}`);
  if (state.drawer) h.set('drawer', state.drawer);
  const url = `#${h}`;
  if (url === location.hash) return;
  if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
}
addEventListener('popstate', () => { readHash(); render(); });
addEventListener('hashchange', () => { readHash(); render(); });

const nowTs = () => Wd.nowTs();
const chain = () => ({ now: nowTs, rate: state.rate });
const times = () => seasonTimes(Wd.SEASON, chain());

// ------------------------------------------------------------------ the scene
const villageAlert = () => summary().items.some(i => i.kind === 'SIEGE_DECLARED');
const scene = () => ({ provinces: Wd.PROVINCES, terrain: Wd.TERRAIN, villages: Wd.VILLAGES.map(v => ({ ...v, alert: v.own && villageAlert() })), structures: Wd.STRUCTURES, vaults: Wd.VAULTS, hosts: Wd.HOSTS, iron: Wd.IRON, sight: Wd.sight, me: { faction: Wd.ME.faction }, stances: Wd.STANCES });
const relOf = f => (f === Wd.ME.faction ? 'own' : (Wd.STANCES[f]?.[Wd.ME.faction] ?? 0) === 0 ? 'war' : 'pass');
const relTag = f => { const r = relOf(f); return `<span class="tag ${r}">${t(...S.rel[r])}</span>`; };
const who = f => `<span class="who"><svg viewBox="-10 -10 20 20" aria-hidden="true">${emblem(f, 0, 0, 7)}</svg>${esc(nationName(f))}</span>`;

// ------------------------------------------------------------------ the models
const VAULT = Wd.VAULTS[0];
function preview(cargo = state.cargo) {
  return caravanPreview({ p: VAULT.p, q: VAULT.q, tile: VAULT.tile }, { p: 0, q: 0, tile: 30 }, cargo, { lands: Wd.LANDS, structures: Wd.STRUCTURES, stances: Wd.STANCES, faction: Wd.ME.faction, genesisTs: Wd.GENESIS, now: nowTs(), margin: 90, provinces: Wd.provinces(), sight: Wd.sight, ownHost: e => !!e.own });
}
const NEED_CITY = [0, 4000, 3000, 0, 0, 1500, 0, 0];
const remedies = () => compareRemedies({ h: Wd.VILLAGE, need: NEED_CITY, now: nowTs(), endTs: Wd.GENESIS + Wd.SEASON.endBell * 600, sources: [{ id: 'vault', label: VAULT.label, have: VAULT.have, preview: preview(VAULT.have) }] });
const me = { tag: Wd.ME.tag, faction: Wd.ME.faction, holdings: [{ p: 0, q: 0, site: 0 }] };
function marksFor() {
  if (state.scenario === 'firstOnDevice') return null;
  if (state.scenario === 'otherWallet') return null;
  if (state.scenario === 'newSeason') return null;
  // (a gap: the page read from a cursor past the mark of nine hours ago, e.g. the herald's first page was all it got)
  if (state.scenario === 'gap') return Wd.FIRST_MARK;
  return RS.loadMarks(storage, '7', Wd.ME.wallet) ?? Wd.FIRST_MARK;
}
function summary() {
  const last = state.scenario === 'otherWallet' ? { seasonId: '7', wallet: 'AnotherWallet' } : state.scenario === 'newSeason' ? { seasonId: '6', wallet: Wd.ME.wallet } : RS.loadLast(storage);
  const gap = state.scenario === 'gap';
  return RS.summarize({ records: gap ? Wd.RECORDS.slice(4) : Wd.RECORDS, read: { after: gap ? '5160' : Wd.READ_AFTER, complete: !gap }, marks: marksFor(), last, season: '7', wallet: Wd.ME.wallet, nowBell: Wd.NOW_BELL, me });
}
const confirmedSeq = () => (marksFor()?.confirmedSeq ?? null);

// ------------------------------------------------------------------ rendering
function renderClock() {
  const tt = times();
  $('clock').innerHTML = `<strong>${t(`第${n(tt.nowBell)}ターン`, `Turn ${n(tt.nowBell)}`)}</strong> / ${n(tt.end.bell)} · ${esc(turnText(tt, LANG))} · ${esc(deadlineText(tt, LANG))}`;
}
function renderAlerts() {
  const s = summary();
  const loss = s.counts.loss ?? 0, threat = s.counts.threat ?? 0;
  const unconfirmed = s.items.length > 0;
  $('alerts').innerHTML = unconfirmed ? `<div class="alert" role="status"><span class="what"><strong>${t('留守のあいだ', 'While you were away')}</strong>：${t(`損失 ${loss}・脅威 ${threat}・ほか ${s.items.length + s.more - loss - threat}`, `${loss} loss, ${threat} threats, ${s.items.length + s.more - loss - threat} more`)} <span class="muted">${t('（まだ確認していません）', '(not yet confirmed)')}</span></span><button type="button" class="btn small primary" data-act="away">${t('知らせを開く', 'Open')}</button></div>` : '';
}
function renderMapPane() {
  const pv = state.panel === 'caravan' ? preview() : null;
  const route = pv?.ok ? { from: { p: VAULT.p, q: VAULT.q, tile: VAULT.tile }, steps: pv.road.steps, turns: pv.turns, avoidedAt: pv.avoided ? '1,0,8' : null } : null;
  const m = renderMap(scene(), { style: 'atlas', size: 22, selected: state.sel, focus: state.focus, route, ariaLabel: t('地図。矢印キーでマスを移動、Enter で選択', 'Map. Arrow keys move between tiles; Enter selects') });
  const host = $('map');
  host.innerHTML = m.svg;
  const svg = host.querySelector('svg');
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('aria-activedescendant', '');
  const f = m.hexes.get(state.focus);
  svg.setAttribute('aria-description', f ? tileWords({ p: f.p, q: f.pq, tile: f.tile }) : '');
  // keep the selected tile in view (the host scrolls; the SVG keeps its scale)
  const at = m.hexes.get(`${state.sel.p},${state.sel.q},${state.sel.tile}`);
  if (at && lastScrolled !== `${state.sel.p},${state.sel.q},${state.sel.tile}`) {
    lastScrolled = `${state.sel.p},${state.sel.q},${state.sel.tile}`;
    requestAnimationFrame(() => { const k = svg.getBoundingClientRect().width / m.width; host.scrollTo({ left: (at.x + m.ox) * k - host.clientWidth / 2, top: (at.y + m.oy) * k - host.clientHeight / 2, behavior: 'instant' }); });
  }
}
let lastScrolled = null;
function tileWords(sel) {
  const ter = Wd.TERRAIN.get(`${sel.p},${sel.q}`)?.[sel.tile];
  const parts = [t(`マス ${sel.p},${sel.q}・${sel.tile}`, `Tile ${sel.p},${sel.q}·${sel.tile}`), S.terrain[LANG][ter] ?? ''];
  const v = Wd.VILLAGES.find(x => x.p === sel.p && x.q === sel.q && x.tile === sel.tile);
  if (v) parts.push(`${v.name}（${nationName(v.faction)}・${t(...S.rel[relOf(v.faction)])}）`);
  for (const st of Wd.STRUCTURES.filter(x => x.p === sel.p && x.q === sel.q && x.tile === sel.tile)) parts.push(`${t(...S.kind[st.kind])}（${nationName(st.faction)}・${t(...S.rel[relOf(st.faction)])}）`);
  if (Wd.VAULTS.some(x => x.p === sel.p && x.q === sel.q && x.tile === sel.tile)) parts.push(t('あなたの貯蔵庫', 'your storehouse'));
  for (const h of Wd.HOSTS.filter(x => x.p === sel.p && x.q === sel.q && x.tile === sel.tile && Wd.sight(x.p, x.q, x.tile) >= 3)) parts.push(t(`${nationName(h.faction)}の軍勢 ${n(h.troops / 1000)}`, `${nationName(h.faction)} host of ${n(h.troops / 1000)}`));
  if (Wd.sight(sel.p, sel.q, sel.tile) < 3) parts.push(t('見えていない（誰がいるかわかりません）', 'out of sight (who stands here is unknown)'));
  return parts.filter(Boolean).join('、');
}

function panelTile() {
  const sel = state.sel, ter = Wd.TERRAIN.get(`${sel.p},${sel.q}`)?.[sel.tile];
  const v = Wd.VILLAGES.find(x => x.p === sel.p && x.q === sel.q && x.tile === sel.tile);
  const vault = Wd.VAULTS.find(x => x.p === sel.p && x.q === sel.q && x.tile === sel.tile);
  const sts = Wd.STRUCTURES.filter(x => x.p === sel.p && x.q === sel.q && x.tile === sel.tile);
  const hosts = Wd.HOSTS.filter(x => x.p === sel.p && x.q === sel.q && x.tile === sel.tile);
  const seen = Wd.sight(sel.p, sel.q, sel.tile);
  const out = [`<h2 id="panel-title">${v ? esc(v.name) : vault ? esc(vault.label) : t('マス', 'Tile')} <span class="muted small">${sel.p},${sel.q}・${sel.tile}</span></h2>`];
  out.push(`<dl class="kv"><dt>${t('地形', 'Terrain')}</dt><dd>${S.terrain[LANG][ter]}${Wd.IRON.has(`${sel.p},${sel.q},${sel.tile}`) ? t('（鉄：近くの村の鉱石が増える）', ' (iron: more ore for villages near)') : ''}</dd>`);
  out.push(`<dt>${t('見え方', 'Sight')}</dt><dd>${seen >= 3 ? t('見えている', 'in sight') : t('見えていない：誰がいるかはわかりません', 'out of sight: who stands here is unknown')}</dd></dl>`);
  if (v) {
    out.push(`<h3>${t('村', 'Village')}</h3><dl class="kv"><dt>${t('国', 'Nation')}</dt><dd>${who(v.faction)} ${relTag(v.faction)}</dd><dt>${t('規模', 'Tier')}</dt><dd>${S.tier[LANG][v.tier]}</dd>`);
    if (v.shield) out.push(`<dt>${t('状態', 'State')}</dt><dd>${t('保護期間中（包囲できません）', 'shielded (cannot be besieged)')}</dd>`);
    out.push('</dl>');
    if (v.own) {
      const sum = summary(), siege = sum.items.find(i => i.kind === 'SIEGE_DECLARED');
      if (siege) out.push(`<p class="status err">${esc(RS.itemText(siege, LANG))}</p>`);
      out.push(`<div class="actions"><button type="button" class="btn primary" data-act="shortfall">${t('都市へ昇格：足りない分をそろえる', 'Promote to city: gather what is short')}</button></div>`);
    } else {
      out.push(`<h3>${t('包囲', 'Siege')}</h3><div class="actions"><button type="button" class="btn" aria-disabled="true" data-act="noop">${t('包囲を宣言する', 'Declare a siege')}</button></div>
        <ul class="why"><li>${t('この村のマスに、あなたの戦える軍勢がいません', 'No fighting host of yours stands on this village\'s tile')}</li>${v.shield ? `<li>${t('保護期間中の村です', 'This village is shielded')}</li>` : ''}</ul>
        <p class="small muted">${esc(SIEGE_WORDS.unjudged[LANG])}</p>`);
    }
  }
  if (vault) {
    out.push(`<h3>${t('貯蔵庫', 'Storehouse')}</h3><p>${vault.have.map((x, r) => (x ? `${resName(r)} ${n(x)}` : null)).filter(Boolean).join('・')}</p>
      <div class="actions"><button type="button" class="btn primary" data-act="caravan">${t('ハルデンへ隊商を送る…', 'Send a caravan to Halden…')}</button></div>`);
  }
  for (const st of sts) out.push(`<h3>${t(...S.kind[st.kind])}</h3><dl class="kv"><dt>${t('国', 'Nation')}</dt><dd>${who(st.faction)} ${relTag(st.faction)}</dd><dt>${t('はたらき', 'Does')}</dt><dd>${esc(structureWords(st))}</dd></dl>`);
  for (const h of hosts) if (seen >= 3) out.push(`<h3>${t('軍勢', 'Host')}</h3><dl class="kv"><dt>${t('国', 'Nation')}</dt><dd>${who(h.faction)} ${relTag(h.faction)}</dd><dt>${t('兵', 'Troops')}</dt><dd>${n(h.troops / 1000)}</dd></dl>${h.own ? `<div class="actions"><button type="button" class="btn" data-act="forecast">${t('進軍の予測を点検する', 'Check a march forecast')}</button></div>` : ''}`);
  return out.join('');
}
function structureWords(st) {
  const r = relOf(st.faction);
  if (st.kind === 1) return r === 'war' ? t('あなたの進軍と隊商を見張り、そのまわりを歩いた 1 分ごとに 1% 減らします（最大 30%）', 'Watches you; wears your marches and caravans by 1% a minute walked near it (at most 30%)') : t('あなたの国を止めません（見張りだけ）', 'Does not stop your nation (watch only)');
  if (st.kind === 2) return r === 'war' ? t('あなたの進軍と隊商を通しません。道はここを避けて引かれます', 'Stops your marches and caravans; roads are drawn round it') : t('あなたは通れます', 'Lets you through');
  return st.faction === Wd.ME.faction ? t(`兵 ${n(st.troops ?? 0)}：このマスに来たほかの国の軍勢と城壁つきで戦います`, `${n(st.troops ?? 0)} troops: fights every other nation's host on this tile, behind walls`) : t('このマスに来たほかの国の軍勢と戦います', 'Fights every other nation\'s host on this tile');
}

function whenText(ready) {
  if (ready === null) return null;
  const secs = ready - nowTs(), bell = Math.floor((ready - Wd.GENESIS) / 600);
  return t(`約 ${spanText(secs / state.rate)}後（第${n(bell)}ターン）`, `in about ${spanText(secs / state.rate, 'en')} (turn ${n(bell)})`);
}
function panelShortfall() {
  const c = remedies();
  const rows = NEED_CITY.map((x, r) => (x ? `<tr><td>${resName(r)}</td><td>${n(x)}</td><td>${n(c.have[r])}</td><td>${c.short.find(s => s.r === r) ? `<span class="short">${n(c.short.find(s => s.r === r).missing)}</span>` : '—'}</td></tr>` : '')).join('');
  const name = o => ({ wait: t('待つ', 'Wait'), grow: t(`増やす：${resName(o.r)}の建物をもう一つ`, `Grow: one more ${resName(o.r)} building`), carry: t(`運ぶ：${o.label}から隊商`, `Carry: a caravan from ${o.label}`), both: t(`運ぶ＋増やす（${resName(o.r)}）`, `Carry + grow (${resName(o.r)})`), ask: t('頼む：国の仲間に依頼する', 'Ask: request from your nation') })[o.kind];
  const why = o => (o.blocked ?? []).map(b => b.why === 'AboveCap' ? t(`${resName(b.r)}は蔵の上限 ${n(b.cap)} を超えます（待っても増えません）`, `${resName(b.r)} is above the store's cap of ${n(b.cap)}`) : b.why === 'NoRate' ? t(`${resName(b.r)}は毎時 ${n(b.perHour)}（増えていません）`, `${resName(b.r)} is ${n(b.perHour)} an hour (not growing)`) : b.why === 'Insufficient' ? t('建設費が足りません', 'The building\'s cost is short') : b.why === 'QueueFull' ? t('建設の枠がいっぱいです', 'The building queue is full') : esc(b.why));
  const parts = o => {
    const p = [];
    if (o.kind === 'grow' || o.kind === 'both') p.push(t(`建設費：${o.costs.map((x, r) => (x ? `${resName(r)} ${n(x)}` : null)).filter(Boolean).join('・')}（今払う。同じ蔵から出ます）`, `Cost: ${o.costs.map((x, r) => (x ? `${resName(r)} ${n(x)}` : null)).filter(Boolean).join(', ')} (paid now, from the same stores)`));
    if (o.kind === 'grow') p.push(t(`純増：${resName(o.r)} 毎時 +${n(o.gives.perHour)}（完成後、${whenText(o.gives.from)}から）`, `Net: ${resName(o.r)} +${n(o.gives.perHour)} an hour once built (${whenText(o.gives.from)})`));
    if (o.kind === 'carry' || o.kind === 'both') {
      p.push(t(`届く：${o.arrives.map((x, r) => (x ? `${resName(r)} ${n(x)}` : null)).filter(Boolean).join('・')}（到着予定 第${n(o.arrive.bell)}ターン）`, `Arrives: ${o.arrives.map((x, r) => (x ? `${resName(r)} ${n(x)}` : null)).filter(Boolean).join(', ')} (turn ${n(o.arrive.bell)}, planned)`));
      if (o.wear) p.push(t(`物見櫓で ${o.wear / 100}% 減ります（ルールどおり）`, `${o.wear / 100}% worn by watchtowers (as the rules wear it)`));
      if (o.partial) p.push(t('部分輸送：残りは村で増えるのを待ちます', 'Partial: the rest still has to grow in the village'));
      if (o.risk) p.push(o.risk.knownTurns ? t(`略奪の危険：見えている他国の軍勢が道に ${n(o.risk.knownTurns)} か所（時間からは引いていません）`, `Raid risk: ${n(o.risk.knownTurns)} known (not taken from the time)`) : o.risk.unknown ? t('略奪の危険：道の一部が見えていません（不明）', 'Raid risk: part of the road is out of sight (unknown)') : t('略奪の危険：いま見えている範囲にはありません', 'Raid risk: none in sight now'));
    }
    if (o.kind === 'ask') p.push(t('いつ、どれだけ届くかは相手しだいで、時間は出しません。国の卓（①の担当）は未接続の試作です', 'When and whether it comes depends on others; no time is given. The nation\'s table (workstream 1) is a mock'));
    if (o.notes.includes('AfterSeasonEnd')) p.push(t('シーズンの終わりまでにそろいません', 'Not all there before the season ends'));
    if (o.notes.includes('CostsWhatIsShort')) p.push(t('建設費に足りない資源が含まれます', 'Its cost uses what is short'));
    return p;
  };
  const best = c.options.find(o => o.ready !== null);
  const items = c.options.map(o => `<li class="opt${o === best ? ' best' : ''}"><div><strong>${esc(name(o))}</strong>${o === best ? ` <span class="tag plan">${t('いちばん早い', 'quickest')}</span>` : ''}</div>
    <div class="${o.ready === null ? 'none' : 'when'}">${o.ready === null ? (o.kind === 'ask' ? t('時間は出せません', 'No time can be given') : t('全部そろいません', 'Never all there')) : t(`全部そろう：${whenText(o.ready)}`, `All there: ${whenText(o.ready)}`)}</div>
    ${why(o).length ? `<ul class="why">${why(o).map(x => `<li>${x}</li>`).join('')}</ul>` : ''}<ul class="parts">${parts(o).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    ${o.kind === 'carry' || o.kind === 'both' ? `<button type="button" class="btn small" data-act="caravan">${t('隊商の準備へ', 'Prepare the caravan')}</button>` : ''}</li>`).join('');
  return `<h2 id="panel-title">${t('都市への昇格：足りない分', 'Promotion to city: what is short')}</h2>
    <table class="need"><thead><tr><th>${t('資源', 'Resource')}</th><th>${t('必要', 'Need')}</th><th>${t('いま', 'Have')}</th><th>${t('不足', 'Short')}</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="small muted">${t('どの方法も「必要な分が全部そろう時点」で比べています。部分的に届く時点ではありません。', 'Every way is compared at the moment ALL that is needed is there, not when part of it arrives.')}</p>
    <ol class="opts">${items}</ol>
    <div class="actions"><button type="button" class="btn quiet" data-act="back">${t('戻る', 'Back')}</button></div>`;
}
function panelCaravan() {
  const pv = preview();
  const inputs = state.cargo.map((x, r) => (VAULT.have[r] ? `<label class="sel">${resName(r)}（${t('最大', 'max')} ${n(VAULT.have[r])}） <input type="number" min="0" max="${VAULT.have[r]}" step="1" value="${x}" data-cargo="${r}" aria-label="${resName(r)}"></label>` : '')).join(' ');
  const over = state.cargo.some((x, r) => x > VAULT.have[r] || x < 0 || !Number.isInteger(x));
  const empty = state.cargo.every(x => x === 0);
  const blocks = [...(over ? [t('貯蔵庫にある量を超えています', 'More than the storehouse holds')] : []), ...(empty ? [t('運ぶものを入れてください', 'Put something in the cargo')] : []), ...(!pv.ok ? [pv.why === 'OnlyThroughPalisade' ? t('道は止められる柵の向こうにしかありません', 'The only road is through a palisade that stops you') : t('そこまで隊商の道が届きません', 'No caravan road reaches there')] : [])];
  const tt = pv.ok ? pv.turns.map((x, i) => `<li><strong>${i + 1}</strong>. ${t(`第${n(x.bell)}ターンの始め`, `start of turn ${n(x.bell)}`)}：${x.p},${x.q}・${x.tile} — ${x.known.length ? `<span class="tag loss">!</span> ${x.known.map(k => t(`${nationName(k.faction)}の軍勢 ${n(k.troops)} が見えています（ここにいれば襲われます）`, `${nationName(k.faction)} host of ${n(k.troops)} in sight (it raids if it stays)`)).join('、')}` : x.unknown ? `<span class="tag threat">?</span> ${t('見えていません（誰がいるか不明）', 'out of sight (unknown)')}` : x.sheltered ? t('守備隊のいるマス：他国の略奪は起きません', 'a garrisoned tile: no raid by another nation') : t('いま見えている軍勢はいません', 'no host in sight now')}${x.domestic?.length ? ` <span class="tag threat">${t('国内', 'domestic')}</span> ${x.domestic.map(k => t(`同じ国の別の村の軍勢 ${n(k.troops)}（国内の略奪がありえます）`, `a host of ${n(k.troops)} of another village of your nation (a domestic raid is possible)`)).join('、')}` : ''}</li>`).join('') : '';
  const sent = state.send;
  const status = !sent ? '' : sent.status === 'pending' ? `<p class="status" role="status">${t('送っています…（ボタンはもう一度押しても二重に送りません）', 'Sending… (pressing again does not send twice)')}</p>`
    : sent.status === 'failed' ? `<p class="status err" role="alert">${t('送れませんでした（試作の失敗シミュレーション：RPC が応答しません）。隊商は出発していません。積荷はそのままです。', 'Not sent (simulated failure: the RPC did not answer). No caravan left; the cargo is untouched.')} <button type="button" class="btn small" data-act="send">${t('もう一度送る', 'Send again')}</button></p>`
    : sent.status === 'awaiting' ? `<p class="status" role="status"><span class="tag plan">${t('予定', 'planned')}</span> ${t('送信済み。記録（CARAVAN_SENT）を待っています。到着の時刻はその記録で確定します。', 'Sent. Waiting for its record (CARAVAN_SENT): the arrival is fixed by that record.')}</p>`
    : `<p class="status ok" role="status"><span class="tag done">${t('確定', 'confirmed')}</span> ${t(`記録より：第${n(sent.departBell)}ターンに出発、到着は第${n(sent.arriveBell)}ターン、物見櫓による減りは ${sent.worn / 100}%。略奪されるかどうかは、まだ決まっていません。`, `From the record: left at turn ${n(sent.departBell)}, arrives at turn ${n(sent.arriveBell)}, worn ${sent.worn / 100}% by watchtowers. Whether it is raided is not decided yet.`)}</p>`;
  return `<h2 id="panel-title">${t(`隊商：${VAULT.label} → ハルデン`, `Caravan: ${VAULT.label} → Halden`)}</h2>
    <form id="caravan-form" onsubmit="return false"><fieldset ${sent && sent.status !== 'failed' ? 'disabled' : ''}><legend class="small muted">${t('積荷', 'Cargo')}</legend>${inputs}</fieldset></form>
    ${pv.ok ? `<h3>${t('送る前の見通し', 'Before you send')} <span class="tag plan">${t('予定', 'planned')}</span></h3>
      <dl class="kv"><dt>${t('道', 'Road')}</dt><dd>${t(`${n(pv.road.dirs.length)} マス`, `${n(pv.road.dirs.length)} tiles`)}${pv.avoided ? t('（戦争中の国の柵を避けた道。避けないとプログラムが送信を拒みます）', ' (round a palisade of a nation at war; through it the program refuses the send)') : ''}</dd>
      <dt>${t('かかる時間', 'Takes')}</dt><dd>${t(`ゲーム内 ${spanText(pv.travelSecs)}（実時間 約 ${spanText(pv.travelSecs / state.rate)}）`, `${spanText(pv.travelSecs, 'en')} of game time (about ${spanText(pv.travelSecs / state.rate, 'en')} real)`)}</dd>
      <dt>${t('到着', 'Arrives')}</dt><dd>${t(`第${n(pv.arrive.bell)}ターン`, `turn ${n(pv.arrive.bell)}`)}${pv.arrive.bellIfLate !== pv.arrive.bell ? t(`（送信が遅れると第${n(pv.arrive.bellIfLate)}ターン）`, ` (turn ${n(pv.arrive.bellIfLate)} if the send lands late)`) : ''}</dd>
      <dt>${t('物見櫓', 'Towers')}</dt><dd>${pv.wear.bps ? t(`戦争中の国の物見櫓のそばを ${spanText(pv.wear.secs)}歩き、積荷が ${pv.wear.bps / 100}% 減ります → 届くのは ${pv.wear.cargo.map((x, r) => (x ? `${resName(r)} ${n(x)}` : null)).filter(Boolean).join('・')}`, `${spanText(pv.wear.secs, 'en')} near towers of a nation at war: ${pv.wear.bps / 100}% worn → arrives ${pv.wear.cargo.map((x, r) => (x ? `${resName(r)} ${n(x)}` : null)).filter(Boolean).join(', ')}`) : t('減りません', 'no wear')}</dd></dl>
      <h3>${t('ターンの始めに立つマス（略奪はここで決まります）', 'Where it stands at each turn\'s start (raids are judged there)')}</h3><ol class="turns">${tt}</ol>
      <p class="small muted">${t('封をした進軍は着くまで見えません。見えていない土地の軍勢もわかりません。ここに出ない危険があります。', 'Sealed marches are not seen until they arrive, nor are hosts out of sight: there are dangers this does not show.')}</p>` : ''}
    ${blocks.length ? `<ul class="why">${blocks.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${status}
    <div class="actions"><button type="button" class="btn primary" data-act="send" ${blocks.length || (sent && sent.status !== 'failed') ? 'aria-disabled="true"' : ''}>${t('隊商を送る', 'Send the caravan')}</button><button type="button" class="btn" data-act="cancel">${sent && sent.status !== 'failed' ? t('閉じる', 'Close') : t('取り消す', 'Cancel')}</button></div>
    <div class="dev"><label><input type="checkbox" data-act="failnext" ${state.failNext ? 'checked' : ''}> ${t('次の送信を失敗させる（試作の点検用）', 'Make the next send fail (prototype check)')}</label></div>`;
}

// ---- the forecast check: the recorded keep clash, the page's builder against the program's
let K = null, FIX = null;
async function loadForecastBits() {
  if (K && FIX) return;
  const [w, f] = await Promise.all([fetch('../../../permutation-server/web/frontier/wasm/frontier-v3.wasm').then(r => r.arrayBuffer()), fetch('../../../permutation-gateway/test/fixtures/uxs1-keep-two-turns.json').then(r => r.json())]);
  K = new Kernel((await WebAssembly.instantiate(w, {})).instance.exports); FIX = f;
}
function panelForecast() {
  if (!K || !FIX) { loadForecastBits().then(render).catch(e => { state.fcError = String(e); render(); }); return `<h2 id="panel-title">${t('予測の点検', 'Forecast check')}</h2><p>${state.fcError ? esc(state.fcError) : t('ルールのモジュールを読み込んでいます…', 'Loading the rules module…')}</p>`; }
  const rec = FIX.records['619'], PB = fromBase64(rec.province_before_b64), PV = decode('Province', PB), CI = decode('ClashInputs', fromBase64(rec.inputs_b64));
  const A = CI.arrivals.find(a => a.present === 1);
  const c = { host: { id: String(A.hostId), unit: A.unit, troops: Math.floor(A.troops / 1000), staminaValue: A.stamina + 10, staminaBell: 619 }, dest: { p: PV.p, q: PV.q, tile: A.tile }, arriveBell: 619, stance: A.stance, retreat: 'never', ratio: null, route: { dirs: [] } };
  const page = forecast(K, c, PV, A.faction), bps = wearBps(state.wearSecs), model = modelForecast(K, c, PB, A.faction, { wornBps: bps });
  const range = f => (f.ok ? (f.troops.min === f.troops.max ? n(f.troops.min) : `${n(f.troops.min)}〜${n(f.troops.max)}`) : '—');
  return `<h2 id="panel-title">${t('予測の点検：砦への進軍', 'Forecast check: a march on a keep')}</h2>
    <p class="small">${t('記録された局所チェーンの州データ（uxs1・シーズン98・ターン619：500 の軍勢が守備兵 100 の砦へ）を、ページの予測と、プログラムと同じ組み立ての予測で比べます。チェーンが記録した結果は残り 488 でした。', 'A recorded local-chain province (uxs1, season 98, turn 619: a host of 500 on a keep of 100), forecast by the page and by the program\'s own clash model. The chain recorded 488 left.')}</p>
    <div class="vs"><div><strong>${t('いまのページ', 'Page today')}</strong><p>${t('残る兵', 'Left')} <strong>${range(page)}</strong></p><p class="small muted">${t('砦の守備兵、要塞、物見櫓の減りを数えていません', 'Counts no keep garrison, fort or tower wear')}</p></div>
    <div><strong>${t('プログラムと同じ組み立て', 'Program\'s model')}</strong><p>${t('残る兵', 'Left')} <strong>${range(model)}</strong></p><p class="small muted">${model.worn?.bps ? t(`物見櫓で ${model.worn.before} → ${model.worn.after}（${model.worn.bps / 100}%）`, `towers: ${model.worn.before} → ${model.worn.after} (${model.worn.bps / 100}%)`) : t('物見櫓の減りなし', 'no tower wear')}</p></div></div>
    <label class="sel">${t('道のうち、戦争中の物見櫓の見張りの中を歩く時間', 'Time the road spends inside an enemy tower\'s watch')} <input type="range" min="0" max="2400" step="60" value="${state.wearSecs}" data-act="wear" aria-valuetext="${spanText(state.wearSecs)}"> <span>${spanText(state.wearSecs)}（${bps / 100}%、${t('上限', 'cap')} ${TOWER_WEAR_CAP_BPS / 100}%）</span></label>
    <h3>${t('それでも数えられないもの', 'Still not counted')}</h3><ul class="why"><li>${t('封をされたほかの国の進軍（着くまで見えません）', 'Other nations\' sealed marches (unseen until they arrive)')}</li><li>${t('着くターンの守り手（いまの記録で計算しています）', 'The defenders at the arrival turn (computed from today\'s record)')}</li><li>${t('封が開くときに立っている物見櫓と柵（いま立っているもので計算）', 'The towers and palisades standing at the Reveal (computed from those standing now)')}</li></ul>
    <div class="actions"><button type="button" class="btn quiet" data-act="back">${t('戻る', 'Back')}</button></div>`;
}

function drawerAway() {
  const s = summary(), conf = confirmedSeq();
  const items = s.items.map(i => `<li class="${i.tone}"><span class="tag ${i.tone}">${t(...S.tone[i.tone])}</span> ${esc(RS.itemText(i, LANG))}${i.at ? ` <button type="button" class="btn small" data-act="goto" data-at="${i.at.p},${i.at.q},${i.at.tile ?? (i.at.p === 0 && i.at.q === 0 ? 30 : 30)}">${t('地図で見る', 'Show on map')}</button>` : ''}</li>`).join('');
  return `<button type="button" class="btn small close" data-act="close" aria-label="${t('閉じる', 'Close')}">×</button>
    <h2 id="drawer-title">${t('留守のあいだ', 'While you were away')}</h2>
    <p>${esc(RS.headText(s, LANG))}</p>
    <div class="marks"><div><strong>${t('読み込み済み', 'Read')}</strong>：${s.read.n ? t(`第${n(s.read.fromBell)}〜${n(s.read.toBell)}ターン（記録 ${n(s.read.n)} 件、番号 ${esc(s.read.after)} の次から）`, `turns ${n(s.read.fromBell)}–${n(s.read.toBell)} (${n(s.read.n)} records after #${esc(s.read.after)})`) : t('なし', 'none')}</div>
      <div><strong>${t('あなたが確認済み', 'You confirmed')}</strong>：${conf ? t(`記録 ${esc(conf)} まで`, `up to record ${esc(conf)}`) : t('この端末ではまだありません', 'nothing yet on this device')}</div></div>
    ${s.items.length ? `<ol class="items">${items}</ol>${s.more ? `<p class="small">${t(`ほか ${n(s.more)} 件は年代記にあります`, `${n(s.more)} more in the chronicle`)}</p>` : ''}` : `<p>${t('知らせることはありません。', 'Nothing to tell.')}</p>`}
    <p class="small muted">${t('記録にない損失は表示しません。量は記録が持つ数だけを書いています。', 'No loss is shown that no record logged; amounts are the records\' own.')}</p>
    <div class="actions"><button type="button" class="btn primary" data-act="confirm" ${s.items.length ? '' : 'aria-disabled="true"'}>${t('確認した', 'Mark as seen')}</button><button type="button" class="btn" data-act="close">${t('あとで（確認済みにしない）', 'Later (keep unconfirmed)')}</button></div>
    <div class="dev"><label>${t('点検用の場合', 'Check case')} <select data-act="scenario">${['normal', 'firstOnDevice', 'otherWallet', 'newSeason', 'gap'].map(x => `<option value="${x}" ${state.scenario === x ? 'selected' : ''}>${({ normal: t('ふつう', 'normal'), firstOnDevice: t('この端末で初めて／別の端末', 'first on this device / other device'), otherWallet: t('別のウォレット', 'another wallet'), newSeason: t('新しいシーズン', 'new season'), gap: t('履歴の欠け', 'a gap in history') })[x]}</option>`).join('')}</select></label>
      <button type="button" class="btn small quiet" data-act="reset">${t('確認の記録を消す', 'Forget the confirmed mark')}</button></div>`;
}
function drawerTerms() {
  const tt = times();
  const closed = seasonTimes(Wd.SEASON, { now: () => Wd.GENESIS + 1600 * 600, rate: state.rate });
  return `<button type="button" class="btn small close" data-act="close" aria-label="${t('閉じる', 'Close')}">×</button>
    <h2 id="drawer-title">${t('用語と締め切り', 'Terms and deadlines')}</h2>
    <p>${esc(turnText(tt, LANG))}</p><p>${esc(deadlineText(tt, LANG))}</p>
    <ul class="items">${s1Terms(tt).map(x => `<li><span>${esc(x[LANG])}</span></li>`).join('')}</ul>
    <h3>${t('押せない理由の例', 'Why a button is off: examples')}</h3>
    <ul class="why"><li>${esc(whyWrongStatus(closed, 'join', LANG))}</li><li>${esc(SIEGE_WORDS.SourceShielded[LANG])}</li><li>${esc(SIEGE_WORDS.SiegeBusy[LANG])}</li></ul>
    <p class="small muted">${t('期間と締め切りはシーズンの設定（終わりのターン・参加締め切りのターン・時計の速さ）から読んでいます。文中に固定の時間は書いていません。', 'Lengths and deadlines are read from the season (its end turn, its join-close turn, the clock\'s speed); no sentence carries a fixed time.')}</p>`;
}
function renderLegend() {
  const svg = (body, vb = '-14 -11 28 22') => `<svg viewBox="${vb}" aria-hidden="true">${body}</svg>`;
  const ter = [0, 1, 2, 3, 4, 5].map(i => `<li>${svg(`<rect x="-12" y="-9" width="24" height="18" fill="var(--t-${TERRAIN_NAME[i]})"/>${i ? `<rect x="-12" y="-9" width="24" height="18" fill="url(#lg-${TERRAIN_NAME[i]})"/>` : ''}`)}<span>${S.terrain[LANG][i]}${i === 2 || i === 3 ? t('（歩くのが遅い）', ' (slow)') : i >= 4 ? t('（通れない）', ' (impassable)') : ''}</span></li>`).join('');
  const nat = [0, 1, 2, 3, 4, 5].map(f => `<li>${svg(emblem(f, 0, 0, 7))}<span>${esc(nationName(f))}${f === Wd.ME.faction ? t('（あなた）', ' (you)') : ''}</span></li>`).join('');
  const things = [['village', t('村（屋根の数＝規模）', 'village (roofs = tier)'), 1], ['vault', t('貯蔵庫', 'storehouse')], ['tower', t('物見櫓', 'watchtower')], ['palisade', t('柵', 'palisade')], ['fort', t('要塞', 'fort')], ['host', t('軍勢（数＝兵）', 'host (number = troops)')]].map(([k, w, tier]) => `<li>${svg(glyph(k, 0, 0, 22, tier ?? 0))}<span>${w}</span></li>`).join('');
  const states = [['own', t('あなたのもの（二重の輪）', 'yours (double ring)')], ['war', t('戦争中の国（破線の輪）', 'a nation at war (dashed ring)')], ['pass', t('通行の国（点線の輪）', 'a nation at passage (dotted ring)')]].map(([k, w]) => `<li>${svg(`<circle r="9" class="st-${k}"/>${k === 'own' ? '<circle r="6.5" class="st-own2"/>' : ''}`)}<span>${w}</span></li>`).join('')
    + `<li>${svg('<rect x="-12" y="-9" width="24" height="18" fill="url(#lg-fog)"/>')}<span>${t('見えていない（斜線）', 'out of sight (hatched)')}</span></li><li>${svg('<g class="st-alert"><circle r="7"/><text y="4" text-anchor="middle">!</text></g>')}<span>${t('知らせがある', 'has news')}</span></li>`;
  $('legend').innerHTML = `<svg width="0" height="0" style="position:absolute"><defs>${['forest', 'hills', 'mountain', 'water', 'plains'].map(x => document.querySelector(`#pt-${x}`)?.outerHTML.replace(`id="pt-${x}"`, `id="lg-${x}"`) ?? '').join('')}${document.querySelector('#pt-fog')?.outerHTML.replace('id="pt-fog"', 'id="lg-fog"') ?? ''}</defs></svg>
    <strong>${t('地形', 'Terrain')}</strong><ul>${ter}</ul><strong>${t('国（色と形）', 'Nations (colour and shape)')}</strong><ul>${nat}</ul><strong>${t('建物と軍勢', 'Buildings and hosts')}</strong><ul>${things}</ul><strong>${t('状態', 'States')}</strong><ul>${states}</ul>`;
}

function render() {
  document.documentElement.lang = LANG;
  $('lang').textContent = ja() ? 'EN' : '日本語'; $('lang').setAttribute('aria-label', ja() ? 'English' : '日本語');
  $('keyhint').textContent = t('矢印キーでマスを移動（Shift で斜め上下）、Enter で選択、Esc で閉じる', 'Arrow keys move (Shift for the other diagonal), Enter selects, Esc closes');
  renderClock(); renderAlerts(); renderMapPane();
  const panel = $('panel');
  panel.innerHTML = state.panel === 'shortfall' ? panelShortfall() : state.panel === 'caravan' ? panelCaravan() : state.panel === 'forecast' ? panelForecast() : panelTile();
  const d = $('drawer');
  d.hidden = !state.drawer;
  if (state.drawer) d.innerHTML = state.drawer === 'away' ? drawerAway() : drawerTerms();
  if (!$('legend').hidden) renderLegend();
  const sel = $('goto');
  const places = [['0,0,30', t('ハルデン（あなたの村）', 'Halden (your village)')], ['1,0,30', t('北の貯蔵庫', 'North storehouse')], ['1,0,44', t('グラム砦町（ダンマール）', 'Gram (Dunmar)')], ['1,0,8', t('ダンマールの柵', 'Dunmar palisade')], ['1,0,13', t('ダンマールの物見櫓', 'Dunmar watchtower')], ['0,0,23', t('あなたの要塞', 'Your fort')]];
  sel.innerHTML = `<option value="">—</option>${places.map(([k, w]) => `<option value="${k}">${esc(w)}</option>`).join('')}`;
}

// ------------------------------------------------------------------ actions
function go(panel, push = true) { state.panel = panel; writeHash(push); render(); $('panel').focus({ preventScroll: true }); }
function select(key, push = true) {
  const [p, q, tile] = key.split(',').map(Number);
  state.sel = { p, q, tile }; state.focus = key;
  // (choosing another tile shows that tile; a caravan being composed keeps its cargo for when it is opened again)
  state.panel = 'tile';
  writeHash(push); render();
}
let sendSeq = 0;
async function send() {
  if (state.send && state.send.status !== 'failed') return; // a second press while one is under way sends nothing
  const pv = preview();
  if (!pv.ok || state.cargo.every(x => x === 0) || state.cargo.some((x, r) => x > VAULT.have[r])) return;
  const id = ++sendSeq;
  state.send = { status: 'pending', id }; render();
  await new Promise(r => setTimeout(r, 600));
  if (state.send?.id !== id) return; // cancelled meanwhile
  if (state.failNext) { state.failNext = false; state.send = { status: 'failed', id }; render(); return; }
  state.send = { status: 'awaiting', id }; render();
  await new Promise(r => setTimeout(r, 900));
  if (state.send?.id !== id) return;
  // the record decides: here the mock "CARAVAN_SENT" carries the preview's own arrival and wear
  state.send = { status: 'confirmed', id, departBell: Math.floor((nowTs() - Wd.GENESIS) / 600), arriveBell: pv.arrive.bell, worn: pv.wear.bps };
  render();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  const hex = e.target.closest('.hex');
  if (!b && hex) { select(hex.dataset.key); return; }
  if (!b) return;
  const act = b.dataset.act;
  if (b.getAttribute('aria-disabled') === 'true' && act !== 'close') { e.preventDefault(); return; }
  if (act === 'away' || act === 'terms') { e.preventDefault(); state.drawer = act; writeHash(); render(); $('drawer').querySelector('h2')?.focus?.(); $('drawer').querySelector('.close')?.focus(); }
  else if (act === 'close') { state.drawer = null; writeHash(); render(); }
  else if (act === 'confirm') { const s = summary(); const last = s.items.length ? Wd.RECORDS.at(-1) : null; if (last) { const m = RS.confirm(storage, { seasonId: '7', wallet: Wd.ME.wallet, toSeq: last.seq, toBell: Number(last.record.bell), at: nowTs() }); state.confirmError = !m; } state.scenario = 'normal'; state.drawer = null; writeHash(); render(); }
  else if (act === 'reset') { try { storage.removeItem(RS.storeKey('7', Wd.ME.wallet)); storage.removeItem('ws07-return:last'); } catch { /* nothing kept */ } render(); }
  else if (act === 'goto') { state.drawer = null; select(b.dataset.at); }
  else if (act === 'shortfall') go('shortfall');
  else if (act === 'caravan') { state.sel = { p: VAULT.p, q: VAULT.q, tile: VAULT.tile }; go('caravan'); }
  else if (act === 'forecast') { e.preventDefault(); go('forecast'); }
  else if (act === 'back') history.length > 1 ? history.back() : go('tile', false);
  else if (act === 'cancel') { state.send = null; state.cargo = [0, 600, 900, 0, 0, 0, 0, 0]; go('tile'); }
  else if (act === 'send') send();
  else if (act === 'legend') { const l = $('legend'); l.hidden = !l.hidden; b.setAttribute('aria-expanded', String(!l.hidden)); if (!l.hidden) renderLegend(); }
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'rate') { state.rate = Number(el.value); render(); }
  else if (el.id === 'goto' && el.value) { select(el.value); }
  else if (el.dataset.act === 'scenario') { state.scenario = el.value; render(); }
  else if (el.dataset.act === 'failnext') { state.failNext = el.checked; }
});
document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.cargo !== undefined) { const v = Number(el.value); state.cargo[Number(el.dataset.cargo)] = Number.isFinite(v) ? Math.trunc(v) : 0; const pos = el.selectionStart; render(); const again = document.querySelector(`[data-cargo="${el.dataset.cargo}"]`); again?.focus(); try { again?.setSelectionRange(pos, pos); } catch { /* number inputs */ } }
  else if (el.dataset.act === 'wear') { state.wearSecs = Number(el.value); render(); document.querySelector('[data-act="wear"]')?.focus(); }
});
$('lang').addEventListener('click', () => { LANG = ja() ? 'en' : 'ja'; setLang(LANG); try { storage.setItem('ws07-lang', LANG); } catch { /* not kept */ } render(); });
// the map's keyboard: arrows move the focus among the hexes, Enter selects, Esc closes a drawer or goes back
const KEYDIR = { ArrowRight: 0, ArrowLeft: 3, ArrowUp: 1, ArrowDown: 4 };
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (state.drawer) { state.drawer = null; writeHash(); render(); } else if (state.panel !== 'tile') go('tile'); return; }
  if (!e.target.closest?.('.map-host')) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(state.focus); return; }
  let d = KEYDIR[e.key];
  if (d === undefined) return;
  e.preventDefault();
  if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) d = e.key === 'ArrowUp' ? 2 : 5;
  const [p, q, tile] = state.focus.split(',').map(Number), h = tileHex(p, q, tile), [dq, dr] = DIRECTIONS[d];
  const at = locate(h.q + dq, h.r + dr), key = `${at.p},${at.q},${at.idx}`;
  if (!Wd.TERRAIN.has(`${at.p},${at.q}`)) return;
  state.focus = key; renderMapPane(); $('map').querySelector('svg')?.focus();
  $('keyhint').textContent = tileWords({ p: at.p, q: at.q, tile: at.idx });
});

// ------------------------------------------------------------------ start
setLang(LANG);
readHash();
if (!location.hash) { state.drawer = summary().items.length ? 'away' : null; writeHash(false); }
render();
