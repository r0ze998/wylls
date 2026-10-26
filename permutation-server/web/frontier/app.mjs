import { territoryEnabled, territoryOf } from './territory.mjs';
import { setS1, setOreExtraProvider } from './fs1.mjs';
import { s1Marks } from './map/s1marks.mjs';
import * as territoryScreen from './screens/territory.mjs';
import * as conquestScreen from './screens/conquest.mjs';
import { conquestEnabled, kernelFile, outpostOffer } from './fconquest.mjs';
// Boot of the Frontier pages (index, practice, spectate): config → the
// herald's season record → pins (program, cluster, season, ruleset,
// beacon) → the chain clock → the shell (bell chip, staleness banner,
// language toggle) → the map. On the game page (W3-F) the play screens
// follow: the faction and quota chips, the bottom tabs and the panel of
// each tab (join and sites, holding, hosts and explore, the march composer
// with the tracker and incoming warnings, the bell sheet and chronicle),
// driven by controller.mjs. Wave 4 (W4-E) routes the clash report with
// "verify in this browser", practice mode (its own page and, on the game
// page, the "what if" of a report), the onboarding card, and the spectator
// page; their logic is in screens/{report,practice,onboarding,spectate}.mjs
// and onboarding.mjs, the actions below only move state and call them.
import { config } from './config.mjs';
import { FS, invalidate, registerRenderers } from './fstate.mjs';
import { createHerald, nextPoll, staleness } from './herald.mjs';
import { setPin, setRelay } from './fchainio.mjs';
import { checkBeacon } from './seal.mjs';
import { ChainClock, bellChip, countdown, seasonClock, bellStart, pollCap } from './clock.mjs';
import { effectiveStatus } from './fcodec.mjs';
import { FrontierMap } from './map/fmap.mjs';
import { openHint, heroZoom } from './map/opening.mjs';
import { createSurveyor } from './map/survey.mjs';
import { surveyInput } from './map/viewer.mjs';
import { fxNow } from './map/chart.mjs';   // (milliseconds on the effects clock)
import { reducedMotion } from './map/camera.mjs';
import { renderSurveyHelp } from './map/legend.mjs';
import { NOTE_TEXT, createActions, actorsAt } from './map/actions.mjs';
import * as hand from './hud/hand.mjs';
import * as turnlist from './hud/turnlist.mjs';
import { createCamKeep } from './hud/camkeep.mjs';
import { settled } from './hud/rulebook.mjs';
import * as dialcard from './hud/dialcard.mjs';
import { paintVillagePics } from './map/village.mjs';
import { createLandingBook, landedKey } from './map/landing.mjs';
import { setBoardCharacters, landingAge } from './people/onboard.mjs';
import { placeName, villageLine } from './map/names.mjs';
import { lastWalletName } from '../wallet.mjs';
import { SEASON_STATUS_TEXT, clientText, factionName, TIERS, BUILDINGS, FATES, unitCount } from './fi18n.mjs';
import { L, fmtNum, mountLangToggle, onLangChange, lang } from '../lang.mjs';
import { toHex } from '../sdk/bytes.mjs';
import { html, setHtml } from '../util.mjs';
import { ACTIONS, FORMS, bind, startPlay, wantProvince, wantKeepHistory, wantKeepReach, wantHostReach, refreshConquest, refreshPrize, ackHomeGrant, tolled, syncProto, wantPreview, wantPlaces, composeTick } from './controller.mjs';
import { mountProtoBoard } from './proto/board-mount.mjs';
import { mountKeepBoard, keepReachOf } from './map/keepmount.mjs';
import { provinceName as placeProvinceName } from './hud/place.mjs';
// the prototype rule "banners" (a design tried in the sample world: hud/proto.mjs, proto/hand-model.mjs)
import * as protoHud from './hud/proto.mjs';
import * as pm from './proto/hand-model.mjs';
import { renderTabs, factionChip, quotaChip, mountSheet, PHONE_MAX, row, lamports, setClockPace } from './screens/shell.mjs';
import { cardHead, fold, label } from './screens/parts.mjs';
import { drawerOf, closeDrawer, drawerTitle, holdsLand, viewerState, LIFTS, DRAWER_ICON, WIDE, STAGE, settleRows, releaseRows } from './hud/drawer.mjs';
import { icon, iconizeMapTools } from './hud/icons.mjs';
import { hudInsets, noGoRects, CARDS_OVER_BOARD } from './hud/insets.mjs';
import { mountTextures } from './hud/textures.mjs';
import { createTerrain } from './map/terrain.mjs';
import { provincePixel } from './map/layers.mjs';
import { startFx, motion as fxMotion, on as fxOn } from './fx/index.mjs';
import { audio as fxAudio } from './fx/audio.mjs';
import { emit as fxEmit } from './fx/bus.mjs';
import * as keephand from './hud/keephand.mjs';
import * as provstrip from './hud/provstrip.mjs';
import './fx/sheetfx.mjs';   // [uxs-art] the handover pack's sprite-sheet effects: they hang themselves on the effects bus (conquest seasons only)

// Sprite art is on by default (?art=0 turns it off); ?art=1 adds the preview helpers below.
const ART_ON = new URLSearchParams(globalThis.location?.search ?? '').get('art') !== '0';
const ART_PREVIEW = new URLSearchParams(globalThis.location?.search ?? '').get('art') === '1';
// ?art=1&roads=1 adds sample roads between sites where the account has none (presentation only).
const ART_ROADS = ART_PREVIEW && new URLSearchParams(globalThis.location?.search ?? '').get('roads') === '1';
/**
 * Art mode: the ClashInputs of each province's last resolved clash (its /h/clash report), loaded once:
 * the resolve summary's bell, else the three bells before the envelope's.
 */
const artClash = new Map();
function artClashOf(p, q) {
  const env = FS.provinces.get(`${p},${q}`);
  if (!env || !heraldRef) return null;
  const key = `${p},${q}`;
  const rb = env.province?.resolveSummary?.bell;
  // (kept per province and resolved bell: once loaded, the report of an earlier clash stayed for good, so the marks of
  // a clash that resolved while the page was open never showed; seen on the live fixture's turn)
  const have = artClash.get(key);
  if (have && have.bell === (rb ?? 0)) return have.inputs;
  const rec = { bell: rb ?? 0, inputs: null };
  artClash.set(key, rec);
  const bells = rb ? [rb] : ART_PREVIEW ? [env.bell - 1, env.bell - 2, env.bell - 3].filter(b => b > 0) : [];
  (async () => {
    for (const b of bells) {
      const r = await heraldRef.clash(p, q, b).catch(() => null);
      if (r?.ok && r.inputs) { if (artClash.get(key) === rec) { rec.inputs = r.inputs; mapRef?.invalidate(); } return; }
    }
  })();
  return null;
}
// ?art=1&ringopen=1 replays the ring-open moment on the outermost open ring; &engine=N previews an Engine stage (presentation only).
const ART_Q = new URLSearchParams(globalThis.location?.search ?? '');
const ART_RINGOPEN = ART_PREVIEW && ART_Q.get('ringopen') === '1';
// ?art=1&relics=1 places sample Relic Sites and Waystones (M3 features, no accounts in M1; presentation only).
const ART_RELICS = ART_PREVIEW && ART_Q.get('relics') === '1';
// ?art=1&rivers=1 draws sample rivers (no river data in the Frontier; presentation only).
const ART_RIVERS = ART_PREVIEW && ART_Q.get('rivers') === '1';
// ?art=1&ally=0-1,2-4 shows those faction pairs as allied (presentation only; real relations come from the Province).
const ART_ALLY = ART_PREVIEW ? (ART_Q.get('ally') ?? '').split(',').map(x => x.split('-').map(Number)).filter(x => x.length === 2 && x.every(Number.isInteger)) : [];
const ART_ENGINE = ART_PREVIEW ? Math.max(0, Math.min(5, Number(ART_Q.get('engine') ?? 0) | 0)) : 0;
import * as joinScreen from './screens/join.mjs';
import * as prizeScreen from './screens/prize.mjs';
import * as holdingScreen from './screens/holding.mjs';
import * as hostScreen from './screens/host.mjs';
import * as exploreScreen from './screens/explore.mjs';
import * as marchScreen from './screens/march.mjs';
import * as trackerScreen from './screens/tracker.mjs';
import * as incomingScreen from './screens/incoming.mjs';
import * as bellScreen from './screens/bell.mjs';
import * as chronicleScreen from './screens/chronicle.mjs';
import * as reportScreen from './screens/report.mjs';
import * as practiceScreen from './screens/practice.mjs';
import * as onboardingCard from './screens/onboarding.mjs';
import * as spectateScreen from './screens/spectate.mjs';
import { FLAG, withFlag, restoreFlags } from './onboarding.mjs';
import { useHerald, refresh as refreshPlay } from './controller.mjs';
import { kernel as loadKernel } from './wasm.mjs';
import { scope } from './fchainio.mjs';
import { hostParts } from './faddr.mjs';
import { RETREAT_CHOICES, retreatBps, DEPART_STAMINA, departMargin, planRoute, earliestBell, arrivalWindow, marchCosts } from './fmarch.mjs';
import { MAX_PATH_STEPS } from './seal.mjs';
import { uiKey, uiStorage, loadUi, saveUi, UI_PREFIX } from './fui.mjs';
import * as hud from './hud/hud.mjs';
import * as inspect from './hud/inspect.mjs';
import * as feed from './hud/feed.mjs';
import * as status from './hud/status.mjs';
import * as title from './intro/title.mjs';
import { mountTitleScene } from './intro/scene.mjs';
import * as marchCard from './hud/marchcard.mjs';
import * as minimap from './hud/minimap.mjs';
import * as search from './hud/search.mjs';
import { createRoster } from './people/roster.mjs';
import * as scene from './people/scene.mjs';
import { activityText } from './people/activity.mjs';
import { hostOwner, provinceFactions, renderNameForm, ownTag, holdingName } from './people/ui.mjs';
import * as profile from './people/profile.mjs';
import * as glossary from './hud/glossary.mjs';
import * as milestones from './hud/milestones.mjs';
import * as guide from './hud/guide.mjs';
import { forecast, forecastKey, compareStances, compareKey } from './hud/forecast.mjs';
import { keepForecast, forecastFor } from './hud/forecastbook.mjs';
import { mountRadioKeys } from './hud/radiokeys.mjs';
import { BUILD_ITEMS, UNIT_ORDER, SCOUT, SETTLER, ticketTimes, queueItem, queueBuildingItem } from './fland.mjs';
import { UNIT_KINDS } from './people/units.mjs';
import { momentSnapshot, detectMoments, liveMoments } from './people/moments.mjs';
import * as pins from './hud/pins.mjs';
import { battleScene, startBattle, battleLive, BATTLE_SPEEDS, PHASE } from './people/battle.mjs';
import { decode as decodeAccount } from './fcodec.mjs';
import { fromBase64 } from '../sdk/bytes.mjs';
import { tileHex, ringProvinces, wedgeOf } from './fgeo.mjs';
import { project, RADIUS } from '../map.mjs';
import { identityOf, displayName, withProfile, tagKey } from './people/identity.mjs';
import { lifeAt, lordLine } from './people/life.mjs';
import { instantHomeEnabled, homeSites, sameHome } from './home.mjs';

const $ = id => globalThis.document?.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };

/**
 * The turn dial's text in one line: "ターン 1,034 · 残り 6:12" / "Turn 1,034 · 6:12 left".
 * The HUD clock counts turns (UX design section 6); the bell is the thing in the world
 * that tolls when a turn ends, and the mechanics copy keeps that word.
 */
export function chipText(chip) {
  if (!chip || (chip.bell === null && !chip.beforeGenesis)) return L`ターン —`;
  if (chip.beforeGenesis) return L`開始まで ${countdown(chip.secondsLeft)}`;
  if (chip.ended) return L`ターン ${fmtNum(chip.bell)} · 終了`;
  return L`ターン ${fmtNum(chip.bell)} · 残り ${countdown(chip.secondsLeft)}`;
}

/** The dial's three places: the small label, the large figure, the line under it. */
export function dialParts(chip) {
  if (!chip || (chip.bell === null && !chip.beforeGenesis)) return { label: L`ターン`, num: '—', left: '' };
  if (chip.beforeGenesis) return { label: L`開始まで`, num: countdown(chip.secondsLeft), left: '' };
  return { label: L`ターン`, num: fmtNum(chip.bell), left: chip.ended ? L`終了` : countdown(chip.secondsLeft) };
}

/**
 * The dial's markup: the parts of `dialParts` cut out of the one-line text in order; what lies
 * between them stays in the page for a screen reader (visually hidden), so the element's text
 * is exactly `chipText`.
 */
export function dialMarkup(chip) {
  const parts = dialParts(chip);
  let rest = chipText(chip);
  const out = [];
  // (the word that says the time is what is LEFT, 「残り」 / "left", stands beside the time, small: 「9:26」 alone read as
  // time gone as well as time left: the design review of 2026-10-24. The rest of the glue stays for a screen reader)
  const glue = (seg, nextToLeft) => {
    const word = nextToLeft ? seg.replace(/[·\s]+/g, ' ').trim() : '';
    if (!word) { out.push(html`<span class="visually-hidden">${seg}</span>`); return; }
    const at = seg.indexOf(word);
    if (at > 0) out.push(html`<span class="visually-hidden">${seg.slice(0, at)}</span>`);
    out.push(html`<span class="dial-word">${word}</span>`);
    if (at + word.length < seg.length) out.push(html`<span class="visually-hidden">${seg.slice(at + word.length)}</span>`);
  };
  for (const [cls, text] of [['dial-label', parts.label], ['dial-num', parts.num], ['dial-left', parts.left]]) {
    const i = text ? rest.indexOf(text) : -1;
    if (i < 0) continue;
    if (i > 0) glue(rest.slice(0, i), cls === 'dial-left');
    out.push(html`<span class="${cls}">${text}</span>`);
    rest = rest.slice(i + text.length);
  }
  if (rest) glue(rest, !!parts.left && out.length > 0 && String(out[out.length - 1]).includes('dial-left'));
  return out;
}

function renderChip() {
  const now = FS.chain?.now() ?? null;
  const chip = $('bell-chip');
  if (chip) setHtmlIfChanged(chip, dialMarkup(FS.clock ? bellChip(FS.clock, now) : null));
  renderHudTick(now);
  FS.stale = staleness({ latestUnix: FS.record?.latestUnix, chainNow: now, behind: FS.chain?.behind() ?? null });
  const banner = $('stale-banner');
  if (banner) {
    banner.hidden = !FS.stale.stale;
    if (FS.stale.stale) banner.textContent = L`表示が ${Math.round(FS.stale.behind)} 秒遅れています。最新の状態が必要な操作の前に再読み込みしてください。`;
  }
}

/**
 * The sample world's tag (UX design 14.5). The screenshot fixture's world that keeps going says what it is in its
 * season record (`sample`, a localnet record only: loadSeason): the page says so for as long as it is open, with how
 * fast that world's clock runs, so nothing on screen can be taken for a chain run. Absent on every real season.
 */
function renderSampleTag() {
  const el = $('sample-tag');
  if (!el) return;
  const sm = FS.sample ?? null;
  if (el.hidden !== !sm) el.hidden = !sm;
  if (!sm) return;
  const rate = Number(sm.rate) || 0, times = rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10;
  const pace = sm.paused || !(rate > 0) ? L`時計は止めてあります` : rate === 1 ? L`時計はそのまま` : L`時計 ${fmtNum(times)} 倍速`;
  const arrival = territoryEnabled(FS);
  const long = arrival ? L`領土ルールの開発版です。チェーンにはつないでいません。進行はこのサーバー内に保存され、再起動すると最初からになります。時間表示はゲーム内の時間です（${pace}）。` : L`見本の世界です。基本ゲームのルールで動きますが、チェーンにはつないでいません。画面の時間はこの世界の中の時間です（${pace}）。`;
  setHtmlIfChanged(el, html`${icon('info')}<span>${arrival ? L`領土ルールの開発版` : L`見本の世界`}</span><span class="sample-pace">${pace}</span>`);
  if (el.title !== long) { el.title = long; el.setAttribute('aria-label', long); }
}

function renderStatus() {
  renderSampleTag();
  renderProto();
  const s = FS.season;
  const status = s ? SEASON_STATUS_TEXT[effectiveStatus(s, FS.chain?.now() ?? 0)] : L`読み込み中…`;
  // the beacon's kind is a detail: "More → details" names it (detailsMarkup)
  setText('season-status', status);
  const err = $('error-line');
  if (err) { err.hidden = !FS.error; err.textContent = FS.error ? FS.error.text : ''; }
}

/** Whether a host or holding id is the viewer's (its province, site and generation are one of the viewer's holdings). */
export function mineOf(holdings) {
  return id => {
    const h = hostParts(id);
    return !!h && (holdings ?? []).some(o => o.p === h.p && o.q === h.q && o.site === h.site && o.gen === h.gen);
  };
}

/** The viewer's resolved clashes: marches whose arrival bell is resolved, and clashes in provinces of its holdings. */
export function myReports(FS) {
  const out = [];
  const add = x => { if (!out.some(y => y.p === x.p && y.q === x.q && y.bell === x.bell)) out.push({ ...x, mine: true }); };
  for (const m of FS.marches ?? []) {
    const bell = m.entry?.arriveBell ?? m.transit?.arriveBell;
    if (m.facts?.pipeline === 'resolved' && m.dest && Number.isInteger(bell)) add({ p: m.dest.p, q: m.dest.q, bell });
  }
  const own = FS.holdings ?? [];
  for (const c of reportScreen.clashesFrom(FS.chronicle ?? [], 24)) if (own.some(o => o.p === c.p && o.q === c.q)) add(c);
  return out.slice(0, 12);
}

/** The "more" drawer's settings card. */
function settingsMarkup(FS) {
  return html`<section class="vcard" aria-labelledby="more-title">${cardHead({ id: 'more-title', ic: 'compass', title: L`設定` })}
    <label class="choice"><input type="checkbox" data-act="autopan" ${FS.ui?.autoPan ? 'checked' : ''}>${L`自分に関わる戦いが決着したら、地図をそこへ動かして見せる`}</label>
    <div class="choice-row" role="group" aria-label="${L`ガイドの強さ`}"><span class="choice-k">${L`ガイドの強さ`}</span><span class="seg">${guide.GUIDE_LEVELS.map(v => html`<button type="button" class="seg-btn" data-act="guide-level" data-v="${v}" aria-pressed="${guide.guideLevel(FS) === v ? 'true' : 'false'}">${guide.GUIDE_TEXT[v]()}</button>`)}</span></div>
    <div class="choice-row" role="group" aria-label="${L`戦いの演出`}"><span class="choice-k">${L`戦いの演出`}</span><span class="seg">${['normal', 'fast', 'off'].map(v => html`<button type="button" class="seg-btn" data-act="battle-fx" data-v="${v}" aria-pressed="${(FS.ui?.battleFx ?? 'normal') === v ? 'true' : 'false'}">${BATTLE_FX_TEXT[v]()}</button>`)}</span></div>
    <div class="choice-row" role="group" aria-label="${L`動きの演出`}"><span class="choice-k">${L`動きの演出`}</span><span class="seg">${['full', 'reduced', 'off'].map(v => html`<button type="button" class="seg-btn" data-act="fx-level" data-v="${v}" aria-pressed="${(FS.ui?.effects ?? 'full') === v ? 'true' : 'false'}">${FX_LEVEL_TEXT[v]()}</button>`)}</span></div>
    <div class="choice-row" role="group" aria-label="${L`音`}"><span class="choice-k">${L`音`}</span><span class="seg">${['on', 'off'].map(v => html`<button type="button" class="seg-btn" data-act="fx-sound" data-v="${v}" aria-pressed="${(fxAudio().muted ? 'off' : 'on') === v ? 'true' : 'false'}">${v === 'on' ? L`オン` : L`オフ`}</button>`)}</span></div>
    ${onboardingCard.renderRestore(FS)}
    <div class="actions"><button type="button" class="btn" data-act="practice-open">${icon('swords')}${L`練習モードを開く`}</button><button type="button" class="btn" data-act="intro-open">${L`タイトルを見る`}</button></div>
    <p class="link-row"><a href="practice.html">${L`練習ページ`}</a> · <a href="spectate.html">${L`観戦ページ`}</a>${FS.agentWallet ? html` · <a href="agent.html" data-agent-link="1">${L`代理人のページ（テストUSDCで自動運転を任せる）`}</a>` : ''}</p></section>`;
}

/**
 * "More → details": what a player does not need on the play screen but may want to check — the
 * season's state and its beacon, the turn sheet (each turn's pipeline, the sponsored actions left),
 * how a turn's work gets done (the keepers), the rules module, what a march costs (the relay fronts
 * it), and the key kept on this device. The internal words (beacon, keeper, lamports, frontier.wasm)
 * live here and nowhere on the play screen (UX design 11.13).
 */
export function detailsMarkup(FS) {
  const s = FS.season;
  const status = s ? SEASON_STATUS_TEXT[effectiveStatus(s, FS.chain?.now() ?? 0)] : L`読み込み中…`;
  const tips = s ? marchScreen.composerChoices(FS).tips : [];
  const costs = tips.map(t => { try { return { text: t.text, ...marchCosts(s, t.lamports) }; } catch { return null; } }).filter(Boolean);
  return html`<section class="vcard vcard-folds" aria-label="${L`詳細`}">${fold('more-details', html`${icon('scroll')}${L`詳細`}<span class="fold-val">${status}</span>`, html`
    <dl class="facts">
      ${row(L`シーズン`, status)}
      ${FS.beacon?.kind ? row(L`乱数のビーコン`, FS.beacon.kind === 'test' ? L`テスト用ビーコン` : L`公開ビーコン（drand）`) : ''}
      ${row(L`ルールのモジュール`, FS.kernelError ? L`frontier.wasm を読み込めません（${FS.kernelError}）` : L`frontier.wasm（見込みの計算と報告の確かめに使います）`)}
      ${FS.land ? row(L`村の申し込みの預け金（いま要る額）`, lamports(FS.land.escrowNeeded ?? 0n)) : ''}
    </dl>
    ${bellScreen.render(FS, { bare: true })}
    <p class="muted">${L`封を開ける、衝突を決着させる、結果を届ける。こうした手続きは、ターンごとに自動の係（キーパー）が代わりに行います。チップはその報酬です。`}</p>
    <p class="muted">${L`いまの段階に賞金はありません。費用はテスト用の SOL で、ゲーム側（中継サーバー）が立て替えます（価値はありません）。`}</p>
    ${costs.length ? html`${label(L`進軍の費用（単位：ランポート）`)}<ul class="cost-list">${costs.map(c => html`<li><strong>${c.text}</strong><span>${L`チップ`} ${fmtNum(Number(c.tip))} · ${L`進軍の手数料（決着させた人へ）`} ${fmtNum(Number(c.marchFee))} · ${L`封の保証金（結果を受け取ると戻る）`} ${fmtNum(Number(c.sealBond))} · ${L`合計`} ${fmtNum(Number(c.total))}</span></li>`)}</ul>` : ''}
    <div class="actions"><button type="button" class="btn" data-act="forget">${L`この端末からこのシーズンの鍵を消す`}</button></div>`)}</section>`;
}

/** The rest of "More" as one card of folds: pins, the viewer's name, the season's timeline, the glossary. */
function moreFolds(FS) {
  const parts = [['more-pins', 'pin', L`ピン`, pins.renderPins(FS.pins ?? [], FS)], ['more-name', 'person', L`あなたの名前`, renderNameForm(FS)],
    ['more-timeline', 'hourglass', L`シーズンの年表`, milestones.renderTimeline(FS.mileRecord)], ['more-glossary', 'tome', L`用語集`, glossary.renderGlossary()]].filter(x => String(x[3] ?? '') !== '');
  return html`<section class="vcard vcard-folds" aria-label="${L`そのほか`}">${parts.map(([key, ic, title, body]) => fold(key, html`${icon(ic)}${title}`, body, { cls: 'fold-doc' }))}</section>`;
}

/**
 * What stands in the phone sheet while the drawer is closed: the village plate and the one "next
 * thing" under it (the peek shows these two); the to-do lines below, for a raised sheet. On desktop
 * the plate floats over the map (`aside#rail`), the next thing is the top strip's button and the
 * closed drawer is empty.
 */
export function restMarkup(FS) {
  // (without a village the plate carries its own one button: no second prompt beside it)
  return [hud.renderPlate(FS), holdsLand(FS) ? hud.renderNextRow(nextNow()) : '', hud.renderTodo(FS, { max: 8, open: true })];
}

/**
 * The drawer's content on the game page, for the one drawer state (hud/drawer.mjs `drawerOf`):
 * a report or a practice run takes it whole; then a dock press; then, on the map, the order
 * being composed, the selection, the guide's steps or the join flow.
 */
export function panelMarkup(FS, d = drawerOf(FS)) {
  if (FS.conquest) {
    const s = FS.selected, pv = s && FS.provinces.get(`${s.p},${s.q}`)?.province;
    const site = pv && Number.isInteger(s.idx) ? pv.sites.indexOf(s.idx) : -1;
    FS.conquest.outpost = site >= 0 ? outpostOffer(FS, { p: s.p, q: s.q, site }) : null;
    // the selected keep changed hands (the control snapshot is newer than the /h/keep record the panel holds): the record
    // is read again at once, so that the history shows the capture and its signature with the new holder (at most every 4 s)
    if (s) {
      const key = `${s.p},${s.q}`, h = FS.conquest.history?.get?.(key), k = FS.conquest.keeps?.get?.(key);
      if (h && k && Number.isInteger(h.holder) && Number.isInteger(k.holder) && h.holder !== k.holder && Date.now() - (keepStale.get(key) ?? 0) > 4000) {
        keepStale.set(key, Date.now()); h.asOf = -1;
        wantKeepHistory(s.p, s.q, () => invalidate('panel'));
      }
    }
    // the keeps the viewer's marches can reach: only while the list (the territory drawer) or a keep panel is on screen
    if (FS.mode === 'play' && (d?.kind === 'territory' || s)) wantKeepReach();
  }
  // the action's outcome is said at the map (hud/status.mjs, renderFeed), not in a box inside the drawer
  const parts = [];
  if (!d) return [...parts, ...restMarkup(FS)];
  if (d.kind === 'practice') return [...parts, practiceScreen.render(FS.practice, { kernelError: FS.practiceError ?? null, closable: true })];
  if (d.kind === 'report') return [...parts, reportScreen.render(FS, mineOf(FS.holdings), { ownerOf: reportOwner, forecastOf: (id, bell) => forecastFor(uiStorage, scope()?.seasonId, id, bell) })];
  if (d.kind === 'march' || d.kind === 'inspect') {
    // an order being written on the map is the one document in the drawer (hud/marchcard.mjs); else what is selected
    if (FS.compose) return [...parts, marchCard.render(FS)];
    // tiles picked on the map for a Scout's exploration (map/actions.mjs): the explore card stands with the map too
    if (FS.explore?.host && FS.mode === 'play') return [...parts, exploreScreen.render(FS)];
    if (FS.selected) parts.push(inspect.render(FS, terrainRef, mapRef?.art?.activities ?? null), protoLandCard());
    return parts;
  }
  if (d.kind === 'guide') return [...parts, protoHud.guideCard(FS), onboardingCard.render(FS, { open: true }), FS.land?.stage === 'provisional' ? joinScreen.render(FS) : ''];
  // the first minute: the six banners, the wait for the village (with the guide's steps on demand under it), or what must be mended
  if (d.kind === 'home') return [...parts, joinScreen.render(FS)];
  if (d.kind === 'territory') return [...parts, ...(territoryEnabled(FS) ? [territoryScreen.render(FS)] : [conquestScreen.render(FS), prizeScreen.render(FS)])];
  if (d.kind === 'nation') return [...parts, joinScreen.render(FS)];
  if (d.kind === 'wait' || d.kind === 'join') return [...parts, joinScreen.render(FS)];
  // a dock tab keeps one line of the selection (the inspector itself opens from the map)
  if (FS.selected) parts.push(inspect.renderBrief(FS, terrainRef));
  if (d.kind === 'holding') parts.push(holdingScreen.render(FS));
  else if (d.kind === 'hosts') parts.push(hostScreen.render(FS), exploreScreen.render(FS));
  else if (d.kind === 'marches') {
    // a warning of arrivals stands first; with none, its quiet line closes the screen
    const warned = (FS.incoming ?? []).length > 0;
    parts.push(warned ? incomingScreen.render(FS) : '', marchScreen.render(FS), trackerScreen.render(FS), reportScreen.renderLinks(myReports(FS), L`あなたの衝突の報告`, { FS }), warned ? '' : incomingScreen.render(FS));
  }
  else parts.push(feed.renderCentre(FS.feed ?? [], FS.feedFilter ?? 'all'), chronicleScreen.render(FS), reportScreen.renderLinks(reportScreen.clashesFrom(FS.chronicle ?? []), L`最近の衝突`, { FS }),
    settingsMarkup(FS), ...surveyHelpWithProto(), moreFolds(FS), detailsMarkup(FS));
  return parts;
}

/**
 * The legend, with the prototype's one entry (hud/proto.mjs) while the prototype is on, unless the map's own legend
 * already carries a section for it (map/legend.mjs, the board track's: the entry is then said once, there).
 */
function surveyHelpWithProto() {
  const help = renderSurveyHelp();
  if (!FS.proto || [help].flat(Infinity).map(String).join('').includes('proto-legend')) return [help];
  return [help, protoHud.legend(FS)];
}

/** The panel of the practice and spectator pages. */
export function modePanel(FS) {
  if (FS.mode === 'practice') return [practiceScreen.render(FS.practice, { kernelError: FS.practiceError ?? null })];
  return [FS.selected ? inspect.render(FS, terrainRef, mapRef?.art?.activities ?? null) : '', spectateScreen.render(FS, { ownerOf: reportOwner, standings: hud.renderStandingsList(FS) }), FS.report ? '' : pins.renderPins(FS.pins ?? [], FS)];
}

/**
 * Re-render a panel without losing what the player was doing: the values
 * typed into its forms (inputs whose value differs from the markup's), the
 * choices made in them (a picture chosen from a row of radio buttons, an
 * option of a list), the folds opened (`details[data-fold]`), the focused
 * control (a field, or the same button again) and the scroll position come
 * back after the new markup. `scroller` null: a different view, which starts
 * from its own markup (only typed values are carried).
 */
export function keepState(el, render, scroller = el) {
  if (!el?.querySelectorAll) { render(); return; }
  const keyOf = x => { const f = x.closest('form[data-form]')?.dataset.form ?? x.closest('[data-bind]')?.dataset.bind ?? ''; return `${f}|${x.name || x.dataset.bind || x.id}`; };
  // a button, a summary or a link is found again by what it does: its action and data, then its place among its like
  const actOf = x => `${x.tagName}|${x.dataset?.act ?? ''}|${JSON.stringify({ ...x.dataset })}|${x.closest('[data-fold]')?.dataset.fold ?? ''}`;
  const nthOf = x => [...el.querySelectorAll(x.tagName)].filter(y => actOf(y) === actOf(x)).indexOf(x);
  const typed = new Map(), picked = new Map(), folds = new Map();
  for (const x of el.querySelectorAll('input, select, textarea')) {
    // a control bound to the store (data-bind, data-act) is the store's to restore
    if (x.type === 'checkbox') continue;
    if (x.type === 'radio') { if (x.checked && !x.defaultChecked && !x.dataset.bind && !x.dataset.act) picked.set(keyOf(x), x.value); continue; }
    if (x.tagName === 'SELECT') { if (!x.dataset.bind && x.value !== ([...x.options].find(o => o.defaultSelected) ?? x.options[0])?.value) picked.set(keyOf(x), x.value); continue; }
    if (x.value !== (x.defaultValue ?? x.value)) typed.set(keyOf(x), x.value);
  }
  if (scroller) for (const d of el.querySelectorAll('details[data-fold]')) folds.set(d.dataset.fold, d.open);
  const active = globalThis.document?.activeElement;
  const inside = !!active && el.contains(active);
  const focusKey = inside && active.matches?.('input, select, textarea') ? keyOf(active) : null;
  const focusAct = inside && !focusKey && scroller && active.matches?.('button, summary, a') ? { key: actOf(active), nth: nthOf(active), tag: active.tagName } : null;
  const top = scroller?.scrollTop ?? 0;
  // a part that scrolls by itself (the order's body above its seal: `data-scroll`) keeps its place too
  const inner = scroller ? new Map([...el.querySelectorAll('[data-scroll]')].map(x => [x.dataset.scroll, x.scrollTop])) : new Map();
  render();
  if (typed.size || picked.size || focusKey) for (const x of el.querySelectorAll('input, select, textarea')) {
    const k = keyOf(x);
    if (x.type === 'radio') { if (picked.get(k) === x.value) x.checked = true; }
    else if (x.tagName === 'SELECT') { if (picked.has(k) && [...x.options].some(o => o.value === picked.get(k))) x.value = picked.get(k); }
    else if (typed.has(k) && x.type !== 'checkbox') x.value = typed.get(k);
    if (k === focusKey && (x.type !== 'radio' || x.checked)) x.focus({ preventScroll: true });
  }
  for (const d of folds.size ? el.querySelectorAll('details[data-fold]') : []) { const was = folds.get(d.dataset.fold); if (was !== undefined && d.open !== was) d.open = was; }
  if (focusAct && !el.contains(globalThis.document?.activeElement)) [...el.querySelectorAll(focusAct.tag)].filter(y => actOf(y) === focusAct.key)[Math.max(0, focusAct.nth)]?.focus?.({ preventScroll: true });
  if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
  for (const x of inner.size ? el.querySelectorAll('[data-scroll]') : []) { const y = inner.get(x.dataset.scroll); if (y && x.scrollTop !== y) x.scrollTop = y; }
}

// ------------------------------------------------------------------ the drawer (hud/drawer.mjs)
let settleAt = null;
function settleSoon() {
  if (settleAt !== null || !globalThis.requestAnimationFrame) return;
  settleAt = globalThis.requestAnimationFrame(() => { settleAt = null; try { settleRows(); paintVillagePics(); } catch { /* a page without the drawer */ } });
}
globalThis.addEventListener?.('resize', settleSoon);
/** The phone sheet (screens/shell.mjs `mountSheet`): `{set, state}` or null. */
let sheetRef = null;
const phone = () => !!globalThis.matchMedia?.(`(max-width: ${PHONE_MAX}px)`).matches;
// (one answer for everything that moves: fx/motion.mjs, the system's setting and the player's own)
const calm = () => fxMotion() !== 'full';
let drawerKind;            // the kind applied last (undefined before the first render)
let drawerClear = null;    // the timer that empties a closed drawer after it has slid away
/** Where the camera was before a drawer or a battle took it (hud/camkeep.mjs). */
const camKeep = createCamKeep(() => mapRef);
/**
 * Apply the drawer state to the page: `data-drawer` (open | closed) and `data-kind` on the
 * panel and the body at once (state is synchronous; the slide is CSS on the stable panel
 * element, never on its re-rendered content), and the phone sheet's height when the state
 * changes: closed rests at the peek, a panel that opens lifts it to half.
 */
function applyDrawer(d) {
  const panel = $('panel'), body = globalThis.document?.body;
  const state = d ? 'open' : 'closed', kind = d?.kind ?? '';
  // a document over the map (the report, a practice battle) is wide and centred, not the side drawer
  const doc = d && WIDE.has(d.kind) ? 'wide' : d && STAGE.has(d.kind) ? 'stage' : '';
  for (const el of [panel, body]) {
    if (!el?.dataset) continue;
    if (el.dataset.drawer !== state) el.dataset.drawer = state;
    if ((el.dataset.kind ?? '') !== kind) el.dataset.kind = kind;
    if (el.dataset.doc !== doc) el.dataset.doc = doc;
  }
  if (kind === drawerKind) return false;
  // the camera comes back when the drawer closes (hud/camkeep.mjs): where it was when the drawer opened, unless the
  // player moved it in between. (An order card is not a drawer in this sense: its route frames the picture on purpose.)
  if (kind && !drawerKind && kind !== 'march') camKeep.keep('drawer');
  else if (!kind && drawerKind !== undefined) { if (drawerKind === 'march' || FS.departed?.fresh) camKeep.drop('drawer'); else camKeep.back('drawer', { ms: calm() ? 0 : 260 }); }
  if (FS.departed) FS.departed.fresh = false;
  drawerKind = kind;
  // what the drawer covers changes while it slides: the map frames its subject again (a camera nobody moved follows)
  for (const ms of [0, 130, 260, 420]) setTimeout(() => { mapRef?.tick(); if (ms >= 260) publishNoGo(); }, ms);
  if (sheetRef && phone()) {
    if (!d) sheetRef.set('peek');
    else if (LIFTS.has(d.kind) && sheetRef.state() === 'peek') sheetRef.set('half');
  }
  return true;
}

let lastPanelView = null;
/** Write the drawer: its state, title and body (the same view keeps its scroll and typed values). */
function renderDrawer(markupOf) {
  const d = drawerOf(FS);
  applyDrawer(d);
  const body = $('panel-body');
  const view = `${d?.kind ?? ''}|${FS.mode}`;
  const same = view === lastPanelView;
  lastPanelView = view;
  clearTimeout(drawerClear); drawerClear = null;
  if (body) {
    const scroller = phone() ? $('panel') : body;
    if (d || phone()) keepState(body, () => setHtml(body, markupOf(d)), same ? scroller : null);
    // desktop, closed: the content leaves once the drawer has slid away (at once without motion)
    else if (calm()) setHtml(body, '');
    else drawerClear = setTimeout(() => { if (!drawerOf(FS)) { setHtml(body, ''); setText('panel-title', drawerTitle(null)); } }, 200);
    if (!same && scroller) scroller.scrollTop = 0;
  }
  // (a part of the drawer that scrolls above a foot rests on a whole row: after this picture is laid out)
  settleSoon();
  // (desktop, closed: the title leaves with the content, not before it — the head read 「地図」 over the order card's body for
  // the fifth of a second the drawer takes to slide away; the English recording of 2026-10-11)
  if (d || phone() || calm()) setText('panel-title', drawerTitle(d));
  const mark = $('panel-ic');
  if (mark && d) setHtmlIfChanged(mark, icon(DRAWER_ICON[d.kind] ?? 'chart'));
  return d;
}

function renderPlay() {
  // (the stage mark of the page follows the same answer as the plate, in the same render: never a village's plate over a waiting dock)
  renderChips();
  const d = renderDrawer(dd => panelMarkup(FS, dd));
  focusHome();
  const tabs = $('tabs');
  // what the map itself opens (a selection, an order, the guide, the join flow) leaves "Map" current; a report or a run, none
  if (tabs) setHtml(tabs, renderTabs(FS, !d || ['inspect', 'march', 'guide', 'join', 'nation', 'wait'].includes(d.kind) ? 'map' : d.kind));
  renderRail();
  renderHand();
  renderMinimap();
  // the header follows new data at once, not only on the next one-second tick
  renderHudTick(FS.chain?.now() ?? null);
}

function renderMode() {
  renderDrawer(() => modePanel(FS));
  renderRail();
  renderMinimap();
  renderFeed();
}

// ------------------------------------------------------------------ the HUD (hud/hud.mjs)
let mapRef = null;
let terrainRef = null;
/** Who holds each site (people/roster.mjs): names and faces for tags, the rail, the inspector, reports. */
let rosterRef = null;
/** The viewer's survey (map/survey.mjs), kept on the page state for every surface that asks what may be told. */
const surveyor = createSurveyor({ now: fxNow });
let surveyDeps = [], revealTold = -Infinity;
function surveyNow() {
  // asked every frame: the anchors are read again only when something they are read from was replaced
  const deps = [FS.mode, FS.record, FS.wallet, FS.citizen, FS.land, FS.holdings, FS.chronicle, FS.marches, FS.activeHolding, FS.nowBell, viewerKnown, terrainRef?.status?.(), ...FS.provinces.values()];
  if (FS.survey && deps.length === surveyDeps.length && deps.every((x, i) => x === surveyDeps[i])) return FS.survey;
  surveyDeps = deps;
  FS.survey = surveyor(surveyInput(FS, { terrainOf: terrainRef, ready: viewerKnown || !!FS.land, scope: scope() || null }));
  // land that comes out of the chart now is told once on the effects bus (a shimmer: fx/stage.mjs)
  let newest = -Infinity;
  for (const t0 of FS.survey.reveals?.values?.() ?? []) if (t0 > newest) newest = t0;
  // (it is called a survey only for a viewer whose people see land: a village's or a host's sight, an exploration.
  // The candidate sites of the wait come into the picture without words: nobody surveyed them)
  if (newest > revealTold) { revealTold = newest; fxEmit('reveal', { n: FS.survey.reveals.size, words: (FS.holdings ?? []).length > 0 }); }
  return FS.survey;
}
/** The face and name of a report row's owner (a host id; holdings' ids give none). */
const reportOwner = id => { try { return hostOwner(rosterRef, id); } catch { return null; } };
/** The people layer's inputs, rebuilt at most once a second (the chronicle changes on polls only). */
/**
 * Who stands on the board (people/onboard.mjs; UX design 13.2: the six are the players): the viewer's character
 * beside the viewer's active village, and another player's beside that player's village while it is selected (what
 * the inspector says of the selection, so only a village the viewer has surveyed). `pending`: the village's landing
 * has been reported and has not begun on the map yet (the character walks in with it).
 */
let otherCharacter = { key: '', value: null };
export function boardCharactersNow() {
  if (FS.mode !== 'play') return [];
  const out = [], f = FS.citizen?.faction, h = hud.activeHolding(FS);
  if (Number.isInteger(f) && h && Number.isInteger(h.tile)) {
    const key = `${h.p},${h.q},${h.tile}`;
    out.push({ p: h.p, q: h.q, tile: h.tile, faction: f, own: true, tier: Number(h.tier ?? 0), pending: landingAge(key) === null && (landingSoon() === key || landingNow()?.key === key) });
  }
  const s = FS.selected;
  if (s && Number.isInteger(s.p) && Number.isInteger(s.idx)) {
    const key = `${s.p},${s.q},${s.idx}|${Math.floor(Date.now() / 1000)}`;
    if (otherCharacter.key !== key) {
      let site = null;
      try { site = inspect.inspectModel(FS, terrainRef)?.tile?.site ?? null; } catch { site = null; }
      otherCharacter = { key, value: site && site.state === 'holding' && !site.mine && Number.isInteger(site.faction) && site.faction >= 0 && site.faction < 6 ? { p: s.p, q: s.q, tile: s.idx, faction: site.faction, own: false, tier: Number(site.tier ?? 1) } : null };
    }
    if (otherCharacter.value) out.push(otherCharacter.value);
  }
  return out;
}

let peopleCache = { at: -1, value: null };
export function peopleSource() {
  // (every frame, outside the second's cache: a selection shows its village's character at once)
  setBoardCharacters(boardCharactersNow());
  const bell = FS.nowBell ?? (FS.clock ? Math.max(0, Math.floor(((FS.chain?.now() ?? 0) - FS.clock.genesisTs) / 600)) : 0);
  const sec = Math.floor(Date.now() / 1000);
  if (peopleCache.at === sec && peopleCache.lang === lang() && peopleCache.value) { peopleCache.value.battles = (FS.battles ?? []).filter(b => battleLive(b, performance.now() / 1000)); return peopleCache.value; }
  if (rosterRef) {
    for (let d = 0; d < (FS.record?.rings?.length ?? 1); d++) rosterRef.ensure(d);
    scene.seedOwn(rosterRef, FS.holdings);
  }
  // the labels inside (construction names, tiers) are in the page's language: a switch rebuilds them
  peopleCache = { at: sec, lang: lang(), value: {
    departures: scene.departuresAt(FS.chronicle, FS.overviews, bell),
    // the hosts the public record says are on the road until their arrival is resolved (a player's character is away with its first host: UX design 14.3)
    away: scene.awayAt(FS.chronicle, bell),
    explores: scene.exploresAt(FS.chronicle, FS.overviews, bell),
    marches: ownColumns(),
    // the token layer (people/units.mjs): who explores, whose column walks its road, the stamina a march needs
    exploringHosts: new Set(scene.exploresAt(FS.chronicle, FS.overviews, bell).map(x => x.host).filter(Boolean)),
    marchingHosts: new Set(ownColumns().map(m => m.host)),
    restBelow: DEPART_STAMINA,
    constructions: constructionsNow(),
    moments: liveMoments(FS.moments ?? [], performance.now() / 1000),
    nameOf: ownNamer(scene.namer(rosterRef)),
    life: FS.life ?? null,
    tierName: t => TIERS[t] ?? '',
    now: FS.chain?.now() ?? 0,
    lordOf: (p, q, site) => { const o = rosterRef?.ownerOf(p, q, site); return o ? identityOf(o.tag) : null; },
    bell,
    own: FS.holdings ?? [],
    columnLabel: d => L`出陣 · ターン ${fmtNum(d.arriveBell)} に到着`,
    demo: ART_PREVIEW && ART_Q.get('acts') === '1',
    battles: FS.battles ?? [],
    lossText: n => L`−${fmtNum(n)} 兵`,
    // (the fates in the report's own words: fi18n.mjs FATES, one vocabulary for an outcome)
    fateText: f => FATES[f] ?? null,
  } };
  peopleCache.value.battles = (FS.battles ?? []).filter(b => battleLive(b, performance.now() / 1000));
  autoBattles();
  return peopleCache.value;
}
const lastHtml = new Map();
/** Put markup in an element only when it changed (a hover title survives the one-second tick). */
function setHtmlIfChanged(el, markup) {
  const key = el.id;
  const text = [markup].flat(Infinity).map(String).join('');
  if (lastHtml.get(key) === text) return;
  lastHtml.set(key, text);
  setHtml(el, markup);
}

/** Every second: the bell pill's bar and urgency, the resource strip, the attention pill. */
let routeShown = null;
/** When a composed march gets its route, the camera frames origin and destination at tile detail. */
function frameRoute() {
  const c = FS.compose;
  const key = c?.route && c.dest ? `${c.host.id}:${c.dest.p},${c.dest.q},${c.dest.tile}` : null;
  if (!key || key === routeShown || !mapRef) { routeShown = key ?? routeShown; return; }
  routeShown = key;
  const hx = marchCard.routeHexes(c).map(h => project(h.q, h.r));
  if (!hx.length) return;
  const xs = hx.map(p => p.x), ys = hx.map(p => p.y);
  const size = mapRef.size(), span = Math.max(Math.max(...xs) - Math.min(...xs), (Math.max(...ys) - Math.min(...ys)) * 1.4, 1);
  const zoom = Math.max(0.55, Math.min(1.4, (Math.min(size.width, size.height) * 0.6) / span));
  // a fly, centred in the part of the map no sheet covers (map/fmap.mjs flyTo)
  mapRef.flyTo({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2, zoom });
}

/** The resource breakdown under the header (hud.renderBreakdown): every holding's store of one resource. */
function renderResPop(now) {
  let el = $('res-pop');
  if (!FS.resOpen || FS.mode !== 'play') { if (el) el.hidden = true; return; }
  const doc = globalThis.document;
  if (!el && doc) {
    el = doc.createElement('div');
    el.id = 'res-pop'; el.className = 'res-pop'; el.setAttribute('role', 'dialog');
    doc.body.appendChild(el);
  }
  if (!el) return;
  el.hidden = false;
  if (FS.resOpen === '*') { el.setAttribute('aria-label', L`資源`); setHtmlIfChanged(el, hud.renderAllBreakdowns(hud.allBreakdowns(FS.holdings ?? [], now))); return; }
  const b = hud.resourceBreakdown(FS.holdings ?? [], FS.resOpen, now);
  el.setAttribute('aria-label', b.name);
  setHtmlIfChanged(el, hud.renderBreakdown(b));
}
/** The term popover (hud/glossary.mjs): one definition, a link to the glossary. */
function renderTermPop() {
  let el = $('term-pop');
  if (!FS.term) { if (el) el.hidden = true; return; }
  const doc = globalThis.document;
  if (!el && doc) { el = doc.createElement('div'); el.id = 'term-pop'; el.className = 'res-pop term-pop'; el.setAttribute('role', 'dialog'); doc.body.appendChild(el); }
  if (!el) return;
  el.hidden = false;
  el.setAttribute('aria-label', glossary.TERMS[FS.term]?.name() ?? '');
  setHtmlIfChanged(el, glossary.renderTerm(FS.term));
}
function closeTermPop() { if (FS.term) { FS.term = null; renderTermPop(); } }
/** The dial's card (hud/dialcard.mjs): the turn, the time to the next bell, what that bell brings; under the dial. */
function renderDialPop(now = FS.chain?.now?.() ?? null) {
  let el = $('dial-pop');
  const pill = $('bell-pill');
  if (pill && pill.getAttribute('aria-expanded') !== String(!!FS.dialOpen)) pill.setAttribute('aria-expanded', String(!!FS.dialOpen));
  if (!FS.dialOpen) { if (el) el.hidden = true; return; }
  const doc = globalThis.document;
  if (!el && doc) { el = doc.createElement('div'); el.id = 'dial-pop'; el.className = 'dial-pop'; el.setAttribute('role', 'dialog'); doc.body.appendChild(el); }
  if (!el) return;
  el.hidden = false;
  el.setAttribute('aria-label', L`ターンと残り時間`);
  const c = FS.mode === 'play' ? joinScreen.waitClock(FS) : null;
  const items = [...dialcard.nextBellItems(FS, { hostInfo: inspect.hostInfoOf(FS), decides: c?.kind === 'result' ? c : null }), ...protoHud.turnItems(FS)];
  // with a village the card is the list of this turn (hud/turnlist.mjs): what was ordered, what the next toll resolves, what happened
  const list = FS.mode === 'play' && holdsLand(FS) ? turnlist.renderTurnList(turnlist.turnModel(FS, { next: items, now: now ?? 0 })) : '';
  const card = dialcard.renderDialCard(FS.clock ? bellChip(FS.clock, now) : null, items, list), markup = String(card);
  // (the time left ticks every second: the card is rewritten around the control that has the focus, which keeps it)
  if (lastHtml.get('dial-pop') !== markup) { lastHtml.set('dial-pop', markup); keepState(el, () => setHtml(el, card)); }
}
function closeDialPop({ focus = false } = {}) { if (FS.dialOpen) { FS.dialOpen = false; renderDialPop(); if (focus) $('bell-pill')?.focus?.({ preventScroll: true }); } }
// ------------------------------------------------------------------ milestones (hud/milestones.mjs)
const BOOT_AT = Date.now();
const MILE_QUIET_MS = 20_000;   // what loads in the first seconds is old news, recorded without a banner
let mileTimer = null;
function checkMilestones() {
  if (FS.mode !== 'play' || !Number.isInteger(FS.citizen?.faction)) return;
  const sc = scope();
  if (!sc) return;
  const key = milestones.MILESTONE_KEY + uiKey(sc).slice(UI_PREFIX.length);
  if (FS.mileRecord === undefined) FS.mileRecord = milestones.loadSeen(uiStorage, key);
  const quiet = Date.now() - BOOT_AT < MILE_QUIET_MS;
  const { fresh, record } = milestones.newMilestones(quiet && !FS.mileRecord ? null : FS.mileRecord ?? { v: 1, seen: {} }, milestones.reachedMilestones(FS), FS.nowBell ?? 0);
  if (Object.keys(record.seen).length !== Object.keys(FS.mileRecord?.seen ?? {}).length) { FS.mileRecord = record; uiStorage.set(key, JSON.stringify(record)); }
  // (the first village's line comes with its landing on the map: mountLandingLine)
  const say = fresh.filter(m => m.id !== 'first-holding' || !mapRef);
  if (!quiet && say.length) { FS.mileQueue = [...(FS.mileQueue ?? []), ...say]; showMilestone(); }
}
const mileShown = new Set();
/** The milestone whose banner stands (its words follow the page's language). */
let mileNow = null;
onLangChange(() => { const el = $('mile-banner'); if (el && !el.hidden && mileNow) setHtml(el, milestones.renderBanner(mileNow, FS.citizen?.faction)); });
function showMilestone() {
  const doc = globalThis.document;
  if (!doc || mileTimer || !(FS.mileQueue ?? []).length) return;
  const m = FS.mileQueue.shift();
  // (one banner per milestone on this page: the landing brings the first village's line itself)
  if (mileShown.has(m.id)) { showMilestone(); return; }
  mileShown.add(m.id);
  let el = $('mile-banner');
  if (!el) { el = doc.createElement('div'); el.id = 'mile-banner'; el.className = 'mile-banner'; el.setAttribute('role', 'status'); doc.body.appendChild(el); }
  mileNow = m;
  setHtml(el, milestones.renderBanner(m, FS.citizen?.faction));
  el.hidden = false;
  // a phone: the line stands just above the sheet (never over the map's buttons) and leaves after about four seconds or at the first touch
  const small = phone();
  if (small) { const top = $('panel')?.getBoundingClientRect?.().top; if (Number.isFinite(top)) el.style.setProperty('--foot', `${Math.max(0, Math.round((globalThis.innerHeight ?? 0) - top + 8))}px`); }
  mileAt = Date.now();
  mileTimer = setTimeout(closeMilestone, small ? MILE_PHONE_MS : milestones.BANNER_MS);
  publishNoGo();
}
/** How many tokens the resource strip has room for at the width it was last measured at (renderHudTick). */
let stripFit = { w: 0, max: 8 };
/** How long the leader's line stands on a phone (ms), and when the one on screen appeared. */
const MILE_PHONE_MS = 4200;
let mileAt = 0;
/**
 * The landing of the viewer's village (map/fmap.mjs tellLanding) ends with the leader's first line (UX brief
 * §5.1): the "first village" banner, once the standard stands. Only for a village the page holds.
 */
function mountLandingLine() {
  fxOn('landing', a => {
    const h = (FS.holdings ?? []).find(x => x.p === a.p && x.q === a.q && x.tile === a.tile);
    if (FS.mode !== 'play' || a.replay || !h || mileShown.has('first-holding') || (FS.holdings ?? []).indexOf(h) !== 0) return;
    setTimeout(() => {
      if (mileShown.has('first-holding')) return;
      FS.mileQueue = [{ id: 'first-holding', kind: 'first-holding', p: h.p, q: h.q, site: h.site, tier: 0 }, ...(FS.mileQueue ?? [])];
      showMilestone();
    }, calm() ? 0 : Math.round(((a.impact ?? 1.2) + 0.9) * 1000));
  });
}
function closeMilestone() {
  clearTimeout(mileTimer); mileTimer = null;
  const el = $('mile-banner');
  if (el) el.hidden = true;
  publishNoGo();
  if ((FS.mileQueue ?? []).length) setTimeout(showMilestone, 600);
}

// ------------------------------------------------------------------ the viewer's own name (people/profile.mjs, UI plan F4)
/**
 * The viewer's own marches on the road, for the people layer: from the
 * holding's tile toward the destination this browser sealed, `k` the share
 * of the way from the departure bell to the arrival bell. Never anyone
 * else's (their destinations are sealed).
 */
function ownColumns() {
  const out = [];
  const now = FS.chain?.now?.() ?? 0;
  if (!FS.clock) return out;
  for (const m of FS.marches ?? []) {
    const e = m.entry, d = m.dest;
    if (!e || !d || !Number.isInteger(d.tile) || !Number.isInteger(e.departBell) || !Number.isInteger(e.arriveBell)) continue;
    if (['revealed', 'settled', 'failed'].includes(e.state)) continue;
    const hp = hostParts(e.host);
    const h = hp && (FS.holdings ?? []).find(x => x.p === hp.p && x.q === hp.q && x.site === hp.site);
    if (!h) continue;
    const t0 = bellStart(FS.clock.genesisTs, e.departBell), t1 = bellStart(FS.clock.genesisTs, e.arriveBell);
    const k = t1 > t0 ? (now - t0) / (t1 - t0) : 1;
    if (k >= 1) continue;
    const host = (FS.provinces.get(`${hp.p},${hp.q}`)?.province?.entries ?? []).find(x => String(x.id) === String(e.host));
    out.push({ host: String(e.host), from: e.route ? { p: e.route.p, q: e.route.q, tile: e.route.tile } : { p: h.p, q: h.q, tile: h.tile }, to: { p: d.p, q: d.q, tile: d.tile }, route: e.route ?? null,
      k: Math.max(0, k), faction: FS.citizen?.faction ?? 0, kind: UNIT_KINDS[host?.unit ?? 0] ?? 'spearman', troops: host ? Math.floor(Number(host.troops) / 1000) : null });
  }
  return out;
}

/**
 * Buildings going up (public: the BUILD records of the chronicle, folded into FS.life; and the
 * viewer's own queue): `[{p, q, site, share, label}]` — the share of the time gone, the
 * building's name and the time left.
 */
function constructionsNow() {
  const now = FS.chain?.now?.() ?? 0, out = [], seen = new Set();
  const add = (p, q, site, item, doneAt, startTs) => {
    const key = `${p},${q},${site}`;
    if (seen.has(key) || !(doneAt > now)) return;
    seen.add(key);
    const total = Math.max(60, doneAt - startTs);
    const name = BUILDINGS[BUILD_ITEMS[item]?.resource] ?? '';
    out.push({ p, q, site, name, share: Math.max(0, Math.min(1, 1 - (doneAt - now) / total)), label: `${name} ${hud.span(doneAt - now)}`.trim() });
  };
  for (const h of FS.holdings ?? []) for (const q of h.queue ?? []) {
    if (!q) continue;
    const done = Number(q.doneAt ?? 0);
    if (done > now) add(h.p, h.q, h.site, queueBuildingItem(q), done, done - buildSecsOf(q));
  }
  if (FS.clock) for (const [k, rec] of FS.life ?? []) {
    if (!rec.build || !(rec.build.doneAt > now)) continue;
    const [p, q, site] = k.split(',').map(Number);
    add(p, q, site, rec.build.item, rec.build.doneAt, bellStart(FS.clock.genesisTs, rec.build.bell));
  }
  return out;
}
/** A queued build's length (the first copy's hour when the queue does not say). */
const buildSecsOf = q => (Number(q.secs) > 0 ? Number(q.secs) : 3_600);

// ------------------------------------------------------------------ what the selection can do on the map (map/actions.mjs, UX brief §5.2)
/** The lit tiles of the host that acts for the selection (or for the march being composed), kept between frames. */
const actionsOf = createActions({ passableOf: (p, q) => terrainRef?.(p, q)?.passable ?? null });
function actionsNow() {
  if (FS.mode !== 'play') return null;
  // a tile is being picked for an order of the village (where a new host forms up): those tiles are what is lit
  const pick = !FS.compose ? FS.hand?.pick ?? null : null;
  if (pick && !pick.external) return FS.view.lod === 'tile' ? pickModel(pick) : null;
  if (!FS.compose && !Number.isInteger(FS.selected?.idx)) return null;
  if (!FS.compose) {
    // the village has the hand: nothing is lit until one of its hosts is chosen (its chip, its figures, 次の軍勢)
    const sub = hand.subjectOf(FS);
    if (sub?.kind !== 'host') return null;
    // the host that has the hand is the one that acts on the map (map/actions.mjs counts the hosts of the tile in its own order)
    const s = FS.selected, key = `${s.p},${s.q},${s.idx}`;
    const i = actorsAt({ holdings: FS.holdings, provinces: FS.provinces, nowBell: FS.nowBell ?? 0, now: FS.chain?.now?.() ?? 0 }, s.p, s.q, s.idx).findIndex(a => a.id === sub.host.id);
    if (i < 0) return null;
    if (FS.actor?.key !== key || FS.actor.i !== i) FS.actor = { key, i };
  }
  const m = actionsOf({ mode: FS.mode, holdings: FS.holdings, provinces: FS.provinces, nowBell: FS.nowBell ?? 0, now: FS.chain?.now?.() ?? 0, selected: FS.view.lod === 'tile' ? FS.selected : null,
    compose: FS.compose, explore: FS.explore, actor: FS.actor, citizen: FS.citizen, survey: FS.survey });
  return m && m.mode === 'select' && FS.hand?.far && !FS.compose ? aimModel(m) : m;
}

/** The rules module once it has loaded (the terrain loads it with the first tile view): the planner answers at once. */
let kernelNow = null, kernelAsked = false;
function wantKernel() {
  if (!kernelNow && !kernelAsked) { kernelAsked = true; loadKernel().then(k => { kernelNow = k; hoverPlan(hoverHit); }).catch(() => { kernelAsked = false; }); }
  return kernelNow;
}
const seedsNow = () => (FS.record?.rings ?? []).map(r => ({ ring: r.d, seed: r.seed }));

/**
 * The planner's route from the acting host to a tile, and the turn it would
 * arrive (fmarch.mjs planRoute, earliestBell, arrivalWindow): `{ok, hexes,
 * arriveBell}` or `{ok: false, code}`; null while the rules module loads.
 */
const routeCache = new Map();
function routeTo(A, to) {
  const k = wantKernel();
  if (!k || !A?.actor) return null;
  const key = `${A.actor.id}|${A.origin.p},${A.origin.q},${A.origin.tile}|${to.p},${to.q},${to.tile}|${FS.nowBell ?? 0}`;
  if (routeCache.has(key)) return routeCache.get(key);
  const r = planRoute(k, { from: A.origin, to, unit: A.actor.unit, seeds: seedsNow() });
  let v;
  if (!r.ok) v = { ok: false, code: r.code };
  else {
    const early = FS.clock ? earliestBell(k, { genesisTs: FS.clock.genesisTs, departTs: (FS.chain?.now?.() ?? 0) + departMargin(FS.chain?.rate), secs: r.route.secs }) : null;
    v = { ok: true, hexes: marchCard.routeHexes({ route: r.route, origin: A.origin, host: { tile: A.origin.tile } }), arriveBell: FS.season ? arrivalWindow(FS.season, FS.nowBell ?? 0, early).min : null };
  }
  if (routeCache.size > 96) routeCache.clear();
  routeCache.set(key, v);
  return v;
}

/** The route to the lit tile under the pointer (the map draws it as a ribbon with its arrival turn). */
let hoverRoute = null, hoverHit = null;
function hoverPlan(hit) {
  hoverHit = hit ?? null;
  // (tiles being picked for an order of the village are not a march: no route is drawn to them)
  const A0 = hit && Number.isInteger(hit.idx) ? actionsNow() : null, A = A0?.mode === 'pick' ? null : A0;
  if (A) wantKernel();
  const t = A ? A.byHex.get(`${hit.tileQ},${hit.tileR}`) : null;
  const dest = FS.compose?.dest;
  // (not for a tile to explore: no march goes there; not for the destination already chosen: its own route is drawn)
  // (a tile beyond the pale line can be a destination too, as far as the planner finds a way: the lit reach is the
  // near reach, not the limit. So the pointer is answered there as well: a route, or nothing)
  const beyond = A && !t && (A.mode === 'select' || A.mode === 'aim') && A.actor?.march?.ok && !(hit.p === A.origin.p && hit.q === A.origin.q && hit.idx === A.origin.tile)
    && !(FS.survey && !FS.survey.showAll && FS.survey.levelOf(hit.p, hit.q, hit.idx) === 0) ? { p: hit.p, q: hit.q, tile: hit.idx, hq: hit.tileQ, hr: hit.tileR, kind: 'move' } : null;
  const want = t && t.kind !== 'explore' && !(dest && dest.p === t.p && dest.q === t.q && dest.tile === t.tile) ? t : beyond;
  const key = want ? `${A.actor.id}|${want.hq},${want.hr}` : null;
  if ((hoverRoute?.key ?? null) === key) return;
  const r = want ? routeTo(A, { p: want.p, q: want.q, tile: want.tile }) : null;
  // (while the rules module loads there is no answer yet: asked again when it has loaded)
  hoverRoute = r?.ok ? { key, q: want.hq, r: want.hr, hexes: r.hexes, arriveBell: r.arriveBell } : r ? { key, q: want.hq, r: want.hr, hexes: [], arriveBell: null } : null;
  mapRef?.tick();
}

/** The map's own answer on a tile (a refusal never fails silently): drawn there for a moment, and said in the map's live line. */
function mapNote(hit, say) {
  FS.mapNote = { p: hit.p, q: hit.q, tile: hit.idx, say, get text() { return say(); }, at: fxNow() };
  summary(say);
  mapRef?.tick();
}
/**
 * Why a tile cannot be a march's destination, as the rules say it (travel.rs: mountains and water are impassable; one
 * march covers at most 32 hexes over at most 4 provinces): the planner's answer, and what stands on the tile.
 */
function refusalText(code, hit = null) {
  if (code === 'NoKernel') return NOTE_TEXT.wait;
  if (code === 'Path') return () => L`遠すぎます（1 回の進軍は ${fmtNum(MAX_PATH_STEPS)} マス・4 州まで）`;
  const pass = hit && Number.isInteger(hit.idx) ? terrainRef?.(hit.p, hit.q)?.passable ?? null : null;
  let open = null;
  try { open = pass === null ? null : ((BigInt(pass) >> BigInt(hit.idx)) & 1n) === 1n; } catch { open = null; }
  if (open === false) return () => L`山や水のマスには進めません`;
  if (code === 'NoPath') return () => L`道がありません（山や水にふさがれています）`;
  return NOTE_TEXT.unreachable;
}
/** The map's live line (`#map-summary`): `say()` gives its words, again when the language changes. */
let summarySay = null;
function summary(say) { summarySay = say; setText('map-summary', say()); }
onLangChange(() => { if (summarySay) setText('map-summary', summarySay()); });

/** Start the order card for the acting host with `hit` as its destination (the existing compose flow). */
async function orderMarch(A, hit) {
  if (Number.isInteger(A.actor.holdingIndex) && A.actor.holdingIndex !== (FS.activeHolding ?? 0)) FS.activeHolding = A.actor.holdingIndex;
  ACTIONS.compose({ host: A.actor.id, stay: 'map' });
  if (!FS.compose) return;
  FS.tab = 'map'; FS.explore = null;
  FS.selected = { kind: 'tile', p: hit.p, q: hit.q, idx: hit.idx, tileQ: hit.tileQ, tileR: hit.tileR };
  invalidate('map', 'panel', 'tabs');
  await ACTIONS['dest-from-map']();
  if (FS.compose?.routeError) mapNote(hit, refusalText(FS.compose.routeError, hit));
}

/**
 * A tap on the map while the hand holds something (UX brief §5.2, UX design 14.2). Returns true when the tap was an
 * order or was answered on the map; false lets it select the tile as usual.
 *   a tile is being picked      (where a new host forms up) the tile is the choice, or the map says why not
 *   the selected tile again     the next thing standing there takes the hand: the village, then each host
 *   the village has the hand    any other tile is a new selection
 *   a host has the hand:
 *     a sky-blue tile           picked for the Scout's exploration (the explore card opens above the bar)
 *     another lit tile          the order card for a march there
 *     an unlit tile             put to the planner: a route means the order card; none is said on the map with the
 *                               rule (and a second tap on that tile selects it)
 */
function mapTap(hit) {
  if (FS.mode !== 'play') return false;
  const pick = !FS.compose ? FS.hand?.pick ?? null : null;
  if (pick) {
    if (pick.external || !Number.isInteger(hit?.idx)) return true;
    const t = pick.tiles.find(x => x.p === hit.p && x.q === hit.q && x.tile === hit.idx);
    if (t) pickChosen(pick, t); else mapNote(hit, pickRefusal(pick, hit));
    return true;
  }
  if (FS.compose || !Number.isInteger(hit?.idx)) return false;
  const sub = hand.subjectOf(FS), s = FS.selected;
  if (!sub || !s) return false;
  if (hit.p === s.p && hit.q === s.q && hit.idx === s.idx) {
    // the same tile again: the village, then each of the hosts standing there, in turn
    const stops = [...(sub.kind === 'village' || sub.host.home ? [null] : []), ...sub.hosts.map(r => r.id)];
    if (stops.length < 2) return true;
    const at = stops.indexOf(sub.kind === 'host' ? sub.host.id : null);
    handHost(stops[(at + 1) % stops.length]);
    return true;
  }
  if (sub.kind !== 'host') return false;
  const A = actionsNow();
  const t = A?.byHex.get(`${hit.tileQ},${hit.tileR}`) ?? null;
  if (t?.kind === 'explore') {
    if (String(FS.explore?.host?.id ?? '') !== sub.host.id) { if (sub.holdingIndex !== (FS.activeHolding ?? 0)) FS.activeHolding = sub.holdingIndex; ACTIONS['explore-open']({ host: sub.host.id }); }
    FS.tab = 'map';
    FS.hand = { ...(FS.hand ?? {}), host: sub.host.id, pop: 'explore' };
    if (FS.explore) ACTIONS['explore-tile']({ tile: String(t.tile) });
    invalidate('map', 'panel', 'tabs');
    return true;
  }
  // (a Scout's tiles are being picked: a tap elsewhere is answered, the picking stays)
  if (hand.popOf(FS, sub) === 'explore') { mapNote(hit, () => L`斥候のとなりで光っているマスだけ調べられます`); return true; }
  if (!A || !sub.host || !hand.marchCheck(FS, sub.host).ok) return false;
  if (t) { orderMarch(A, hit).catch(() => {}); return true; }
  // unlit: a second tap on the tile just refused selects it
  const n = FS.mapNote;
  if (n && n.p === hit.p && n.q === hit.q && n.tile === hit.idx && fxNow() - n.at < 6000) { FS.mapNote = null; return false; }
  if (FS.survey && !FS.survey.showAll && FS.survey.levelOf(hit.p, hit.q, hit.idx) === 0) { mapNote(hit, NOTE_TEXT.unopened); return true; }
  const r = routeTo(A, { p: hit.p, q: hit.q, tile: hit.idx });
  if (r?.ok) { orderMarch(A, hit).catch(() => {}); return true; }
  mapNote(hit, r ? refusalText(r.code, hit) : NOTE_TEXT.wait);
  return true;
}

// ------------------------------------------------------------------ the hand (hud/hand.mjs, UX design 14.2)
/**
 * The action bar and the card above it. `#hand` (a toolbar) stands where the dock stands while the viewer's own
 * village or host is selected (`body[data-hand]`: the stylesheet puts the dock away on wide screens and stands the
 * bar above the tab bar on phones); `#hand-pop` is the bar's card: the build fan over the village (placed through
 * the map's own projection, following the camera), or a card above the bar.
 */
let handEl = null, handPopEl = null;
let handLast = { bar: '', pop: '', key: null, reserve: null }, handRing = null;
function mountHand() {
  const doc = globalThis.document;
  if (!doc?.createElement || handEl || FS.mode !== 'play') return;
  handEl = doc.createElement('div');
  handEl.id = 'hand'; handEl.className = 'hand'; handEl.setAttribute('role', 'toolbar'); handEl.hidden = true;
  handPopEl = doc.createElement('div');
  handPopEl.id = 'hand-pop'; handPopEl.className = 'hand-pop'; handPopEl.setAttribute('role', 'group'); handPopEl.hidden = true;
  const dock = $('tabs');
  // (a conquest season's card 砦へ進軍: the row under the pointer, or with the focus, lights its keep on the board)
  for (const ev of ['pointerover', 'focusin']) handPopEl.addEventListener(ev, e => { const row = e.target?.closest?.('[data-keep-row]'); if (row) hotKeepRow(row.dataset.keepRow); });
  handPopEl.addEventListener('pointerleave', () => hotKeepRow(null));
  (dock?.parentNode ?? doc.body).insertBefore(handPopEl, dock ?? null);
  (dock?.parentNode ?? doc.body).insertBefore(handEl, dock ?? null);
  // the arrow keys move along the bar (a toolbar's own keys); Escape closes the card, then lets the selection go
  handEl.addEventListener('keydown', e => {
    const keys = { ArrowRight: 1, ArrowLeft: -1 };
    if (keys[e.key]) {
      const all = [...handEl.querySelectorAll('.hand-btn')], i = all.indexOf(globalThis.document.activeElement);
      if (i >= 0) { e.preventDefault(); all[(i + keys[e.key] + all.length) % all.length].focus({ preventScroll: true }); }
    }
  });
  for (const el of [handEl, handPopEl]) el.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (FS.hand?.pop) { setPop(null); handEl.querySelector('.hand-btn[aria-pressed="true"], .hand-btn')?.focus?.({ preventScroll: true }); } else HUD_ACTIONS['hand-close']();
  });
}
/** What the hand holds now, or null (never while an order card, the title or a wide document has the screen). */
function handNow() {
  if (FS.mode !== 'play' || FS.compose || FS.report || FS.practice || titleUp()) return null;
  // (on a phone an open sheet has the foot of the screen: the bar comes back when it closes)
  if (phone() && drawerOf(FS)) return null;
  try { return hand.handModel(FS); } catch (e) { console.error('frontier hand:', e); return null; }
}
/** When the selected keep's record was last asked again because its holder had changed (ms, by province). */
const keepStale = new Map();
// ---- a conquest season: the keeps the host's card lists are lit on the board (hud/keephand.mjs)
/** What the board was last told to light (`map.setKeepReach`), and the row under the pointer. */
let keepLit = '', keepHot = null, keepHotTimer = null;
/**
 * While a fighting host has the hand on a conquest season: ask for this host's list (controller.mjs `wantHostReach`,
 * the planner the order card itself uses), and tell the board which keeps to light (`map.setKeepReach(list | null)`,
 * the board's own method and shape: `{p, q, tile, arriveTurn, holder, defenders, reachable, why}`): the keeps of the
 * list are lit with the turn the march would arrive on (the card's own figure; none while the host cannot depart
 * yet), the other nations' keeps it cannot take are dim and answer a press with the reason (map/keepmount.mjs
 * `keepReachOf`, the board's reading of the same planner). The row under the pointer is `hot`. The lights go when
 * the host leaves the hand or an order card takes the screen.
 */
function syncKeepLights(model) {
  const host = model?.kind === 'host' && keephand.conquestOn(FS) && model.host && model.host.unit !== SCOUT && model.host.unit !== SETTLER ? model.host : null;
  const open = !!host && model.pop === 'keeps';
  if (host) { try { if (wantHostReach(host.id)) invalidate('rail'); } catch (e) { console.error('frontier keeps:', e); } }
  let list = null;
  if (host) {
    try {
      const km = keephand.keepsModel(FS, host);
      if (km.state === 'ready') {
        const lit = new Set(km.rows.map(x => x.key));
        list = keephand.keepLights(km, open ? keepHot : null);
        for (const x of keepReachOf(FS, host) ?? []) if (!x.reachable && !lit.has(`${x.p},${x.q}`)) list.push({ ...x, hot: false });
      }
    } catch (e) { console.error('frontier keeps:', e); list = null; }
  }
  if (!open && keepHot !== null) { keepHot = null; clearTimeout(keepHotTimer); }
  const key = list ? JSON.stringify(list) : '';
  if (key === keepLit) return;
  keepLit = key;
  try { mapRef?.setKeepReach?.(list && list.length ? list : null); mapRef?.invalidate?.(); } catch { /* the board's own */ }
}
/** A row of the card comes under the pointer (or takes the focus): its keep is lit brighter and, after a moment's rest on it, brought into view. */
function hotKeepRow(key) {
  if (key === keepHot) return;
  keepHot = key;
  clearTimeout(keepHotTimer);
  syncKeepLights(handNow());
  if (!key || !mapRef) return;
  keepHotTimer = setTimeout(() => {
    if (keepHot !== key || FS.hand?.pop !== 'keeps') return;
    const [p, q] = key.split(',').map(Number), k = FS.conquest?.keeps?.get?.(key);
    camKeep.keep('pop');
    try { if (mapRef.flyToKeep) mapRef.flyToKeep({ p, q }); else mapRef.flyTo({ p, q, ...(Number.isInteger(k?.tile) ? { tile: k.tile } : {}), zoom: Math.min(mapRef.view.zoom, 1.0) }, null, { auto: true }); } catch { /* the board's own */ }
  }, calm() ? 0 : 420);
}
function renderHand() {
  if (!handEl) return;
  const model = handNow();
  syncRaisePreview(model);
  keepMarchBest(model);
  syncKeepLights(model);
  const body = globalThis.document.body, kind = model?.kind ?? '';
  // the board rings the host that has the hand (map/fmap.mjs selectHost), whichever way it was chosen: its figures, its chip, 次の軍勢
  { const ring = model?.kind === 'host' ? String(hand.subjectOf(FS)?.host?.id ?? '') || null : null; if (ring !== handRing) { handRing = ring; try { mapRef?.selectHost?.(ring); } catch { /* the board's own */ } } }
  if ((body.dataset.hand ?? '') !== kind) { body.dataset.hand = kind; for (const ms of [0, 130, 260, 420]) setTimeout(() => { measureHand(); mapRef?.tick(); publishNoGo(); }, ms); }
  if (handEl.hidden !== !model) handEl.hidden = !model;
  if (!model) {
    // nothing of the viewer's is selected: what the hand was doing goes with it (a tile being picked, a card)
    if (FS.hand && !FS.compose) { endPick(); FS.hand = null; }
    // (a card's kept view: gone back to when the selection simply went; forgotten when an order card took over)
    if (FS.compose) camKeep.drop('pop'); else camKeep.back('pop', { ms: calm() ? 0 : 260 });
    if (!handPopEl.hidden) handPopEl.hidden = true;
    handLast = { bar: '', pop: '', key: null, reserve: null };
    if (handPopEl.dataset.pop) { handPopEl.dataset.pop = ''; setHtml(handPopEl, ''); }
    return;
  }
  if (handEl.getAttribute('aria-label') !== model.label) handEl.setAttribute('aria-label', model.label);
  // (the player's own "effects: reduced / off" stills the bar's and the fan's entrances too, not only the system's setting)
  for (const el of [handEl, handPopEl]) { const c = calm() ? '1' : ''; if ((el.dataset.calm ?? '') !== c) el.dataset.calm = c; }
  measureHand();
  const bar = String(hand.renderHand(model));
  if (bar !== handLast.bar) { keepState(handEl, () => setHtml(handEl, hand.renderHand(model))); handLast.bar = bar; }
  // the reserve's count rises when the record says so: the figure answers with a beat (visual only)
  if (model.kind === 'village') {
    if (handLast.key === model.key && handLast.reserve !== null && model.musterable > handLast.reserve && !calm()) { const fig = handEl.querySelector('.hand-train .hand-fig'); if (fig) { fig.classList.remove('bump'); void fig.offsetWidth; fig.classList.add('bump'); } }
    handLast.reserve = model.musterable;
  } else handLast.reserve = null;
  handLast.key = model.key;
  // (the view kept for the new host's card: gone back to once that card no longer stands)
  if (!(model.kind === 'village' && CARDS_OVER_BOARD.includes(model.pop)) && FS.hand?.pick?.kind !== 'dress' && model.pop !== 'keeps') camKeep.back('pop', { ms: calm() ? 0 : 260 });
  const pop = model.pop ? String(hand.renderPop(FS, model)) : '';
  if (handPopEl.hidden !== !pop) handPopEl.hidden = !pop;
  if ((handPopEl.dataset.pop ?? '') !== (model.pop ?? '')) handPopEl.dataset.pop = model.pop ?? '';
  // (a tile is being picked on the board for the card — the prototype's widening —: the card counts as covering the map's foot, hud/insets.mjs)
  { const pk = FS.hand?.pick?.kind === 'dress' ? 'dress' : ''; if ((handPopEl.dataset.pick ?? '') !== pk) handPopEl.dataset.pick = pk; }
  if (pop !== handLast.pop) { keepState(handPopEl, () => setHtml(handPopEl, pop ? hand.renderPop(FS, model) : '')); handLast.pop = pop; if (pop) handPopEl.setAttribute('aria-label', model.label); }
  placeHandPop(model);
  publishNoGo();
}
/** Where the bar stands, told to the stylesheet (`--hand-h`, `--hand-l`, `--hand-t` on the body): the cards stand above it, and the dock tucks behind its top left corner. */
function measureHand() {
  if (!handEl || handEl.hidden) return;
  const body = globalThis.document.body, r = handEl.getBoundingClientRect();
  const set = (k, v) => { if (body.style.getPropertyValue(k) !== v) body.style.setProperty(k, v); };
  set('--hand-h', `${Math.round(handEl.offsetHeight || 0)}px`);
  set('--hand-l', `${Math.round(r.left)}px`);
  set('--hand-t', `${Math.round(r.top)}px`);
}
globalThis.addEventListener?.('resize', () => { measureHand(); setTimeout(measureHand, 260); });
/** The fan's seven places on an arc over the village (degrees from the right, counter-clockwise; px from the village). */
// (`ry`: tall enough that the token at the top of the arc stands clear of the village's own name plate, which it covered at 204)
export const FAN = Object.freeze({ from: 205, to: -25, rx: 288, ry: 240, tok: { w: 116, h: 128 }, head: 96 });
/**
 * Where the card stands: the build fan is laid over the village itself when the village is far enough from the
 * HUD's pieces for the whole arc (`data-mode="fan"`: each token's place is given in px from the village, which the
 * map projects to the page); otherwise, and for every other card and on phones, it is a card above the bar.
 */
function placeHandPop(model = handNow()) {
  if (!handPopEl || handPopEl.hidden || !model) return;
  let mode = 'card';
  if (model.pop === 'build' && !phone() && mapRef && FS.view.lod === 'tile') {
    const h = model.subject.holding, c = (x => project(x.q, x.r))(tileHex(h.p, h.q, h.tile));
    const at = mapRef.project(c.x, c.y), ins = hudInsets(), W = globalThis.innerWidth ?? 1440, H = globalThis.innerHeight ?? 900;
    const barTop = handEl.getBoundingClientRect().top || H;
    const fits = at.x - FAN.rx - FAN.tok.w / 2 > 12 && at.x + FAN.rx + FAN.tok.w / 2 < W - 12 - ins.right && at.y - FAN.ry - FAN.tok.h / 2 > ins.top + 8 && at.y + FAN.head + (handPopEl.querySelector('.fan-full') ? 108 : 92) < barTop - 8;
    if (fits) {
      mode = 'fan';
      handPopEl.style.setProperty('--ax', `${Math.round(at.x)}px`);
      handPopEl.style.setProperty('--ay', `${Math.round(at.y)}px`);
      const toks = [...handPopEl.querySelectorAll('.fan-tok')];
      toks.forEach((el, i) => {
        const a = ((FAN.from + (FAN.to - FAN.from) * (toks.length > 1 ? i / (toks.length - 1) : 0.5)) * Math.PI) / 180;
        el.style.setProperty('--dx', `${Math.round(Math.cos(a) * FAN.rx)}px`);
        el.style.setProperty('--dy', `${Math.round(-Math.sin(a) * FAN.ry)}px`);
        el.style.setProperty('--i', String(i));
      });
    }
  }
  if (handPopEl.dataset.mode !== mode) handPopEl.dataset.mode = mode;
}

/** Open a card of the bar (null closes it); the board is asked for a tile when the card needs one. */
function setPop(pop) {
  const sub = hand.subjectOf(FS);
  endPick();
  const next = pop && (hand.POPS.includes(pop) || (FS.proto && hand.PROTO_POPS.includes(pop)) || (keephand.conquestOn(FS) && hand.CONQUEST_POPS.includes(pop))) ? pop : null;
  FS.hand = { ...(FS.hand ?? {}), pop: next, unit: undefined, n: undefined, troops: undefined, tile: undefined, pick: null, strike: undefined, widen: undefined, more: undefined, protoWhy: undefined };
  FS.mapNote = null;
  if (next !== 'explore' && FS.explore) FS.explore = null;
  // the card of a new host is used with the board: the camera is kept, and the village's province comes into the part
  // of the map the bar and the card leave free (the card counts as covered: hud/insets.mjs); it goes back when the
  // card closes (renderHand)
  // (the village's other wide cards — training, the promotion — stood over the village itself on a wide screen: the
  // village comes into the free part of the map above them, at the zoom the player has, and the view goes back after)
  if (CARDS_OVER_BOARD.includes(next) && sub?.kind === 'village' && mapRef && (next === 'muster' || !phone())) {
    camKeep.keep('pop');
    // (a phone with the prototype rule "banners" on: the strip of map above the card is low, and the tiles where a
    // banner can rise lie round the village, not at the province's middle: the village's own tile is framed)
    const at = next === 'muster' && !(FS.proto && phone()) ? { p: sub.holding.p, q: sub.holding.q } : { p: sub.holding.p, q: sub.holding.q, tile: sub.holding.tile };
    // (after the card is laid out: its height is part of what is covered)
    setTimeout(() => { if (FS.hand?.pop === next && mapRef) { mapRef.tick(); mapRef.flyTo({ ...at, zoom: Math.min(mapRef.view.zoom, 1.0) }, null, { auto: true }); } }, 80);
  }
  // (the card 旗 of a host, prototype rule "banners": the ground the banner would take lies round the host, and the
  // card stood over the lower half of it — on a phone over all of it. The host's tile comes into the part of the map
  // the card leaves free, and the view stays there: the flood that follows is seen where the player is looking)
  // (the card is not counted as covering the map's foot — hud/insets.mjs —: counted, the camera eased far out to fit
  // the host's whole reach above it. Only the pan is made here, and only when the ground is under the card)
  if (next === 'banner' && sub?.kind === 'host' && FS.proto && mapRef) {
    const at = { p: sub.host.p, q: sub.host.q, tile: sub.host.tile };
    // (once the camera rests: the guide flies to the host as it opens this card, and a pan worked out in the middle
    // of that flight left the pole under the top of the HUD — on a phone the banner rose out of sight)
    setTimeout(() => { if (FS.hand?.pop === 'banner') whenStill(() => { if (FS.hand?.pop === 'banner') clearOfCard(at); }); }, 90);
  }
  if (next === 'muster' && sub?.kind === 'village') startPick('muster', sub);
  if (next === 'explore' && sub?.kind === 'host') {
    if (sub.holdingIndex !== (FS.activeHolding ?? 0)) FS.activeHolding = sub.holdingIndex;
    ACTIONS['explore-open']({ host: sub.host.id });
    FS.tab = 'map';
    startPick('explore', sub);
  }
  invalidate('map', 'panel', 'tabs');
}
/** Run `fn` once the map's camera rests (a few still frames), or after `max` ms at the latest. */
function whenStill(fn, max = 1500) {
  const raf = globalThis.requestAnimationFrame ?? (f => setTimeout(f, 16)), t0 = Date.now();
  let still = 0;
  const step = () => {
    still = mapRef?.cam?.moving || mapRef?.reachFly ? 0 : still + 1;
    if (still >= 3 || Date.now() - t0 > max) fn(); else raf(step);
  };
  raf(step);
}
/**
 * Bring a tile and the tiles round it into the part of the map above the card that stands over the bar (and under
 * the top of the HUD), when they are not there already: one short pan, the zoom kept (a phone: not closer than a
 * view in which the seven tiles fit above the card).
 */
function clearOfCard(at) {
  const card = handPopEl, hex = tileHex(at.p, at.q, at.tile);
  if (!mapRef || !card || card.hidden || !hex || typeof mapRef.project !== 'function') return;
  const c = project(hex.q, hex.r), size = mapRef.size(), ins = mapRef.inset?.() ?? hudInsets(), k = card.getBoundingClientRect(), cv = $('frontier-map')?.getBoundingClientRect?.();
  if (!cv || !(k.height > 0)) return;
  const narrow = phone(), zoom = narrow ? Math.min(mapRef.view.zoom, 0.8) : mapRef.view.zoom;
  // the room a banner's land takes round its tile on screen (a tile and a half each way, the board is flattened), and the box it must lie in
  const rx = RADIUS * 2.7 * zoom, ry = RADIUS * 2.0 * zoom;
  const top = cv.top + (ins.top ?? 0) + (narrow ? 100 : 40), bottom = Math.min(k.top, cv.bottom - (ins.bottom ?? 0)) - 24;
  const left = cv.left + (narrow ? 8 : (ins.left ?? 0) + 240), right = cv.left + size.width - (narrow ? 8 : (ins.right ?? 0) + 340);
  const p = mapRef.project(c.x, c.y);
  const fits = zoom === mapRef.view.zoom && p.x - rx >= left && p.x + rx <= right && p.y - ry >= top && p.y + ry <= bottom;
  if (fits) return;
  const tx = Math.max(Math.min((left + right) / 2, right - rx), left + rx), ty = bottom - top >= 2 * ry ? Math.max(top + ry, Math.min(bottom - ry, p.y)) : (top + bottom) / 2;
  const wantX = p.x - rx >= left && p.x + rx <= right ? p.x : tx;
  camKeep.touch();
  // (the world point now seen where the tile is wanted: the view moves by the difference, so the tile stands there)
  const w = mapRef.unproject?.(wantX, ty) ?? { x: c.x - (p.x - wantX) / mapRef.view.zoom, y: c.y - (p.y - ty) / mapRef.view.zoom };
  mapRef.flyTo({ x: mapRef.view.x + (c.x - w.x), y: mapRef.view.y + (c.y - w.y), zoom }, calm() ? 0 : 250, { auto: true, exact: true });
}
/** A host standing on the selected tile takes the hand (null: the village there does). */
function handHost(id) {
  endPick();
  FS.hand = { host: id ?? null, pop: null };
  FS.explore = null; FS.mapNote = null; FS.actor = null;
  invalidate('map', 'panel', 'tabs');
}
/** Select one of the viewer's hosts wherever it stands: its tile is the selection and it has the hand. `fly`: bring it into view. */
function selectHost(row, { fly = false } = {}) {
  if (!row) return false;
  endPick();
  if (Number.isInteger(row.holdingIndex) && row.holdingIndex >= 0 && row.holdingIndex !== (FS.activeHolding ?? 0)) FS.activeHolding = row.holdingIndex;
  FS.selected = { kind: 'tile', p: row.p, q: row.q, idx: row.tile };
  FS.hand = { host: String(row.id), pop: null };
  FS.inspectOpen = false; FS.explore = null; FS.mapNote = null; FS.actor = null; FS.tab = 'map'; FS.report = null; FS.practice = null; FS.guideOpen = false;
  if (fly && mapRef) {
    // (only when it is not in the picture already: a host that is in sight is not flown to)
    const c = (x => project(x.q, x.r))(tileHex(row.p, row.q, row.tile)), at = mapRef.project(c.x, c.y, { logical: true }), size = mapRef.size(), ins = hudInsets();
    const seen = FS.view.lod === 'tile' && at.x > 80 && at.x < size.width - ins.right - 80 && at.y > ins.top + 80 && at.y < size.height - ins.bottom - 120;
    if (!seen) { camKeep.touch(); mapRef.flyTo({ p: row.p, q: row.q, tile: row.tile, zoom: Math.max(mapRef.view.zoom, 1.0) }); }
  }
  wantProvince(row.p, row.q, () => { mapRef?.invalidate(); invalidate('panel'); });
  summary(() => L`${unitCount(UNIT_ORDER[row.unit], row.troops)} を選びました`);
  invalidate('map', 'panel', 'tabs', 'rail');
  return true;
}
/** Select one of the viewer's own villages on the board (it has the hand), with a card of its bar open when `pop` names one. */
function selectVillage(i, pop = null) {
  const h = (FS.holdings ?? [])[i >= 0 ? i : FS.activeHolding ?? 0];
  if (!h || !Number.isInteger(h.tile)) return false;
  endPick();
  FS.activeHolding = FS.holdings.indexOf(h);
  FS.selected = { kind: 'tile', p: h.p, q: h.q, idx: h.tile };
  FS.hand = { host: null, pop: null };
  FS.inspectOpen = false; FS.explore = null; FS.mapNote = null; FS.actor = null; FS.tab = 'map'; FS.report = null; FS.practice = null; FS.guideOpen = false; FS.todoOpen = false;
  if (mapRef) {
    const c = (x => project(x.q, x.r))(tileHex(h.p, h.q, h.tile)), at = mapRef.project(c.x, c.y, { logical: true }), size = mapRef.size(), ins = hudInsets();
    const seen = FS.view.lod === 'tile' && at.x > 320 && at.x < size.width - ins.right - 320 && at.y > ins.top + 240 && at.y < size.height - ins.bottom - 240;
    if (!seen) { camKeep.touch(); mapRef.flyTo({ p: h.p, q: h.q, tile: h.tile, zoom: Math.max(mapRef.view.zoom, 1.0) }); }
  }
  if (pop) setPop(pop); else invalidate('map', 'panel', 'tabs', 'rail');
  return true;
}
/** The next (dir +1) or previous (−1) of the viewer's hosts, those that can act this turn first (Civ's "next unit"). */
function nextHost(dir) {
  const all = hand.ownHosts(FS);
  if (!all.length) return;
  const sub = hand.subjectOf(FS);
  const at = sub?.kind === 'host' ? all.findIndex(r => r.id === sub.host.id) : -1;
  selectHost(all[((at + dir) % all.length + all.length) % all.length], { fly: true });
}
/**
 * One of the viewer's own hosts under the last press on the map, when the board can say so. HOOK (board track):
 * `map.hostAt(clientX, clientY)` → `{id}` (the host's id; anything else it carries is ignored) or null. Until the
 * board has it, a host is chosen by its chip in the bar, by a second tap on its tile, or with 次の軍勢.
 */
let lastPress = null;
function hostUnderPress() {
  if (!lastPress || typeof mapRef?.hostAt !== 'function') return null;
  let h = null;
  try { h = mapRef.hostAt(lastPress.x, lastPress.y); } catch { h = null; }
  const id = h === null || h === undefined ? null : String(h.id ?? h.hostId ?? h);
  if (!id) return null;
  for (let i = 0; i < (FS.holdings ?? []).length; i++) {
    const row = hand.ownHosts({ ...FS, activeHolding: i }).find(r => r.id === id);
    if (row) return row;
  }
  return null;
}

// ---- a tile picked on the board for an order of the hand
/**
 * HOOK (board track): `map.pickTile({kind: 'muster' | 'explore', tiles: [{p, q, tile}], label, max, chosen})` lights
 * the tiles and answers with the tapped one: `{p, q, tile}` (or an array of them, or a promise of either), null when
 * the pick was put away; `map.pickTile(null)` ends a pick that is open. While the board has no such function the
 * page picks by itself: the tiles are lit through the map's own action model (map/actions.mjs: the contour of the
 * set, a check on the chosen tile) and a tap on one of them is the choice (mapTap).
 */
let pickSeq = 0;
const pickMemo = { key: null, model: null };
function startPick(kind, sub) {
  const h = sub.holding;
  // (where a host may form up: the Province's own mask, and the rules module's terrain where the page has it — the
  // generator's mountains and water are never offered)
  const land = kind === 'muster' ? terrainRef?.(h.p, h.q)?.passable ?? null : null;
  const open = t => { try { return land === null || ((BigInt(land) >> BigInt(t.tile)) & 1n) === 1n; } catch { return true; } };
  const tiles = kind === 'muster' ? hand.musterTiles(FS, h).filter(open) : (sub.host && hand.exploreCheck(FS, sub.host).targets.map(t => ({ p: sub.host.p, q: sub.host.q, tile: t }))) || [];
  const origin = kind === 'muster' ? { p: h.p, q: h.q, tile: h.tile } : { p: sub.host.p, q: sub.host.q, tile: sub.host.tile };
  const label = kind === 'muster' ? L`ここに集める` : L`ここを調べる`;
  const pick = { kind, tiles, origin, max: kind === 'explore' ? 2 : 1, label, token: ++pickSeq, external: false, t0: fxNow() };
  if (!tiles.length) return;
  // (the Scout's tiles are lit by the map already, with the reach: only a board that picks by itself takes them over)
  if (typeof mapRef?.pickTile !== 'function') {
    if (kind !== 'muster') return;
    FS.hand = { ...(FS.hand ?? {}), pick };
    return;
  }
  pick.external = true;
  FS.hand = { ...(FS.hand ?? {}), pick };
  const wait = ms => new Promise(res => setTimeout(res, ms));
  const ask = async () => {
    // (the board is asked again while the card stands: another tile may be tapped for the new host, and a Scout's
    // second tile, or a chosen one again to take it back. A tap outside the lit set is answered on the map and the
    // pick stays: `miss`. Escape puts the pick away on the board: the card goes with it)
    while (FS.hand?.pick === pick) {
      const chosen = kind === 'explore' ? (FS.explore?.tiles ?? []).map(t => ({ p: origin.p, q: origin.q, tile: t })) : Number.isInteger(FS.hand?.tile) ? [{ ...origin, tile: FS.hand.tile }] : [];
      let r = null;
      try { r = await mapRef.pickTile({ kind, tiles, label, max: 1, origin, chosen, miss: hit => { if (FS.hand?.pick === pick && hit && Number.isInteger(hit.idx)) mapNote(hit, pickRefusal(pick, hit)); } }); } catch { r = null; }
      if (FS.hand?.pick !== pick) return;
      // (null: the board put the pick away — Escape: the card closes with it)
      if (r === null || r === undefined) { if (FS.hand?.pop === kind) setPop(null); else endPick(); return; }
      const got = (Array.isArray(r) ? r : [r]).map(x => (Number.isInteger(x) ? { ...origin, tile: x } : x)).filter(x => x && Number.isInteger(x.tile) && tiles.some(t => t.tile === x.tile));
      if (!got.length) return;
      pickChosen(pick, got[0]);
      await wait(30);
    }
  };
  ask().catch(() => {});
}
function endPick() {
  const pick = FS.hand?.pick;
  if (!pick) return;
  FS.hand = { ...FS.hand, pick: null };
  if (pick.external) { try { mapRef?.pickTile?.(null); } catch { /* the board's own */ } }
  mapRef?.tick();
}
/** A tile was chosen for the pick in hand. */
function pickChosen(pick, t) {
  // (a Scout's tile tapped again is let go; a third tile is not taken: two at most, M1-CONTRACT 5.10)
  const had = pick.kind === 'explore' && (FS.explore?.tiles ?? []).includes(t.tile);
  if (pick.kind === 'muster' || pick.kind === 'dress') FS.hand = { ...(FS.hand ?? {}), tile: t.tile };
  else if (pick.kind === 'explore' && FS.explore) {
    if (!had && (FS.explore.tiles ?? []).length >= pick.max) { mapNote({ p: t.p, q: t.q, idx: t.tile }, () => L`一度に調べられるのは 2 マスまでです`); return; }
    ACTIONS['explore-tile']({ tile: String(t.tile) });
  }
  FS.mapNote = null;
  summary(() => (pick.kind === 'muster' ? L`${tileNameOf(t)}に集めます` : pick.kind === 'dress' ? L`${tileNameOf(t)}を旗の土地にします` : had ? L`${tileNameOf(t)}をやめました` : L`${tileNameOf(t)}を調べます`));
  invalidate('map', 'panel');
}
const tileNameOf = t => inspect.placeAt?.(FS, { p: t.p, q: t.q, tile: t.tile }, terrainRef)?.name ?? L`このマス`;
/** Why a tapped tile cannot be the pick's (the rule: Muster takes any passable tile of the village's own province, six hosts to a tile). */
function pickRefusal(pick, hit) {
  if (pick.kind === 'dress') return () => L`広げられるのは、光っているマスだけです（旗の土地のとなりで、軍勢のそば）`;
  if (pick.kind !== 'muster') return () => L`斥候のとなりで光っているマスだけ調べられます`;
  if (hit.p !== pick.origin.p || hit.q !== pick.origin.q) return () => L`集められるのは、村のある州の中だけです`;
  const prov = FS.provinces.get(`${hit.p},${hit.q}`)?.province ?? null;
  let open = true;
  try { open = ((BigInt(prov?.passableMask ?? 0) >> BigInt(hit.idx)) & 1n) === 1n; } catch { open = true; }
  return open ? () => L`このマスはいっぱいです（1 マスに 6 軍勢まで）` : () => L`山や水のマスには集められません`;
}
/** The picked-for tiles as the map's action model (the contour of the set, the chosen tile with a check): the page's own way while the board has no pickTile. */
function pickModel(pick) {
  const chosen = pick.kind === 'muster' || pick.kind === 'dress' ? (Number.isInteger(FS.hand?.tile) ? [FS.hand.tile] : []) : [];
  const key = `pick|${pick.token}|${pick.tiles.length}|${chosen.join('.')}`;
  if (pickMemo.key === key) return pickMemo.model;
  const o = tileHex(pick.origin.p, pick.origin.q, pick.origin.tile);
  const tiles = [], byHex = new Map();
  for (const t of pick.tiles) {
    const h = tileHex(t.p, t.q, t.tile);
    if (!h) continue;
    const d = o ? (Math.abs(h.q - o.q) + Math.abs(h.r - o.r) + Math.abs(h.q + h.r - o.q - o.r)) / 2 : 1;
    const x = { p: t.p, q: t.q, tile: t.tile, hq: h.q, hr: h.r, d, lv: 3, kind: chosen.includes(t.tile) ? 'explore' : 'move' };
    tiles.push(x); byHex.set(`${h.q},${h.r}`, x);
  }
  const model = { key, mode: 'pick', origin: pick.origin, hex: o, actor: { id: `pick:${pick.kind}`, unit: 0, troops: 0, stamina: 120, march: { ok: true, blocks: [] }, explore: null }, actors: [], index: 0, tiles, byHex, t0: pick.t0, chosen, dest: null, label: pick.label };
  pickMemo.key = key; pickMemo.model = model;
  return model;
}
/** A control that cannot be pressed now was pressed: it shakes its head and its reason is said in the map's live line (the reason stands on the control too). */
function refuseInPlace(el) {
  const why = el.querySelector?.('.hand-why, .fan-why')?.textContent?.trim() || el.closest?.('#hand-pop')?.querySelector?.('.pop-why')?.textContent?.trim() || el.title || '';
  if (why) summary(() => why);
  if (calm()) return;
  el.classList.remove('refused'); void el.offsetWidth; el.classList.add('refused');
  setTimeout(() => el.classList.remove('refused'), 400);
}
/** An order given from the bar or its card: when it is accepted the card closes (the board has the screen for what follows). */
async function handOrder(send) {
  // (the card the order is given from. An order takes a moment to land, and the card that stood THEN was closed:
  // a player who had gone on to the next card — trained, then pressed 編成 — had it shut under the finger, and
  // the tap meant for a muster tile selected the tile and let the village go. Found in the play-through of wave 5)
  const from = FS.hand?.pop ?? null;
  const r = await send();
  if (r?.ok && FS.hand?.pop && FS.hand.pop === from) { endPick(); FS.hand = { ...FS.hand, pop: null, unit: undefined, n: undefined, troops: undefined, tile: undefined }; invalidate('map', 'panel'); }
  renderHand();
  return r;
}
/**
 * The player looks for a far destination with a host in hand: the lit reach stays lit, but it no longer has the camera
 * (map/fmap.mjs frames the reach of a selection again whenever it comes back into tile detail: `mode: 'select'`; the
 * model is handed on as `mode: 'aim'` from here on, the same tiles, so the camera stays where the player took it).
 */
function goFar() { camKeep.touch(); if (FS.hand && !FS.hand.far) FS.hand = { ...FS.hand, far: true }; }
const aimMemo = { of: null, model: null };
const aimModel = m => { if (aimMemo.of !== m) { aimMemo.of = m; aimMemo.model = { ...m, mode: 'aim' }; } return aimMemo.model; };
/** The march's far ways: the whole chart (a tap on a province flies there with the host still in hand) or the search field. */
function farChoice(how) {
  goFar();
  if (how === 'search') { setSearch(true); return; }
  if (mapRef && !mapRef.chartOn?.()) mapRef.worldChart?.();
  summary(() => L`行き先のあたりを押すと、そこへ近づきます。それからマスを押してください`);
}

// ------------------------------------------------------------------ the prototype rule "banners" (hud/proto.mjs, proto/hand-model.mjs; PROTOTYPE-SPEC)
// A DESIGN tried in the sample world: not in the program, nothing of it sent to a chain. All of this runs only while
// the season record carries `sample.proto.claims` (`FS.proto`); the fixed chip stands for as long as any of it shows.
/** The chip beside the dial (its words are the record's own label and nothing else) and the score with its note. */
function renderProto() {
  const chip = $('proto-chip'), score = $('proto-score');
  const text = protoHud.chipText(FS);
  const body = globalThis.document?.body;
  if (body?.dataset && (body.dataset.proto ?? '') !== (text ? 'banners' : '')) { if (text) body.dataset.proto = 'banners'; else delete body.dataset.proto; }
  if (chip) { if (chip.hidden !== !text) chip.hidden = !text; if (chip.textContent !== text) chip.textContent = text; }
  if (score) {
    const show = !!text && FS.mode === 'play' && holdsLand(FS) && !titleUp();
    // (a phone while the hand, a card, a selection or a sheet has the foot of the screen: the score steps aside and the
    // guide's step stands in its place as one line — the map between the top and the sheet is narrow then, and the
    // resting sheet's own line of the guide is not in sight. The label's chip stays where it is)
    const busy = show && phone() && (!!handNow() || !!FS.selected || !!FS.compose || !!drawerOf(FS));
    const strip = busy && guide.guideLevel(FS) === 'all' ? protoHud.guideStrip(FS) : '';
    if ((score.dataset.strip ?? '') !== (busy ? '1' : '')) { if (busy) score.dataset.strip = '1'; else delete score.dataset.strip; }
    setHtmlIfChanged(score, !show ? '' : busy ? strip : protoHud.ticker(FS, { open: !phone() || !!FS.proto?.tickerOpen }));
    const has = !!score.firstElementChild;
    if (score.hidden !== !has) { score.hidden = !has; publishNoGo(); }
  }
  tickProtoPlate();
  // (the board: the same reading of the records that the hand reads, built into the board's model and given to the
  // map — `map.setProto` — by proto/board-mount.mjs, only when something of it changed)
  try { protoBoard?.build(); } catch (e) { console.error('frontier proto board:', e); }
}
/** The board's side of the prototype (proto/board-mount.mjs), once the map exists. */
let protoBoard = null;
/** HOOK (board track): `map.flyToBanner({p, q, slot})` brings a banner into view; true when the board took it. */
function flyToBanner(ref) {
  if (!FS.proto || typeof mapRef?.flyToBanner !== 'function') return false;
  try { camKeep.touch(); mapRef.flyToBanner(ref); return true; } catch { return false; }
}
/** The plate's count of the viewer's land follows its record a tile at a time (visual only; at once when effects are reduced). */
let plateStep = null;
function tickProtoPlate() {
  const P = FS.proto, m = P ? pm.plateModel(FS) : null;
  if (!m) return;
  if (!Number.isInteger(P.plateShown) || calm()) { if (P.plateShown !== m.tiles) { P.plateShown = m.tiles; invalidate('rail', 'panel'); } return; }
  if (P.plateShown === m.tiles || plateStep) return;
  plateStep = setInterval(() => {
    const Q = FS.proto, to = Q ? pm.plateModel(FS)?.tiles ?? null : null;
    if (!Q || to === null || Q.plateShown === to) { clearInterval(plateStep); plateStep = null; return; }
    Q.plateShown += Math.sign(to - Q.plateShown);
    invalidate('rail', 'panel');
  }, 90);
}
/**
 * The place the player has in hand while choosing where a fighting host forms up or marches: the march's chosen
 * destination, the tile under the pointer, the new host's tile, or (the card 旗) the host's own tile. Null otherwise.
 */
let hoverPlace = null, hoverTimer = null, tipAt = null;
function protoPlaceNow(model) {
  if (!FS.proto) return null;
  const c = FS.compose;
  if (c?.host && c.dest && !c.sending && pm.fights(c.host)) return { host: String(c.host.id), p: c.dest.p, q: c.dest.q, tile: c.dest.tile };
  if (c) return null;
  if (hoverPlace) return hoverPlace;
  if (model?.kind === 'village' && model.pop === 'muster') return hand.musterPlace(FS, model);
  // (the card 旗 of a host that stands where a banner could rise; on land of a banner already — its own, or another's
  // pole — there is no raise to preview)
  if (model?.kind === 'host' && model.pop === 'banner' && pm.fights(model.host) && !FS.hand?.widen && FS.hand?.pick?.kind !== 'dress' && !['own', 'foe'].includes(pm.hostSituation(FS, model.host)?.mode)) return { host: String(model.host.id), p: model.host.p, q: model.host.q, tile: model.host.tile };
  return null;
}
/**
 * The preview route is asked for the place in hand, and its answer goes to the board. HOOK (board track):
 * `map.showRaisePreview(answer | null)`: the world's answer as it came (`{ok: true, tiles, trail, size, price,
 * waitTurns}` or `{ok: false, code, need}`) with where it is about (`p`, `q`, `tile`, `host`: null for a host that
 * is being formed) and the words the page says for it (`text`); null when no place is in hand.
 */
let raiseShown = '';
function syncRaisePreview(model) {
  if (!FS.proto) { if (raiseShown) { raiseShown = ''; try { mapRef?.showRaisePreview?.(null); } catch { /* the board's own */ } } return; }
  // (the host that has the hand: what the world says of its own tile is the bar's first button)
  if (model?.kind === 'host' && pm.fights(model.host) && !pm.hostActs(FS, model.host.id)) wantPreview({ host: String(model.host.id), p: model.host.p, q: model.host.q, tile: model.host.tile }, () => renderHand());
  const x = protoPlaceNow(model);
  const a = x ? wantPreview(x, () => { renderHand(); if (tipAt) showTip(tipAt.hit, tipAt.at); }) : null;
  const key = x && a ? `${pm.previewKey(FS, x)}|${a.ok}` : '';
  if (key === raiseShown) return;
  raiseShown = key;
  try { mapRef?.showRaisePreview?.(x && a ? { ...a, p: x.p, q: x.q, tile: x.tile, host: x.host ?? null, text: pm.previewLine(FS, a)?.text ?? '' } : null); } catch (e) { console.error('frontier proto board:', e); }
}
/**
 * What the page said a banner at a place would bring when the player chose it (the preview's own answer at that
 * moment), kept by place: the raise card says so when the world now gives fewer tiles (hud/proto.mjs raiseCard).
 */
function protoPromise(x) {
  const P = FS.proto, a = P && x ? pm.previewOf(FS, x) : null;
  if (!a?.ok || !Number.isInteger(x.tile)) return;
  (P.promised ??= new Map()).set(`${x.p},${x.q},${x.tile}`, { size: Number(a.size ?? (a.tiles ?? []).length), tiles: [...(a.tiles ?? [])], turn: FS.nowBell ?? null });
  if (P.promised.size > 24) P.promised.delete(P.promised.keys().next().value);
}
/** The tile under the pointer becomes the place in hand a moment after the pointer rests on it (one request per tile, not per pixel). */
function protoHover(hit) {
  if (!FS.proto) return;
  let next = null;
  if (hit && Number.isInteger(hit.idx) && !FS.compose) {
    const model = handNow();
    if (model?.kind === 'village' && model.pop === 'muster') {
      const m = hand.musterPlace(FS, model);
      if (m && (FS.hand?.pick?.tiles ?? []).some(t => t.p === hit.p && t.q === hit.q && t.tile === hit.idx)) next = { ...m, tile: hit.idx };
    } else if (model?.kind === 'host' && pm.fights(model.host) && model.march?.ok && !FS.hand?.pick && !(hit.p === model.host.p && hit.q === model.host.q && hit.idx === model.host.tile)
      && !(FS.survey && !FS.survey.showAll && FS.survey.levelOf(hit.p, hit.q, hit.idx) === 0)) next = { host: String(model.host.id), p: hit.p, q: hit.q, tile: hit.idx };
  }
  const same = (a, b) => (a === null || b === null ? a === b : a.p === b.p && a.q === b.q && a.tile === b.tile && (a.host ?? '') === (b.host ?? ''));
  if (same(next, hoverPlace)) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { hoverPlace = next; syncRaisePreview(handNow()); if (tipAt) showTip(tipAt.hit, tipAt.at); }, next ? 150 : 0);
}
/** What the hover tip says of a tile under the banner rule: the banner or the village land there, and the preview of the place in hand. Each line says 試作. */
function protoTipLines(hit) {
  if (!FS.proto || !hit || !Number.isInteger(hit.idx) || FS.view.lod !== 'tile') return [];
  if (FS.survey && !FS.survey.showAll && FS.survey.levelOf(hit.p, hit.q, hit.idx) < 2) return [];
  const out = [], land = pm.landOf(FS, hit.p, hit.q), k = land ? pm.kindAt(land, hit.idx) : null;
  if (k?.kind === 'banner' && k.banner) for (const x of pm.bannerLines(FS, hit.p, hit.q, k.banner, land.resolvedNext).filter(y => !y.quiet)) out.push(html`<span class="tip-proto${x.tone ? ` tone-${x.tone}` : ''}">${out.length ? '' : protoHud.tagHtml()}${x.text}</span>`);
  else if (k?.kind === 'village' && (FS.holdings ?? []).some(h => h.p === hit.p && h.q === hit.q && h.site === k.site)) out.push(html`<span class="tip-proto">${protoHud.tagHtml()}${L`村の土地 ${fmtNum(land.claim.filter(c => c === k.site).length)}マス`}</span>`);
  // (what a banner on the tile in hand would bring, or why none can rise, is said once, by the board's own chip on
  // that tile — map/protoboard.mjs —: the tip beside the pointer said the same words a second time)
  return out;
}
/** The inspector's lines of the selection under the banner rule (a tile's land, the province's card). */
function protoLandCard() {
  const s = FS.selected;
  if (!FS.proto || !s || !Number.isInteger(s.p)) return '';
  if (!Number.isInteger(s.idx)) return protoHud.provinceCard(FS, s.p, s.q);
  if (FS.survey && !FS.survey.showAll && FS.survey.levelOf(s.p, s.q, s.idx) < 2) return '';
  return protoHud.tileCard(FS, s.p, s.q, s.idx);
}
/**
 * The feed's lines of the prototype since the last look: the log's new records (each also told on the effects bus:
 * `proto:land` {record, own, turn} — the board's moments are driven by these records and by nothing else), and what
 * has come to threaten the viewer's land (the land records' `contested` and `rising`), with 軍勢を送る.
 */
function protoNews() {
  const P = FS.proto;
  if (!P) return [];
  const { records, items: told } = pm.freshNews(FS);
  for (const x of records) fxEmit('proto:land', { record: x.record, own: x.own, turn: FS.nowBell ?? null });
  // (a phone: the board's own chip says 「+7マス あなたの土地になりました」 where the land is, and the notice that said
  // the same dropped over the flag as it landed — the line is kept in the list and raised as no notice; and for a
  // moment after a record of the viewer's own, no new notice comes down over the map at all)
  const small = phone(), items = small ? told.map(x => (x.gain ? { ...x, quiet: true } : x)) : told;
  if (small && records.some(x => x.own || x.did)) P.toastHold = Date.now() + PROTO_TOAST_HOLD_MS;
  if (records.some(x => x.did && ['TEND', 'WALK'].includes(String(x.record.op ?? '').toUpperCase()))) P.guide.walked = true;
  const seen = (P.threatSeen ??= new Set()), news = [...items], standing = (P.threatsUp ??= new Map());
  const now = pm.threatsOf(FS);
  P.threatsNow = new Set(now.map(t => t.id));
  for (const t of now) {
    standing.set(t.id, t);
    if (seen.has(t.id)) continue;
    seen.add(t.id); P.guide.threat = true;
    // (`own`: a notice of its own on the board even while a sheet is open or the turn's notices are gathered into one line)
    news.push({ id: t.id, kind: 'proto', proto: true, own: true, alarm: true, bell: FS.nowBell ?? null, p: t.p, q: t.q, tile: t.tile, text: t.text, ...(Number.isInteger(t.slot) ? { banner: { p: t.p, q: t.q, slot: t.slot } } : {}), send: { p: t.p, q: t.q, tile: t.tile } });
  }
  // (a threat that was told of and stands no longer: what the records say became of it — the other nation's count is
  // gone, the banner was defended — said once; a tile a host of the viewer's now holds is the guide's next step)
  for (const [id, was] of standing) {
    if (now.some(t => t.id === id)) continue;
    const line = pm.threatGone(FS, was);
    // (what became of it, for the guide's list: stopped, ended, kept — or the banner rose, or was taken)
    { const out = pm.threatOutcome(FS, was); if (out) P.guide.answer = out; }
    if (!line) { if ((FS.nowBell ?? 0) > (was.goneAt ??= FS.nowBell ?? 0) + 2) standing.delete(id); continue; }
    standing.delete(id);
    if (line.won) P.guide.won = { p: was.p, q: was.q, tile: was.tile };
    // (`lead`: on a phone, which shows one notice, what became of the threat comes before the turn's own card, as the threat's notice did)
    news.push({ ...line, own: true, lead: true });
  }
  if (news.length) invalidate('rail', 'map');
  return news;
}
/** How long a phone keeps new notices back after a record of the viewer's own land (ms): the moment on the board is seen first. */
const PROTO_TOAST_HOLD_MS = 1600;
/** 旗の土地を1マス広げる: the tiles the banner's land could take are lit, and a tap on one is the choice (the world judges the order). */
function protoDressPick() {
  const sub = hand.subjectOf(FS);
  const s0 = sub?.kind === 'host' ? pm.hostSituation(FS, sub.host) : null;
  // (the banner to widen: the one the host stands in or beside; or, for a host whose own card is the raise, the
  // banner of the viewer's that the world says it could widen — hud/proto.mjs opens that banner's card on a press)
  const s = s0?.mode === 'own' && s0.mine ? s0 : s0?.mode === 'rising' && s0.widen && FS.hand?.widen ? s0.widen : null;
  if (!s) return;
  if (FS.hand?.pick?.kind === 'dress') { endPick(); FS.hand = { ...FS.hand, tile: undefined }; invalidate('map', 'panel'); return; }
  // (the world says which tiles this host could add, where it serves that; else the page lights a hint and the world judges the order)
  const tiles = Array.isArray(s.dress?.tiles) ? s.dress.tiles.map(t => ({ p: sub.host.p, q: sub.host.q, tile: t })) : pm.dressTiles(FS, sub.host.p, sub.host.q, s.banner, hand.ownHosts(FS));
  if (!tiles.length) { const say = () => L`広げられるマスが、軍勢のそばにありません（旗の土地のとなりに軍勢を立たせましょう）`; summary(say); FS.notice = { ok: false, code: 'NoHostBeside', text: say }; invalidate('panel'); return; }
  FS.hand = { ...(FS.hand ?? {}), tile: undefined, pick: { kind: 'dress', tiles, origin: { p: sub.host.p, q: sub.host.q, tile: s.banner.pole }, max: 1, label: L`ここを広げる`, token: ++pickSeq, external: false, t0: fxNow() } };
  summary(() => L`光っているマスを押して、広げるマスを選びます`);
  invalidate('map', 'panel');
  // (the lit tiles lie round the banner: it comes into the part of the map above the card, and the view goes back when the card closes)
  if (mapRef) { camKeep.keep('pop'); const at = { p: sub.host.p, q: sub.host.q, tile: s.banner.pole }; setTimeout(() => { if (FS.hand?.pick?.kind === 'dress' && mapRef) { mapRef.tick(); mapRef.flyTo({ ...at, zoom: Math.min(mapRef.view.zoom, 1.0) }, null, { auto: true }); } }, 80); }
}
/** 軍勢を送る: the strongest fighting host that can march gets the order card with the threatened tile as its destination (the player seals it). */
async function protoSend(to) {
  if (!FS.proto || ![to.p, to.q, to.tile].every(Number.isInteger)) return;
  closeDialPop();
  const fighting = hand.ownHosts(FS).filter(r => pm.fights(r)), checks = fighting.map(r => [r, hand.marchCheck(FS, r)]);
  const row = checks.filter(([, c]) => c.ok).map(([r]) => r).sort((a, b) => b.troops - a.troops)[0] ?? null;
  // (the first minute of a turn: hosts could march but their province has not caught up. Said as that — the page
  // said "form a new host" and opened the village's card, which was the wrong reason and the wrong remedy)
  const lag = !row ? checks.find(([, c]) => c.code === 'NotResident')?.[1] ?? null : null;
  if (lag) { mapNote({ p: to.p, q: to.q, idx: to.tile }, () => lag.text); invalidate('map', 'panel'); return; }
  if (!row) {
    // nobody can march now: the village's card for a new host (or for training) stands open, and the map says why
    const say = () => L`いま進軍できる軍勢がいません。新しい軍勢を編成しましょう`;
    protoGuideGo({ go: 'form' });
    summary(say); FS.notice = { ok: false, code: 'HostBusy', text: say }; invalidate('panel');
    return;
  }
  await composeTo(row, to);
}
/** The order card of a host with a tile as its destination (the player reads it and seals it, or puts it away). */
async function composeTo(row, to) {
  if (Number.isInteger(row.holdingIndex) && row.holdingIndex !== (FS.activeHolding ?? 0)) FS.activeHolding = row.holdingIndex;
  endPick(); FS.hand = null;
  ACTIONS.compose({ host: row.id, stay: 'map' });
  if (!FS.compose) return;
  FS.tab = 'map'; FS.report = null; FS.practice = null; FS.guideOpen = false; FS.explore = null; FS.inspectOpen = false;
  FS.selected = { kind: 'tile', p: to.p, q: to.q, idx: to.tile };
  invalidate('map', 'panel', 'tabs', 'rail');
  await ACTIONS['dest-quick']({ p: String(to.p), q: String(to.q), tile: String(to.tile) });
  if (FS.compose?.routeError) mapNote({ p: to.p, q: to.q, idx: to.tile }, refusalText(FS.compose.routeError, { p: to.p, q: to.q, idx: to.tile }));
  // (a march of the viewer's is already sealed for that province and that turn: the sample world lets one host of a
  // citizen in a turn, and the second would be turned back at its seal's opening — the answer to a threat was lost
  // that way, with a forecast that said it would win. The card the page makes names the next turn that is free, and
  // says why; the player can still step it back)
  const c = FS.compose;
  if (c && FS.proto && FS.season && Number.isInteger(c.arriveBell) && pm.ownArrivalAt(FS, to, c.arriveBell, row.id)) {
    const w = arrivalWindow(FS.season, FS.nowBell ?? 0, c.earliest);
    let b = c.arriveBell;
    while (b < w.max && pm.ownArrivalAt(FS, to, b, row.id)) b++;
    if (!pm.ownArrivalAt(FS, to, b, row.id)) { c.protoShift = { from: c.arriveBell, to: b }; c.arriveBell = b; invalidate('panel', 'map'); }
  }
}
/** The province the guide's march goes to: the other province of the viewer's own wedge in ring 2 (the one whose land record is on the page, when one is), or null. */
function marchProvince(row) {
  if (!Number.isInteger(FS.citizen?.faction)) return null;
  const near = ringProvinces(2).filter(pq => wedgeOf(pq.p, pq.q) === FS.citizen.faction && !(pq.p === row.p && pq.q === row.q));
  return near.find(pq => FS.proto?.lands?.has(`${pq.p},${pq.q}`)) ?? near[0] ?? null;
}
/**
 * The guide's march: the world is asked what a banner of this host would bring on every tile of the province the
 * march goes to, and the widest of its answers is kept for the bar's one button (hud/proto.mjs armedNote) with the
 * settled turn it was said at. Asked again when that turn has moved on.
 */
function wantMarchBest(row) {
  const P = FS.proto, next = P && row ? marchProvince(row) : null;
  if (!next) return;
  const take = all => {
    if (FS.proto !== P || !Array.isArray(all)) return;
    const w = pm.widestPlace(all);
    const best = w ? { host: String(row.id), p: next.p, q: next.q, tile: w.tile, size: w.size, r: pm.landOf(FS, next.p, next.q)?.resolvedNext ?? null } : null;
    const same = (a, b) => (!a || !b ? a === b : a.host === b.host && a.p === b.p && a.q === b.q && a.tile === b.tile && a.size === b.size && a.r === b.r);
    if (same(best, P.marchBest ?? null)) return;
    P.marchBest = best;
    // (after the drawing that asked: the bar's line is built before this answer is in the store)
    setTimeout(renderHand, 0);
  };
  const held = wantPlaces({ host: String(row.id), p: next.p, q: next.q }, take);
  if (Array.isArray(held)) take(held);
}
/**
 * While the guide's march is armed (a fighting host in hand that can march, no card over the board, the guide at the
 * step of the march), the widest place is kept up with the settled turn: an answer of an older turn is not offered
 * (hud/proto.mjs armedNote), and on a running clock the button was gone a turn after the guide was pressed.
 */
function keepMarchBest(model) {
  if (!FS.proto || model?.kind !== 'host' || model.pop || FS.compose || !model.march?.ok || !pm.fights(model.host)) return;
  const g = pm.guideModel(FS);
  if (g?.current === 'march' && g.go?.data?.go === 'march') wantMarchBest(model.host);
}
/** いちばん広く取れるマスを選ぶ: the order card of the host in hand with that tile as its destination. */
async function protoMarchBest(to) {
  const sub = hand.subjectOf(FS);
  if (!FS.proto || sub?.kind !== 'host' || ![to.p, to.q, to.tile].every(Number.isInteger)) return;
  const check = hand.marchCheck(FS, sub.host);
  if (!check.ok) { mapNote({ p: sub.host.p, q: sub.host.q, idx: sub.host.tile }, () => check.text); invalidate('map', 'panel'); return; }
  // (the tile comes into the part of the map the order card leaves free)
  await composeTo(sub.host, to);
  if (FS.compose && mapRef) setTimeout(() => { if (FS.compose && mapRef) { mapRef.tick(); mapRef.flyTo({ p: to.p, q: to.q, tile: to.tile, zoom: Math.min(mapRef.view.zoom, 0.9) }, null, { auto: true }); } }, 120);
}
/**
 * The guide's march: the host and the other province of the viewer's own wedge come into one picture (the ground a
 * march can reach lies off the screen of a player who has only looked at the village), still near enough for tiles.
 */
function frameMarchGround(row) {
  if (!mapRef || !Number.isInteger(FS.citizen?.faction)) return false;
  // (the province's record need not be here yet: a player who has kept the camera close to the village has never had
  // that province in the picture, and the guide framed nothing then — the ground to march to stayed off the screen)
  const next = marchProvince(row);
  if (!next) return false;
  const pt = x => project(x.q, x.r), a = pt(tileHex(row.p, row.q, row.tile)), b = pt(tileHex(next.p, next.q, 30));
  wantProvince(next.p, next.q, () => { mapRef?.invalidate(); invalidate('panel'); });
  // (after the map has framed the host's near reach, which it does once for a new selection: this view is the wider one)
  setTimeout(() => {
    if (!mapRef || FS.hand?.host !== String(row.id) || FS.compose) return;
    const size = mapRef.size(), ins0 = mapRef.inset?.() ?? hudInsets();
    // (the card of 進軍 stands over the foot of the map on a wide screen, and the ground to march to lay under it: the
    // two places are framed in the part of the map above the card)
    const cv = $('frontier-map')?.getBoundingClientRect?.(), k = handPopEl && !handPopEl.hidden ? handPopEl.getBoundingClientRect() : null;
    const cover = cv && k && k.height > 0 ? Math.max(0, cv.bottom - k.top + 12) : 0, ins = { ...ins0, bottom: Math.max(ins0.bottom ?? 0, cover) };
    const freeW = Math.max(200, size.width - (ins.left ?? 0) - (ins.right ?? 0)), freeH = Math.max(200, size.height - (ins.top ?? 0) - (ins.bottom ?? 0));
    // (a province is about nine tiles across: half of one round each end of the line between the two places)
    const zoom = Math.max(0.56, Math.min(mapRef.view.zoom, 0.9, freeW / (Math.abs(a.x - b.x) + 560), freeH / (Math.abs(a.y - b.y) + 440)));
    camKeep.touch();
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (cover > (ins0.bottom ?? 0) && typeof mapRef.aim === 'function') mapRef.flyTo({ ...mapRef.aim(mid, zoom, size, ins), zoom }, null, { exact: true });
    else mapRef.flyTo({ ...mid, zoom });
  }, 450);
  return true;
}
/** The guide's one button for a step (hud/proto.mjs guideNext): the thing to do stands ready on the board. */
function protoGuideGo(d) {
  if (!FS.proto) return;
  const hi = FS.activeHolding ?? 0;
  const form = () => {
    const h = (FS.holdings ?? [])[hi];
    const ready = h && [0, 1, 2, 3, 4, 5].some(u => Number(h.reserve?.[u] ?? 0) >= 100);
    selectVillage(hi, ready ? 'muster' : 'train');
  };
  if (d.go === 'steps') { HUD_ACTIONS['guide-open'](); return; }
  if (d.go === 'host') {
    const row = hand.ownHosts(FS).find(r => r.id === String(d.host)) ?? null;
    if (row && selectHost(row, { fly: true })) { setPop('banner'); return; }
    form(); return;
  }
  if (d.go === 'march') {
    // (the smallest host that can march goes for new land; the strongest stays to answer a threat)
    const checks = hand.ownHosts(FS).filter(r => pm.fights(r)).map(r => [r, hand.marchCheck(FS, r)]);
    // (first a host that stands on the pole of a banner it has raised, last one that is counting toward a banner or
    // taking its place for a walk — proto/hand-model.mjs marchRank —: the guide took the host formed for the walk)
    const row = checks.filter(([, c]) => c.ok).map(([r]) => r).sort((a, b) => pm.marchRank(FS, a.id) - pm.marchRank(FS, b.id) || Number(a.troops) - Number(b.troops))[0] ?? null;
    // (the first minute of a turn: hosts could march but their province has not caught up. The host is taken in hand
    // all the same, with the reason on the map: its bar lights 進軍, and says what to press, the moment the province
    // has caught up — the press did nothing but show the reason, and had to be made again)
    const waits = !row ? checks.filter(([, c]) => c.code === 'NotResident').sort(([a], [b]) => pm.marchRank(FS, a.id) - pm.marchRank(FS, b.id) || Number(a.troops) - Number(b.troops))[0] ?? null : null;
    if (waits) {
      const [at, lag] = waits;
      if (selectHost(at, { fly: true })) frameMarchGround(at);
      mapNote({ p: at.p, q: at.q, idx: at.tile }, () => lag.text); invalidate('map', 'panel');
      return;
    }
    // (on a phone the card of 進軍 is a sheet over the lower half of the map, where the ground to march to lies: the
    // host is taken in hand without it — a press on a tile gives the order card, as for any host in hand)
    // (and on a wide screen too, since the fixing pass: the card stood over the very ground the march goes to. The bar's
    // own line says what to press and why — hud/proto.mjs armedNote —, and the board is left free)
    if (row && selectHost(row, { fly: true })) { summary(() => L`行き先のマスを押します`); frameMarchGround(row); wantMarchBest(row); return; }
    form(); return;
  }
  if (d.go === 'walk') {
    // (a host the world lets walk a banner of the viewer's: one that came there after the last walk. The host that
    // raised a banner stood there already and may not: then a new host is formed in or beside the banner's land)
    const sit = hand.ownHosts(FS).map(r => [r, pm.hostSituation(FS, r)]);
    const row = (sit.find(([, x]) => x?.mode === 'own' && x.tend?.ok) ?? [])[0] ?? null;
    if (row && selectHost(row, { fly: true })) { setPop('banner'); return; }
    // (the card that opens says why it opened: FS.hand.why, shown as one line of the prototype on it)
    form(); FS.hand = { ...(FS.hand ?? {}), protoWhy: 'walk' }; invalidate('panel'); renderHand();
    summary(() => L`見回れるのは、旗の土地に新しく立った軍勢です`);
    // (the new host's card frames the village; the land to form it on is a banner's: the nearest banner of the
    // viewer's in the village's own province comes into the part of the map above the card instead)
    { const h = (FS.holdings ?? [])[hi];
      const own = h ? (pm.landOf(FS, h.p, h.q)?.banners ?? []).filter(b => pm.isOwnBanner(FS, h.p, h.q, b)).map(b => ({ tile: b.pole, tiles: b.tiles ?? [], d: pm.tileSteps(b.pole, h.tile) })).sort((a, b) => a.d - b.d) : [], poles = own;
      // (and the place the card names is a tile of that banner's land, not the village's own tile: the card opened on
      // the village, and a host formed there with one press could walk nothing — the step then asked for training again)
      if (FS.hand?.pop === 'muster' && FS.hand?.pick?.kind === 'muster' && !Number.isInteger(FS.hand.tile)) {
        const free = new Set((FS.hand.pick.tiles ?? []).map(t => t.tile)), taken = new Set(hand.ownHosts(FS).filter(r => r.p === h.p && r.q === h.q).map(r => r.tile));
        const at = own.flatMap(b => b.tiles.filter(t => t !== b.tile && free.has(t) && !taken.has(t)))[0];
        if (Number.isInteger(at)) { FS.hand = { ...FS.hand, tile: at }; invalidate('map', 'panel'); renderHand(); }
      }
      if (poles.length && FS.hand?.pop === 'muster' && mapRef) setTimeout(() => whenStill(() => { if (FS.hand?.pop === 'muster' && FS.hand?.protoWhy === 'walk') clearOfCard({ p: h.p, q: h.q, tile: poles[0].tile }); }), 160); }
    return;
  }
  form();
}

// ------------------------------------------------------------------ the viewer's villages for the map (map/ownland.mjs)
let ownCache = { holdings: null, lang: null, value: [] };
/** The viewer's villages with their names (the far view's beacon carries the name). */
function ownNow() {
  const hs = FS.holdings ?? [];
  if (ownCache.holdings !== hs || ownCache.lang !== lang()) ownCache = { holdings: hs, lang: lang(), value: hs.map(h => ({ p: h.p, q: h.q, tile: h.tile, tier: h.tier ?? 0, state: h.state ?? null, name: holdingName(h) })) };
  return ownCache.value;
}
/**
 * The times of the wait for the village, for the map's countdown (map/waitview.mjs): `{now, nextTurnAt, resultAt,
 * first}` in chain seconds; `resultAt` when the open request's result is due (fland.mjs ticketTimes), `first` the
 * candidate tried first; `said` while the wait view shows the same time itself. Null outside the wait.
 */
function waitNow() {
  const st = FS.land?.stage;
  if (FS.mode !== 'play' || !FS.clock || !['joined', 'ticket', 'refugee'].includes(st)) return null;
  const now = FS.chain?.now?.() ?? null;
  if (!Number.isFinite(now)) return null;
  const bell = FS.nowBell ?? Math.max(0, Math.floor((now - FS.clock.genesisTs) / 600)), t = st === 'ticket' ? FS.land.ticket ?? null : null;
  let resultAt = null, tollAt = null, share = null;
  try { resultAt = t ? ticketTimes(FS.clock, t.bell).resultAbout : null; } catch { resultAt = null; }
  // (the bell that decides the village: the toll just before the result; the wait's clocks all count to it, as the dial does)
  if (resultAt !== null) { tollAt = bellStart(FS.clock.genesisTs, Math.floor((resultAt - FS.clock.genesisTs) / 600)); const from = bellStart(FS.clock.genesisTs, t.bell); share = Math.max(0, Math.min(1, (now - from) / Math.max(1, tollAt - from))); }
  // one countdown on the screen (UX design 11.10): while the wait view stands open with its own clock, the map leaves its line out
  const said = drawerOf(FS)?.kind === 'wait' && !(phone() && sheetRef?.state() === 'peek');
  // the leader's line likewise: a phone's wait view says it in the sheet (screens/join.mjs waitHead), so the map leaves its own out
  // (the card says the nation's words whenever it stands open, on every size: the map then leaves its own out)
  const wordsSaid = drawerOf(FS)?.kind === 'wait' && !(phone() && sheetRef?.state() === 'peek');
  return { now, nextTurnAt: bellStart(FS.clock.genesisTs, bell + 1), resultAt, tollAt, share, first: t ? t.next ?? 0 : null, said, wordsSaid, state: st === 'ticket' ? 'ticket' : FS.autoTicket?.state ?? null };
}
/** The village that lands now, the first time this device sees it (map/landing.mjs). */
const landingBook = createLandingBook();
// the S1 marks, rebuilt when a feed or the bell changes (the map asks for its source every frame)
let s1Memo = null;
function s1MarksNow() {
  const s1 = FS.s1;
  if (!s1) return null;
  const bell = FS.nowBell ?? null;
  if (s1Memo?.c !== s1.caravans || s1Memo.s !== s1.structures || s1Memo.bell !== bell || s1Memo.n !== FS.holdings?.length) {
    // (the provinces' caravan slots say which caravans an open raid holds; they are read again at the next bell)
    s1Memo = { c: s1.caravans, s: s1.structures, bell, n: FS.holdings?.length, marks: s1Marks(s1, { own: ownTag(FS), bell, provinces: FS.provinces }) };
  }
  return s1Memo.marks;
}

function landingNow() {
  if (FS.mode !== 'play' || !viewerKnown || !FS.wallet?.address) return null;
  const sc = scope();
  return sc ? landingBook.next(landedKey(sc, FS.wallet.address), FS.holdings ?? []) : null;
}
/** The village whose landing is about to be reported (the page does not know its viewer for sure yet): its key, or null (map/landing.mjs peek). */
function landingSoon() {
  if (FS.mode !== 'play' || viewerKnown || calm() || !FS.wallet?.address) return null;
  const sc = scope();
  return sc ? landingBook.peek(landedKey(sc, FS.wallet.address), FS.holdings ?? []) : null;
}

/** The map's name tags use the viewer's verified profile on their own holdings. */
function ownNamer(base) {
  const p = FS.ownProfile, tag = p ? ownTag(FS) : null;
  if (!p || tag === null) return base;
  const key = tagKey(tag);
  return (...a) => { const r = base(...a); if (!r || r.identity.tag !== key) return r; const id = withProfile(r.identity, p); return { ...r, identity: id, name: displayName(id) }; };
}
let profileChecked = null;
/** Load and verify the stored profile once per (season, wallet). */
async function checkOwnProfile() {
  const sc = scope(), w = FS.wallet?.address;
  const k = sc && w ? `${sc.seasonId}:${w}` : null;
  if (!k || k === profileChecked) return;
  profileChecked = k;
  const p = profile.loadOwnProfile(uiStorage, sc.seasonId, w);
  FS.ownProfile = p && (await profile.verifyProfile(p)) ? p : null;
  if (FS.ownProfile) { peopleCache.at = -1; invalidate('panel', 'rail', 'map'); }
}
async function saveOwnName(raw) {
  const sc = scope(), w = FS.wallet;
  const name = profile.validName(raw);
  if (!name) { FS.notice = { ok: false, code: 'BadName', text: L`名前は1〜24文字の文字・数字・空白・「-」「_」「.」で付けてください` }; invalidate('panel'); return; }
  if (!sc || !w?.signMessage) return;
  FS.nameBusy = true; invalidate('panel');
  try {
    const p = await profile.makeProfile({ season: sc.seasonId, wallet: w.address, name }, async bytes => (await w.signMessage(bytes)).signature);
    if (!(await profile.verifyProfile(p))) throw Object.assign(new Error('verify'), { code: 'WalletBadSignature' });
    profile.saveOwnProfile(uiStorage, p);
    FS.ownProfile = p;
    FS.notice = { ok: true, text: L`名前を「${name}」にしました` };
  } catch (e) {
    FS.notice = { ok: false, code: e?.code ?? 'Error', text: L`名前を保存できませんでした（${e?.code ?? e?.message ?? 'error'}）` };
  } finally { FS.nameBusy = false; peopleCache.at = -1; invalidate('panel', 'rail', 'map'); }
}

// ------------------------------------------------------------------ the guide (hud/guide.mjs)
/** The to-do pill's items at the guide's level: all, warnings only, or none. */
function pillItems() {
  const lv = guide.guideLevel(FS);
  if (lv === 'off') return [];
  const items = hud.attentionItems(FS);
  return lv === 'warn' ? items.filter(x => guide.WARN_KINDS.has(x.kind)) : items;
}
let guideCache = { at: 0, value: null };
function guideNow() {
  const t = Date.now();
  if (t - guideCache.at > 1000) guideCache = { at: t, value: guide.guideTarget(FS) };
  return guideCache.value;
}
/**
 * The one "next thing" (UX design 11.11; hud/hud.mjs nextThing): while the guide runs, its step; afterwards the
 * most pressing to-do item. A viewer without a village has the plate's own button instead (the first minute).
 */
function nextNow() {
  if (FS.mode !== 'play') return null;
  const items = pillItems();
  // (with the prototype rule "banners" on, its guided first minutes have the one prompt; a warning of an attack still comes first)
  const pg = FS.proto && holdsLand(FS) && guide.guideLevel(FS) === 'all' && items[0]?.kind !== 'incoming' ? protoHud.guideNext(FS) : null;
  if (pg) return pg;
  return hud.nextThing(FS, { guide: holdsLand(FS) ? onboardingCard.objectiveModel(FS) : null, items });
}
/** The guide card's "show me": the target in view, and for the first march the card with host and destination filled in. */
async function guideGo() {
  const g = guide.guideTarget(FS);
  if (!g) return;
  // (the guide's step is done on the board: the village is selected and the card of the step stands open above its bar.
  // It opened a drawer and scrolled to a card: a list where the board should speak)
  const hi = (FS.holdings ?? []).findIndex(o => o.p === g.p && o.q === g.q && o.tile === g.tile);
  if (g.kind === 'build') { selectVillage(hi, 'build'); return; }
  if (g.kind === 'train' || g.kind === 'muster') {
    selectVillage(hi, g.kind);
    FS.hand = { ...(FS.hand ?? {}), unit: 0, n: 200, troops: 200 };
    invalidate('panel'); return;
  }
  if (g.kind === 'scout') {
    // a Scout host that can explore has the hand; else the reserve's Scouts are formed up; else Scouts are trained
    const scout = hand.ownHosts(FS).find(r => r.unit === 6 && hand.exploreCheck(FS, r).ok) ?? null;
    if (scout) { selectHost(scout, { fly: true }); setPop('explore'); return; }
    const hasScouts = (hud.activeHolding(FS)?.reserve?.[6] ?? 0) >= 100;
    selectVillage(hi, hasScouts ? 'muster' : 'train');
    FS.hand = { ...(FS.hand ?? {}), unit: 6 };
    return;
  }
  if (g.kind === 'march') {
    goToItem({ p: g.p, q: g.q, tile: g.tile, tab: 'map' });
    if (g.host && FS.mode === 'play' && !FS.compose) {
      ACTIONS.compose({ host: g.host, stay: 'map' });
      setLens('war');
      await ACTIONS['dest-quick']({ p: String(g.p), q: String(g.q), tile: String(g.tile) });
    }
  }
}

function nudgeField(el, name, f) {
  const i = el?.closest?.('form')?.querySelector?.(`input[name="${String(name).replace(/[^\w-]/g, '')}"]`);
  if (!i) return;
  const min = i.min === '' ? -Infinity : Number(i.min), max = i.max === '' ? Infinity : Number(i.max);
  i.value = String(Math.max(min, Math.min(max, Math.round(f(Number(i.value) || 0)))));
  i.dispatchEvent(new Event('input', { bubbles: true }));
}

function closeResPop() { if (FS.resOpen) { FS.resOpen = null; renderHudTick(FS.chain?.now?.() ?? 0); } }

/** The march card's forecast: recomputed with the rules when the composed march changes (hud/forecast.mjs). */
let fcBusy = null;
function updateForecast() {
  const c = FS.compose;
  const key = forecastKey(c);
  if (!key || !c.route || c.sending) return;
  if (c.forecast?.key === key || fcBusy === key) return;
  // (a destination out of sight: no forecast. It would be worked out from the province's whole record, the hosts the
  // viewer cannot see among them, and its numbers would tell of them: a fort's tile out of sight said only "守り N"
  // while the forecast counted N and every host on it. The independent audit of 2026-10-24, older than the uplift,
  // which had made it easier to see. Same reading of sight as the card's: hud/marchcard.mjs)
  if (FS.survey && !FS.survey.showAll && FS.survey.levelOf(c.dest.p, c.dest.q, c.dest.tile) < 3) {
    c.forecast = { key, ok: false, why: 'OutOfSight' }; c.compare = null; invalidate('panel'); return;
  }
  fcBusy = key;
  c.forecast = { key, pending: true };
  invalidate('panel');
  seasonKernel().then(k => {
    if (FS.compose !== c || forecastKey(c) !== key) return;
    const prov = FS.provinces.get(`${c.dest.p},${c.dest.q}`)?.province ?? null;
    let fc;
    try { fc = forecast(k, c, prov, FS.citizen?.faction ?? 0); } catch (e) { fc = { ok: false, why: e?.code ?? 'Error' }; }
    c.forecast = { key, ...fc };
    // the stances side by side (the card's comparison): once per destination, turn and retreat, not per stance chosen
    const ck = compareKey(c);
    if (fc.ok && c.compare?.key !== ck) c.compare = { key: ck, rows: compareStances(k, c, prov, FS.citizen?.faction ?? 0) };
  }).catch(() => { if (FS.compose === c) c.forecast = { key, ok: false, why: 'NoWasm' }; })
    .finally(() => { fcBusy = null; invalidate('panel'); });
}

/** A holding as the next instruction will find it (hud/rulebook.mjs `settled`: a finished building already produces): what the strip shows can be spent now. */
const settledHolding = (h, now) => { try { return h ? settled(h, now) : h; } catch { return h; } };

/** Once a second: compare the page's state with the last look and start the moments it shows (people/moments.mjs). */
let momentPrev = null;
/** The viewer's villages ("P,Q,site") at the last look of checkMoments. */
let ownSitesSeen = new Set();
function checkMoments() {
  if (!FS.provinces) return;
  const next = momentSnapshot({ life: FS.life ?? new Map(), constructions: constructionsNow(), provinces: FS.provinces, bell: FS.nowBell ?? null, logged: FS.chronicle !== undefined && FS.isMine !== undefined });
  const t = performance.now() / 1000;
  const fresh = detectMoments(momentPrev, next, t);
  momentPrev = next;
  // each is reported on the effects bus and played by fx/stage.mjs (`own`: the viewer's own village or host)
  // (`lost` / `taken`: a site that was a village of the viewer's at the last look and is someone else's now, or none; a
  // site the viewer holds now that another nation held: the two largest things that happen to a player, which played
  // as small as a finished sawmill. The holdings no longer list a village just taken, so the last look's are kept)
  const mineNow = new Set((FS.holdings ?? []).map(h => `${h.p},${h.q},${h.site}`));
  for (const m of fresh) {
    const key = `${m.p},${m.q},${m.site}`, village = m.kind === 'village';
    const lost = village && ownSitesSeen.has(key) && !mineNow.has(key);
    const taken = village && mineNow.has(key) && !ownSitesSeen.has(key) && Number.isInteger(m.from) && m.from < 6 && m.from !== FS.citizen?.faction;
    fxEmit('moment', { ...m, lost, taken, own: lost || (FS.holdings ?? []).some(h => h.p === m.p && h.q === m.q && (h.site === m.site || h.tile === m.tile)) || (m.faction !== undefined && m.faction === FS.citizen?.faction && ['muster', 'depart'].includes(m.kind) && (FS.holdings ?? []).some(h => h.p === m.p && h.q === m.q)) });
  }
  if (FS.holdings) ownSitesSeen = mineNow;
}

/** The waiting view's one clock (screens/join.mjs waitClock marks the nodes): its text and its ring, every second. */
function tickTurn() {
  const doc = globalThis.document;
  const el = doc?.querySelector?.('[data-wait-clock]');
  if (!el) return;
  const c = joinScreen.waitClock(FS);
  if (!c) return;
  if (el.textContent !== c.text) el.textContent = c.text;
  doc.querySelector('[data-wait-ring] .ring-fg')?.setAttribute('stroke-dasharray', `${(c.share * 100).toFixed(1)} 100`);
  const note = doc.querySelector('[data-wait-note]'), words = joinScreen.waitNote(c);
  if (note && note.textContent !== words) note.textContent = words;
}

let homeGuideDeadline = null;
function renderHudTick(now) {
  const m = hud.bellModel(FS.clock, now);
  tickTurn();
  if (FS.dialOpen) renderDialPop(now);
  if (instantHomeEnabled(FS.season)) {
    if (Number.isInteger(m.bell) && FS.nowBell !== m.bell) { FS.nowBell = m.bell; invalidate('panel'); }
    for (const el of globalThis.document?.querySelectorAll?.('[data-home-deadline]') ?? []) {
      const left = Number(el.dataset.homeDeadline) - now;
      el.textContent = countdown(left);
      if (left <= 0) invalidate('panel');
    }
    const next = (hud.activeHolding(FS)?.queue ?? []).filter(q => q && Number(q.doneAt) > now).reduce((a, q) => Math.min(a, Number(q.doneAt)), Infinity);
    if (homeGuideDeadline !== null && now >= homeGuideDeadline) invalidate('panel');
    homeGuideDeadline = Number.isFinite(next) ? next : null;
  }
  checkMoments();
  frameRoute();
  updateForecast();
  ringToll(m.bell, m.secondsLeft);
  renderIntro();
  const pill = $('bell-pill');
  if (pill) {
    if (pill.dataset.urgency !== m.urgency) pill.dataset.urgency = m.urgency;
    $('bell-fill')?.style.setProperty('--f', m.frac.toFixed(3));
  }
  // The screen edge warns only while a march is being composed (the bell closes its arrival choice).
  const body = globalThis.document?.body;
  const edge = FS.compose && !FS.compose.sending ? m.urgency : 'calm';
  if (body && body.dataset.urgency !== edge) body.dataset.urgency = edge;
  const strip = $('res-strip');
  if (strip) {
    const tokens = FS.mode === 'play' ? hud.resourceModel(settledHolding(hud.activeHolding(FS), now ?? 0), now ?? 0) : [];
    strip.hidden = !tokens.length;
    // the room left of the dial: more tokens as the strip widens
    const w = globalThis.innerWidth ?? 1440;
    // (a phone's strip: the two most pressing and a chip for the rest, which opens them all; the second review:
    // a strip that scrolled sideways ended in half an icon at the plaque's point)
    const room = w < 380 ? 1 : w <= PHONE_MAX ? 2 : w < 900 ? 2 : w < 1040 ? 3 : w < 1280 ? 4 : w < 1600 ? 5 : 8;
    // (what does not fit is never cut: a strip that overflows its plaque shows one token fewer, and stays so at this width)
    // (tried again now and then: the first measure may have been taken before the fonts were in)
    if (stripFit.w !== w || (stripFit.n = (stripFit.n ?? 0) + 1) % 5 === 0) stripFit = { w, max: room, n: stripFit.w === w ? stripFit.n : 0 };
    setHtmlIfChanged(strip, hud.renderStrip(tokens, FS.resOpen ?? null, Math.min(room, stripFit.max)));
    if (tokens.length && stripFit.max > 1 && strip.scrollWidth > strip.clientWidth + 1) {
      stripFit.max = Math.min(room, stripFit.max, tokens.length) - 1;
      setHtmlIfChanged(strip, hud.renderStrip(tokens, FS.resOpen ?? null, Math.max(1, stripFit.max)));
    }
    resChanges(strip, tokens);
  }
  renderSound();
  publishNoGo();
  renderResPop(now ?? 0);
  checkMilestones();
  checkOwnProfile();
  if (FS.pins === undefined) { const sc = scope(); if (sc) { FS.pins = pins.loadPins(uiStorage, sc.seasonId); if (FS.pins.length) { invalidate('map'); renderMinimap(); } } }
  tickFeed();
  renderFeed();
  renderHand();
  renderProto();
  const attn = $('attn-pill');
  if (attn) {
    // the one prompt: the guide's step while the guide runs, then the most pressing thing (a press does it: its action is the button's own)
    const nx = nextNow();
    attn.hidden = !nx;
    const steps = $('next-steps');
    if (steps) { steps.hidden = nx?.kind !== 'guide'; const t = L`ガイドの手順を見る`; if (steps.getAttribute('aria-label') !== t) { steps.setAttribute('aria-label', t); steps.title = t; } }
    // (the count of other things is part of what the prompt says: it stood at 「ほか 2」 beside a to-do tab of 3)
    const key = nx ? `${nx.kind}|${nx.act}|${JSON.stringify(nx.data)}|${nx.text}|${nx.more}` : '';
    if (nx && attn.dataset.key !== key) {
      for (const k of Object.keys(attn.dataset)) delete attn.dataset[k];
      Object.assign(attn.dataset, Object.fromEntries(Object.entries(nx.data).map(([k, v]) => [k, String(v)])), { key, act: nx.act, next: nx.kind });
      attn.setAttribute('aria-label', L`次にやること：${nx.text}`);
      attn.title = nx.hint || nx.text;
      setHtml(attn, html`${icon(nx.icon, 'next-ic')}${nx.kicker ? html`<span class="next-kicker" aria-hidden="true">${nx.kicker}</span>` : ''}<span class="attn-long" aria-hidden="true"><strong>${nx.short ?? nx.title}</strong>${nx.label && nx.label !== (nx.short ?? nx.title) ? html`<span class="next-do">${nx.label}</span>` : nx.more > 0 ? html`<span class="next-more">${L`ほか ${fmtNum(nx.more)}`}</span>` : ''}</span>${icon('next', 'next-go')}`);
    }
  }
}

// ------------------------------------------------------------------ the strip's small moves
let resSeen = { key: null, values: new Map() };
/** Jumps that wait for the harvest's tokens to land in the strip (fx/stage.mjs `res:gain`): resource → {was, to}. */
const resHeld = new Map();
let harvestDue = 0;
/** Count one token up from `was` to `to` and flash it (visual only; nothing moves under reduced motion). */
function countUp(el, was, to) {
  if (!el) return;
  el.classList.remove('res-wait');
  el.classList.remove('res-bump', 'res-up', 'res-down'); void el.offsetWidth;
  el.classList.add('res-bump', to >= was ? 'res-up' : 'res-down');
  const val = el.querySelector('.res-val');
  if (!val || calm() || !globalThis.requestAnimationFrame) { if (val) val.textContent = fmtNum(to); return; }
  const t0 = fxNow();
  const step = () => {
    const k = Math.min(1, (fxNow() - t0) / 450);
    val.textContent = fmtNum(Math.round(was + (to - was) * (1 - Math.pow(1 - k, 3))));
    if (k < 1 && val.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
/** The harvest's tokens landed: what waited counts up now; with nothing waiting the strip only answers with a flash. */
function resGain() {
  const strip = $('res-strip');
  if (!strip?.querySelector) return;
  harvestDue = 0;
  if (!resHeld.size) { for (const el of strip.querySelectorAll('[data-res]')) { el.classList.remove('res-bump', 'res-up'); void el.offsetWidth; el.classList.add('res-bump', 'res-up'); } return; }
  for (const [res, j] of resHeld) countUp(strip.querySelector(`[data-res="${res}"]`), j.was, j.to);
  resHeld.clear();
}
function mountResGain() {
  // an own harvest is on its way to the strip: a jump of the stores waits for the tokens (at most two and a half seconds)
  fxOn('moment', m => { if (m?.kind === 'harvest' && m.own && !calm()) harvestDue = Date.now() + 2500; });
  fxOn('res:gain', () => resGain());
}
/**
 * A resource that jumps (a harvest, a build paid for) counts up to its new value and flashes;
 * the slow rise of production does neither. Visual only: the number in the page is already the
 * new one, and nothing moves under reduced motion.
 */
function resChanges(strip, tokens) {
  const h = hud.activeHolding(FS);
  const key = h ? `${h.p},${h.q},${h.site}` : null;
  const prev = resSeen.key === key ? resSeen.values : null;
  resSeen = { key, values: new Map(tokens.map(r => [r.resource, r.value])) };
  if (!strip.querySelector) return;
  if (!prev) { resHeld.clear(); return; }
  const waiting = Date.now() < harvestDue;
  // (the tokens never came: what waited counts up now)
  if (!waiting && resHeld.size) { for (const [res, j] of resHeld) countUp(strip.querySelector(`[data-res="${res}"]`), j.was, tokens.find(r => r.resource === res)?.value ?? j.to); resHeld.clear(); }
  for (const r of tokens) {
    const el = strip.querySelector(`[data-res="${r.resource}"]`);
    const held = resHeld.get(r.resource);
    if (held) {
      // still waiting for the tokens: the number shown stays the old one (the page's value is already the new one)
      held.to = r.value;
      const val = el?.querySelector('.res-val');
      if (val) val.textContent = fmtNum(held.was);
      continue;
    }
    const was = prev.get(r.resource);
    if (was === undefined) continue;
    const d = r.value - was;
    if (Math.abs(d) <= Math.ceil((r.perHour / 3600) * 5) + 1) continue;
    if (!el) continue;
    if (waiting && d > 0) { resHeld.set(r.resource, { was, to: r.value }); const val = el.querySelector('.res-val'); if (val) val.textContent = fmtNum(was); el.classList.add('res-wait'); continue; }
    countUp(el, was, r.value);
  }
}

/**
 * The speaker button: the effects track owns the sound (`globalThis.__fxAudio`: `{muted, toggle()}`).
 * The button shows only when that exists, calls its `toggle` and reflects `muted`; without it the
 * page has no sound and shows no button that would do nothing.
 */
function mountSound() { try { globalThis.__fxAudio?.onChange?.(() => { renderSound(); invalidate('panel'); }); } catch { /* no sound here */ } }
function renderSound() {
  const b = $('sound-btn');
  if (!b) return;
  const a = globalThis.__fxAudio;
  const has = !!a && typeof a.toggle === 'function';
  if (b.hidden === has) b.hidden = !has;
  if (!has) return;
  const on = !a.muted;
  const label = on ? L`音を消す` : L`音を出す`;
  if (b.getAttribute('aria-label') !== label) { b.setAttribute('aria-label', label); b.title = label; }
  if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
}

// ------------------------------------------------------------------ notifications (hud/feed.mjs)
let feedPrev = null;
let feedBell = null;
/** Compare what the page knows with the last tick's; new changes become notifications; a new bell folds the last one into a summary. */
function tickFeed() {
  if (FS.mode !== 'play' || !FS.citizen || !FS.chronicle) return;
  const snap = feed.snapshot(FS, undefined, feedPrev);
  let fresh = feed.diffFeed(feedPrev, snap);
  feedPrev = snap;
  // (a battle in the viewer's province that is no march's of this browser: who fought there and on which tile is in
  // the clash's own report, which is read first — clashTold — and the line is told then, by what the report says)
  const held = fresh.filter(x => x.kind === 'battle' && String(x.id).startsWith('cl:'));
  if (held.length) { fresh = fresh.filter(x => !held.includes(x)); for (const x of held) clashTold(x); }
  let items = fresh;
  if (feedBell !== null && snap.bell !== null && snap.bell > feedBell) {
    const sum = feed.bellSummary(FS.feed ?? [], feedBell);
    if (sum) items = [sum, ...items];
  }
  if (snap.bell !== null) feedBell = snap.bell;
  // this turn's own results for the effects layer (fx/stage.mjs plays them in order and emits `turn:results`).
  // A battle of the viewer's is one of them: `scene` says the page plays battles by itself (the scene's seconds at
  // the chosen speed) and `focus` that the camera goes there (Civ VII's "pan to combat", opt-in); the effects layer
  // gives the scene its place in the order and the page starts it then (mountTurnStrip). It played at once, under
  // the toll's banner and beside its own mark, the first time a real turn was seen.
  const speed = BATTLE_SPEEDS[FS.ui?.battleFx ?? 'normal'] || 0;
  if (fresh.length) fxEmit('feed', { turn: snap.bell, fresh: fresh.map(x => ({ ...x, tile: feedTile(x), faction: FS.citizen?.faction ?? null, ...(x.battle && speed > 0 ? { scene: PHASE.end / speed, focus: !!FS.ui?.autoPan } : {}) })) });
  items = [...items, ...protoNews()];
  if (!items.length) return;
  FS.feed = feed.pushFeed(FS.feed ?? [], items);
  invalidate('panel');
}
/**
 * A battle in a province of the viewer's that no march of this browser led to (hud/feed.mjs, the `cl:` line), told
 * from its report: a host of the viewer's that stood there and was attacked is named with its tile and with who came
 * (a neighbour's host walking onto the tile next to the village halved a new host, and the line named neither);
 * a battle among others is said as that, kept in the list with its report and raised neither as a card nor as a scene.
 */
async function clashTold(x) {
  const { p, q, bell } = x.battle;
  let item = { ...x };
  try {
    const r = await heraldRef?.clash(p, q, bell).catch(() => null);
    let before = null;
    try { before = r?.report?.province_before_b64 ? decodeAccount('Province', fromBase64(r.report.province_before_b64)) : null; } catch { before = null; }
    const after = FS.provinces.get(`${p},${q}`)?.province ?? null;
    const scene = r?.ok && r.inputs ? battleScene({ p, q, bell, inputs: r.inputs, before, after: after && after.resolvedNext > bell ? after : null }) : null;
    const mine = id => { try { const h = hostParts(id); return !!h && (FS.holdings ?? []).some(o => o.p === h.p && o.q === h.q && o.site === h.site); } catch { return false; } };
    const sides = t => [...(t.attackers ?? []), ...(t.defenders ?? [])];
    const tile = scene ? scene.tiles.find(t => sides(t).some(s0 => mine(s0.id))) ?? null : null;
    if (tile) {
      const me = sides(tile).find(s0 => mine(s0.id)), foe = sides(tile).find(s0 => !mine(s0.id) && Number.isInteger(s0.faction) && s0.faction !== (FS.citizen?.faction ?? -1)) ?? null;
      const where = tileNameOf({ p, q, tile: tile.idx });
      const who = foe && foe.faction >= 0 && foe.faction < 6 ? factionName(foe.faction) : null;
      const lost = Number.isFinite(me.before) && Number.isFinite(me.after) ? Math.max(0, me.before - me.after) : null;
      item = { ...item, tile: tile.idx, text: who
        ? (lost !== null ? L`${where}で、あなたの軍勢が${who}の軍勢と戦いました（ターン ${fmtNum(bell)}・${fmtNum(lost)} 兵を失いました）` : L`${where}で、あなたの軍勢が${who}の軍勢と戦いました（ターン ${fmtNum(bell)}）`)
        : L`${where}で、あなたの軍勢が戦いました（ターン ${fmtNum(bell)}）` };
    } else if (scene) {
      // (nobody of the viewer's fought: a public fact of the province, in the list with its report)
      item = { ...item, quiet: true, tile: scene.tiles[0]?.idx ?? null, text: L`${placeProvinceName(FS, p, q)}で、ほかの国どうしの戦いがありました（ターン ${fmtNum(bell)}）` };
    }
  } catch (e) { console.error('frontier feed:', e); }
  const speed = BATTLE_SPEEDS[FS.ui?.battleFx ?? 'normal'] || 0;
  if (!item.quiet) fxEmit('feed', { turn: FS.nowBell ?? item.bell, fresh: [{ ...item, tile: feedTile(item), faction: FS.citizen?.faction ?? null, ...(speed > 0 ? { scene: PHASE.end / speed, focus: !!FS.ui?.autoPan } : {}) }] });
  FS.feed = feed.pushFeed(FS.feed ?? [], [item]);
  invalidate('panel');
}

/** The tile a notification is about: the march's destination, else the viewer's village in that province. */
function feedTile(x) {
  // (a line that knows its own tile — a battle told from its report — is about that tile)
  if (Number.isInteger(x.tile) && String(x.id ?? '').startsWith('cl:')) return x.tile;
  const k = String(x.id ?? '').split(':')[1];
  const m = (FS.marches ?? []).find(y => String(y.entry?.host ?? y.transit?.hostId ?? '') === k);
  return m?.dest && m.dest.p === x.p && m.dest.q === x.q ? m.dest.tile : (FS.holdings ?? []).find(h => h.p === x.p && h.q === x.q)?.tile ?? null;
}

/** When the notice in hand appeared (a landed action's chip leaves after a few seconds). */
let noticeSeen = { ref: null, at: 0 };
/** The status of the action in hand, for the map's stack (hud/status.mjs). */
function statusNow() {
  const n = FS.notice ?? null;
  if (noticeSeen.ref !== n) noticeSeen = { ref: n, at: Date.now() };
  const st = status.statusOf(FS, { age: Date.now() - noticeSeen.at, canRetry: !!FS.lastAct });
  // a hook for effects and sound (they are another track's): `wylls:status` {state: busy | done | refused | null, act} when it changes
  const key = st?.state ?? null;
  if (key !== statusShown) {
    statusShown = key;
    try { globalThis.dispatchEvent?.(new CustomEvent('wylls:status', { detail: { state: key, act: FS.lastAct?.name ?? null } })); } catch { /* no events here (tests) */ }
  }
  return st;
}
let statusShown = null;
/**
 * The map's stack of notices: the status of the action in hand first, then what happened (at most
 * three). Kept by key, so a notice that arrives slides in and one that leaves fades out without the
 * others starting again (220 ms in, 160 ms out; at once under reduced motion).
 */
function renderFeed() {
  const el = $('feed');
  if (!el) return;
  const st = statusNow();
  // this turn's own results stand together in one card (fx/stage.mjs `turn:results`); they are not said twice as single
  // notices, not even in the moment before the card comes (it waits for the toll's banner: the single notices stood
  // under the banner for a second and were then replaced by the card)
  // (nor after the card was put away: its rows came back as single notices)
  const strip = turnStripNow(), inStrip = new Set((turnStrip && fxNow() - turnStrip.at <= TURN_STRIP_MS ? turnStrip.items : []).map(x => x.id));
  // (a phone, just after a record of the viewer's own land under the banner prototype: the notices wait a moment)
  const held = !!FS.proto?.toastHold && Date.now() < FS.proto.toastHold;
  if (held) setTimeout(renderFeed, Math.max(30, FS.proto.toastHold - Date.now() + 20));
  const standing = FS.proto?.threatsNow ?? null;
  // (a notice that tells how a fight ended — 「シンダーの旗を止めました。このマスは、あなたの軍勢が押さえています」 — waits for the
  // scene of that fight: it stood beside the strength bars that still read 600 against 500, three seconds before the
  // scene's own verdict. It comes when the battle the page stages in that province is over; a notice that has just
  // come waits a beat for the battle to be told, which the same turn's records do a moment later)
  const sceneEnds = x => { if (!x.proto || !x.lead || !Number.isInteger(x.p)) return 0; const now = fxNow(); let until = (x.at ?? 0) + OUTCOME_BEAT_MS > Date.now() ? now + ((x.at ?? 0) + OUTCOME_BEAT_MS - Date.now()) : 0;
    for (const it of turnStripHeld()?.items ?? []) if (it.plays && it.battle && it.battle.p === x.p && it.battle.q === x.q && Number.isFinite(it.at)) until = Math.max(until, (it.at + (it.secs ?? 0)) * 1000 + 300);
    for (const b of FS.battles ?? []) if (b.scene?.p === x.p && b.scene?.q === x.q && battleLive(b, performance.now() / 1000)) until = Math.max(until, now + 400);
    return until > now ? until : 0; };
  const waits = (FS.feed ?? []).map(sceneEnds).filter(t => t > 0);
  if (waits.length) { clearTimeout(outcomeTimer); outcomeTimer = setTimeout(renderFeed, Math.max(60, Math.min(...waits) - fxNow() + 30)); }
  const toasts = feed.liveToasts((FS.feed ?? []).filter(x => !inStrip.has(x.id) && !sceneEnds(x)), { dismissed: FS.feedDismissed ?? new Set(), standing })
    // (a standing threat's notice says the count as it is now, not as it was when the threat was first seen)
    // (and once a host of the viewer's is sealed and on its way to that tile, the notice says so and offers no second one)
    .map(x => ({ id: `n:${x.id}`, alarm: (!!x.alarm && !!standing?.has(x.id)) || !!x.lead, markup: feed.renderToast(x.alarm && FS.proto?.threatsUp?.has(x.id) ? protoAlarmNow(x, FS.proto.threatsUp.get(x.id)) : x) }));
  const stripItem = strip ? [{ id: `turn:${strip.turn}`, markup: feed.renderTurnStrip(strip, { now: turnRowNow(strip), faction: FS.citizen?.faction ?? null }) }] : [];
  // (a phone shows one notice: a standing threat's comes before the turn's own card, which hid it for as long as that
  // card stood — the threat was then told only by the guide's line; a wide screen shows both, the turn's card first)
  const items = held ? [] : [...(st ? [{ id: 'tx', markup: status.renderStatus(st) }] : []),
    ...feed.stackOrder(stripItem, toasts, { alarmsFirst: phone() })];
  syncStack(el, items);
  publishNoGo();
}
/** How long a notice of how a fight ended waits for that fight's battle to be told (ms), and the timer that shows it. */
const OUTCOME_BEAT_MS = 1500;
let outcomeTimer = null;
/** A standing threat's notice as it is now: the count the records give, and whether the answer is on its way. */
function protoAlarmNow(x, up) {
  const at = pm.marchingTo(FS, up);
  // (in the turn it arrives in, and until that turn is settled: arrived, the fight not told yet — the notice said "on its way" for a turn that had passed)
  if (at !== null) return { ...x, send: null, text: (FS.nowBell ?? 0) < at ? L`${up.text}。あなたの軍勢が向かっています（ターン ${fmtNum(at)} に到着）` : L`${up.text}。あなたの軍勢が着きました。戦いの結果を待っています` };
  // (outnumbered — a new hamlet against a host of 500 —: the notice carries the numbers, as the guide's step does)
  const force = up.foe ? pm.strengthOf(FS) : null;
  return force && force.best < up.foe.troops ? { ...x, text: L`${up.text}。${pm.threatNumbers(up, force)}数で下回っています` } : { ...x, text: up.text };
}
/**
 * "What happened this turn" (UX design 8.3): after the toll the effects layer plays this turn's own results on
 * the map in order and says so on the bus (`turn:results`); the HUD shows them as one card, the row that is
 * playing lit, each with "see" (which flies there: goToItem, playBattle).
 */
let turnStrip = null;
const TURN_STRIP_MS = 60_000;
/** The turn's card while it holds its results: also before it shows (the toll's banner has the top of the map first). */
function turnStripHeld() {
  const s = turnStrip;
  return !s || s.dismissed || fxNow() - s.at > TURN_STRIP_MS ? null : s;
}
function turnStripNow() {
  const s = turnStripHeld();
  // (the card comes as the first result plays)
  return !s || fxNow() - s.at < s.startsIn * 1000 - 40 ? null : s;
}
/**
 * The row whose mark (or battle) is playing on the map now, or -1: each result says when it starts and how long it
 * plays (`at`, `secs` on the effects clock); a list without times plays one row every `gap` for a second and a half.
 */
function turnRowNow(s) {
  if (s.items.some(x => Number.isFinite(x.at))) { const now = fxNow() / 1000; return s.items.findIndex(x => Number.isFinite(x.at) && now >= x.at - 0.02 && now < x.at + (x.secs ?? 1.5)); }
  const t = (fxNow() - s.at) / 1000 - s.startsIn;
  if (t < 0) return -1;
  const i = Math.floor(t / s.gap);
  return i < s.items.length && t - i * s.gap < 1.5 ? i : i >= s.items.length && t - (s.items.length - 1) * s.gap < 1.5 ? s.items.length - 1 : -1;
}
function mountTurnStrip() {
  fxOn('turn:results', p => {
    if (!p?.items?.length || (FS.mode !== 'play' && !p.demo)) return;
    turnStrip = { turn: p.turn, items: p.items, demo: !!p.demo, at: fxNow(), startsIn: Math.max(0, p.startsIn ?? 0), gap: Math.max(0.2, p.gap ?? 0.7), dismissed: false };
    renderFeed();
    // the lit row follows the map's marks (a few re-renders, then the card rests)
    const s = turnStrip, now = fxNow() / 1000;
    const later = (secs, ms) => setTimeout(() => { if (turnStrip === s) renderFeed(); }, Math.max(0, Math.round(secs * 1000)) + ms);
    if (p.items.some(x => Number.isFinite(x.at))) for (const x of p.items) { if (!Number.isFinite(x.at)) continue; later(x.at - now, 30); later(x.at + (x.secs ?? 1.5) - now, 60); }
    else { for (let i = 0; i <= p.items.length; i++) later(s.startsIn + i * s.gap, 30); later(s.startsIn + (p.items.length - 1) * s.gap + 1.5, 60); }
  });
  // a battle that is its own result starts when its turn in the order comes (fx/stage.mjs says when, on the effects clock)
  fxOn('turn:scene', x => { if (FS.mode === 'play' && x?.battle) playBattle(x.battle.p, x.battle.q, x.battle.bell, { auto: true, focus: !!x.focus }); });
  // the next toll clears the card of the turn before
  fxOn('bell', () => { if (turnStrip && !turnStrip.demo) { turnStrip = null; renderFeed(); } });
  // the survey grew (map/fmap.mjs says so once, with how many tiles): the plate's count follows it
  fxOn('survey:gain', () => invalidate('rail'));
}
const stackHtml = new WeakMap();
function syncStack(el, items) {
  if (!el.children || !globalThis.document?.createElement) { setHtml(el, items.map(x => x.markup)); return; }
  const want = new Map(items.map(x => [x.id, String([x.markup].flat(Infinity).map(String).join(''))]));
  for (const node of [...el.children]) {
    const id = node.dataset.key;
    if (want.has(id) && !node.classList.contains('leaving')) continue;
    if (node.classList.contains('leaving')) continue;
    // gone: it fades out (state first: it no longer takes the pointer or a place in the reading order)
    node.classList.add('leaving'); node.setAttribute('aria-hidden', 'true'); node.inert = true;
    if (calm()) node.remove(); else setTimeout(() => node.remove(), 170);
  }
  let before = el.firstElementChild;
  for (const x of items) {
    let node = [...el.children].find(n => n.dataset.key === x.id && !n.classList.contains('leaving'));
    const markup = want.get(x.id);
    if (!node) {
      const tpl = globalThis.document.createElement('template');
      tpl.innerHTML = markup;
      node = tpl.content.firstElementChild;
      if (!node) continue;
      node.dataset.key = x.id;
      stackHtml.set(node, markup);
      el.insertBefore(node, before);
    } else if (stackHtml.get(node) !== markup) {
      const tpl = globalThis.document.createElement('template');
      tpl.innerHTML = markup;
      const next = tpl.content.firstElementChild;
      if (next) { node.className = `${next.className} shown`; node.setAttribute('role', next.getAttribute('role') ?? 'status'); node.replaceChildren(...next.childNodes); stackHtml.set(node, markup); }
    }
    before = node.nextElementSibling;
    while (before && before.classList.contains('leaving')) before = before.nextElementSibling;
  }
}

/**
 * The bottom-left corner: the to-do tab (its list on demand) and the village plate. On phones both stand
 * in the sheet instead (restMarkup): one copy in the page, never two. The guide's objective is not here:
 * it has one place, the "next thing" button of the top strip (renderHudTick; UX design 11.11), and on the
 * map only the ivory ring on the ground marks its tile (the canvas's label makes way: `guideChip`).
 */
function renderRail() {
  const small = phone();
  const el = $('rail');
  if (el) { setHtmlIfChanged(el, small ? '' : hud.renderRail(FS, { todoOpen: !!FS.todoOpen })); el.hidden = small || !el.firstElementChild; }
  const ob = $('objective');
  if (ob && !ob.hidden) ob.hidden = true;
  renderProvinces();
  publishNoGo();
}
// ---- a conquest season: "Provinces held" under the top strip, and the season's end (hud/provstrip.mjs)
let provEl = null, provLast = null, seasonEndEl = null;
/**
 * The strip of the six nations' provinces from the chain's records, and the season-end card once the records say
 * it. Both exist only on a conquest season (program version 3) outside the sample world; a figure that changed with
 * a new record answers with a beat.
 */
function renderProvinces() {
  const doc = globalThis.document;
  if (!doc?.createElement) return;
  const on = keephand.conquestOn(FS) && !territoryEnabled(FS) && !FS.sample && !titleUp() && !phone();
  let m = null, end = null;
  if (on) { try { m = provstrip.stripModel(FS); end = FS.seasonEndSeen ? null : provstrip.seasonEndModel(FS); } catch (e) { console.error('frontier provinces:', e); } }
  if (m && !provEl) { provEl = doc.createElement('div'); provEl.id = 'prov-strip'; provEl.className = 'prov-strip'; ($('hud-tl') ?? doc.body).append(provEl); }
  if (provEl) {
    provEl.hidden = !m;
    if (m && setHtmlIfChanged(provEl, provstrip.renderStrip(m)) !== false) {
      for (const c of provstrip.changedCounts(provLast, m)) {
        const n = provEl.querySelector(`.ps-n[data-f="${c.faction}"]`);
        if (!n) continue;
        n.dataset.delta = `${c.to > c.from ? '+' : '−'}${Math.abs(c.to - c.from)}`;
        n.classList.add(c.to > c.from ? 'ps-up' : 'ps-down');
      }
    }
    if (m) provLast = m;
  }
  if (end && !seasonEndEl) { seasonEndEl = doc.createElement('div'); seasonEndEl.id = 'season-end'; seasonEndEl.className = 'season-end'; ($('frontier') ?? doc.body).append(seasonEndEl); }
  if (seasonEndEl) { seasonEndEl.hidden = !end; setHtmlIfChanged(seasonEndEl, end ? provstrip.renderSeasonEnd(end) : ''); }
  // (the season has ended: the pool's count is read until it is final, so that the card can stand without a press)
  if (on && FS.prize && (FS.nowBell ?? 0) >= Number(FS.season?.endBell ?? Infinity) && FS.prize.state === 'open') refreshPrize().catch(() => {});
}

/**
 * What the HUD covers, told to the map (UX design 11.6: labels and anchored things keep out of the dial, the
 * plaques, the plate, the dock, the minimap, the button columns and the open drawer): after the layout changes
 * the client rectangles go to `globalThis.__wyllsMap?.setNoGo?.(rects)`; `globalThis.__wyllsHud.noGo()` reads
 * the same list at any time (hud/insets.mjs noGoRects).
 */
/** How far inside the map's top edge no label of the map stands (px). */
export const EDGE_TOP = 4;
let noGoKey = '', noGoMap = null, noGoQueued = false;
function publishNoGo() {
  if (noGoQueued || !globalThis.requestAnimationFrame) return;
  noGoQueued = true;
  requestAnimationFrame(() => {
    noGoQueued = false;
    const rects = noGoRects();
    // the map's own top edge is a piece too, for the map alone: a nameplate that would stand half above it slides down
    // or is left out, like one under the dial (the second check: the spectator's 'Emar Town' plate was cut by the edge)
    const cr = $('frontier-map')?.getBoundingClientRect?.();
    if (cr && cr.width > 0) rects.push({ id: 'edge-top', x: Math.round(cr.left), y: Math.round(cr.top) - 60, width: Math.round(cr.width), height: 60 + EDGE_TOP });
    const key = rects.map(r => `${r.id}:${r.x},${r.y},${r.width},${r.height}`).join('|');
    const m = globalThis.__wyllsMap ?? null;
    if (key === noGoKey && m === noGoMap) return;
    noGoKey = key; noGoMap = m;
    try { m?.setNoGo?.(rects); } catch (e) { console.error('frontier no-go:', e); }
  });
}
if (globalThis.document) globalThis.__wyllsHud = { noGo: () => noGoRects() };

/**
 * The hover tip (Civ's unit tooltip): who holds the tile and what is
 * happening on it, from the activities the last frame drew. Mouse only;
 * touch shows the same in the inspector.
 */
function showTip(hit, at) {
  const tip = $('map-tip');
  if (!tip) return;
  // (mouse only, as said: a touch screen's tap also "hovers", and the tip then stood over the village and the lens's
  // words beside the open card that says the same: the design review of 2026-10-24)
  if (globalThis.matchMedia?.('(hover: none)')?.matches) { tip.hidden = true; return; }
  const acts = hit && Number.isInteger(hit.idx) ? mapRef?.art?.activities?.get(`${hit.p},${hit.q},${hit.idx}`) : null;
  const t = acts || hit ? mapRef?.art?.tiles?.find(u => u.p === hit?.p && u.pq === hit?.q && u.idx === hit?.idx) : null;
  const owner = t && t.state === 1 && t.site !== undefined ? rosterRef?.ownerOf(hit.p, hit.q, t.site) : null;
  const land = protoTipLines(hit);
  if (!acts?.length && !owner && !land.length) { tip.hidden = true; return; }
  const lines = [];
  // the place by its name first (map/names.mjs), then who holds it
  if (owner) lines.push(html`<strong class="tip-place">${villageLine({ p: hit.p, q: hit.q, site: t.site }, t.tier, t.owner)}</strong>`);
  if (owner) lines.push(html`<span data-name>${displayName(identityOf(owner.tag), { full: true })}</span>`);
  // the lord out on their land (people/life.mjs): what they are doing
  const lf = owner && FS.life ? lifeAt(FS.life.get(`${hit.p},${hit.q},${t.site}`), FS.nowBell ?? 0, FS.chain?.now() ?? 0) : null;
  if (lf?.lord) lines.push(html`<span class="tip-lord">${lordLine(displayName(identityOf(owner.tag)), lf.doing, L)}</span>`);
  for (const a of (acts ?? []).filter((a, i, all) => all.findIndex(b => b.kind === a.kind) === i)) lines.push(html`<span class="tip-${a.kind}">${activityText(a, inspect.hostInfoOf(FS))}</span>`);
  lines.push(...land);
  setHtml(tip, lines.map(l => html`<span class="tip-line">${l}</span>`));
  tip.hidden = false;
  // beside the pointer, inside the part of the map nothing covers (never under the drawer or the sheet)
  const size = mapRef?.size?.() ?? { width: 0, height: 0 }, ins = hudInsets();
  const w = tip.offsetWidth || 0, h = tip.offsetHeight || 0;
  const x = at.x + 16 + w > size.width - ins.right - 8 ? at.x - 16 - w : at.x + 16;
  const y = at.y + 12 + h > size.height - ins.bottom - 8 ? at.y - 12 - h : at.y + 12;
  tip.style.setProperty('--x', `${Math.round(Math.max(8, x))}px`);
  tip.style.setProperty('--y', `${Math.round(Math.max(ins.top + 8, y))}px`);
}

// ------------------------------------------------------------------ battle scenes (people/battle.mjs)
const battleSeen = new Map(); // "P,Q" → the last resolved bell a scene was considered for
let battleBack = null;
/** Load a clash and play its scene on the map; `focus` moves the camera to it first. */
export async function playBattle(p, q, bell, { focus = false, auto = false } = {}) {
  const fx = FS.ui?.battleFx ?? 'normal';
  if (auto && fx === 'off') return false;
  if (!heraldRef || ![p, q, bell].every(Number.isInteger)) return false;
  const r = await heraldRef.clash(p, q, bell).catch(() => null);
  if (!r?.ok || !r.inputs) return false;
  let before = null;
  try { before = r.report?.province_before_b64 ? decodeAccount('Province', fromBase64(r.report.province_before_b64)) : null; } catch { before = null; }
  const after = FS.provinces.get(`${p},${q}`)?.province ?? null;
  // (the viewer's own villages in the province: the map draws them larger, and a fight there is staged before them)
  const ownTiles = new Set((FS.holdings ?? []).filter(h => h.p === p && h.q === q && Number.isInteger(h.tile)).map(h => h.tile));
  const scene = battleScene({ p, q, bell, inputs: r.inputs, before, after: after && after.resolvedNext > bell ? after : null, ownTiles });
  if (!scene) return false;
  // (a scene the page stages by itself, with no flight to it — "pan to combat" is the player's to switch on — plays
  // only where it can be seen whole: staged at the edge of the picture it was cut by the screen. Out of sight, the
  // turn's notice keeps its 見る, which flies there and plays it)
  if (auto && !focus && mapRef) {
    const hx = tileHex(p, q, scene.tiles[0].idx);
    if (hx) {
      const c = project(hx.q, hx.r), at = mapRef.project(c.x, c.y, { logical: true }), size = mapRef.size(), ins = hudInsets();
      const mx = Math.min(170, size.width * 0.22);
      const whole = FS.view.lod === 'tile' && at.x > (ins.left ?? 0) + mx && at.x < size.width - (ins.right ?? 0) - mx && at.y > (ins.top ?? 0) + 130 && at.y < size.height - (ins.bottom ?? 0) - 110;
      if (!whole) return false;
    }
  }
  // the camera flies in, to the part of the map no sheet covers (map/fmap.mjs flyTo)
  if (focus && mapRef) {
    // (and comes back when the scene is over, unless the player has moved it: hud/camkeep.mjs)
    camKeep.keep('battle');
    mapRef.flyTo({ p, q, tile: scene.tiles[0].idx, zoom: 2.1 }, 500);
    const secs = PHASE.end / (BATTLE_SPEEDS[fx] || 1) + 0.9;
    clearTimeout(battleBack);
    // (the flights to the scene are the page's and the effects layer's own; a place the player goes to meanwhile is
    // reported by name: goToItem, the plate, a selection that flies)
    battleBack = setTimeout(() => camKeep.back('battle', { ms: calm() ? 0 : 420, slack: Infinity }), secs * 1000);
  }
  const play = startBattle(scene, performance.now() / 1000, BATTLE_SPEEDS[fx] || 1);
  FS.battles = [...(FS.battles ?? []).filter(b => !(b.scene.p === p && b.scene.q === q)), play];
  // staged by the effects layer (fx/battle.mjs): the dimmed map, the scene on its own canvas, the title
  fxEmit('battle', { play, focus, zoom: focus ? 2.1 : null, viewerFaction: FS.citizen?.faction ?? null, lossText: n => L`−${fmtNum(n)} 兵`, numText: n => fmtNum(n) });
  mapRef?.invalidate();
  return true;
}
/** A clash that resolved in a province the page has loaded plays once, when it is new. */
function autoBattles() {
  for (const [key, env] of FS.provinces) {
    const b = env.province?.resolveSummary?.bell;
    if (!Number.isInteger(b) || b <= 0) continue;
    const prev = battleSeen.get(key);
    battleSeen.set(key, b);
    if (prev === undefined || prev >= b) continue;  // the first sight of a province is not news
    // a clash the notifications announce (the viewer's own province, or where a march of theirs arrived) is one of
    // the turn's own results: it plays once, in its place after the toll (tickFeed, mountTurnStrip), not here as well
    if (FS.mode === 'play' && feedAnnounces(env.province.p, env.province.q, b)) continue;
    playBattle(env.province.p, env.province.q, b, { auto: true });
  }
}
/** Whether hud/feed.mjs makes a notification of the clash of (p, q) at `bell`: a province of the viewer's, or the destination of a march of theirs arriving then. */
const feedAnnounces = (p, q, bell) => !!FS.citizen && ((FS.holdings ?? []).some(h => h.p === p && h.q === q)
  || (FS.marches ?? []).some(m => m.dest && m.dest.p === p && m.dest.q === q && (m.entry?.arriveBell ?? m.transit?.arriveBell) === bell));

// ------------------------------------------------------------------ the minimap and the lenses (hud/minimap.mjs)
let miniQueued = false, miniPulse = null;
function renderMinimap() {
  if (miniQueued) return;
  miniQueued = true;
  requestAnimationFrame(() => {
    miniQueued = false;
    const cv = $('minimap-canvas');
    if (!cv || !mapRef || !cv.getContext) return;
    const px = minimap.MINIMAP_PX, dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (cv.width !== px * dpr) { cv.width = px * dpr; cv.height = px * dpr; }
    const recs = new Map();
    for (const ov of FS.overviews.values()) for (const r of ov.provinces) recs.set(`${r.p},${r.q}`, r);
    const sv = FS.survey ?? null, pulse = !!sv?.home && !sv.showAll && !reducedMotion();
    minimap.paintMinimap(cv.getContext('2d'), { recs, rings: Math.max(1, (FS.record?.rings?.length ?? 1)), own: (FS.holdings ?? []).map(h => ({ p: h.p, q: h.q })),
      view: mapRef.shown ?? mapRef.view, size: mapRef.size(), quad: mapRef.viewQuad?.() ?? null, px, dpr, lens: FS.view.lens ?? 'realm', pins: FS.pins ?? [], survey: sv, now: fxNow() });
    // the viewer's pip breathes: a few small repaints a second while it shows
    if (pulse && !miniPulse) miniPulse = setTimeout(() => { miniPulse = null; renderMinimap(); }, 110);
  });
}
function renderLenses() {
  const el = $('lenses');
  if (!el) return;
  const cur = FS.view.lens ?? 'realm';
  const open = el.dataset?.open === 'true';
  // a phone has one layers button that opens the four choices by name (UX design 11.11); wider screens show the four chips
  setHtmlIfChanged(el, html`<button type="button" class="hud-btn lens-toggle" data-act="lens-menu" aria-expanded="${open ? 'true' : 'false'}" aria-controls="lens-list" aria-label="${L`地図の表示：${minimap.LENS_TEXT[cur]()}`}" title="${L`地図の表示`}">${icon('layers')}</button>
    <div class="lens-list" id="lens-list">${minimap.LENSES.map((l, i) => html`<button type="button" class="lens" data-act="lens" data-lens="${l}" aria-pressed="${l === cur ? 'true' : 'false'}" aria-label="${minimap.LENS_TEXT[l]()}" title="${minimap.LENS_TEXT[l]()} (${i + 1})">${icon(minimap.LENS_ICON[l])}<span class="lens-text" aria-hidden="true">${minimap.LENS_TEXT[l]()}</span></button>`)}${FS.mode === 'play' ? html`<button type="button" class="lens lens-help" data-act="legend-open" aria-label="${L`地図の見かた`}" title="${L`地図の見かた`}"><span class="lens-q" aria-hidden="true">?</span><span class="lens-text" aria-hidden="true">${L`地図の見かた`}</span></button>` : ''}</div>`);
}
/** Open or close the phone's list of lenses (a DOM state of the HUD: nothing in the store follows it). */
function setLensMenu(open) {
  const el = $('lenses');
  if (!el?.dataset || (el.dataset.open === 'true') === open) return;
  el.dataset.open = open ? 'true' : 'false';
  renderLenses();
}
// ------------------------------------------------------------------ map search (hud/search.mjs)
let searchHits = [];
function runSearch(q) {
  const recs = new Map();
  for (const ov of FS.overviews.values()) for (const r of ov.provinces) recs.set(`${r.p},${r.q}`, r);
  searchHits = search.searchMap(q, { recs, roster: rosterRef, sitesOf: (p, q2) => terrainRef?.(p, q2)?.sites ?? null, pins: FS.pins ?? [], survey: FS.survey ?? null, pinName: x => pins.pinName(x, FS) });
  const el = $('map-search-results');
  if (el) setHtml(el, search.renderResults(searchHits, q));
}

/** The search field opens from its icon (UX design section 6) and closes again when it has done its work. */
function setSearch(open, { focus = true } = {}) {
  const form = $('map-search'), btn = $('search-btn');
  if (!form) return;
  form.hidden = !open;
  btn?.setAttribute('aria-expanded', String(open));
  if (open) { if (focus) $('map-search-q')?.focus({ preventScroll: true }); return; }
  const q = $('map-search-q'), res = $('map-search-results');
  if (q) q.value = '';
  if (res) setHtml(res, '');
  searchHits = [];
  if (focus) btn?.focus({ preventScroll: true });
}

function setLens(l) {
  if (!minimap.LENSES.includes(l)) return;
  FS.view.lens = l;
  const el = $('lenses'); if (el?.dataset) el.dataset.open = 'false';
  renderLenses(); renderMinimap(); mapRef?.invalidate();
}

// ------------------------------------------------------------------ the title and the bell toll (intro/title.mjs)
/** Whether the title card is up (the map's opening drifts in slowly behind it: map/opening.mjs). */
const titleUp = () => { const el = $('intro'); return !!el && !el.hidden; };
// The map's opening waits for the viewer's record only when one may come: a wallet was used here before.
let viewerKnown = !lastWalletName();
function introLive() {
  const total = hud.standings(FS.overviews).reduce((a, r) => a + r.holdings, 0);
  const bell = FS.clock ? bellChip(FS.clock, FS.chain?.now() ?? null).bell : null;
  return title.liveLine({ seasonId: FS.record?.season ?? null, bell, holdings: total });
}
let stopTitleScene = null, titleCanvas = null;
function renderIntro() {
  const el = $('intro');
  if (!el || el.hidden) return;
  // the button says where it leads once the viewer's stage is known (intro/title.mjs ctaText)
  const stage = FS.mode === 'play' && FS.playReady && viewerState(FS) === 'known' ? FS.land?.stage ?? 'none' : null;
  setHtmlIfChanged(el, title.render({ mode: FS.mode, live: introLive(), stage }));
  // the scene's picture (intro/scene.mjs) is painted into the markup's canvas while the title stands (a new canvas when the words changed)
  const cv = el.querySelector('.intro-scene');
  if (cv && cv !== titleCanvas) { stopTitleScene?.(); titleCanvas = cv; stopTitleScene = mountTitleScene(cv, { calm }); }
}
/**
 * The title is a scene of its own (UX design 11.9): while it stands the page is marked `data-title="up"`, the
 * game behind it is neither shown nor reachable (the map and the dock are inert; the nation choice does not
 * open: hud/drawer.mjs reads `FS.titleUp`), and only the sound and language buttons stay with it.
 */
function markTitle(up) {
  FS.titleUp = up;
  const doc = globalThis.document, body = doc?.body;
  if (!body?.dataset) return;
  if (up) body.dataset.title = 'up'; else delete body.dataset.title;
  for (const el of [$('frontier'), $('tabs')]) if (el) el.inert = up;
}
export function openIntro() {
  const el = $('intro');
  if (!el) return;
  el.hidden = false;
  markTitle(true);
  lastHtml.delete('intro');
  renderIntro();

  el.querySelector('.intro-go')?.focus({ preventScroll: true });
  // behind the scene the map waits at its opening view's start (the map reads titleUp()); the drawer follows FS.titleUp
  mapRef?.invalidate();
  invalidate('panel', 'tabs', 'rail');
}
export function closeIntro() {
  const el = $('intro');
  if (!el || el.hidden) return;
  el.hidden = true;
  markTitle(false);
  stopTitleScene?.(); stopTitleScene = null; titleCanvas = null;
  title.markSeen(globalThis.localStorage);
  // the scene lifts like a curtain (visual only: the game is already there and usable under it)
  const doc = globalThis.document;
  if (!calm() && doc?.createElement && doc.body) {
    const veil = doc.createElement('div');
    veil.className = 'intro-out'; veil.setAttribute('aria-hidden', 'true');
    doc.body.append(veil);
    setTimeout(() => veil.remove(), 620);
  }
  $('frontier-map')?.focus({ preventScroll: true });
  mapRef?.invalidate();   // the wait ends now: the map flies to this viewer's opening view
  invalidate('panel', 'tabs', 'rail');
}
let tollBell = null, urgentBell = null;
/**
 * The bell toll: reported on the effects bus; fx/stage.mjs sends the brass ripple across the map, writes
 * 「ターン N」 (and 「新しいターン」 under it) into #bell-toll and sounds the bell; the dial swings (a class, visual only).
 * In the last 30 s of a turn `turn:urgent` goes out once.
 */
function ringToll(bell, left = null) {
  if (!Number.isInteger(bell)) return;
  if (tollBell !== null && bell > tollBell) {
    const h = hud.activeHolding(FS);
    fxEmit('bell', { turn: bell, home: h && Number.isInteger(h.tile) ? { p: h.p, q: h.q, tile: h.tile } : null });
    const dial = $('bell-pill');
    if (dial?.classList) { dial.classList.remove('toll'); void dial.offsetWidth; dial.classList.add('toll'); }
    // (a clock that runs fast: the page reads again now and when the turn before last is resolved)
    if (FS.mode === 'play') tolled();
  }
  if (Number.isFinite(left) && left <= 30 && left >= 0 && urgentBell !== bell) { urgentBell = bell; fxEmit('turn:urgent', { turn: bell, secondsLeft: left }); }
  tollBell = bell;
}

/** The to-do kinds that are a card of the village's bar (hud/hud.mjs attentionItems): the card that opens, or null for the bar alone. */
const VILLAGE_TODO = Object.freeze({ build: 'build', muster: 'muster', full: null, dormant: null });
/** Move the map to an attention item and open its tab. */
/** The report's map buttons close it, so the map (and on phones the sheet's map) is in view. */
function leaveReport() { if (FS.report) { FS.report = null; invalidate('panel'); } }
const FX_LEVEL_TEXT = { full: () => L`標準`, reduced: () => L`控えめ`, off: () => L`オフ` };
const BATTLE_FX_TEXT = { normal: () => L`ふつう`, fast: () => L`早送り`, off: () => L`自動では見せない` };

/** Consume an explicit home focus once, using the map's tilted, sheet-aware camera. */
export function focusHome(state = FS, map = mapRef) {
  const h = state.homeFocus;
  if (!h || !map?.flyTo || !Number.isInteger(h.p) || !Number.isInteger(h.q) || !Number.isInteger(h.tile) || h.tile < 0 || h.tile >= 61) return false;
  state.homeFocus = null;
  closeIntro();
  state.selected = { kind: 'tile', p: h.p, q: h.q, idx: h.tile };
  // A new grant or the player's explicit "begin" request may leave a view the
  // player panned. Ordinary polls cannot repeat it; an untouched camera keeps
  // the opening's responsive framing after the focus.
  map.flyTo({ p: h.p, q: h.q, tile: h.tile, zoom: heroZoom(map.dpr?.() ?? 1) }, null, { auto: !map.cam?.userMoved, seat: true });
  return true;
}

function goToItem(x) {
  if (!x) return;
  camKeep.touch();   // (a place the player asked for: a kept view is not gone back to)
  // a thing to do at one of the viewer's own villages is done on the board: the village is selected, its card stands open
  if (FS.mode === 'play' && x.holding && FS.holdings?.includes(x.holding) && VILLAGE_TODO[x.kind] !== undefined && holdsLand(FS)) { selectVillage(FS.holdings.indexOf(x.holding), VILLAGE_TODO[x.kind]); return; }
  // the item's holding becomes the active one (its tab then shows that holding)
  if (x.holding && FS.holdings?.includes(x.holding)) FS.activeHolding = FS.holdings.indexOf(x.holding);
  endPick(); FS.hand = null; FS.inspectOpen = false;
  if (Number.isInteger(x.tile)) {
    mapRef?.flyTo({ p: x.p, q: x.q, tile: x.tile, zoom: 1.0 });
    FS.selected = { kind: 'tile', p: x.p, q: x.q, idx: x.tile };
    // (a raid's choice is on the tile's card, which the viewer's host standing there would otherwise keep behind its bar)
    if (x.kind === 'raid') FS.inspectOpen = true;
    // (an item about a host puts that host in the hand: the to-do's "hosts ready" led to a list)
    if (x.host !== undefined && x.host !== null) { FS.hand = { host: String(x.host), pop: null }; FS.tab = 'map'; invalidate('map', 'panel', 'tabs', 'rail'); return; }
  } else {
    mapRef?.flyTo({ p: x.p, q: x.q, zoom: 0.6 });
    FS.selected = { kind: 'province', p: x.p, q: x.q };
  }
  if (FS.mode === 'play' && x.tab) FS.tab = x.tab;
  // going there reads the province at once, as a tap on the map does: its keep panel must not wait for the next poll
  if (FS.mode !== 'practice') wantProvince(x.p, x.q, () => invalidate('map', 'panel'));
  wantKeepHistory(x.p, x.q, () => invalidate('panel'));
  invalidate('map', 'panel', 'tabs', 'rail');
}

/** The HUD's actions (data-act): cycle the attention items, jump to one, choose the active holding. */
/** The next (dir +1) or previous (−1) host ready to march, selected on the map (Civ's "next unit"). */
function cycleHost(dir) { nextHost(dir); }
/** The next or previous holding (Civ's "next city"). */
function cycleHolding(dir) {
  const hs = FS.holdings ?? [];
  if (!hs.length) return;
  const i = (((FS.activeHolding ?? 0) + dir) % hs.length + hs.length) % hs.length;
  FS.activeHolding = i;
  goToItem({ p: hs[i].p, q: hs[i].q, tile: hs[i].tile, tab: 'holding', holding: hs[i] });
}

/** Close the drawer ("Map", the drawer's ×, Escape): back to the world. */
function shutDrawer({ focus = false } = {}) {
  // the details of what the hand holds were open: they close, the hand keeps its thing
  if (FS.mode === 'play' && FS.inspectOpen && drawerOf(FS)?.kind === 'inspect' && hand.subjectOf(FS)) { FS.inspectOpen = false; invalidate('map', 'panel', 'tabs', 'rail'); if (focus) handEl?.querySelector('.hand-btn')?.focus?.({ preventScroll: true }); return; }
  endPick();
  ackHomeGrant();
  closeDrawer(FS);
  // (the selection went with the drawer: so do the host that acted for it and the map's last answer)
  if (!FS.selected) { FS.actor = null; FS.mapNote = null; }
  if (FS.mode === 'play') ACTIONS.tab({ tab: 'map' }); else invalidate('panel');
  invalidate('map', 'panel', 'tabs', 'rail');
  if (focus) $('frontier-map')?.focus({ preventScroll: true });
}

export const HUD_ACTIONS = {
  // ---- a conquest season (hud/keephand.mjs, hud/provstrip.mjs): a signature to the clipboard, the season-end card put away
  'kh-copy': async (d, el) => {
    let ok = false;
    try { await globalThis.navigator?.clipboard?.writeText?.(String(d.copy ?? '')); ok = !!globalThis.navigator?.clipboard?.writeText; } catch { ok = false; }
    const t = el?.querySelector?.('.kh-copy-t');
    if (t) { t.textContent = ok ? L`コピーしました` : L`コピーできませんでした`; setTimeout(() => { if (t.isConnected) t.textContent = L`コピー`; }, 1600); }
  },
  'se-close': () => { FS.seasonEndSeen = true; invalidate('rail'); },
  // (the card's own way to the result: the card is put away as the result opens — it stood over the map beside the very
  // table it had led to; the season's end on the local test chain, 2026-10-11)
  'se-go': () => { FS.seasonEndSeen = true; HUD_ACTIONS.tab({ tab: 'territory' }); invalidate('rail'); },
  // the conquest guide's press (screens/conquestguide.mjs): the village with the step's card open, or a host with its list of keeps
  'cg-go': d => {
    if (FS.mode !== 'play' || !keephand.conquestOn(FS)) return;
    leaveReport(); FS.compose = null; FS.guideOpen = false; FS.tab = 'map';
    if (d.pop === 'keeps') {
      const r = hand.ownHosts(FS).find(x => x.id === String(d.host)) ?? hand.ownHosts(FS).find(x => x.unit !== 6 && x.unit !== 7 && hand.marchCheck(FS, x).ok) ?? null;
      if (!r) { HUD_ACTIONS.tab({ tab: 'hosts' }); return; }
      endPick(); FS.selected = { p: r.p, q: r.q, idx: r.tile }; FS.hand = { host: r.id }; FS.inspectOpen = false;
      setPop('keeps'); invalidate('map', 'panel', 'tabs', 'rail');
      return;
    }
    const hi = Math.max(0, Math.min((FS.holdings ?? []).length - 1, FS.activeHolding ?? 0));
    if (['build', 'train', 'muster'].includes(d.pop)) selectVillage(hi, d.pop);
  },
  // ---- the prototype rule "banners" (hud/proto.mjs): orders to the sample world from the bar's card, and its small controls
  'proto-raise': d => handOrder(() => ACTIONS['proto-raise'](d)),
  'proto-dress': d => handOrder(() => ACTIONS['proto-dress'](d)),
  'proto-tend': d => handOrder(() => ACTIONS['proto-tend'](d)),
  'proto-take': d => handOrder(() => ACTIONS['proto-take'](d)),
  'proto-pull': d => handOrder(() => ACTIONS['proto-pull'](d)),
  'proto-strike': d => handOrder(() => ACTIONS['proto-strike'](d)).then(r => { if (FS.proto) FS.proto.ask = null; return r; }),
  'proto-strike-ask': d => { FS.hand = { ...(FS.hand ?? {}), strike: d.on ? true : undefined }; invalidate('panel'); renderHand(); },
  'proto-strike-tile': d => { if (!FS.proto) return; const key = `${d.p},${d.q},${d.slot}`; FS.proto.ask = d.on === '' ? null : key; invalidate('panel'); },
  'proto-dress-pick': () => protoDressPick(),
  'proto-widen': d => { if (!FS.proto) return; endPick(); FS.hand = { ...(FS.hand ?? {}), widen: d.on ? true : undefined, tile: undefined }; invalidate('map', 'panel'); renderHand(); },
  'proto-send': d => protoSend({ p: num(d.p), q: num(d.q), tile: num(d.tile) }),
  'proto-guide': d => protoGuideGo(d),
  'proto-march-best': d => protoMarchBest({ p: num(d.p), q: num(d.q), tile: num(d.tile) }),
  'proto-more': () => { FS.hand = { ...(FS.hand ?? {}), more: FS.hand?.more ? undefined : true }; invalidate('panel'); renderHand(); },
  'proto-ticker': () => { if (FS.proto) { FS.proto.tickerOpen = !FS.proto.tickerOpen; renderProto(); } },
  // ---- the hand (hud/hand.mjs): the bar's buttons and its cards
  'hand-pop': d => { const sub = hand.subjectOf(FS); if (!sub) return; setPop(d.pop && hand.popOf(FS, sub) !== d.pop ? d.pop : null); },
  'hand-host': d => handHost(d.host || null),
  'hand-next': () => nextHost(1),
  // 進軍: the board is armed as soon as a host that can march has the hand; the button opens the line that says how far it may go
  'hand-march': () => { const sub = hand.subjectOf(FS); if (sub?.kind === 'host') setPop(hand.popOf(FS, sub) === 'march' ? null : 'march'); },
  // 村へ戻す: a march like any other, with the village as its destination; the order card is its confirmation
  'hand-return': async d => {
    const sub = hand.subjectOf(FS);
    if (sub?.kind !== 'host') return;
    if (sub.holdingIndex !== (FS.activeHolding ?? 0)) FS.activeHolding = sub.holdingIndex;
    endPick();
    await ACTIONS['march-home']({ host: d.host ?? sub.host.id });
    if (!FS.compose) return;
    FS.tab = 'map'; FS.report = null; FS.practice = null; FS.guideOpen = false; FS.explore = null;
    invalidate('map', 'panel', 'tabs', 'rail');
    if (FS.compose.routeError) { const h = hud.activeHolding(FS); mapNote({ p: h.p, q: h.q, idx: h.tile }, refusalText(FS.compose.routeError)); }
  },
  'hand-unit': d => { FS.hand = { ...(FS.hand ?? {}), unit: num(d.unit), n: undefined, troops: undefined }; invalidate('panel'); },
  'hand-n': d => { FS.hand = { ...(FS.hand ?? {}), n: num(d.n) }; invalidate('panel'); },
  'hand-troops': d => { FS.hand = { ...(FS.hand ?? {}), troops: num(d.n) }; invalidate('panel'); },
  'hand-info': () => { endPick(); FS.inspectOpen = true; FS.hand = { ...(FS.hand ?? {}), pop: null }; FS.tab = 'map'; invalidate('map', 'panel', 'tabs', 'rail'); },
  'hand-close': () => { endPick(); FS.selected = null; FS.hand = null; FS.inspectOpen = false; FS.actor = null; FS.mapNote = null; FS.explore = null; invalidate('map', 'panel', 'tabs', 'rail'); $('frontier-map')?.focus?.({ preventScroll: true }); },
  'hand-turn': () => { FS.dialOpen = true; closeTermPop(); renderDialPop(); $('dial-pop')?.querySelector('button')?.focus?.({ preventScroll: true }); },
  'hand-far': d => farChoice(d.how),
  // the orders of the bar and its cards: the controller's own, and the card closes once the order is accepted
  // (the build fan steps back as its order leaves: while the order was on its way the fan stood on over the village with
  // every building greyed — the queue counts the one just ordered — and the 「送信中…」 tag across its cards. A refusal is
  // said by the status notice and on the map, as for every order. The promotion's card, which also orders a build, stays
  // until its order has landed, as before.)
  build: d => { if (FS.hand?.pop === 'build') { endPick(); FS.hand = { ...FS.hand, pop: null }; invalidate('map', 'panel'); renderHand(); } return handOrder(() => ACTIONS.build(d)); },
  train: d => handOrder(() => ACTIONS.train(d)),
  muster: d => { const m = handNow(); protoPromise(m?.kind === 'village' ? hand.musterPlace(FS, m) : null); return handOrder(() => ACTIONS.muster(d)); },
  dissolve: d => handOrder(() => ACTIONS.dissolve(d)),
  'explore-send': d => handOrder(() => ACTIONS['explore-send'](d)),
  // 探索 on a host's card of the drawer: the Scouts take the hand on the board, where their tiles are picked
  'explore-open': d => { const row = hand.ownHosts(FS).find(r => r.id === String(d.host)); if (row && selectHost(row, { fly: true })) setPop('explore'); },
  // the seal: once the march has left, the board has the screen (the selection that was its destination goes; the column sets out)
  'march-send': async () => {
    const c = FS.compose;
    if (c?.host && c.dest && pm.fights(c.host)) protoPromise({ host: String(c.host.id), p: c.dest.p, q: c.dest.q, tile: c.dest.tile });
    // (only a forecast of the march as sent: a stance changed a moment ago has not been forecast yet)
    const fc = c?.forecast?.ok && c.forecast.key === forecastKey(c) ? { hostId: c.host.id, bell: c.arriveBell, stance: c.stance ?? 0, fc: c.forecast } : null;
    const r = await ACTIONS['march-send']();
    // (sent: what the card forecast is kept on this device, for the report's 予測 beside its 確定: hud/forecastbook.mjs)
    if (c && !FS.compose && fc) keepForecast(uiStorage, scope()?.seasonId, fc);
    if (c && !FS.compose) { FS.selected = null; FS.hand = null; FS.inspectOpen = false; FS.actor = null; FS.mapNote = null; invalidate('map', 'panel', 'tabs', 'rail'); }
    return r;
  },
  // this turn's list (hud/turnlist.mjs): 見る flies to where the order or the result is
  'turn-see': d => { closeDialPop(); const tile = d.tile === '' || d.tile === undefined ? undefined : num(d.tile); goToItem({ p: num(d.p), q: num(d.q), tile, tab: 'map' }); },
  // the dock (screens/shell.mjs renderTabs): "Map" closes the drawer, a tab opens it, the open tab pressed again closes it
  tab: d => {
    if (FS.mode !== 'play') return;
    const open = drawerOf(FS)?.kind === d.tab;
    // on a phone a press on the open tab while the sheet rests at its peek lifts the sheet instead
    if (open && phone() && sheetRef?.state() === 'peek') { sheetRef.set('half'); return; }
    if (d.tab === 'map' || open) { shutDrawer(); return; }
    FS.report = null; FS.practice = null; FS.guideOpen = false;
    ackHomeGrant();
    ACTIONS.tab(d);
    invalidate('rail');
  },
  'drawer-close': () => shutDrawer({ focus: !phone() }),
  // an order is written on the map, whatever screen it was started from: the drawer shows the order, the map its reach
  compose: d => {
    ACTIONS.compose(d);
    const c = FS.compose;
    if (!c) return;
    FS.tab = 'map'; FS.report = null; FS.practice = null; FS.guideOpen = false;
    if (d.stay === 'map' && !(FS.selected && FS.selected.p === c.origin.p && FS.selected.q === c.origin.q && FS.selected.idx === c.host.tile)) {
      // started from a list: the host's tile comes into view (a selection made on the map is already there)
      const at = (h => project(h.q, h.r))(tileHex(c.origin.p, c.origin.q, c.host.tile));
      if (mapRef && FS.view.lod !== 'tile') mapRef.setView({ x: at.x, y: at.y, zoom: 1.0 });
      FS.selected = { kind: 'tile', p: c.origin.p, q: c.origin.q, idx: c.host.tile };
    }
    invalidate('map', 'panel', 'tabs', 'rail');
  },
  'drawer-open': () => { FS.drawerShut = false; invalidate('panel'); },
  // the join flow and the guide's steps open in the drawer from the plate and the objective
  'join-open': () => { FS.joinShut = false; FS.tab = 'map'; FS.report = null; FS.practice = null; FS.selected = null; if (holdsLand(FS)) FS.guideOpen = true; invalidate('map', 'panel', 'tabs', 'rail'); },
  'guide-open': () => { FS.tab = 'map'; FS.report = null; FS.practice = null; FS.selected = null; FS.guideOpen = true; FS.joinShut = false; invalidate('map', 'panel', 'tabs', 'rail'); },
  // a selection named on a dock tab opens its inspector
  'sel-open': () => { FS.tab = 'map'; invalidate('panel', 'tabs', 'rail'); },
  // the village plate: one press home (pressed again while there: the next village)
  home: () => {
    camKeep.touch();
    mapRef?.home();
    const hs = FS.holdings ?? [], v = mapRef?.view;
    if (v && hs.length > 1) {
      const at = hs.map(h => (c => Math.hypot(c.x - v.x, c.y - v.y))((x => project(x.q, x.r))(tileHex(h.p, h.q, h.tile))));
      const i = at.indexOf(Math.min(...at));
      if (i >= 0 && i !== (FS.activeHolding ?? 0)) { FS.activeHolding = i; invalidate('panel', 'rail'); }
    }
  },
  'holding-go': d => {
    const i = num(d.i), h = FS.holdings?.[i];
    if (!h) return;
    FS.activeHolding = i;
    const c = (x => project(x.q, x.r))(tileHex(h.p, h.q, h.tile));
    camKeep.touch();
    mapRef?.setView({ x: c.x, y: c.y, zoom: Math.max(mapRef.view.zoom, 1.0) });
    invalidate('map', 'panel', 'rail');
  },
  sound: () => { try { globalThis.__fxAudio?.toggle?.(); } catch (e) { console.error('frontier sound:', e); } renderSound(); },
  'search-toggle': () => setSearch(!!$('map-search')?.hidden),
  'search-go': d => {
    const x = searchHits[num(d.i)];
    if (!x) return;
    setSearch(false, { focus: false });
    // a host that can march has the hand: what was searched for is where it may go (the camera goes there, the host stays in hand)
    const sub = FS.mode === 'play' && !FS.compose ? hand.subjectOf(FS) : null;
    if (sub?.kind === 'host' && hand.marchCheck(FS, sub.host).ok) {
      const A = actionsNow(), h = Number.isInteger(x.tile) ? tileHex(x.p, x.q, x.tile) : null;
      if (A && h) { orderMarch(A, { p: x.p, q: x.q, idx: x.tile, tileQ: h.q, tileR: h.r }).catch(() => {}); return; }
      goFar();
      mapRef?.flyTo({ p: x.p, q: x.q, zoom: 1.0 });
      summary(() => L`行き先のマスを押してください`);
      return;
    }
    goToItem({ ...x, tab: FS.mode === 'play' ? 'map' : undefined });
  },
  'home-begin': () => {
    ACTIONS['home-begin']();
    requestAnimationFrame(() => {
      const panel = $('hp-build');
      panel?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
      panel?.querySelector?.('button:not(:disabled)')?.focus({ preventScroll: true });
    });
  },
  lens: d => setLens(d.lens),
  'lens-menu': () => setLensMenu($('lenses')?.dataset.open !== 'true'),
  // the to-do lines wait behind their count: the tab opens and closes the list (on a phone the list is the raised sheet's)
  'todo-toggle': () => {
    if (phone()) { sheetRef?.set(sheetRef.state() === 'peek' ? 'half' : 'peek'); return; }
    FS.todoOpen = !FS.todoOpen; invalidate('rail');
  },
  // a candidate place of the wait view (screens/join.mjs): the map is asked to go there (`wylls:fly-to` with the site;
  // the map's own listener may take it — preventDefault — else the camera flies to the tile itself)
  'site-go': d => {
    const p = num(d.p), q = num(d.q), site = num(d.site), i = num(d.i);
    if (![p, q, site].every(Number.isInteger)) return;
    const tile = terrainRef?.(p, q)?.sites?.[site];
    const detail = { p, q, site, index: Number.isInteger(i) ? i : null, tile: Number.isInteger(tile) ? tile : null };
    let taken = false;
    try { taken = !globalThis.dispatchEvent?.(new CustomEvent('wylls:fly-to', { detail, cancelable: true })); } catch { /* no events here (tests) */ }
    if (!taken && mapRef) mapRef.flyTo(Number.isInteger(tile) ? { p, q, tile, zoom: 1.0 } : { p, q, zoom: 0.6 });
    if (phone() && sheetRef?.state() !== 'peek') sheetRef.set('peek');
  },
  // the order's summary line (hud/marchcard.mjs): on a phone it raises the sheet to the whole order; elsewhere the order's top comes into view
  'order-open': () => {
    if (phone() && sheetRef) { sheetRef.set(sheetRef.state() === 'peek' ? 'half' : 'peek'); return; }
    $('panel-body')?.querySelector?.('.order-body')?.scrollTo?.({ top: 0, behavior: calm() ? 'auto' : 'smooth' });
  },
  goto: d => { leaveReport(); closeResPop(); goToItem({ p: num(d.p), q: num(d.q), tab: 'map' }); },
  'intro-close': () => closeIntro(),
  'intro-open': () => openIntro(),
  'feed-go': d => { const x = (FS.feed ?? []).find(y => y.id === d.id); if (x?.banner && flyToBanner(x.banner)) return; goToItem(x); },
  // the card of this turn's results: "see" flies to the place (a battle is played there by its own button); × puts the card away
  'turn-go': d => { const x = turnStrip?.items.find(y => y.id === d.id); if (x) goToItem({ p: x.p, q: x.q, tile: Number.isInteger(x.tile) ? x.tile : undefined, tab: 'map' }); },
  'turn-dismiss': () => { if (turnStrip) turnStrip.dismissed = true; renderFeed(); },
  'feed-dismiss': d => { FS.feedDismissed = new Set([...(FS.feedDismissed ?? []), d.id]); renderFeed(); },
  'feed-filter': d => { FS.feedFilter = feed.FEED_FILTERS.includes(d.f) ? d.f : 'all'; invalidate('panel'); },
  // the status at the map: put a refusal away, or send the refused action once more
  'notice-close': () => { FS.notice = null; renderFeed(); invalidate('panel'); },
  'notice-retry': () => { const r = retryLast(); renderFeed(); return r; },
  autopan: () => { const sc = scope(); const v = !FS.ui?.autoPan; FS.ui = sc ? saveUi(uiStorage, uiKey(sc), { autoPan: v }) : { ...(FS.ui ?? {}), autoPan: v }; invalidate('panel'); },
  'battle-play': d => { leaveReport(); closeDialPop(); playBattle(num(d.p), num(d.q), num(d.bell), { focus: true }); },
  'res-open': d => { FS.resOpen = FS.resOpen === d.r ? null : d.r; renderHudTick(FS.chain?.now?.() ?? 0); },
  'res-close': () => closeResPop(),
  // pins (hud/pins.mjs): this device, this season
  'pin-toggle': d => {
    const sc = scope(); if (!sc) return;
    const place = { p: num(d.p), q: num(d.q), tile: d.tile === '' || d.tile === undefined ? null : num(d.tile) };
    if (!Number.isInteger(place.p) || !Number.isInteger(place.q)) return;
    FS.pins = pins.togglePin(FS.pins ?? pins.loadPins(uiStorage, sc.seasonId), place);
    pins.savePins(uiStorage, sc.seasonId, FS.pins);
    invalidate('panel', 'map'); renderMinimap();
  },
  'goto-pin': d => { leaveReport(); goToItem({ p: num(d.p), q: num(d.q), tile: d.tile === '' ? undefined : num(d.tile), tab: 'map' }); },
  // the count steppers (screens/holding.mjs): change the number field of the same form, within its min and max
  step: (d, el) => nudgeField(el, d.name, v => v + (num(d.d) || 0)),
  'step-set': (d, el) => nudgeField(el, d.name, () => num(d.v) || 0),
  'profile-clear': () => { const sc = scope(); if (sc) profile.clearOwnProfile(uiStorage, sc.seasonId); FS.ownProfile = null; peopleCache.at = -1; invalidate('panel', 'rail', 'map'); },
  // the spectator (screens/spectate.mjs, UI plan G3): faction filter, bell timeline, the camera following battles
  'watch-faction': d => { FS.watch = { ...(FS.watch ?? {}), faction: d.f === '' ? null : num(d.f) }; invalidate('panel'); },
  'watch-bell': d => { FS.watch = { ...(FS.watch ?? {}), bell: d.bell === '' ? null : num(d.bell) }; invalidate('panel'); },
  'watch-auto': () => { const v = (FS.watch?.auto ?? true) === false; FS.watch = { ...(FS.watch ?? {}), auto: v }; try { globalThis.localStorage?.setItem('ps-fwatch:v1', v ? '1' : '0'); } catch { /* none */ } invalidate('panel'); },
  'ob-go': () => guideGo(),
  'guide-level': d => { if (!guide.GUIDE_LEVELS.includes(d.v)) return; const sc = scope(); FS.ui = sc ? saveUi(uiStorage, uiKey(sc), { guide: d.v }) : { ...(FS.ui ?? {}), guide: d.v }; guideCache.at = 0; invalidate('panel', 'map', 'rail'); renderHudTick(FS.chain?.now?.() ?? 0); },
  'mile-close': () => closeMilestone(),
  'sel-clear': () => { FS.selected = null; invalidate('map', 'panel'); },
  dial: () => { FS.dialOpen = !FS.dialOpen; closeTermPop(); renderDialPop(); if (FS.dialOpen) $('dial-pop')?.querySelector('button')?.focus?.({ preventScroll: true }); },
  'dial-close': () => closeDialPop({ focus: true }),
  // the plate's one key while the viewer's record cannot be read (hud/hud.mjs renderPlate): the page again, from the start
  reload: () => globalThis.location?.reload?.(),
  term: d => { FS.term = FS.term === d.term || !glossary.TERMS[d.term] ? null : d.term; renderTermPop(); $('term-pop')?.querySelector('button')?.focus?.(); },
  'term-close': () => closeTermPop(),
  // the legend of the map (map/legend.mjs), from the "?" beside the lenses: the More sheet opens on it
  'legend-open': () => { closeTermPop(); setLensMenu(false); leaveReport(); if (FS.mode === 'play') { FS.tab = 'more'; FS.practice = null; } invalidate('panel', 'tabs'); requestAnimationFrame(() => { const g = $('survey-help'); for (let d = g?.closest?.('details'); d; d = d.parentElement?.closest?.('details')) d.open = true; g?.scrollIntoView?.({ block: 'start' }); g?.querySelector?.('h3')?.focus?.({ preventScroll: true }); }); },
  'glossary-open': () => { closeTermPop(); leaveReport(); if (FS.mode === 'play') FS.tab = 'more'; invalidate('panel', 'tabs'); requestAnimationFrame(() => { const g = $('glossary'); const d = g?.closest?.('details'); if (d) d.open = true; (d ?? g)?.scrollIntoView?.({ block: 'start' }); }); },
  // a card of the village drawer by its id: the folds around it open, it comes into view
  'hp-jump': d => {
    const el = /^hp-[a-z]+$/.test(d.id ?? '') ? $(d.id) : null;
    if (!el) return;
    for (let x = el.closest?.('details'); x; x = x.parentElement?.closest?.('details')) x.open = true;
    el.scrollIntoView?.({ block: 'start', behavior: calm() ? 'auto' : 'smooth' });
  },
  // how much may move (fx/motion.mjs reads FS.ui.effects) and the sound's mute (fx/audio.mjs, remembered on this device)
  'fx-level': d => { if (!['full', 'reduced', 'off'].includes(d.v)) return; const sc = scope(); FS.ui = sc ? saveUi(uiStorage, uiKey(sc), { effects: d.v }) : { ...(FS.ui ?? {}), effects: d.v }; invalidate('panel', 'map'); },
  'fx-sound': d => { fxAudio().setMuted(d.v !== 'on'); renderSound(); invalidate('panel'); },
  'battle-fx': d => { if (!['normal', 'fast', 'off'].includes(d.v)) return; const sc = scope(); FS.ui = sc ? saveUi(uiStorage, uiKey(sc), { battleFx: d.v }) : { ...(FS.ui ?? {}), battleFx: d.v }; invalidate('panel'); },
  attn: () => {
    const items = pillItems();
    if (!items.length) return;
    FS.attnIdx = ((FS.attnIdx ?? -1) + 1) % items.length;
    goToItem(items[FS.attnIdx]);
  },
  'attn-go': d => { FS.todoOpen = false; goToItem(hud.attentionItems(FS)[num(d.i)]); },
  'holding-pick': d => {
    const i = num(d.i), h = FS.holdings?.[i];
    if (!h) return;
    FS.activeHolding = i;
    goToItem({ p: h.p, q: h.q, tab: 'holding' });
  },
};

/** The relay's sends left at which its count shows in the top strip. */
export const QUOTA_LOW = 5;
function renderChips() {
  const f = $('faction-chip');
  const fc = factionChip(FS.citizen);
  // the nation's leader (the hexagon icon with the sigil at its foot) and name; on phones the icon alone
  if (f) { f.hidden = !fc; setHtmlIfChanged(f, fc ? html`${hud.leaderCrest(FS.citizen.faction, { size: 34 })}<span class="chip-text">${fc}</span>` : ''); }
  // the relay's count belongs to More → details (screens/bell.mjs); it stands in the strip only when it runs low
  const q = $('quota-chip');
  const qc = quotaChip(FS.quota);
  if (q) { q.hidden = !qc || !(Number(FS.quota?.left) <= QUOTA_LOW); q.textContent = qc ?? ''; }
  // the viewer's stage, for the stylesheet (what has no use before joining is not shown)
  // (`loading` until the viewer's record has answered: nothing that depends on the answer is offered, UX design 12.3)
  const body = globalThis.document?.body, stage = FS.mode === 'play' ? (viewerState(FS) === 'known' ? FS.land?.stage ?? 'none' : 'loading') : '';
  if (body?.dataset && body.dataset.stage !== stage) body.dataset.stage = stage;
}

// ------------------------------------------------------------------ wave 4: report, practice, onboarding (W4-E)
let heraldRef = null;
const num = x => Number.parseInt(x, 10);

/** Save the onboarding flags (ps-fui `dismissed`) of the pinned season; in memory only before a season is pinned. */
function setFlags(next) {
  const sc = scope();
  FS.ui = sc ? saveUi(uiStorage, uiKey(sc), { dismissed: next }) : { ...(FS.ui ?? loadUi(uiStorage, '')), dismissed: next };
  invalidate('panel');
}
const setFlag = (flag, add = true) => setFlags(withFlag(FS.ui?.dismissed ?? [], flag, add));

/** The page's kernel, with the season's ruleset required (practice and verify refuse another). */
async function seasonKernel() {
  const k = await loadKernel(FS.season ? { ruleset: toHex(FS.season.rulesetHash), url: new URL(`./wasm/${kernelFile(FS.season)}`, import.meta.url) } : undefined);
  if (FS.season && k.rulesetHash() !== toHex(FS.season.rulesetHash)) { const e = new Error('ruleset'); e.code = 'RulesetMismatch'; throw e; }
  return k;
}

/** Open the report of (P, Q, bell): the herald's /h/clash file, the ClashInputs decoded by this page. */
export async function openReport(p, q, bell) {
  if (!heraldRef || ![p, q, bell].every(Number.isInteger)) return;
  const rep = { p, q, bell, loading: true };
  FS.report = rep; FS.practice = null;
  invalidate('panel');
  const r = await heraldRef.clash(p, q, bell);
  if (FS.report !== rep) return;
  FS.report = r.ok ? { p, q, bell, clash: r } : { p, q, bell, error: r.code ?? 'Error' };
  if (r.ok) {
    // the province before the bell (the report's own copy) and, when that bell's clash is the last one resolved there,
    // the province now: the viewer's own side is on the page before anything is verified (screens/report.mjs recordRows)
    try { FS.report.before = r.report?.province_before_b64 ? decodeAccount('Province', fromBase64(r.report.province_before_b64)) : null; } catch { FS.report.before = null; }
    const now = FS.provinces.get(`${p},${q}`)?.province ?? null;
    // (resolved through that bell, and no later clash there: quiet turns since change nothing that fought)
    FS.report.after = now && now.resolvedNext > bell && (now.resolveSummary?.bell ?? bell) <= bell ? now : null;
    FS.report.destroyed = now?.resolveSummary?.bell === bell ? Number(now.resolveSummary.destroyed ?? 0) : null;
  }
  if (r.ok && FS.mode === 'play') setFlag(FLAG.report);
  invalidate('panel');
  // the keep of the province (screens/report.mjs keepStake): what a clash on its tile was for
  const open = FS.report;
  if (r.ok && conquestEnabled(FS.season) && heraldRef.keep) {
    const k = await heraldRef.keep(p, q).catch(() => null);
    if (k?.ok && FS.report === open) { open.keep = k.keep; invalidate('panel'); }
  }
}

async function verifyReport() {
  const rep = FS.report;
  if (!rep?.clash || rep.verifying || !FS.clock) return;
  rep.verifying = true;
  invalidate('panel');
  const v = await reportScreen.verifyClash({ p: rep.p, q: rep.q, bell: rep.bell, clash: rep.clash, herald: heraldRef, kernel: seasonKernel, clock: FS.clock, season: FS.season });
  rep.verifying = false;
  if (FS.report === rep) { rep.verify = v; invalidate('panel'); }
}

const retreatChoiceOf = bps => (RETREAT_CHOICES.find(c => c.bps === (bps ?? 0))?.id ?? 'never');

function openWhatIf() {
  const rep = FS.report, v = rep?.verify;
  if (!v?.args) return;
  const mine = mineOf(FS.holdings);
  const own = v.args.arrivals.filter(f => mine(f.id));
  const st = practiceScreen.practiceState({ faction: FS.citizen?.faction });
  if (own[0]) { st.stance = own[0].posture <= 3 ? own[0].posture : 0; st.retreat = retreatChoiceOf(own[0].retreatBps); }
  st.whatif = { p: rep.p, q: rep.q, bell: rep.bell, args: v.args, outcome: v.outcome, mine, mineCount: own.length, result: null };
  FS.practice = st;
  invalidate('panel');
}

async function runPractice({ reroll = false } = {}) {
  const st = FS.practice;
  if (!st) return;
  let k;
  try { k = await seasonKernel(); FS.practiceError = null; } catch (e) { FS.practiceError = e?.code ?? 'NoWasm'; invalidate('panel'); return; }
  if (st.whatif) {
    const retreat = st.retreat === 'never' ? null : retreatBps(st.retreat, st.ratio);
    st.whatif.result = practiceScreen.whatIf(k, st.whatif, st.whatif.mine, { stance: st.stance, retreat });
  } else {
    if (reroll || !st.seed) st.seed = practiceScreen.practiceSeed();
    st.result = practiceScreen.runScenario(k, st, st.seed);
    if (st.result.ok) st.history = [...st.history, st.stance].slice(-12);
  }
  if (FS.pin) setFlag(FLAG.practice); else invalidate('panel');
  // a phone: the result stands first in the sheet, above the orders; it comes into view (on desktop it is beside them)
  if (phone()) globalThis.requestAnimationFrame?.(() => $('panel-body')?.querySelector?.('.pr-result')?.scrollIntoView?.({ block: 'start', behavior: calm() ? 'auto' : 'smooth' }));
}

/** The wave-4 actions (data-act). */
export const W4_ACTIONS = {
  'report-open': d => openReport(num(d.p), num(d.q), num(d.bell)),
  'report-close': () => { FS.report = null; invalidate('panel'); },
  'report-verify': () => verifyReport(),
  'report-whatif': () => openWhatIf(),
  'practice-open': () => { FS.practice = practiceScreen.practiceState({ faction: FS.citizen?.faction }); invalidate('panel'); },
  'practice-close': () => { FS.practice = FS.mode === 'practice' ? practiceScreen.practiceState({ faction: FS.citizen?.faction }) : null; invalidate('panel'); },
  'practice-scenario': d => {
    const st = FS.practice;
    if (!st || !practiceScreen.SCENARIOS[d.scenario]) return;
    Object.assign(st, { scenario: d.scenario, troops: practiceScreen.SCENARIOS[d.scenario].troops, result: null, seed: null });
    invalidate('panel');
  },
  'practice-reroll': () => runPractice({ reroll: true }),
  'ob-seen': d => { if (FLAG[d.flag]) setFlag(FLAG[d.flag]); },
  'ob-skip': d => setFlag(FLAG.skip(String(d.step))),
  'ob-dismiss': () => setFlag(FLAG.dismissed),
  'ob-restore': () => setFlags(restoreFlags(FS.ui?.dismissed ?? [])),
};
/** The wave-4 forms (data-form). */
export const W4_FORMS = { 'practice-run': () => runPractice(), 'practice-whatif': () => runPractice(),
  'profile-name': f => saveOwnName(f.querySelector('input[name="name"]')?.value ?? ''),
  'map-search': f => { runSearch(f.querySelector('input')?.value ?? ''); if (searchHits[0]) HUD_ACTIONS['search-go']({ i: '0' }); } };
/** The wave-4 bound inputs (data-bind), all of the practice panel. */
export function w4Bind(name, value) {
  const st = FS.practice;
  if (!st) return false;
  if (name === 'pr-stance') st.stance = Math.max(0, Math.min(3, num(value) || 0));
  else if (name === 'pr-retreat') st.retreat = RETREAT_CHOICES.some(c => c.id === value && c.id !== 'custom') ? value : 'never';
  else if (name === 'pr-troops') st.troops = Math.max(100, Math.min(30_000, num(value) || 100));
  else return false;
  return true;
}

/** The play actions that send something to the chain: a refusal of one offers "try again" (hud/status.mjs). */
export const SENDS = Object.freeze(new Set(['harvest', 'build', 'train', 'muster', 'garrison', 'dissolve', 'join', 'session', 'auto-ticket', 'nudge', 'explore-send', 'settle-explore', 'settle-transit', 'march-send',
  // S1 (screens/s1.mjs)
  's1-vault', 's1-structure', 's1-raid', 's1-vote', 's1-seize', 's1-siege', 's1-expel', 's1-readmit',
  // (orders of the prototype rule "banners": to the sample world only)
  'proto-raise', 'proto-dress', 'proto-tend', 'proto-take', 'proto-pull', 'proto-strike']));
/** Send the refused action once more, as it was (`FS.lastAct`: its name and data, or a form's name and values). */
function retryLast() {
  const a = FS.lastAct;
  if (!a || FS.mode !== 'play') return undefined;
  FS.notice = null;
  if (a.kind === 'form') return FORMS[a.name]?.({ elements: Object.fromEntries(Object.entries(a.values ?? {}).map(([k, v]) => [k, { value: v }])), dataset: { form: a.name } });
  return ACTIONS[a.name]?.(a.data ?? {});
}
/** A refused control shakes its head once (visual only; the toast at the map says why). */
function shake(control) {
  const body = $('panel-body');
  if (!body?.querySelector || calm()) return;
  const same = (el, data) => Object.entries(data ?? {}).every(([k, v]) => el.dataset[k] === v);
  // (the drawer's control, or the action bar's and its card's: an order refused from the hand shakes there)
  const el = control.form ? body.querySelector(`form[data-form="${String(control.form).replace(/[^\w-]/g, '')}"] [type="submit"]`)
    : [body, handPopEl, handEl].flatMap(root => [...(root?.querySelectorAll?.(`[data-act="${String(control.act).replace(/[^\w-]/g, '')}"]`) ?? [])]).find(x => same(x, control.data));
  if (!el) return;
  el.classList.remove('refused'); void el.offsetWidth; el.classList.add('refused');
  setTimeout(() => el.classList.remove('refused'), 400);
}

/**
 * The nation choice tells the map which nation is looked at (UX design 7.2: its home wedge is lit on the
 * chart): `wylls:nation-focus` with `{faction}` on hover, keyboard focus and choice of a banner
 * (`[data-nation]`), and with the chosen nation (or null) when the pointer or the focus leaves the banners.
 */
let nationShown;
function nationFocus(faction) {
  const f = Number.isInteger(faction) && faction >= 0 && faction < 6 ? faction : null;
  if (f === nationShown) return;
  nationShown = f;
  // the confirm line says the looked-at nation's leader and creed (screens/join.mjs renders all six; the stylesheet shows one)
  const panel = $('panel'); if (panel?.dataset) panel.dataset.look = f === null ? '' : String(f);
  try { globalThis.dispatchEvent?.(new CustomEvent('wylls:nation-focus', { detail: { faction: f } })); } catch { /* no events here (tests) */ }
}
function mountNationFocus(doc) {
  const chosen = () => (drawerOf(FS)?.kind === 'nation' && Number.isInteger(FS.joinDraft?.faction) ? FS.joinDraft.faction : null);
  const at = e => { const el = e.target?.closest?.('[data-nation]'); return el ? Number(el.dataset.nation) : null; };
  doc.addEventListener('pointerover', e => { if (e.target?.closest?.('.nations')) nationFocus(at(e) ?? chosen()); else if (nationShown !== null && nationShown !== undefined) nationFocus(chosen()); });
  doc.addEventListener('focusin', e => { const f = at(e); if (f !== null) nationFocus(f); });
  doc.addEventListener('focusout', e => { if (at(e) !== null && !e.relatedTarget?.closest?.('[data-nation]')) nationFocus(chosen()); });
  doc.addEventListener('click', e => { const f = at(e); if (f !== null) nationFocus(f); });
}

/**
 * The map's side of the nation choice: while the six banners stand, the chart is their backdrop and the nation
 * that is looked at has its home wedge lit and brought into the part of the map above the banners
 * (map/opening.mjs `frame`). Null on every other screen.
 */
let nationLook = null;
function stageFrame() {
  if (FS.mode !== 'play' || drawerOf(FS)?.kind !== 'nation') return null;
  return Number.isInteger(nationLook) ? { nation: nationLook } : {};
}
function mountNationLook() {
  globalThis.addEventListener?.('wylls:nation-focus', e => {
    const f = e?.detail?.faction;
    nationLook = Number.isInteger(f) ? f : null;
    mapRef?.invalidate();
  });
}

/** Route the screens' clicks, forms and bound inputs: the wave-4 screens here, the play screens to the controller (game page only). */
function delegate(doc) {
  // a press elsewhere puts small things away: the phone's list of lenses; on a phone the leader's line (its first touch)
  doc.addEventListener('pointerdown', e => {
    if ($('lenses')?.dataset.open === 'true' && !e.target?.closest?.('#lenses')) setLensMenu(false);
    if (FS.dialOpen && !e.target?.closest?.('#dial-pop, #bell-pill, [data-act="hand-turn"]')) closeDialPop();
    if (phone() && mileTimer && Date.now() - mileAt > 350 && !e.target?.closest?.('#mile-banner')) closeMilestone();
  }, true);
  doc.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('lenses')?.dataset.open === 'true') { e.preventDefault(); setLensMenu(false); $('lenses')?.querySelector('.lens-toggle')?.focus({ preventScroll: true }); return; }
    const intro = $('intro');
    if (intro && !intro.hidden && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); closeIntro(); return; }
    if (e.key === 'Escape' && FS.resOpen) { e.preventDefault(); closeResPop(); return; }
    if (e.key === 'Escape' && FS.dialOpen) { e.preventDefault(); closeDialPop({ focus: true }); return; }
    if (e.key === 'Escape' && FS.term) { e.preventDefault(); closeTermPop(); return; }
    if (e.key === 'Escape' && $('map-search') && !$('map-search').hidden && e.target?.closest?.('.search-row')) { e.preventDefault(); setSearch(false); return; }
    // Escape on the map lets the selection go (the lit tiles with it); a march being composed is closed from its card
    if (e.key === 'Escape' && e.target?.id === 'frontier-map' && FS.selected && !FS.compose) {
      e.preventDefault();
      // (a card of the bar closes first; then the selection goes, and the dock comes back)
      if (FS.hand?.pop) { setPop(null); return; }
      endPick(); FS.selected = null; FS.hand = null; FS.inspectOpen = false; FS.actor = null; FS.mapNote = null; FS.explore = null; invalidate('map', 'panel', 'tabs', 'rail'); return;
    }
    // desktop: Escape puts the drawer away (never out of a field being typed in; on phones the sheet has its own rule)
    if (e.key === 'Escape' && !e.defaultPrevented && !phone() && $('panel')?.dataset.drawer === 'open' && !e.target?.closest?.('input, select, textarea')) {
      const was = drawerOf(FS)?.kind;
      shutDrawer({ focus: true });
      if (drawerOf(FS)?.kind !== was) { e.preventDefault(); return; }
    }
    // . , next / previous ready host; ] [ next / previous holding; 1–4 the lenses (never while typing)
    if ((FS.mode !== 'play' && !/^[1-4]$/.test(e.key)) || e.target?.closest?.('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = { '.': () => cycleHost(1), ',': () => cycleHost(-1), ']': () => cycleHolding(1), '[': () => cycleHolding(-1),
      1: () => setLens('realm'), 2: () => setLens('war'), 3: () => setLens('land'), 4: () => setLens('settle') }[e.key];
    if (k) { e.preventDefault(); k(); }
  });
  const play = FS.mode === 'play';
  // `then`: a refusal (the notice the action left) shakes the control that was pressed, once
  const run = (p, control = null) => Promise.resolve(p).catch(e => { FS.notice = { ok: false, code: e?.code ?? 'Error', text: String(e?.message ?? e) }; invalidate('panel'); })
    .then(() => { if (control && FS.notice && FS.notice.ok === false && !FS.notice.busy) shake(control); });
  const action = name => HUD_ACTIONS[name] ?? W4_ACTIONS[name] ?? (play ? ACTIONS[name] : undefined);
  doc.addEventListener('click', e => {
    const el = e.target.closest?.('[data-act]');
    const fn = el && !el.disabled ? action(el.dataset.act) : undefined;
    if (!fn) return;
    if (el.tagName !== 'INPUT') e.preventDefault();
    // a control that cannot be pressed now stays reachable and says why (`aria-disabled`): it does nothing else
    if (el.getAttribute('aria-disabled') === 'true') { refuseInPlace(el); return; }
    const sends = play && SENDS.has(el.dataset.act) && ACTIONS[el.dataset.act];
    if (sends) FS.lastAct = { kind: 'act', name: el.dataset.act, data: { ...el.dataset } };
    run(fn(el.dataset, el), sends ? { act: el.dataset.act, data: { ...el.dataset } } : null);
  });
  doc.addEventListener('submit', e => {
    const f = e.target.closest?.('form[data-form]');
    const fn = f ? W4_FORMS[f.dataset.form] ?? (play ? FORMS[f.dataset.form] : undefined) : undefined;
    if (!fn) return;
    e.preventDefault();
    const sends = play && !!FORMS[f.dataset.form] && f.dataset.form !== 'dest';
    if (sends) FS.lastAct = { kind: 'form', name: f.dataset.form, values: Object.fromEntries([...f.elements].filter(x => x.name && (x.type !== 'radio' || x.checked)).map(x => [x.name, x.value])) };
    run(fn(f), sends ? { form: f.dataset.form } : null);
  });
  doc.addEventListener('input', e => {
    const form = e.target.closest?.('form[data-form="train"]');
    if (!form) return;
    FS.trainingDraft = { unit: Number(form.elements.unit.value), n: Number(form.elements.n.value) };
    invalidate('panel');
  });
  doc.addEventListener('change', e => {
    const el = e.target.closest?.('[data-bind]');
    if (!el) return;
    if (w4Bind(el.dataset.bind, el.value)) invalidate('panel');
    else if (play) bind(el.dataset.bind, el.value);
  });
}

/** The spectator's poll: the events and the bell sheet at load, then every 30 s (§4.2), paused while hidden. */
/** A clash newer than the last one seen: the spectator's camera goes there and plays it (unless turned off). */
let watchSeen = null;
function followBattles() {
  const c = reportScreen.clashesFrom(FS.chronicle ?? [], 1)[0];
  if (!c) return;
  const key = `${c.p},${c.q},${c.bell}`;
  if (watchSeen === null) { watchSeen = key; return; }   // the first look is not news
  if (key === watchSeen) return;
  watchSeen = key;
  const f = FS.watch?.faction;
  if (FS.watch?.auto === false || FS.report || (Number.isInteger(f) && !provinceFactions(FS.overviews, c.p, c.q).includes(f))) return;
  playBattle(c.p, c.q, c.bell, { focus: true }).then(ok => { if (!ok) mapRef?.flyTo({ p: c.p, q: c.q, zoom: 0.6 }); });
}

function startSpectate(herald) {
  useHerald(herald);
  try { FS.watch = { ...(FS.watch ?? {}), auto: globalThis.localStorage?.getItem('ps-fwatch:v1') !== '0' }; } catch { /* none */ }
  let errors = 0, first = true;
  const tick = async () => {
    const wait = nextPoll({ kind: 'own', hidden: first ? false : globalThis.document?.hidden, errors });
    first = false;
    if (wait === null) { globalThis.setTimeout(tick, 5000); return; }
    try {
      await refreshPlay();
      FS.bellItems = spectateScreen.spectateBells(FS, FS.chain?.now() ?? 0);
      followBattles();
      errors = 0;
    } catch (e) { errors++; console.error('frontier spectate:', e); }
    invalidate('panel');
    globalThis.setTimeout(tick, wait * 1000);
  };
  tick();
}

async function loadSeason(herald) {
  const r = await herald.season();
  if (!r.ok) { FS.error = { code: r.code, text: clientText(r.code) }; invalidate('status'); return false; }
  const { record, season } = r;
  try {
    FS.pin = setPin({ programId: record.programId, cluster: record.cluster, seasonId: record.season, seasonAddress: record.seasonAddress ?? null, rulesetHash: toHex(season.rulesetHash) });
  } catch (e) {
    FS.error = { code: e.code, text: e.message };
    invalidate('status');
    return false;
  }
  herald.pin(record.season, FS.pin.addresses);
  FS.beacon = checkBeacon({ drand: record.drand, seasonPkHash: season.quicknetPkHash, cluster: record.cluster, seasonNetwork: season.network });
  if (!FS.beacon.ok) FS.error = { code: FS.beacon.code, text: clientText(FS.beacon.code) };
  FS.record = record;
  FS.season = season;
  setS1(season);
  FS.clock = seasonClock(season);
  // Only a localnet Clock runs accelerated (§8.7); every other cluster's rate is 1.
  FS.chain.setAccelerated(record.cluster === 'localnet');
  FS.chain.observe(record.latestUnix, record.latestSlot);
  // A sample world (the screenshot fixture's world that keeps going, UX design 14.5) says so in its season record and
  // declares its clock's rate: the dial is right from the first sample, and the page says 見本の世界 for as long as it
  // is open. Only a localnet record is believed (`declare` refuses on any other cluster).
  FS.chain.declare(record.sample?.rate);
  setClockPace(() => (FS.chain?.accelerated ? FS.chain.rate : 1));
  FS.sample = record.cluster === 'localnet' && record.sample?.world === 'sample' ? record.sample : null;
  // (the prototype rule "banners" is on exactly while that record carries it: the chip stands from this moment)
  syncProto();
  invalidate('chip', 'status', 'map');
  return true;
}

async function loadOverviews(herald) {
  const rings = Math.max(1, FS.record?.rings?.length ?? 1);
  for (let d = 0; d < rings; d++) {
    const r = await herald.overview(d);
    if (r.ok) FS.overviews.set(d, r);
  }
  invalidate('map');
}

/** Start the page. */
export async function boot() {
  const cfg = config();
  FS.mode = cfg.mode;
  setRelay(cfg.relay);
  FS.chain = new ChainClock();
  // the materials drawn by code (paper grain, the sheet's uneven edge, cloth, brushed metal): hud/textures.mjs
  mountTextures();
  mountLangToggle($('lang-box'));
  // The phone bottom sheet (W5-E; mounted here since W6-D, R3); the drawer state drives its height (applyDrawer).
  sheetRef = mountSheet();
  // a sheet that changes its height shows another part of an order: the row its foot would cut is settled again (hud/drawer.mjs settleRows), now and once the sheet has moved
  { const sheetEl = $('panel'); if (sheetEl && globalThis.MutationObserver) new MutationObserver(() => { settleSoon(); setTimeout(settleSoon, 280); mapRef?.invalidate?.(); }).observe(sheetEl, { attributes: true, attributeFilter: ['data-sheet'] }); }
  // (and once the reader scrolls such a part, the gap left at rest goes: hud/drawer.mjs releaseRows)
  $('panel')?.addEventListener('scroll', e => { releaseRows(e.target); }, { capture: true, passive: true });
  // the plate, the to-do lines and the objective stand in the sheet on phones and over the map on desktop
  globalThis.matchMedia?.(`(max-width: ${PHONE_MAX}px)`)?.addEventListener?.('change', () => { drawerKind = undefined; invalidate('panel', 'tabs', 'rail'); });
  const herald = createHerald({ base: cfg.herald });
  rosterRef = createRoster({ base: cfg.herald ?? '', onChange: () => { mapRef?.invalidate(); invalidate('panel'); } });
  FS.roster = rosterRef;
  let map = null;
  const canvas = $('frontier-map');
  heraldRef = herald;
  if (FS.mode === 'practice') FS.practice = practiceScreen.practiceState();
  registerRenderers([
    ['chip', renderChip],
    ['status', renderStatus],
    ['map', () => map?.invalidate()],
    ...(FS.mode === 'play' ? [['chips', renderChips], ['tabs', renderPlay], ['panel', renderPlay]] : [['panel', renderMode]]),
    ['rail', renderRail],
  ]);
  delegate(globalThis.document);
  mountNationFocus(globalThis.document);
  mountNationLook();
  mountLandingLine();
  mountHand();
  mountTurnStrip();
  mountResGain();
  mountRadioKeys();
  mountSound();
  if (canvas) {
    // Tile-LOD terrain from the season record's ring seeds through the rules module (W5-E R3: passed by the app).
    const terrainOf = createTerrain({ onReady: () => { map?.invalidate(); invalidate('panel'); } });
    terrainRef = terrainOf;
    // places are named by what stands on them (hud/place.mjs reads the terrain through the store)
    FS.terrainOf = terrainOf;
    // S1: a village's terrain ore, as the map reads it (fs1.mjs): its buildings, the next copy's cost and the guide count over it
    setOreExtraProvider((p, q, tile) => map?.art?.oreAround?.(p, q, tile)?.total ?? null);
    map = new FrontierMap(canvas, {
      source: () => {
        if (rosterRef) for (let d = 0; d < (FS.record?.rings?.length ?? 1); d++) rosterRef.ensure(d);
        const own = ownNow();
        return { overviews: FS.overviews, ringsOpen: FS.record?.rings?.length ?? 1, own, selected: FS.selected, terrainOf,
          // what this viewer has surveyed (map/survey.mjs): the one rule for the map, the minimap, tips, the inspector and search
          survey: surveyNow(),
          // art mode: the decoded Province (holdings' tiers, hosts on tiles, camp), loaded on demand
          viewerFaction: FS.citizen?.faction ?? null,
          // who is looking, for the opening view (map/opening.mjs)
          open: openHint(FS, { ready: viewerKnown, title: titleUp(), frame: stageFrame() }),
          // the nation that is looked at in the nation choice: its home wedge is lit on the chart (map/chart.mjs paintWedge)
          focusNation: stageFrame()?.nation ?? null,
          demoRoads: ART_ROADS,
          engineStage: ART_ENGINE,
          demoSpecials: ART_RELICS,
          demoRivers: ART_RIVERS,
          alliedPairs: ART_ALLY,
          artReplayRing: ART_RINGOPEN ? Math.max(0, (FS.record?.rings?.length ?? 1) - 1) : null,
          clashOf: ART_ON ? artClashOf : undefined,
          pendingOf: ART_ON ? (p, q) => FS.provinces.get(`${p},${q}`)?.inputs ?? null : undefined,
          people: ART_ON && FS.mode !== 'practice' ? peopleSource : undefined,
          // the world view's labels: the faction names and the Concord, in the page's language
          realmName: f => (f === 'concord' ? L`大協約` : factionName(f)),
          lens: FS.view.lens ?? 'realm',
          // incoming risk around the viewer's holdings (hud/hud.mjs attention, controller incoming warnings)
          threats: (FS.incoming ?? []).map(w => ({ p: w.holding.p, q: w.holding.q, tile: w.holding.tile, bell: w.bell })),
          threatLabel: w => L`来襲 ターン ${fmtNum(w.bell)}`,
          // the bell now (an overview older than the last bell no longer says "a clash this bell")
          bell: FS.nowBell ?? null,
          // what the selected host can do, lit on the map (map/actions.mjs); the route under the pointer; the map's own answer to a tap
          actions: actionsNow(),
          hoverRoute,
          note: FS.mapNote ?? null,
          // a village this device sees land for the first time (map/landing.mjs)
          landing: landingNow(), landingSoon: landingSoon(),
          // S1: vaults, structures and caravans from the herald's feeds (map/s1marks.mjs)
          s1: s1MarksNow(),
          // the wait for the village on the map (map/waitview.mjs): when the next turn begins and, with a request out, when its result is due
          wait: waitNow(),
          // the viewer's pins (hud/pins.mjs)
          pins: FS.pins ?? [],
          // the guide's target of the current step (hud/guide.mjs; "all" only)
          guide: guideNow(),
          guideLabel: guide.guideLabel,
          // the guide is named in one place, the top strip's button: the canvas's own label makes way (the ivory ring on the ground stays)
          guideChip: true,
          // holdings' tiers for the far view from the roster (no province loads for a spectator's world map)
          tierOf: (p, q, site) => rosterRef?.tierOf(p, q, site) ?? null,
          // the march being composed: its route, drawn for this browser only (the destination is sealed)
          route: FS.compose ? { hexes: marchCard.routeHexes(FS.compose), dest: FS.compose.dest ? tileHex(FS.compose.dest.p, FS.compose.dest.q, FS.compose.dest.tile) : null,
            arriveBell: FS.compose.route ? marchCard.bellWindow(FS)?.value ?? null : null } : null,
          territoryEnabled: territoryEnabled(FS), territoryOf: (p, q) => territoryOf(FS, p, q),
          provinceOf: ART_ON ? (p, q, { far = false } = {}) => { if (!far) wantProvince(p, q, () => map?.invalidate()); return FS.provinces.get(`${p},${q}`)?.province ?? null; } : undefined };
      },
      onSelect: hit0 => {
        // a tap selects what the zoom shows: a province from afar, a tile up close
        const hit = FS.view.lod === 'tile' ? hit0 : { kind: 'province', p: hit0.p, q: hit0.q };
        // the press was on the figures or the token of one of the viewer's hosts (the board says so: map.hostAt): that host takes the hand
        const pressed = FS.mode === 'play' && !FS.compose && !FS.hand?.pick && FS.view.lod === 'tile' ? hostUnderPress() : null;
        lastPress = null;
        if (pressed && hand.subjectOf(FS)?.host?.id !== pressed.id) { selectHost(pressed); return; }
        // from afar, with a host that can march in the hand: the tap chooses where to look for its destination (the
        // camera goes there at tile detail and the host stays in hand: the next tap, on a tile, is the order)
        if (FS.mode === 'play' && !FS.compose && !Number.isInteger(hit.idx)) {
          const sub = hand.subjectOf(FS);
          if (sub?.kind === 'host' && !FS.hand?.pick && hand.marchCheck(FS, sub.host).ok) { goFar(); map.flyTo({ p: hit.p, q: hit.q, zoom: 1.0 }); summary(() => L`行き先のマスを押してください`); return; }
        }
        // a conquest season, a fighting host in the hand: the press was on a keep of the lit reach (the board says so:
        // `hit.keep`, map/fmap.mjs). A keep in reach is the order for it, the same as its row of the card 砦へ進軍; a keep
        // out of reach is answered on the board with the reason (map/keeps.mjs `tapped`) and no order card opens
        if (hit0?.keep && FS.mode === 'play' && !FS.compose && !FS.hand?.pick) {
          const sub = hand.subjectOf(FS);
          if (sub?.kind === 'host' && keephand.conquestOn(FS)) {
            if (hit0.keep.reachable && !keephand.waitOf(FS, sub.host)) Promise.resolve(ACTIONS['cq-march']({ host: sub.host.id, p: hit0.keep.p, q: hit0.keep.q, tile: hit0.idx })).catch(() => {});
            return;
          }
        }
        // the hand holds something: the tap is its order, or the map answers it (map/actions.mjs)
        if (mapTap(hit)) return;
        FS.selected = hit;
        FS.actor = null; FS.mapNote = null; FS.hand = null; FS.inspectOpen = false;
        // (an exploration being picked on the map belongs to its Scout's tile: another selection lets it go)
        if (FS.explore?.host && !(hit.p === FS.explore.host.p && hit.q === FS.explore.host.q && hit.idx === FS.explore.host.tile)) FS.explore = null;
        // one of the viewer's own villages: it becomes the active one (its hosts act from here)
        const mine = Number.isInteger(hit.idx) ? (FS.holdings ?? []).findIndex(h => h.p === hit.p && h.q === hit.q && h.tile === hit.idx) : -1;
        if (mine >= 0 && mine !== (FS.activeHolding ?? 0)) { FS.activeHolding = mine; invalidate('rail', 'tabs'); }
        summary(() => (FS.selected === hit ? L`${placeName(inspect.inspectModel(FS, terrainOf))} を選びました` : ''));
        // The inspector reads the province envelope (loaded once, on demand).
        const chooseHome = () => {
          if (FS.selected !== hit || !instantHomeEnabled(FS.season) || FS.holdings?.length || FS.homeChoice?.busy || !Number.isInteger(hit.idx)) return;
          const candidate = homeSites(FS.provinces.get(`${hit.p},${hit.q}`)?.province, { faction: FS.citizen?.faction ?? null, nowBell: FS.nowBell, ringsOpen: FS.record?.rings?.length ?? 0 }).find(s => s.tile === hit.idx);
          if (!candidate) return;
          const choice = FS.homeChoice;
          if (!choice) return;
          let i = choice.candidates.findIndex(s => sameHome(s, candidate));
          if (i < 0) { choice.candidates = [...choice.candidates.slice(0, 2), candidate]; i = choice.candidates.length - 1; }
          ACTIONS['home-pick']({ i });
        };
        if (FS.mode !== 'practice') { wantProvince(hit.p, hit.q, () => { chooseHome(); map?.invalidate(); invalidate('panel'); }); wantKeepHistory(hit.p, hit.q, () => invalidate('panel')); chooseHome(); }
        // composing a march: a tap on another tile makes it the destination (Civ: select the unit, click where)
        const c = FS.compose;
        if (FS.mode === 'play' && c && !c.sending && Number.isInteger(hit.idx) && !(hit.p === c.origin.p && hit.q === c.origin.q && hit.idx === c.host.tile)) Promise.resolve(ACTIONS['dest-from-map']()).then(() => { if (FS.compose === c && c.routeError) mapNote(hit, refusalText(c.routeError, hit)); }).catch(() => {});
        invalidate('map', 'panel');
      },
      onView: (_, lod) => { FS.view.lod = lod; renderMinimap(); },
      onHover: (hit, at) => { tipAt = hit && at ? { hit, at } : null; showTip(hit, at); hoverPlan(hit); protoHover(hit); },
      // the camera centres in the part of the map the HUD leaves free (hud/insets.mjs): the strip, the open drawer, the dock, the phone's sheet
      insets: () => hudInsets(),
      // what follows the picture on screen: the minimap's frame while the camera travels
      onDraw: () => { if (map?.cam?.moving) renderMinimap(); if (handPopEl && !handPopEl.hidden && handPopEl.dataset.mode === 'fan') placeHandPop(); },
      // Sprite art at tile LOD, opt-in with ?art=1 (docs/frontier/art/tiles/LOD.md).
      art: ART_ON,
    });
    mapRef = map;
    // >>> proto-board: the banner rule's PROTOTYPE (a design, not in the program; the sample world serves its records only when
    // it was started with claims=1). The page's one reading of its records (FS.proto) reaches the map here and nowhere
    // else: proto/board-mount.mjs builds the board's model from it each time the page has drawn itself (renderProto)
    protoBoard = mountProtoBoard({ map, want: wantPreview });
    // <<< proto-board
    // >>> keep-board: the keeps of a conquest season on the board (map/keeps.mjs). The page's conquest records reach the
    // map here and nowhere else: map/keepmount.mjs hands it the keep events and the viewer's nation, and lights the
    // keeps the host in hand can reach until the hand lights its own (`map.setKeepReach`)
    mountKeepBoard({ map });
    // <<< keep-board
    // where the map was pressed (the board says whether a host stands there: hostUnderPress), and whether the player
    // moved the camera by hand (a drag, the wheel, the map's keys: a kept view is then not gone back to; hud/camkeep.mjs)
    {
      let down = null;
      canvas.addEventListener?.('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; lastPress = { x: e.clientX, y: e.clientY }; }, true);
      // (a press that became a drag is not a press on anything, and a key on the map is not a press at all: the place
      // of the last pointer stayed behind, so Enter on the map's middle tile took the host that stood where a drag had
      // ended instead. Found by the interaction suite at the integration of wave 5)
      canvas.addEventListener?.('pointermove', e => { if (down && e.buttons && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { camKeep.touch(); down = null; lastPress = null; } }, true);
      canvas.addEventListener?.('pointerup', e => { lastPress = down ? { x: e.clientX, y: e.clientY } : null; down = null; }, true);
      canvas.addEventListener?.('wheel', () => camKeep.touch(), { passive: true, capture: true });
      // a conquest season, the card 砦へ進軍 open: a press on a lit keep (the board's own hit test, `map.keepAt(clientX, clientY)`,
      // asked only if the board has it) is the same choice as its row: the order card for that keep
      canvas.addEventListener?.('click', e => {
        if (FS.hand?.pop !== 'keeps' || FS.compose || !mapRef?.keepAt) return;
        const sub = hand.subjectOf(FS);
        if (sub?.kind !== 'host') return;
        let k = null;
        try { k = mapRef.keepAt(e.clientX, e.clientY); } catch { k = null; }
        const row = k ? keephand.keepsModel(FS, sub.host).rows.find(x => x.p === k.p && x.q === k.q) : null;
        if (!row || keephand.waitOf(FS, sub.host)) return;
        e.stopImmediatePropagation(); e.preventDefault();
        Promise.resolve(ACTIONS['cq-march']({ host: sub.host.id, p: row.p, q: row.q, tile: row.tile })).catch(() => {});
      }, true);
      // (the board says a capture or a contest it read from the records — `keep:captured`, `keep:contest` —: the counts and
      // the keeps are read again at once, so that the strip and the panels follow the same record)
      for (const ev of ['keep:captured', 'keep:contest']) { try { fxOn(ev, () => { if (keephand.conquestOn(FS)) refreshConquest().catch(() => {}); }); } catch { /* no bus */ } }
      canvas.addEventListener?.('keydown', e => { lastPress = null; if (/^(Arrow|[+\-=hHmM]$)/.test(e.key)) camKeep.touch(); }, true);
      globalThis.document?.addEventListener?.('click', e => { if (e.target?.closest?.('.map-btn[data-map], #minimap-canvas')) camKeep.touch(); }, true);
    }
    // the HUD's rectangles reach the map through this name (publishNoGo: `__wyllsMap.setNoGo`); the effects' set
    // pieces call the same map (`setPiece`, `hideLabelsAt`: fx/engine.mjs is mounted on it)
    globalThis.__wyllsMap = map;
    publishNoGo();
    // a press on the dimmed map behind a document (the report, a practice battle) puts the document away, and is not a selection
    canvas.addEventListener?.('pointerdown', e => {
      if (FS.mode !== 'play' || globalThis.document?.body?.dataset.doc !== 'wide') return;
      e.stopImmediatePropagation(); e.preventDefault();
      shutDrawer();
    }, true);
    // the map buttons take their icons from the sprite (hud/icons.mjs)
    iconizeMapTools(globalThis.document);
    startFx({ map, canvas, effects: () => FS.ui?.effects });   // the effects layer and, with ?fx=, its demo switch (fx/index.mjs)
    // `?fx=hand-…`: the conquest panels alone, from records of finished runs, under the demo tag (hud/handdemo.mjs; loaded on demand)
    try { const q = new URLSearchParams(globalThis.location?.search ?? ''); if (/(^|,)\s*hand-/.test(q.get('fx') ?? '')) import('./hud/handdemo.mjs').then(m => m.startHandDemo({ params: q })).catch(e => console.warn('hand demo:', e)); } catch { /* no address */ }
    renderLenses();
    const mini = $('minimap-canvas');
    mini?.addEventListener('pointerup', e => {
      const r = mini.getBoundingClientRect();
      const fr = minimap.frameOf(Math.max(1, FS.record?.rings?.length ?? 1) + 1, r.width);
      const w = fr.toWorld(e.clientX - r.left, e.clientY - r.top);
      map.flyTo({ x: w.x, y: w.y }, null, { exact: true });
    });
    onLangChange(renderLenses);
    $('map-search-q')?.addEventListener('input', e => runSearch(e.target.value));
    // The art preview opens on the tiles with everything shown (presentation only).
    if (ART_RINGOPEN) setInterval(() => map?.invalidate(), 6000);
    // ?art=1&battle=P,Q,BELL plays that clash on a loop (presentation only; the demo's battle shot)
    const bq = ART_PREVIEW ? (ART_Q.get('battle') ?? '').split(',').map(Number) : [];
    if (bq.length === 3 && bq.every(Number.isInteger)) {
      const go = () => playBattle(bq[0], bq[1], bq[2], { focus: !FS.battleFocused }).then(ok => { if (ok) FS.battleFocused = true; });
      setTimeout(go, 4000); setInterval(go, (PHASE.end + 2.5) * 1000);
    }
    if (ART_PREVIEW || ART_Q.has('at')) {
      // ?at=P,Q[,TILE[,ZOOM]]: a link that opens the map on a province, or on one tile at a zoom (with ?art=1 the preview's default)
      const [ap, aq, at, az] = (ART_Q.get('at') ?? '2,0').split(',').map(Number);
      const P = Number.isInteger(ap) ? ap : 2, Q = Number.isInteger(aq) ? aq : 0;
      const c = Number.isInteger(at) ? (h => project(h.q, h.r))(tileHex(P, Q, at)) : provincePixel(P, Q);
      map.setView({ x: c.x, y: c.y, zoom: Number.isFinite(az) && az > 0 ? Math.min(az, 2.5) : 0.8 });
    }
  }
  invalidate('chip', 'status', 'panel', 'chips');
  if (title.shouldOpen({ storage: globalThis.localStorage, search: globalThis.location?.search ?? '' })) openIntro();
  if (await loadSeason(herald)) {
    await loadOverviews(herald);
    // Practice runs without a season too (the kernel only needs its own ruleset); a season pins it and keeps its flags.
    if (FS.mode === 'practice') { FS.ui = loadUi(uiStorage, uiKey(scope())); invalidate('panel'); }
    if (FS.mode === 'spectate') startSpectate(herald);
    if (FS.mode === 'play') {
      // the first answer about the viewer decides whether the join flow opens by itself (hud/drawer.mjs) and where the map opens (map/opening.mjs)
      startPlay({ herald, cfg }).catch(e => console.error('frontier play:', e)).then(() => { FS.playReady = true; FS.viewerMissed = !!FS.wallet && !FS.land; invalidate('panel', 'tabs', 'rail', 'chips'); }).finally(() => { viewerKnown = true; map?.invalidate(); });
      // the drawer starts closed: the tab of the last visit is not reopened over the map
      FS.tab = 'map';
    }
  }
  // without a season nobody's record will come: the map opens on what there is
  if (FS.mode !== 'play' || !FS.record) { viewerKnown = true; map?.invalidate(); }
  // The chip ticks every second (never announced: aria-live is off on it).
  // (the dial is read once a second; on a clock that runs fast — a sample world — four times, so that the page hears
  // a toll within a quarter of a second: a second late was 50 to 75 seconds of that world's turn, in which the
  // page still offered orders the world refuses until the province has caught up)
  // (only the turn is read in between, and the dial is drawn again when it changed: drawing the whole HUD four times a
  // second began the build fan's entrance again and again)
  let chipTick = 0;
  globalThis.setInterval?.(() => {
    // (an order card that stands open follows the clock: the earliest turn it can name moves on with it)
    if (FS.compose && FS.mode === 'play') { try { composeTick(); } catch (e) { console.error('frontier compose:', e); } }
    if (++chipTick % 4 === 0) { invalidate('chip'); return; }
    if (!(Number(FS.chain?.rate) >= 10) || !FS.clock || tollBell === null) return;
    let b = null;
    try { b = hud.bellModel(FS.clock, FS.chain.now()).bell; } catch { b = null; }
    if (Number.isInteger(b) && b > tollBell) invalidate('chip');
  }, 250);
  // The season record every 30 s (own data poll), paused while hidden.
  let errors = 0;
  const poll = async () => {
    const hidden = globalThis.document?.hidden;
    const wait = nextPoll({ kind: 'own', hidden, errors });
    if (wait === null) { globalThis.setTimeout(poll, 5000); return; }
    const ok = await loadSeason(herald);
    errors = ok ? 0 : errors + 1;
    // (a clock that runs fast is read more often: a quarter of a turn at most, clock.mjs pollCap)
    globalThis.setTimeout(poll, Math.min(wait, pollCap(FS.chain)) * 1000);
  };
  globalThis.setTimeout(poll, Math.min(30, pollCap(FS.chain)) * 1000);
}

if (globalThis.document && !globalThis.process?.versions?.node) boot().catch(e => console.error('frontier boot:', e));
