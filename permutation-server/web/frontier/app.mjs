import { territoryEnabled, territoryOf } from './territory.mjs';
import { landOf, landSummary, landElsewhere, renderLandChip } from './land.mjs';
import { setS1, setOreExtraProvider, s1On } from './fs1.mjs';
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
import { localPlayRequested, localLauncherRequested, openLocalPlayGate, localPlayWorldCheck } from './flocalplay.mjs';
import { localPersistPage } from './flocalplay.mjs';
import { sessionSettled } from './flocalplay-session.mjs';
import { currentEphemeralWallet } from './fephemeral-wallet.mjs';
import { staleBannerView, endedBannerView, rereadLabel } from './stale-banner.mjs';
import { isNotOpen, notOpenBannerView, readWorldOpen } from './world-not-open.mjs';
import { createWorldWatch, worldStateOf, worldEndedWord } from './flocalplay-ended.mjs';
// B21: the launcher that stopped answering (a plain line, not only the dial's red mark) and the test-world box that is told
import { createLauncherWatch } from './flocalplay-ended.mjs';
import { sessionNoticeOf } from './flocalplay-session.mjs';
import { launcherLostBannerView } from './stale-banner.mjs';
import { FS, invalidate, registerRenderers } from './fstate.mjs';
import { clearWideSelect, selectedWide } from './fwide.mjs';
import { EXPEDITION_POP, clearInspection } from './fexpedition.mjs';
import { OUTBOUND_POP, clearOutbound } from './fexpedition-compose.mjs';
import { inspectOriginalExpedition, prepareOriginalExpedition, reconcileExpedition, openOriginalOutbound, editOriginalOutbound, tapOriginalOutbound, originalOutboundMap, inspectOriginalOutboundRoute, inspectOriginalOutboundContext, useEarliestOriginalOutboundArrival, sendLocalPlayDeparture, reconcileLocalPlayDeparture, prepareDevnetPlayDeparture, sendDevnetPlayDeparture, reconcileDevnetPlayDeparture, clearDevnetPlayDeparture, checkLocalPlayReveal, sendLocalPlayReveal, reconcileLocalPlayReveal, clearLocalPlayReveal, prepareLocalPlayReturn, sendLocalPlayReturn, reconcileLocalPlayReturn, prepareLocalPlayConquest, sendLocalPlayConquest, reconcileLocalPlayConquest, readLocalPlayConquestOrders } from './controller.mjs';
import { createHerald, nextPoll, staleness } from './herald.mjs';
import { setTermsPace, realTail, realShort } from './seasonterms.mjs';
import { setPin, setRelay } from './fchainio.mjs';
import { checkBeacon } from './seal.mjs';
import { ChainClock, bellChip, bellAt, countdown, seasonClock, bellStart, pollCap, worldContinues } from './clock.mjs';
import { effectiveStatus } from './fcodec.mjs';
import { FrontierMap } from './map/fmap.mjs';
import { openHint, heroZoom } from './map/opening.mjs';
import { createSurveyor } from './map/survey.mjs';
// the local test world's fog of war (map/fog.mjs: LOCAL_FOG is its one switch)
import { mountWideLegend } from './map/widelegend.mjs';
import { FOG_RULES, LOCAL_FOG, createFogger, fogActive, fogModeOf, fogMemoryKey, nationAnchors, nationSources, viewClash, viewTile, wideLandUnitless } from './map/fog.mjs';
import { mountTerritoryTiles, territoryLand, tagNations, territoryCandidates, ownTileAnchors, createTerritoryMemory, territoryMemoryKey, rememberTerritory, rememberedOf } from './map/territorytiles.mjs';
import { territoryMapReads } from './controller.mjs';
import { surveyInput } from './map/viewer.mjs';
import { fxNow, setBlankChart } from './map/chart.mjs';   // (milliseconds on the effects clock; the fog of war's plain paper)
import { reducedMotion } from './map/camera.mjs';
import { renderSurveyHelp } from './map/legend.mjs';
import { NOTE_TEXT, createActions, actorsAt } from './map/actions.mjs';
import { PLACE, PLACE_NOTE, applySeasonRecord, overviewRings, hexAtPixel, placeNow, worldOf, seededRings, contiguousRings, centreIsLand } from './map/world.mjs';
import { setCentreLand } from './map/sprites.mjs';
// The world's extent as the map, the roster and the minimap read it: FS.world (map/world.mjs), never the length of
// the record's `rings`. A sparse world (one far ring seeded alone) has `ringsOpen` = one past its outermost seeded
// ring, its `seeded` rings, and no land on the others.
const worldNow = () => FS.world ?? worldOf(FS.record);
const ringsOpenNow = () => Math.max(1, worldNow().ringsOpen);
const seededNow = () => seededRings(worldNow());
// (local-perf, 2026-11-21: the rings whose roster is asked — only a seeded ring with a Province on chain has anyone to name.
//  A wide world seeds all 129 rings and has Provinces in a few of them: each seeded ring's roster was asked once a minute,
//  ~130 reads a minute, nearly all of them 404. A record without counts asks every seeded ring, as before)
const rosterRingsNow = () => { const counts = worldNow().ringProvinces; return seededNow().filter(d => !Number.isInteger(counts?.[d]) || counts[d] > 0); };
import { readOverviews, forgetOverviewRefusals, ringMissMarks } from './map/overviews.mjs';
import * as hand from './hud/hand.mjs';
import * as turnlist from './hud/turnlist.mjs';
import * as waitPanel from './hud/waitpanel.mjs';
import { battleOffer } from './hud/firstbattle.mjs';
import { createCamKeep } from './hud/camkeep.mjs';
import { openCoop as coopEntryOpen } from './hud/coopentry.mjs';
import { installCoopBoard } from './hud/coopboard.mjs';
import { localCoopBoardOptions } from './hud/coopboard-local.mjs';
import { installNationChat, sideDrawerKey, objectTokens, drawerOpened } from './hud/nationchat.mjs';
import * as coopTitles from './hud/coopoutcomes.mjs';
import * as worldGoals from './hud/worldgoals.mjs';
import { settled } from './hud/rulebook.mjs';
import * as dialcard from './hud/dialcard.mjs';
import { paintVillagePics } from './map/village.mjs';
import { createLandingBook, landedKey } from './map/landing.mjs';
import { setBoardCharacters, landingAge } from './people/onboard.mjs';
import { placeName, villageLine } from './map/names.mjs';
import { lastWalletName } from '../wallet.mjs';
import { SEASON_STATUS_TEXT, clientText, factionName, TIERS, BUILDINGS, FATES, unitCount } from './fi18n.mjs';
import { L, fmtNum, mountLangToggle, onLangChange, lang, t as tKey, EN, normalizeKey } from '../lang.mjs';
import { toHex } from '../sdk/bytes.mjs';
import { html, setHtml } from '../util.mjs';
import * as returnSum from './hud/returnsum.mjs';
import * as returnWords from './hud/returnwords.mjs';
import * as returnRead from './hud/awayread.mjs';
import { caravanWatchOf } from './screens/s1.mjs';
import { palisadeHexesOf, marchWearOf } from './s1walk.mjs';
import { ACTIONS, FORMS, bind, startPlay, wantProvince, retryProvince, rereadMarchFacts, planS1Place, clearS1Plan, wantKeepHistory, wantKeepReach, wantHostReach, refreshConquest, refreshPrize, ackHomeGrant, tolled, syncProto, wantPreview, wantPlaces, composeTick, localSyncTick } from './controller.mjs';
import { mountProtoBoard } from './proto/board-mount.mjs';
import { mountKeepBoard, keepReachOf } from './map/keepmount.mjs';
// the recorded wide world, read-only (map/widemode.mjs): a button beside the map tools and a sheet over the map;
// the ordinary map is not changed by it
import { mountWideMode } from './map/widemode.mjs';
// the same recorded wide world drawn on the ordinary map and its chart 「全体図」 (map/wideland.mjs: rendering only)
import { mountWideLand, landOfCells } from './map/wideland.mjs';
import { noticeProvince } from './hud/place.mjs';
// the prototype rule "banners" (a design tried in the sample world: hud/proto.mjs, proto/hand-model.mjs)
import * as protoHud from './hud/proto.mjs';
import * as pm from './proto/hand-model.mjs';
import { renderTabs, factionChip, quotaChip, mountSheet, PHONE_MAX, row, lamports, setClockPace, setChainNow } from './screens/shell.mjs';
import { cardHead, fold, label } from './screens/parts.mjs';
import { drawerOf, closeDrawer, drawerTitle, holdsLand, viewerState, LIFTS, DRAWER_ICON, WIDE, STAGE, settleRows, releaseRows } from './hud/drawer.mjs';
import { icon, iconizeMapTools, watchArtIcons } from './hud/icons.mjs';
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
  // (fix-loop5, L5-6: under the fog, the marks of a clash out of sight now are not drawn, nor its inputs read)
  if (!viewClash({ p, q, keepTile: keepTileOf(p, q), mine: inspect.ownClashPlace(FS, p, q, rb) })) return null;
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
// ?art=1&ringopen=1 replays the ring-open moment on the outermost open ring.
const ART_Q = new URLSearchParams(globalThis.location?.search ?? '');
const ART_RINGOPEN = ART_PREVIEW && ART_Q.get('ringopen') === '1';
// ?art=1&relics=1 places sample Relic Sites and Waystones (M3 features, no accounts in M1; presentation only).
const ART_RELICS = ART_PREVIEW && ART_Q.get('relics') === '1';
// ?art=1&rivers=1 draws sample rivers (no river data in the Frontier; presentation only).
const ART_RIVERS = ART_PREVIEW && ART_Q.get('rivers') === '1';
// ?art=1&ally=0-1,2-4 shows those faction pairs as allied (presentation only; real relations come from the Province).
const ART_ALLY = ART_PREVIEW ? (ART_Q.get('ally') ?? '').split(',').map(x => x.split('-').map(Number)).filter(x => x.length === 2 && x.every(Number.isInteger)) : [];
// (⑭, owner decision 2026-11-18: the central tower is abolished, the map has no centre. There is no Engine stage and
// no Engine preview switch any more; held by permutation-gateway/test/web-frontier-no-centre.test.mjs)
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
import { useHerald, refresh as refreshPlay, onReread, adoptPinnedWorld, askSeason, takeSeason, seasonStale } from './controller.mjs';
import { createPollLoop } from './poll-loop.mjs';
import { kernel as loadKernel } from './wasm.mjs';
import { kernelRulesetFor } from './flocalplay-lane.mjs';
import { createRouteCache } from './map/routecache.mjs';
import { scope } from './fchainio.mjs';
import { hostParts } from './faddr.mjs';
import { RETREAT_CHOICES, retreatBps, DEPART_STAMINA, departMargin, planRoute, earliestBell, arrivalWindow, marchCosts } from './fmarch.mjs';
import { MAX_PATH_STEPS } from './seal.mjs';
import { uiKey, uiStorage, loadUi, saveUi, UI_PREFIX } from './fui.mjs';
import * as hud from './hud/hud.mjs';
import { landUpkeepMilli } from './landfood.mjs';
import { horizonHudLine } from './landhorizon.mjs';
import * as inspect from './hud/inspect.mjs';
import * as feed from './hud/feed.mjs';
import * as notify from './hud/notify.mjs';
import * as calendar from './hud/calendar.mjs';
import { ownLandView } from './flocalplay-territory.mjs';
import { hostsIn } from './fland.mjs';
import { said, worded, reworded } from './hud/words.mjs';
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
import { forecast, forecastKey, compareStances, compareKey, COMPARE_RUNS } from './hud/forecast.mjs';
import { modelForecast } from './hud/forecastmodel.mjs';
import { keepForecast, forecastFor } from './hud/forecastbook.mjs';
import { mountRadioKeys } from './hud/radiokeys.mjs';
import { BUILD_ITEMS, buildItemOf, UNIT_ORDER, SCOUT, SETTLER, ticketTimes, queueItem, queueBuildingItem, escrowNeededAt } from './fland.mjs';
import { holdingRentNow, rentNow, rentSource } from './frent.mjs';
import { UNIT_KINDS } from './people/units.mjs';
import { momentSnapshot, detectMoments, liveMoments, mergeNewVillages } from './people/moments.mjs';
import * as pins from './hud/pins.mjs';
import { battleScene, startBattle, battleLive, endBattle, BATTLE_SPEEDS, PHASE } from './people/battle.mjs';
import { decode as decodeAccount } from './fcodec.mjs';
import { fromBase64 } from '../sdk/bytes.mjs';
import { tileHex, ringProvinces, homeNation, locate } from './fgeo.mjs';
import { project, RADIUS } from '../map.mjs';
import { identityOf, displayName, withProfile, tagKey } from './people/identity.mjs';
import { lifeAt, lordLine } from './people/life.mjs';
import { instantHomeEnabled, homeSites, homeRingsOpen, seasonPlace, homePlaceOf, homeRingsOf, sameHome } from './home.mjs';

const $ = id => globalThis.document?.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el && el.textContent !== text) el.textContent = text; };
/**
 * Save one UI preference and lay the saved preferences OVER `FS.ui` (as controller.mjs `saveUiPatch`): `FS.ui` also holds
 * this page's runtime memory (the W2 planner's `wideHost`, `wideHostSay`/`Ready`, `custodyPair`, `wideTried`), which is
 * not stored. verify-pr173: the settings switches (auto-pan, guide level, effects, battle playback) and a hint's dismiss
 * replaced `FS.ui` with the stored preferences alone, wiping that memory just as a tab press did (loop-play10 LP10-1).
 */
const saveUiOver = (sc, patch) => ({ ...(FS.ui ?? {}), ...saveUi(uiStorage, uiKey(sc), patch) });

/**
 * The turn dial's text in one line: "ターン 1,034 · 残り 6:12" / "Turn 1,034 · 6:12 left".
 * The HUD clock counts turns (UX design section 6); the bell is the thing in the world
 * that tolls when a turn ends, and the mechanics copy keeps that word.
 */
export function chipText(chip) {
  if (!chip || (chip.bell === null && !chip.beforeGenesis)) return L`ターン —`;
  // (owner-answers-ui, Q-EUA2-4: on a faster clock the dial's game time also says its real length — seasonterms realTail)
  if (chip.beforeGenesis) return `${L`開始まで ${countdown(chip.secondsLeft)}`}${realTail(chip.secondsLeft)}`;
  // (past the program's end turn: this program takes no new order — said as that, not as the world being over)
  // (a local-play world its launcher has ended: the last turn it reached, and that it is over — B5)
  // (a KEPT world its launcher stopped is paused, its progress saved — owner decision 2026-11-24, LP14-1)
  if (chip.stopped && chip.paused) return L`ターン ${fmtNum(chip.bell)} · 一時停止`;
  if (chip.stopped) return L`ターン ${fmtNum(chip.bell)} · 終了済み`;
  if (chip.ended) return L`ターン ${fmtNum(chip.bell)} · 受付終了`;
  return `${L`ターン ${fmtNum(chip.bell)} · 残り ${countdown(chip.secondsLeft)}`}${realTail(chip.secondsLeft)}`;
}

/** The dial's three places: the small label, the large figure, the line under it. */
export function dialParts(chip) {
  if (!chip || (chip.bell === null && !chip.beforeGenesis)) return { label: L`ターン`, num: '—', left: '' };
  if (chip.beforeGenesis) return { label: L`開始まで`, num: countdown(chip.secondsLeft), left: '' };
  return { label: L`ターン`, num: fmtNum(chip.bell), left: chip.stopped ? worldEndedWord({ kept: !!chip.paused }) : chip.ended ? L`受付終了` : countdown(chip.secondsLeft) };
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
  // (owner-answers-ui, Q-EUA2-4: on a faster clock the line's real-time tail is too long for the round dial — it is
  //  kept whole for a screen reader, and the dial shows the few characters of realShort beside "left" instead)
  const tail = chip && !chip.stopped && !chip.ended ? realTail(chip.secondsLeft) : '';
  if (tail && rest.endsWith(tail)) rest = rest.slice(0, -tail.length);
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
  if (tail) out.push(html`<span class="visually-hidden">${tail}</span>`, html`<span class="dial-word dial-real" aria-hidden="true">${realShort(chip.secondsLeft)}</span>`);
  return out;
}

/** The dial's chip of a world confirmed ended (`FS.worldEnded`): its last turn, marked `stopped`; any other chip as it is. */
export const stoppedChip = (chip, ended) => (ended && chip && chip.bell !== null && !chip.beforeGenesis ? { ...chip, stopped: true, ...(ended.paused === true ? { paused: true } : {}) } : chip);

function renderChip() {
  const now = FS.chain?.now() ?? null;
  const chip = $('bell-chip');
  if (chip) setHtmlIfChanged(chip, dialMarkup(FS.clock ? stoppedChip(bellChip(FS.clock, now), FS.worldEnded) : null));
  renderHudTick(now);
  FS.stale = staleness({ latestUnix: FS.record?.latestUnix, chainNow: now, behind: FS.chain?.behind() ?? null });
  const banner = $('stale-banner');
  if (banner) {
    // (B5: a world confirmed ended is not "behind" — the banner says that it ended)
    const v = FS.worldEnded ? endedBannerView({ kept: FS.worldEnded.paused === true }) : staleBannerView({ stale: FS.stale, localPlay: !!FS.localPlay });
    // B21: the launcher cannot be reached (stopped): said in a plain line; an ended world's own banner stays first
    // (fix-loop16, LP16-7: a wide world and a capture demo are memory-only — a stopped start service ended them for good)
    if (!FS.worldEnded && FS.launcherLost) Object.assign(v, launcherLostBannerView({ kept: FS.localPlay?.wideLand || FS.localPlay?.clockScale ? false : undefined }));
    // (page-not-open-yet) the world is not created yet: said here, calmly, with when it opens — never on the red line
    if (FS.notOpen && !FS.season && !FS.worldEnded && !FS.launcherLost) Object.assign(v, notOpenBannerView(FS.notOpen));
    if (banner.dataset && (banner.dataset.notOpen === '1') !== !!v.notOpen) { if (v.notOpen) banner.dataset.notOpen = '1'; else delete banner.dataset.notOpen; }
    if (banner.dataset && (banner.dataset.lost === '1') !== !!v.lost) { if (v.lost) banner.dataset.lost = '1'; else delete banner.dataset.lost; }
    banner.hidden = v.hidden;
    if (banner.dataset && (banner.dataset.ended === '1') !== !!v.ended) { if (v.ended) banner.dataset.ended = '1'; else delete banner.dataset.ended; }
    if (banner.dataset && (banner.dataset.paused === '1') !== !!v.paused) { if (v.paused) banner.dataset.paused = '1'; else delete banner.dataset.paused; }
    if (!v.hidden) {
      // (local play: the words and one re-read button, made once and kept, so a press is never lost to the redraw)
      let text = banner.querySelector('.stale-text'), btn = banner.querySelector('[data-act="state-reread"]');
      if (!text || !!btn !== v.reread) {
        text = document.createElement('span'); text.className = 'stale-text';
        const parts = [text];
        if (v.reread) { btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn small'; btn.dataset.act = 'state-reread'; parts.push(' ', btn); }
        banner.replaceChildren(...parts);
      }
      if (text.textContent !== v.text) text.textContent = v.text;
      if (v.reread && btn.textContent !== rereadLabel()) btn.textContent = rereadLabel();
    }
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
  // (walletless demo: the static bundle's world says `sample.demo = {live}` — the tag says "playable demo" and links the live world)
  const demo = sm.demo && typeof sm.demo === 'object' ? sm.demo : null;
  const live = demo && /^https:\/\//.test(String(demo.live ?? '')) ? String(demo.live) : null;
  if (demo) {
    // (demo-polish-2, Q-WD-6: the world is saved in this browser; "Start over" — handled by the demo's world script,
    //  which asks first — clears it. Without storage the tag says a reload starts over, as before)
    const saved = !!demo.save?.on;
    const long = saved ? L`ブラウザの中だけで動く体験版です。ウォレットも登録もいりません。進み具合はこのブラウザに保存され、ページを開き直すと続きから遊べます。時間表示はゲーム内の時間です（${pace}）。` : L`ブラウザの中だけで動く体験版です。ウォレットも登録もいりません。ページを開き直すと最初からになります。時間表示はゲーム内の時間です（${pace}）。`;
    const reset = saved ? html`<button type="button" class="sample-reset" data-demo-reset="1" data-confirm="${L`体験版を最初からやり直しますか？ 村も土地も消え、元には戻せません。`}">${L`最初から`}</button>` : '';
    setHtmlIfChanged(el, html`${icon('info')}<span>${L`体験版`}</span><span class="sample-pace">${pace}</span>${live ? html`<a class="sample-live" href="${live}" target="_blank" rel="noopener">${L`本物の世界へ`}</a>` : ''}${reset}`);
    if (el.title !== long) { el.title = long; el.setAttribute('aria-label', long); }
    // (the map's "Records" button opens the recorded wide world, which a demo world never has: verify-pr301 F2)
    const records = document.querySelector('.wide-btn[data-map="wide"]');
    if (records && !records.hidden) records.hidden = true;
    return;
  }
  const long = arrival ? L`領土ルールの開発版です。チェーンにはつないでいません。進行はこのサーバー内に保存され、再起動すると最初からになります。時間表示はゲーム内の時間です（${pace}）。` : L`見本の世界です。基本ゲームのルールで動きますが、チェーンにはつないでいません。画面の時間はこの世界の中の時間です（${pace}）。`;
  setHtmlIfChanged(el, html`${icon('info')}<span>${arrival ? L`領土ルールの開発版` : L`見本の世界`}</span><span class="sample-pace">${pace}</span>`);
  if (el.title !== long) { el.title = long; el.setAttribute('aria-label', long); }
}

/**
 * The page banner's words for an error (display only; exported for the tests). A read that failed by its HTTP status
 * has no text of its own, and the banner read 「不明なエラー（HTTP503）」: nothing a reader can use. Before any season
 * is read it is the season's record that could not be read: said so, with the code. Every other error keeps its text.
 */
export function bannerText(error, haveSeason = false) {
  return !haveSeason && /^HTTP\d{3}$/.test(String(error?.code ?? '')) ? L`${clientText('WorldUnavailable')}（${error.code}）` : error?.text ?? '';
}

/**
 * (devnet-end-season) The season's status word: its effective status; and once the end bell is past while EndSeason has
 * not landed yet (anyone may send it; on devnet the operator does), "no new orders (the end is being confirmed)" rather
 * than 「進行中」 — the turn chip already says 受付終了 then, and the program refuses every new order.
 */
export function seasonStatusText(s, now) {
  const st = effectiveStatus(s, now);
  const g = Number(s?.genesisTs), end = Number(s?.endBell);
  if (st === 'Running' && !worldContinues(s) && Number.isFinite(g) && Number.isFinite(end) && Math.floor((now - g) / 600) >= end) return SEASON_STATUS_TEXT.Over;
  return SEASON_STATUS_TEXT[st];
}

function renderStatus() {
  renderSampleTag();
  renderProto();
  const s = FS.season;
  // (the season could not be read: the word is not 「読み込み中…」 for good — the banner below says what happened)
  const status = s ? seasonStatusText(s, FS.chain?.now() ?? 0) : FS.error ? '' : L`読み込み中…`;
  // the beacon's kind is a detail: "More → details" names it (detailsMarkup)
  // (page-not-open-yet: a world not open yet is not 「読み込み中…」 either — the banner and the plate say it)
  setText('season-status', !s && FS.notOpen ? L`まだ開いていません` : status);
  const err = $('error-line');
  if (err) { err.hidden = !FS.error; err.textContent = FS.error ? bannerText(FS.error, !!s) : ''; }
  // B21: while the launcher cannot be reached the banner's plain line says so; the season poll's own "could not
  // connect" is not raised over it (it comes back with the line's end, if the read still fails)
  if (err && FS.launcherLost && FS.error?.source === 'season') { err.hidden = true; err.textContent = ''; }
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
  // (fix-loop22, LP22-4: and the ones whose march rows have left the list — hud/feed.mjs ownClashesFrom)
  for (const c of FS.ownClashes ?? []) add({ p: c.p, q: c.q, bell: c.bell });
  const own = FS.holdings ?? [];
  for (const c of reportScreen.clashesFrom(FS.chronicle ?? [], 24)) if (own.some(o => o.p === c.p && o.q === c.q)) add(c);
  return out.slice(0, 12);
}

/**
 * "Other → Recent clashes": the viewer's own clashes (myReports — kept after their march rows go, fix-loop22 LP22-4: the
 * keep march that retreated was in neither list) with the chronicle's clashes the fog lets through, newest first.
 */
export function recentClashes(FS) {
  const out = [];
  for (const x of [...myReports(FS), ...reportScreen.clashesFrom(shownChronicle() ?? [])]) if (!out.some(y => y.p === x.p && y.q === x.q && y.bell === x.bell)) out.push(x);
  return out.sort((a, b) => b.bell - a.bell).slice(0, 12);
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
    <p class="link-row"><a href="practice.html">${L`練習ページ`}</a>${fogActive(FS) ? '' : html` · <a href="spectate.html">${L`観戦ページ`}</a>`}${FS.agentWallet ? html` · <a href="agent.html" data-agent-link="1">${L`代理人のページ（テストUSDCで自動運転を任せる）`}</a>` : ''}</p></section>`;
}

/**
 * rent-live-rest: what the ticket escrow figure is computed from — the cluster's rent (its gateway route answered), or
 * the 5,080 MODEL, said to be one (frent.mjs). Never a model shown as the cluster's word.
 */
export function rentNote(r) {
  const n = rentNow(r);
  if (n.source === 'cluster') return n.perByte === null ? L`（クラスターが答えた家賃で計算）` : L`（クラスターの家賃 ${fmtNum(Number(n.perByte))} ランポート/バイトで計算）`;
  return L`（目安：家賃をクラスターから読めていないため、${fmtNum(Number(n.perByte))} ランポート/バイトと仮定した額です）`;
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
  const status = s ? seasonStatusText(s, FS.chain?.now() ?? 0) : L`読み込み中…`;
  const tips = s ? marchScreen.composerChoices(FS).tips : [];
  const costs = tips.map(t => { try { return { text: t.text, ...marchCosts(s, t.lamports) }; } catch { return null; } }).filter(Boolean);
  return html`<section class="vcard vcard-folds" aria-label="${L`詳細`}">${fold('more-details', html`${icon('scroll')}${L`詳細`}<span class="fold-val">${status}</span>`, html`
    <dl class="facts">
      ${row(L`世界`, status)}
      ${FS.beacon?.kind ? row(L`乱数のビーコン`, FS.beacon.kind === 'test' ? L`テスト用ビーコン` : L`公開ビーコン（drand）`) : ''}
      ${row(L`ルールのモジュール`, FS.kernelError ? L`frontier.wasm を読み込めません（${FS.kernelError}）` : L`frontier.wasm（見込みの計算と報告の確かめに使います）`)}
      ${FS.land ? row(L`村の申し込みの預け金（いま要る額）`, html`${lamports(escrowNeededAt(FS.land, holdingRentNow(FS.rent), FS.citizen?.slots))} <span class="muted" data-rent-source="${rentSource(FS.rent)}">${rentNote(FS.rent)}</span>`) : ''}
    </dl>
    ${bellScreen.render(FS, { bare: true })}
    <p class="muted">${L`封を開ける、衝突を決着させる、結果を届ける。こうした手続きは、ターンごとに自動の係（キーパー）が代わりに行います。チップはその報酬です。`}</p>
    <p class="muted">${L`いまの段階に賞金はありません。費用はテスト用の SOL で、ゲーム側（中継サーバー）が立て替えます（価値はありません）。`}</p>
    ${costs.length ? html`${label(L`進軍の費用（単位：ランポート）`)}<ul class="cost-list">${costs.map(c => html`<li><strong>${c.text}</strong><span>${L`チップ`} ${fmtNum(Number(c.tip))} · ${L`進軍の手数料（決着させた人へ）`} ${fmtNum(Number(c.marchFee))} · ${L`封の保証金（結果を受け取ると戻る）`} ${fmtNum(Number(c.sealBond))} · ${L`合計`} ${fmtNum(Number(c.total))}</span></li>`)}</ul>` : ''}
    <div class="actions"><button type="button" class="btn" data-act="forget">${L`この端末からこの世界の鍵を消す`}</button></div>`)}</section>`;
}

/** The rest of "More" as one card of folds: pins, the viewer's name, the season's timeline, the glossary. */
function moreFolds(FS) {
  const parts = [['more-pins', 'pin', L`ピン`, pins.renderPins(FS.pins ?? [], FS)], ['more-name', 'person', L`あなたの名前`, renderNameForm(FS)],
    ['more-timeline', 'hourglass', L`世界の年表`, milestones.renderTimeline(FS.mileRecord)], ['more-glossary', 'tome', L`用語集`, glossary.renderGlossary()]].filter(x => String(x[3] ?? '') !== '');
  return html`<section class="vcard vcard-folds" aria-label="${L`そのほか`}">${parts.map(([key, ic, title, body]) => fold(key, html`${icon(ic)}${title}`, body, { cls: 'fold-doc' }))}</section>`;
}

/**
 * What stands in the phone sheet while the drawer is closed: the village plate and the one "next
 * thing" under it (the peek shows these two); the to-do lines below, for a raised sheet. On desktop
 * the plate floats over the map (`aside#rail`), the next thing is the top strip's button and the
 * closed drawer is empty.
 */
export function restMarkup(FS) {
  // (without a village the plate carries its own one button: no second prompt beside it; the wide pips stand with the
  // plate here as they do in the desktop rail — hud/hud.mjs renderRest is the one composition for both widths)
  return hud.renderRest(FS, { next: holdsLand(FS) ? hud.renderNextRow(nextNow()) : '', todoMax: 8, wait: waitMarkup(FS) });
}

/**
 * (pt-first-battle, owner 2026-11-26 15:48 Q-PT-13) The "While you wait" panel (hud/waitpanel.mjs) of store `F`: the
 * viewer's own timers and suggestions, and the battle it may check now (hud/firstbattle.mjs battleOffer) — its own
 * resolved clashes, else the newest clash the fog lets it read (`clashHere`, the rule every report link obeys), else a
 * practice battle. '' without a village.
 */
/** (fix-loop24) The wait panel's last model with timers (hud/waitpanel.mjs steadyWaitModel), of the page's own store. */
let waitSteady = null;
function waitMarkup(F = FS) {
  if (F?.mode !== 'play' || !hud.activeHolding(F)) return '';
  let offer = null;
  try {
    const visible = F === FS ? reportScreen.clashesFrom(shownChronicle() ?? [], 12).filter(c => clashHere(c.p, c.q, c.bell)) : [];
    offer = battleOffer({ own: myReports(F), visible });
  } catch { offer = null; }
  try {
    // (fix-loop24, BREAK-5: what the panel last said stands until new data is in — hud/waitpanel.mjs steadyWaitModel)
    const st = waitPanel.steadyWaitModel(F, F === FS ? waitSteady : null, waitPanel.waitModel(F, { offer }));
    if (F === FS) waitSteady = st.keep;
    return waitPanel.renderWaitPanel(F, st.shown);
  } catch (e) { console.error('frontier wait panel:', e); return ''; }
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
  if (d.kind === 'territory') return [...parts, worldGoals.render(FS, worldGoals.current()), ...(territoryEnabled(FS) ? [territoryScreen.render(FS)] : [conquestScreen.render(FS), prizeScreen.render(FS)])];
  if (d.kind === 'nation') return [...parts, joinScreen.render(FS)];
  if (d.kind === 'wait' || d.kind === 'join') return [...parts, joinScreen.render(FS)];
  // a dock tab keeps one line of the selection (the inspector itself opens from the map)
  if (FS.selected) parts.push(inspect.renderBrief(FS, terrainRef));
  if (d.kind === 'holding') parts.push(holdingScreen.render(FS));
  // (fix-loop5, L5-10: the exploration card only where there is a scout or an exploration to speak of)
  else if (d.kind === 'hosts') parts.push(hostScreen.render(FS), exploreScreen.exploreRelevant(FS, hostScreen.hostRows(FS)) ? exploreScreen.render(FS) : '');
  else if (d.kind === 'marches') {
    // a warning of arrivals stands first; with none, its quiet line closes the screen
    const warned = (FS.incoming ?? []).length > 0;
    parts.push(warned ? incomingScreen.render(FS) : '', marchScreen.render(FS), trackerScreen.render(FS), reportScreen.renderLinks(myReports(FS), L`あなたの衝突の報告`, { FS }), warned ? '' : incomingScreen.render(FS));
  }
  else parts.push(feed.renderCentre(FS.feed ?? [], FS.feedFilter ?? 'all'), chronicleScreen.render(FS), coopTitles.render(FS, coopTitles.current()), reportScreen.renderLinks(recentClashes(FS), L`最近の衝突`, { FS }),
    settingsMarkup(FS), notifyMarkup(FS), ...surveyHelpWithProto(), moreFolds(FS), detailsMarkup(FS));
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
/**
 * (2026-11-17, ⑦ the keep and the march toward it) Whether a press that names a keep still belongs to what the page is
 * now: the context number it was drawn under is the number NOW, the conquest record is the pinned world's, and the keep
 * of that province still stands on that tile. Answers the keep, or null. Reads only.
 */
let keepAsk = 0;
function keepStill(d) {
  if (FS.mode !== 'play' || !Number.isInteger(FS.contextSeq) || String(FS.contextSeq) !== String(d.ctx ?? '')) return null;
  const cq = FS.conquest ?? null;
  if (!cq || !(cq.keeps instanceof Map) || (cq.world ?? null) !== momentWorld()) return null;
  const k = cq.keeps.get(`${num(d.p)},${num(d.q)}`) ?? null;
  return k && Number.isInteger(k.tile) && k.tile === num(d.tile) ? k : null;
}

/**
 * (corrected) Whether the march a press names is still what the button said of it: the march list is the page's own NOW
 * (screens/tracker.mjs marchListNow — pinned world, context number, viewer, village in hand — and its own context
 * number is the button's), the list holds a march of that host whose destination is the keep's province, and
 *   `sure` = 1: the march's tile is known and IS the keep's tile (the button said "bound for this keep");
 *   `sure` = 0: the march's tile is still not known (the button said only "to this province").
 * A march that turned out to be for another tile, or whose list is another village's, does not answer. Reads only.
 */
function keepMarch(d, k, host) {
  const now = trackerScreen.marchListNow(FS);
  if (!now.ok || now.ctx === null || String(now.ctx) !== String(d.ctx ?? '')) return false;
  const sure = String(d.sure ?? '') === '1';
  return (FS.marches ?? []).some(m => {
    const dest = m?.entry ? m.dest : m?.readDest ?? m?.dest ?? null;
    if (String(m.entry?.host ?? m.transit?.hostId ?? '') !== host || !dest || dest.p !== k.p || dest.q !== k.q) return false;
    return sure ? Number.isInteger(dest.tile) && dest.tile === k.tile : !Number.isInteger(dest.tile);
  });
}

/**
 * (2026-11-17, ⑦ the hosts screen) Whether a press from the hosts screen still belongs to what the page is now: the
 * context number it was drawn under is the number NOW (it moves with every change of viewer, herald or pinned world),
 * the village the list was drawn for (place, site, generation) is the village in hand, and — unless `row: false` — the
 * host is still in that village's list. Answers `{h, row}` or null. Reads only.
 */
let hostAsk = 0;
function hostStill(d, { row: needRow = true } = {}) {
  if (FS.mode !== 'play' || !Number.isInteger(FS.contextSeq) || String(FS.contextSeq) !== String(d.ctx ?? '')) return null;
  const h = FS.holdings?.[FS.activeHolding ?? 0] ?? null;
  if (!h || h.p !== num(d.p) || h.q !== num(d.q) || h.site !== num(d.site) || (h.gen ?? 0) !== num(d.gen)) return null;
  const row = hostScreen.hostRows(FS).find(r => String(r.id) === String(d.host ?? '')) ?? null;
  return needRow && !row ? null : { h, row };
}

/**
 * (2026-11-17, ⑦ the warning's way on, corrected) Whether a press from the warning card still belongs to what the page
 * is now: the judging it was drawn from is the one standing (its context number — it moves with every change of viewer,
 * herald or pinned world), that judging's world is the world pinned and its viewer the viewer now, the warning it names
 * (village and turn) is still among the warnings, and the village is among the viewer's with the same generation.
 * Answers `{w, h, i}` — that warning, that village and its place in the list as it is NOW — or null. Reads only.
 */
let incomingAsk = 0;
function incomingStill(d) {
  const r = FS.incomingRead ?? null;
  // (corrected: the judging's number is compared with the number NOW — `FS.contextSeq` —, and the button's with both:
  //  a judging left standing from an earlier context, and the buttons drawn from it, act on nothing)
  if (FS.mode !== 'play' || !r || !Number.isInteger(r.ctx) || !Number.isInteger(FS.contextSeq) || r.ctx !== FS.contextSeq || String(r.ctx) !== String(d.read ?? '') || r.world !== momentWorld()
    || (r.viewer ?? null) !== (FS.resident?.asset ?? FS.wallet?.address ?? null)) return null;
  const p = num(d.p), q = num(d.q), site = num(d.site), gen = num(d.gen), bell = num(d.bell);
  const w = (Array.isArray(FS.incoming) ? FS.incoming : []).find(x => x.holding.p === p && x.holding.q === q && x.holding.site === site && (x.holding.gen ?? 0) === gen && x.bell === bell) ?? null;
  const i = w ? (FS.holdings ?? []).findIndex(o => o.p === p && o.q === q && o.site === site && (o.gen ?? 0) === gen) : -1;
  return i >= 0 ? { w, h: FS.holdings[i], i } : null;
}

/**
 * (2026-11-17, ⑦ from the map to the trade card) Once the card of plan `id` is drawn (its note carries the number): the
 * select the plan names takes the plan's value — ONCE, at the press; a later choice of the person's in the same select
 * is theirs and is kept by keepState —, the form's fold and the folds around the card open, and the card comes into
 * view. No amount field is touched and nothing is submitted. A card that does not come within a few frames (no village
 * in hand, another plan pressed meanwhile) is left alone.
 */
function landS1Plan(id, tries = 6) {
  const card = globalThis.document?.getElementById?.('hp-trade'), note = card?.querySelector?.(`[data-plan-id="${id}"]`);
  if (!note) { if (tries > 0) requestAnimationFrame(() => landS1Plan(id, tries - 1)); return; }
  if (note.dataset.plan !== 'lost') {
    for (const x of card.querySelectorAll('select[data-plan]')) { const v = x.dataset.plan; if (v !== '' && [...x.options].some(o => o.value === v)) x.value = v; }
    const f = card.querySelector(`details[data-fold="${note.dataset.plan === 'fort' ? 's1-fort' : 's1-send'}"]`);
    if (f) f.open = true;
  }
  for (let x = card.closest?.('details'); x; x = x.parentElement?.closest?.('details')) x.open = true;
  card.scrollIntoView?.({ block: 'start', behavior: calm() ? 'auto' : 'smooth' });
}

export function keepState(el, render, scroller = el) {
  if (!el?.querySelectorAll) { render(); return; }
  const keyOf = x => { const f = x.closest('form[data-form]')?.dataset.form ?? x.closest('[data-bind]')?.dataset.bind ?? ''; return `${f}|${x.name || x.dataset.bind || x.id}`; };
  // a button, a summary or a link is found again by what it does: its action and data, then its place among its like
  const actOf = x => `${x.tagName}|${x.dataset?.act ?? ''}|${JSON.stringify({ ...x.dataset })}|${x.closest('[data-fold]')?.dataset.fold ?? ''}`;
  const nthOf = x => [...el.querySelectorAll(x.tagName)].filter(y => actOf(y) === actOf(x)).indexOf(x);
  const typed = new Map(), picked = new Map(), folds = new Map(), placed = new Map();
  for (const x of el.querySelectorAll('input, select, textarea')) {
    // a control bound to the store (data-bind, data-act) is the store's to restore
    if (x.type === 'checkbox') continue;
    if (x.type === 'radio') { if (x.checked && !x.defaultChecked && !x.dataset.bind && !x.dataset.act) picked.set(keyOf(x), x.value); continue; }
    // (verify-pr244: a select whose options name their place — `data-key`, the caravan's destinations, whose list follows
    //  the fog — keeps the PLACE chosen, not the option's index: a village that came into or left sight moved every index
    //  after it, and the redraw put the choice on another place)
    if (x.tagName === 'SELECT' && !x.dataset.bind && x.selectedOptions?.[0]?.dataset?.key) { const def = [...x.options].find(o => o.defaultSelected) ?? x.options[0]; if (x.selectedOptions[0].dataset.key !== def?.dataset?.key) placed.set(keyOf(x), x.selectedOptions[0].dataset.key); continue; }
    if (x.tagName === 'SELECT') { if (!x.dataset.bind && x.value !== ([...x.options].find(o => o.defaultSelected) ?? x.options[0])?.value) picked.set(keyOf(x), x.value); continue; }
    if (x.value !== (x.defaultValue ?? x.value)) typed.set(keyOf(x), x.value);
  }
  if (scroller) for (const d of el.querySelectorAll('details[data-fold]')) folds.set(d.dataset.fold, d.open);
  const active = globalThis.document?.activeElement;
  const inside = !!active && el.contains(active);
  const focusKey = inside && active.matches?.('input, select, textarea') ? keyOf(active) : null;
  // the caret of the focused field (a field without a selection API — a number — answers null and gets the end)
  let caret = null;
  if (focusKey) { try { caret = Number.isInteger(active.selectionStart) ? [active.selectionStart, active.selectionEnd] : null; } catch { caret = null; } }
  const focusAct = inside && !focusKey && scroller && active.matches?.('button, summary, a') ? { key: actOf(active), nth: nthOf(active), tag: active.tagName } : null;
  const top = scroller?.scrollTop ?? 0;
  // a part that scrolls by itself (the order's body above its seal: `data-scroll`) keeps its place too
  const inner = scroller ? new Map([...el.querySelectorAll('[data-scroll]')].map(x => [x.dataset.scroll, x.scrollTop])) : new Map();
  // loop-play4 B-8: a node marked `data-stable` whose markup did not change is the SAME node after the re-render (the ×60
  // picker's confirm button was replaced at every 10 s turn, and a press between hover and release missed it)
  const stable = new Map();
  for (const x of el.querySelectorAll('[data-stable]')) if (x.dataset?.stable) stable.set(x.dataset.stable, [x, x.outerHTML]);
  render();
  // (fix-loop6, LP6-11: B-8 still took 3–4 real presses in the ×60 wide picker. Its main cause was not this: each press
  //  restarted the candidates reading and so cancelled the press before it — controller.mjs confirmHome, FS.homeConfirmWait.
  //  As a second measure the SAME node is now kept even when its markup changed (label, `disabled`), brought up to the new
  //  markup in place: a press begun on it ends on it)
  for (const x of stable.size ? el.querySelectorAll('[data-stable]') : []) { const was = stable.get(x.dataset?.stable); if (was && was[0] !== x) { if (was[1] !== x.outerHTML) morphStable(was[0], x); x.replaceWith(was[0]); } }
  // the folds first: a field inside a fold the new markup closed cannot take the focus (focus() on it does nothing), so
  // typing in the Muster form opened from its fold lost the focus at the first key's redraw
  for (const d of folds.size ? el.querySelectorAll('details[data-fold]') : []) { const was = folds.get(d.dataset.fold); if (was !== undefined && d.open !== was) d.open = was; }
  if (typed.size || picked.size || placed.size || focusKey) for (const x of el.querySelectorAll('input, select, textarea')) {
    const k = keyOf(x);
    if (x.type === 'radio') { if (picked.get(k) === x.value) x.checked = true; }
    else if (x.tagName === 'SELECT' && placed.has(k)) { const o = [...x.options].find(y => y.dataset?.key === placed.get(k)); if (o) x.value = o.value; }
    else if (x.tagName === 'SELECT') { if (picked.has(k) && [...x.options].some(o => o.value === picked.get(k))) x.value = picked.get(k); }
    else if (typed.has(k) && x.type !== 'checkbox') x.value = typed.get(k);
    if (k === focusKey && (x.type !== 'radio' || x.checked)) {
      x.focus({ preventScroll: true });
      // the caret where it was: a new field takes the focus with its caret at the start, and the next keys typed went
      // in front of what was typed (a count typed as 120 across two redraws read 021)
      if (x.tagName !== 'SELECT' && x.type !== 'radio' && x.type !== 'checkbox') {
        try {
          if (caret && typeof x.setSelectionRange === 'function') x.setSelectionRange(caret[0], caret[1]);
          else { const v = x.value; x.value = ''; x.value = v; }
        } catch { const v = x.value; x.value = ''; x.value = v; }
      }
    }
  }
  // (verify-pr130, LP6-13: the caravan amounts' bounds are the markup's — the source first offered —; a source the person
  //  picked in the field and restored just above takes its own bounds again, or the next redraw, about once a second at
  //  ×60, put the storehouse's back while the field showed the village: food max 0, wood max 20)
  for (const x of picked.size ? el.querySelectorAll('form[data-form="s1-caravan"] select[name="src"]') : []) capCaravanAmounts(x);
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
  // (fix-loop25: a side drawer that opened closes the chat — before the chat follows the screen, so a chat set aside for a
  //  report does not come back over the drawer that the report's closing left)
  nationChatSide(d);
  nationChatPlace();
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
/** The selection whose card headed the drawer at its last render (`drawerHeadFor`); null when none did. */
let lastHeadSelection = null;
/**
 * Where the reader's last press or key began: inside the drawer's sheet (a key of the chronicle, a fold, a field) or
 * anywhere else (the map, the dock, a list of the HUD). Read in the capture phase and only read: no press is changed.
 */
let inputInDrawer = false;
for (const ev of ['pointerdown', 'keydown']) globalThis.document?.addEventListener?.(ev, e => { inputInDrawer = !!e.target?.closest?.('#panel-body'); }, true);

/**
 * A press inside the drawer holds the drawer's redraws until it is released. The drawer is written again whenever a
 * number in it changes (stores, countdowns: several times a second on a fast test clock, now and then on the real
 * one), and each write replaces its buttons: a press that began on a button and ended on its replacement made no
 * click, so a player's tap could be lost. While a pointer is down in the drawer a redraw is kept as pending; on
 * release it runs right after the click (a macrotask after pointerup). A press held longer than `maxHoldMs` (a drag,
 * a long press) no longer holds anything, so the drawer never freezes.
 */
export function makePressGate({ maxHoldMs = 2000, now = () => Date.now() } = {}) {
  let downAt = null, pending = null;
  return {
    down() { downAt = now(); },
    /** The redraw kept while pressed (to run after the click), or null. */
    up() { downAt = null; const p = pending; pending = null; return p; },
    /** True when `redraw` is kept for the release instead of running now. */
    hold(redraw) { if (downAt !== null && now() - downAt < maxHoldMs) { pending = redraw; return true; } if (downAt !== null) { downAt = null; pending = null; } return false; },
  };
}
const drawerPress = makePressGate();
globalThis.document?.addEventListener?.('pointerdown', e => { if (e.target?.closest?.('#panel-body')) drawerPress.down(); }, true);
for (const ev of ['pointerup', 'pointercancel']) globalThis.document?.addEventListener?.(ev, () => { const redraw = drawerPress.up(); if (redraw) setTimeout(redraw, 0); }, true);
// (the hand's bar and its card — the forts' list, the muster — are written by renderHand, outside the drawer: each has a
//  gate of its own, so a press on a fort's row or on the muster's gather is not lost to a write between down and up)
const handPress = makePressGate(), handPopPress = makePressGate();
globalThis.document?.addEventListener?.('pointerdown', e => { if (e.target?.closest?.('#hand')) handPress.down(); if (e.target?.closest?.('#hand-pop')) handPopPress.down(); }, true);
for (const ev of ['pointerup', 'pointercancel']) globalThis.document?.addEventListener?.(ev, () => { for (const g of [handPress, handPopPress]) { const redraw = g.up(); if (redraw) setTimeout(redraw, 0); } }, true);
/**
 * Whether the drawer starts at its head again for this render (pure; exported for the tests): `{selection, toHead}`.
 * The selection's card heads the drawer on the spectator's panel and in the play page's inspector (`modePanel`,
 * `panelMarkup`). The same view keeps its scroll through a re-render (`keepState`), so a place chosen on the map
 * while the drawer stood scrolled left its new card above the fold: nothing on screen answered the press.
 * `selected` is the store's selection now, `shown` the one whose card headed the drawer at its last render. Every
 * choice is a new object (a press on the map, the same tile pressed again too; a row that goes to a place), so a
 * selection that is not the one shown is a new choice, and the drawer starts at its head. Not when the choice was
 * made from inside the drawer (`fromDrawer`: 「見る」 on a line of the chronicle moves the map; the reader keeps the
 * line, and the key keeps the keyboard's focus in sight). A re-render with the selection it already shows, or with
 * none, leaves the reader's place alone. Scroll only: nothing of the game is read or set here.
 */
export function drawerHeadFor(d, selected, shown, fromDrawer = false) {
  const selection = d && (d.kind === 'spectate' || d.kind === 'inspect') ? selected ?? null : null;
  return { selection, toHead: selection !== null && selection !== shown && !fromDrawer };
}
/** Write the drawer: its state, title and body (the same view keeps its scroll and typed values). */
function renderDrawer(markupOf) {
  // (a press in the drawer is under way: this write waits for its release, so the pressed button is not replaced)
  if (drawerPress.hold(() => renderDrawer(markupOf))) return drawerOf(FS);
  const d = drawerOf(FS);
  applyDrawer(d);
  // (fix-wide-breaks BREAK-3: the free-standing reveal strip follows the drawer — it moves out of its header's way)
  if (localRevealEl) { const css = localRevealCss(!!d); if (localRevealEl.dataset.at !== css) { localRevealEl.style.cssText = css; localRevealEl.dataset.at = css; } }
  const body = $('panel-body');
  const view = `${d?.kind ?? ''}|${FS.mode}`;
  const same = view === lastPanelView;
  lastPanelView = view;
  // (round 21: a card's entrance plays when the drawer's view is new, not on each rewrite of the same view — the first
  //  village's welcome fades in from nothing, and a rewrite while an order was being sent restarted it again and again: the
  //  recorded ×30 world showed the drawer's paper blank under its title; frontier.css [data-fresh])
  { const b = $('panel-body'); if (b) b.dataset.fresh = same ? '0' : '1'; }
  const head = drawerHeadFor(d, FS.selected, lastHeadSelection, inputInDrawer);
  lastHeadSelection = head.selection;
  clearTimeout(drawerClear); drawerClear = null;
  if (body) {
    const scroller = phone() ? $('panel') : body;
    if (d || phone()) keepState(body, () => setHtml(body, markupOf(d)), same ? scroller : null);
    // desktop, closed: the content leaves once the drawer has slid away (at once without motion)
    else if (calm()) setHtml(body, '');
    else drawerClear = setTimeout(() => { if (!drawerOf(FS)) { setHtml(body, ''); setText('panel-title', drawerTitle(null)); } }, 200);
    if (!same && scroller) scroller.scrollTop = 0;
    // (a new choice's card heads this view: the scroll's owner — the sheet itself on a phone, the paper under the bar on a
    // desktop — starts at its head, at once and without a glide: a later re-render must never find it half-way)
    if (head.toHead && scroller && scroller.scrollTop !== 0) scroller.scrollTop = 0;
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
  nationChatTick();
  wideModeRef?.validateFocus();
  // (the stage mark of the page follows the same answer as the plate, in the same render: never a village's plate over a waiting dock)
  renderChips();
  const d = renderDrawer(dd => panelMarkup(FS, dd));
  focusHome();
  const tabs = $('tabs');
  // what the map itself opens (a selection, an order, the guide, the join flow) leaves "Map" current; a report or a run, none
  // (the dock's keys are written anew at every render: Enter on one left the keyboard on nothing. The key in focus is
  // found again by what it does, as the bar's keys are — keepState)
  if (tabs) keepState(tabs, () => setHtml(tabs, renderTabs(FS, !d || ['inspect', 'march', 'guide', 'join', 'nation', 'wait'].includes(d.kind) ? 'map' : d.kind)));
  renderRail();
  renderHand();
  renderMinimap();
  // the header follows new data at once, not only on the next one-second tick
  renderHudTick(FS.chain?.now() ?? null);
}

/** The nation chat (hud/nationchat.mjs): what it needs of the page, and a nudge when the viewer's wallet or nation changes. */
let nationChatRef = null, nationChatKey = '';
const nationChatState = () => ({ wallet: FS.wallet, nation: Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : null, world: FS.season?.seasonId ?? null, program: FS.pin?.programId ?? null });
function nationChatTick() {
  const k = `${FS.wallet?.address ?? ''}|${FS.citizen?.faction ?? ''}`;
  if (nationChatRef && k !== nationChatKey) { nationChatKey = k; nationChatRef.changed(); }
}
/** (fix-loop24, BREAK-1) The screen changed under the chat (the title up or down, a wide document opened or closed): it follows (hud/nationchat.mjs chatPlacement). */
function nationChatPlace() { try { nationChatRef?.place?.(); } catch (e) { console.error('frontier nation chat:', e); } }
/**
 * (fix-loop25, owner Q-LP25-1 (a), loop-play25 BREAK-1) One right-side panel at a time (hud/nationchat.mjs
 * sideDrawerKey): the side drawer last seen, by its key. A drawer that OPENS (its key changes to a side drawer) closes
 * the chat; the chat opened by the player closes the side drawer (`nationChatOpening`).
 */
const sideTokens = objectTokens();
let sideKeyNow = null;
const sideKeyOf = d => sideDrawerKey(d, { selected: FS.selected, compose: FS.compose, wide: WIDE, stage: STAGE, token: sideTokens });
function nationChatSide(d) {
  const x = drawerOpened(sideKeyNow, sideKeyOf(d));
  sideKeyNow = x.key;
  if (x.opened) { try { nationChatRef?.yieldToDrawer?.(); } catch (e) { console.error('frontier nation chat:', e); } }
}
/** The player opens the chat: the side drawer closes as its own close button closes it (an order being written stays, set aside under the chat). */
function nationChatOpening() {
  const d = drawerOf(FS);
  if (sideKeyOf(d) !== null && d.kind !== 'march') shutDrawer({ focus: false });
  // (what stands now is what the chat opened over: not a drawer that opened)
  sideKeyNow = sideKeyOf(drawerOf(FS));
}
/** The keyboard, left inside the chat that a drawer's opening closed, goes to the drawer's heading (after the drawer is written). */
function focusDrawerHead() {
  setTimeout(() => {
    const t = $('panel-title');
    if (!t || $('panel')?.dataset.drawer !== 'open') return;
    if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
    t.focus?.({ preventScroll: true });
  }, 0);
}

function renderMode() {
  renderDrawer(() => modePanel(FS));
  renderRail();
  renderMinimap();
  renderFeed();
}

// ------------------------------------------------------------------ the HUD (hud/hud.mjs)
let mapRef = null;
let wideModeRef = null;
let wideLandRef = null;
/** The wide land's key over the map (map/widelegend.mjs): who holds the land the last frame drew. */
let wideLegendRef = null;
/** The wide land as the herald records it (wideLandRef is what the map shows: the same, fogged under the fog of war). */
let wideLandRaw = null;
let terrainRef = null;
/** Who holds each site (people/roster.mjs): names and faces for tags, the rail, the inspector, reports. */
let rosterRef = null;
/** The viewer's survey (map/survey.mjs), kept on the page state for every surface that asks what may be told. */
const surveyor = createSurveyor({ now: fxNow });
let surveyDeps = [], revealTold = -Infinity;
function surveyNow() {
  // asked every frame: the anchors are read again only when something they are read from was replaced
  const deps = [FS.mode, FS.record, FS.wallet, FS.citizen, FS.land, FS.holdings, FS.chronicle, FS.marches, FS.activeHolding, FS.nowBell, viewerKnown, terrainRef?.status?.(), ...FS.provinces.values()];
  // (the fog of war: the nation's villages and provinces see too, and the wide land can be seen — read from the overviews
  //  and the wide land, so a new one of either is a new survey)
  const fog = fogActive(FS);
  if (fog) deps.push(wideLandRaw?.land?.() ?? null, FS.conquest?.control ?? null, ...FS.overviews.values());
  // (territory-map, owner 2026-11-25 item 3: a new read of the viewer's own tiles — they see themselves — is a new survey)
  if (fog) deps.push(territoryRef?.now?.().ownRev ?? 0);
  if (FS.survey && deps.length === surveyDeps.length && deps.every((x, i) => x === surveyDeps[i])) return FS.survey;
  surveyDeps = deps;
  FS.survey = surveyor({ ...surveyInput(FS, { terrainOf: terrainRef, ready: viewerKnown || !!FS.land, scope: scope() || null }), ...(fog ? fogSurveyExtras() : {}) });
  fogUpdate();
  // (territory-map-2: the territory reader keeps only what is in sight — a new sight is read again soon)
  if (fog) territorySightChanged();
  // land that comes out of the chart now is told once on the effects bus (a shimmer: fx/stage.mjs)
  let newest = -Infinity;
  for (const t0 of FS.survey.reveals?.values?.() ?? []) if (t0 > newest) newest = t0;
  // (it is called a survey only for a viewer whose people see land: a village's or a host's sight, an exploration.
  // The candidate sites of the wait come into the picture without words: nobody surveyed them)
  if (newest > revealTold) { revealTold = newest; fxEmit('reveal', { n: FS.survey.reveals.size, words: (FS.holdings ?? []).length > 0 }); }
  return FS.survey;
}
/**
 * The fog of war of a local test world (map/fog.mjs): the survey's extra anchors (the viewer's nation) and the wide
 * land's provinces, which exist beyond the open rings; then the fogged copies of the records every map surface shows.
 */
const fogger = createFogger();
function fogSurveyExtras() {
  const wide = wideLandRaw?.land?.() ?? null;
  const own = new Set((FS.holdings ?? []).filter(h => Number.isInteger(h?.tile)).map(h => `${h.p},${h.q},${h.tile}`));
  const src = nationSources({ overviews: FS.overviews, wide, faction: FS.citizen?.faction ?? null, terrainOf: terrainRef, own, control: FS.conquest?.control?.provinces ?? null });
  // (territory-map, owner 2026-11-25 item 3: the viewer's own tiles are always in view — each own tile sees itself)
  const t = territoryRef?.now?.() ?? null;
  return { extraAnchors: [...nationAnchors(src), ...ownTileAnchors(t?.owners, t?.ownTag)], extraOpen: (wide?.cells ?? []).map(c => c.key).sort() };
}
function fogUpdate() {
  const sc = scope() || null, w = FS.wallet?.address ?? null;
  // (territory-video-2: with a village standing, a local world's 「この試験世界について」 folds to one line, once)
  if ((FS.holdings ?? []).length > 0) sessionSettled();
  FS.fog = fogger({ active: fogActive(FS) && (FS.holdings ?? []).length > 0, survey: FS.survey, overviews: FS.overviews, wide: wideLandRaw?.land?.() ?? null,
    viewer: FS.citizen?.faction ?? null, terrainOf: terrainRef, terrainRev: terrainRef?.status?.() ?? '', relayout: landOfCells,
    // (fog-devnet: a devnet page's last-known memory is keyed by its Season account too — season + wallet)
    memKey: sc && w ? fogMemoryKey(sc, w, fogModeOf(FS) === 'devnet' ? FS.pin?.addresses?.season ?? null : null) : null });
  return FS.fog;
}
/**
 * (fog-devnet) A devnet page learns that it is one from its pinned season (FS.pin.cluster), after boot: once the pin says
 * so, the fog's world-wide parts are laid as a local test world lays them at boot — never-seen land as plain paper, and
 * no 「記録」 sheet (the recorded wide world lists every captured province, its keep nation and villages: a full map).
 * The spectator links (legend, settings) follow `fogActive` / `fogNow()` by themselves.
 */
let fogWorldLaid = null;
function fogWorldPinned() {
  const mode = fogModeOf(FS);
  if (mode !== 'devnet' || !fogActive(FS) || fogWorldLaid === mode) return;
  fogWorldLaid = mode;
  setBlankChart(FOG_RULES.blankChart);
  try { wideModeRef?.unmount?.(); } catch (e) { console.error('frontier wide world:', e); }
  wideModeRef = null;
  mapRef?.invalidate?.();
}
/** The overviews the map shows (fogged under the fog of war). */
const shownOverviews = () => (FS.fog?.on ? FS.fog.overviews : FS.overviews);
/** The wide land the map shows (fogged under the fog of war). */
// (verify-pr197: a fogged page before its first village — no vision yet — shows no host and no keep being taken on it)
const shownWide = land => (FS.fog?.on ? FS.fog.wide : fogActive(FS) ? wideLandUnitless(land) : land);

// ------------------------------------------------------------------ player territory on the map (territory-map)
/**
 * (territory-map, owner 2026-11-25 09:33 items 3/5/6) The tiles players own, read in the background from the territory
 * province records (map/territorytiles.mjs mountTerritoryTiles; a local wide world only: controller.mjs
 * territoryMapReads), laid on the wide land the map shows: the viewer's own tiles always, another player's only where
 * the tile is in sight now (the fog on: a page with no village yet — no vision — shows none of them).
 */
let territoryRef = null;
let tagCache = { key: '', map: new Map() };
/** Tag → nation from the captured wide villages, the heartland roster with the overviews' site owners, and the viewer. */
function tagNationsNow() {
  const raw = wideLandRaw?.land?.() ?? null, t = territoryRef?.now?.() ?? null;
  const key = `${raw?.key ?? ''}|${rosterRef?.size?.() ?? 0}|${FS.overviews?.size ?? 0}|${[...(FS.overviews?.values?.() ?? [])].length}|${t?.ownTag ?? ''}|${FS.citizen?.faction ?? ''}|${t?.rev ?? 0}`;
  if (key === tagCache.key) return tagCache.map;
  const owners = new Map();
  for (const o of FS.overviews?.values?.() ?? []) for (const r of o?.provinces ?? []) owners.set(`${r.p},${r.q}`, r.owners);
  let roster = [];
  try { roster = rosterRef?.entries?.() ?? []; } catch { roster = []; }
  const map = tagNations({ cells: raw?.cells ?? [], roster, siteNation: (p, q, site) => owners.get(`${p},${q}`)?.[site] ?? null,
    own: t?.ownTag && Number.isInteger(FS.citizen?.faction) ? { tag: t.ownTag, nation: FS.citizen.faction } : null });
  tagCache = { key, map };
  return map;
}
const territoryShown = new WeakMap();
/**
 * (territory-map-2, owner 2026-11-25 12:04 Q-TM-1 (b)) The owners of other players' tiles as the viewer last saw them,
 * kept per world and player on this device beside the fog's last-known records (map/fog.mjs; the key is the fog's own
 * under 'ps-fterr:'). Written only from tiles in sight (territorytiles.mjs rememberTerritory), when the territory read or
 * the survey changes; read out of sight, drawn faded.
 */
const territoryMemory = createTerritoryMemory();
let territoryMemoryAt = '';
function territoryMemoryNow(t, fogged) {
  const sc = scope() || null, w = FS.wallet?.address ?? null;
  territoryMemory.use(fogged && sc && w ? territoryMemoryKey(fogMemoryKey(sc, w, fogModeOf(FS) === 'devnet' ? FS.pin?.addresses?.season ?? null : null)) : null);
  if (!fogged || !t) return territoryMemory;
  const survey = FS.survey, at = `${territoryMemory.rev()}|${t.rev}|${survey?.rev ?? 0}`;
  if (at === territoryMemoryAt || !survey) return territoryMemory;
  if (rememberTerritory(territoryMemory, { owners: t.owners, read: t.read ?? [], known: t.known ?? null, ownTag: t.ownTag, seen: (p, q, tile) => survey.levelOf(p, q, tile) === 3 })) territoryMemory.save();
  territoryMemoryAt = `${territoryMemory.rev()}|${t.rev}|${survey.rev}`;
  return territoryMemory;
}
/** The shown wide land with the tiles' owners on it (kept per land and territory/survey/memory revision). */
function withTerritory(land) {
  const t = territoryRef?.now?.() ?? null;
  const fogged = !!FS.fog?.on, hidden = !fogged && fogActive(FS);
  const mem = territoryMemoryNow(t, fogged);
  if (!land?.cells || (!t?.owners?.size && !(fogged && mem.size()))) return land;
  const key = `${t?.rev ?? 0}|${fogged ? FS.survey?.rev ?? 0 : 'open'}|${hidden}|${FS.citizen?.faction ?? ''}|${fogged ? mem.rev() : ''}`;
  const hit = territoryShown.get(land);
  if (hit && hit.key === key) return hit.out;
  const survey = FS.survey;
  const out = territoryLand(land, { owners: t?.owners ?? new Map(), tagNation: tagNationsNow(), ownTag: t?.ownTag ?? null, viewer: FS.citizen?.faction ?? null, fogged, hidden,
    seen: (p, q, tile) => !!survey && survey.levelOf(p, q, tile) === 3, remembered: k => rememberedOf(mem, k), known: t?.known ?? null });
  territoryShown.set(land, { key, out });
  return out;
}
/**
 * (territory-map-2: no leak through the data path) Whether the page may keep who owns tile `tile` of (p, q) now — the
 * reader's `keep` (the viewer's own tiles are kept by the reader itself): without the fog, every tile; under the fog,
 * a tile in sight now (L3); a fogged page with no vision yet, none.
 */
function territoryKeep(p, q, tile) {
  if (FS.fog?.on) return FS.survey?.levelOf?.(p, q, tile) === 3;
  return !fogActive(FS);
}
/** The survey changed: what is in sight may have — read again soon (at most every 2 s), so a tile coming into sight is known. */
let territorySightAt = 0, territorySightTimer = null, territorySightRev = null;
function territorySightChanged() {
  const rev = FS.survey?.rev ?? null;
  if (!territoryRef || rev === territorySightRev) return;
  territorySightRev = rev;
  if (territorySightTimer) return;
  const wait = Math.max(0, territorySightAt + 2000 - Date.now());
  territorySightTimer = setTimeout(() => { territorySightTimer = null; territorySightAt = Date.now(); territoryRef?.reload?.(); }, wait);
}
/** The provinces whose territory record is read: the viewer's tiles' reach first, then the land in sight (none pre-join). */
function territoryCandidatesNow({ ownAt = [] } = {}) {
  const raw = wideLandRaw?.land?.() ?? null, t = territoryRef?.now?.() ?? null;
  if (!raw?.cells?.length) return [];
  const anchors = [];
  for (const c of raw.cells) if (t?.ownTag && (c.owners ?? []).some(o => o.tag === t.ownTag)) anchors.push({ p: c.p, q: c.q });
  for (const h of FS.holdings ?? []) { const p = Number(h?.p), q = Number(h?.q); if (Number.isInteger(p) && Number.isInteger(q)) anchors.push({ p, q }); }
  const fogged = !!FS.fog?.on, survey = FS.survey;
  return territoryCandidates({ cells: raw.cells, ownAt, anchors,
    sight: fogged ? c => survey?.province?.(c.p, c.q)?.max === 3 : fogActive(FS) ? null : () => true });
}
/** The chronicle the page shows (under the fog of war: the records in sight or the viewer's own; kept per log and survey). */
let shownLogCache = { log: null, fog: null, out: null };
function shownChronicle() {
  const log = FS.chronicle, fog = FS.fog;
  if (!fog?.on || !Array.isArray(log)) return log;
  if (shownLogCache.log !== log || shownLogCache.fog !== fog) {
    const mine = r => { try { return !!FS.isMine?.(r); } catch { return false; } };
    shownLogCache = { log, fog, out: log.filter(x => fog.seen(x.record ?? x, mine)) };
  }
  return shownLogCache.out;
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
  // (2026-11-17, ⑦: before the second's cache is used or built: the battle state is made this world's first —
  //  syncBattleWorld — so neither the cache nor its battles show another world's as this one's)
  syncBattleWorld();
  const bell = FS.nowBell ?? (FS.clock ? Math.max(0, Math.floor(((FS.chain?.now() ?? 0) - FS.clock.genesisTs) / 600)) : 0);
  const sec = Math.floor(Date.now() / 1000);
  if (peopleCache.at === sec && peopleCache.lang === lang() && peopleCache.value) { peopleCache.value.battles = (FS.battles ?? []).filter(b => battleLive(b, performance.now() / 1000)); return peopleCache.value; }
  if (rosterRef) {
    for (const d of rosterRingsNow()) rosterRef.ensure(d);
    scene.seedOwn(rosterRef, FS.holdings);
  }
  // the labels inside (construction names, tiers) are in the page's language: a switch rebuilds them
  // (the local test world's fog of war, map/fog.mjs: only the columns and explorations the viewer sees)
  const shownLog = shownChronicle(), shownOv = shownOverviews();
  peopleCache = { at: sec, lang: lang(), value: {
    departures: scene.departuresAt(shownLog, shownOv, bell),
    // the hosts the public record says are on the road until their arrival is resolved (a player's character is away with its first host: UX design 14.3)
    away: scene.awayAt(shownLog, bell),
    explores: scene.exploresAt(shownLog, shownOv, bell),
    marches: ownColumns(),
    // the token layer (people/units.mjs): who explores, whose column walks its road, the stamina a march needs
    exploringHosts: new Set(scene.exploresAt(shownLog, shownOv, bell).map(x => x.host).filter(Boolean)),
    marchingHosts: new Set(ownColumns().map(m => m.host)),
    restBelow: DEPART_STAMINA,
    constructions: constructionsNow(),
    moments: liveMoments(FS.moments ?? [], performance.now() / 1000),
    nameOf: fogLords(ownNamer(scene.namer(rosterRef))),
    life: FS.life ?? null,
    tierName: t => TIERS[t] ?? '',
    now: FS.chain?.now() ?? 0,
    lordOf: fogLords((p, q, site) => { const o = rosterRef?.ownerOf(p, q, site); return o ? identityOf(o.tag) : null; }),
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
/**
 * A roster reader `(p, q, site, faction?)` under the fog of war of a local test world (map/fog.mjs — verify-pr93): the
 * roster is live, so a lord is named only where the site's tile is in sight now, or for the viewer's own nation. Without
 * the fog: the reader itself.
 */
function fogLords(read) {
  return (p, q, site, faction) => {
    if (!FS.fog?.on) return read(p, q, site, faction);
    const tile = terrainRef?.(p, q)?.sites?.[site];
    const own = Number.isInteger(FS.citizen?.faction) && (faction === FS.citizen.faction || (FS.holdings ?? []).some(h => h.p === p && h.q === q && h.site === site));
    return own || (Number.isInteger(tile) && FS.survey?.levelOf?.(p, q, tile) === 3) ? read(p, q, site, faction) : null;
  };
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
  if (FS.resOpen === '*') { el.setAttribute('aria-label', L`資源`); setHtmlIfChanged(el, hud.renderAllBreakdowns(hud.allBreakdowns(FS.holdings ?? [], now, h => landUpkeepMilli(FS, h)))); return; }
  const b = hud.resourceBreakdown(FS.holdings ?? [], FS.resOpen, now, h => landUpkeepMilli(FS, h));
  const hz = b && b.landPerHour > 0 ? holdingScreen.horizonFromFS(FS) : null;
  if (b && hz) b.horizonLine = horizonHudLine(hz, hz.rate);
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
/** The 「？」 that opened the term's popover (its term and its place among the keys of that term), while it is open. */
let termFrom = null;
/**
 * Close the term's popover. `focus`: the keyboard goes back to the key that opened it (Escape, the popover's own
 * close key) — it was left on nothing, and the next Tab began at the top of the page. The key is found again by its
 * term and its place: the drawer it stands in may have been written anew since.
 */
function closeTermPop({ focus = false } = {}) {
  if (!FS.term) return;
  FS.term = null; renderTermPop();
  const from = termFrom; termFrom = null;
  if (focus && from) [...(globalThis.document?.querySelectorAll?.(`[data-act="term"][data-term="${String(from.term).replace(/[^\w-]/g, '')}"]`) ?? [])][from.nth]?.focus?.({ preventScroll: true });
}
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
  const firstRecord = !FS.mileRecord;
  const { fresh, record } = milestones.newMilestones(quiet && !FS.mileRecord ? null : FS.mileRecord ?? { v: 1, seen: {} }, milestones.reachedMilestones(FS), FS.nowBell ?? 0);
  if (Object.keys(record.seen).length !== Object.keys(FS.mileRecord?.seen ?? {}).length) { FS.mileRecord = record; uiStorage.set(key, JSON.stringify(record)); }
  // (the first village's line comes with its landing on the map: mountLandingLine)
  // (rings open before this viewer's first record are old news; of several opening together only the newest is told)
  const say = milestones.bannerMilestones(fresh.filter(m => m.id !== 'first-holding' || !mapRef), { firstRecord });
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
function constructionsNow(life = FS.life) {
  const now = FS.chain?.now?.() ?? 0, out = [], seen = new Set();
  const add = (p, q, site, item, doneAt, startTs) => {
    const key = `${p},${q},${site}`;
    if (seen.has(key) || !(doneAt > now)) return;
    seen.add(key);
    const total = Math.max(60, doneAt - startTs);
    const name = BUILDINGS[buildItemOf(item)?.resource] ?? '';
    out.push({ p, q, site, name, share: Math.max(0, Math.min(1, 1 - (doneAt - now) / total)), label: `${name} ${hud.span(doneAt - now)}`.trim() });
  };
  for (const h of FS.holdings ?? []) for (const q of h.queue ?? []) {
    if (!q) continue;
    const done = Number(q.doneAt ?? 0);
    if (done > now) add(h.p, h.q, h.site, queueBuildingItem(q), done, done - buildSecsOf(q));
  }
  if (FS.clock) for (const [k, rec] of life ?? []) {
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
// (B14: a centre place without a Province is not lit: an unknown province stops the walk, map/actions.mjs litTiles)
const actionsOf = createActions({ passableOf: (p, q) => (placeNow(FS, p, q) === PLACE.centre ? null : terrainRef?.(p, q)?.passable ?? null) });
function actionsNow() {
  if (FS.mode !== 'play') return null;
  if (FS.hand?.pop === EXPEDITION_POP) return null;
  if (FS.hand?.pop === OUTBOUND_POP) return null;
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
const cachedRoute = createRouteCache(planRoute);
function routeTo(A, to) {
  const k = wantKernel();
  if (!k || !A?.actor) return null;
  const r = cachedRoute(k, { from: A.origin, to, unit: A.actor.unit, seeds: seedsNow(), blocked: palisadeHexesOf(FS) });
  if (!r.ok) return { ok: false, code: r.code };
  // Time keeps moving even within one turn. Only the path is cached; the
  // arrival is recalculated from the current clock, rate and lead window.
  const early = FS.clock ? earliestBell(k, { genesisTs: FS.clock.genesisTs, departTs: (FS.chain?.now?.() ?? 0) + departMargin(FS.chain?.rate), secs: r.route.secs }) : null;
  return { ok: true, hexes: marchCard.routeHexes({ route: r.route, origin: A.origin, host: { tile: A.origin.tile } }), arriveBell: FS.season ? arrivalWindow(FS.season, FS.nowBell ?? 0, early).min : null };
}

/** The route to the lit tile under the pointer (the map draws it as a ribbon with its arrival turn). */
let hoverRoute = null, hoverHit = null;
function hoverPlan(hit, { redraw = true } = {}) {
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
  const r = want ? routeTo(A, { p: want.p, q: want.q, tile: want.tile }) : null;
  // (while the rules module loads there is no answer yet: asked again when it has loaded)
  hoverRoute = r?.ok ? { key, q: want.hq, r: want.hr, hexes: r.hexes, arriveBell: r.arriveBell } : r ? { key, q: want.hq, r: want.hr, hexes: [], arriveBell: null } : null;
  if (redraw) mapRef?.tick();
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
  if (code === 'PlannerBudget') return () => L`道を調べきれませんでした（届かないとは限りません）`;
  return NOTE_TEXT.unreachable;
}
/** The map's live line (`#map-summary`): `say()` gives its words, again when the language changes. */
let summarySay = null;
function summary(say) { summarySay = say; setText('map-summary', say()); }
onLangChange(() => { if (summarySay) setText('map-summary', summarySay()); });

/** Start the order card for the acting host with `hit` as its destination (the existing compose flow). */
async function orderMarch(A, hit) {
  // (round 28: local play — the host's own march answer, as its send will read it (controller.mjs localMarchFor), is asked
  //  before any order is drafted; a refusal is said on the map instead of after the order card is up)
  if (FS.localPlay && typeof FS.localMarchFor === 'function') {
    const own = Number.isInteger(A.actor.holdingIndex) ? FS.holdings?.[A.actor.holdingIndex] ?? null : null;
    if (FS.localMarchFor(own, A.actor.id)?.open !== true) { mapNote(hit, () => L`ローカルプレイでは、まだ命令を送れません（読み取りのみ）。`); return; }
  }
  if (Number.isInteger(A.actor.holdingIndex) && A.actor.holdingIndex !== (FS.activeHolding ?? 0)) FS.activeHolding = A.actor.holdingIndex;
  const c = ACTIONS.compose({ host: A.actor.id, stay: 'map' });
  // (2026-11-17, ⑦ the march's entry: only the draft this request itself opened for this host is given the place — a
  //  host that is not there any more opens none, and a draft of another host standing from before is left as it is.
  //  After the route's wait, only that same draft, still naming this place, speaks: put away, another host's draft, a
  //  place chosen again or another world meanwhile, and nothing of this request is said or written)
  if (!c || FS.compose !== c || String(c.host?.id) !== String(A.actor.id)) return;
  FS.tab = 'map'; FS.explore = null;
  FS.selected = { kind: 'tile', p: hit.p, q: hit.q, idx: hit.idx, tileQ: hit.tileQ, tileR: hit.tileR };
  invalidate('map', 'panel', 'tabs');
  // (the place this request gave the draft is taken before the wait — the very object, set at once by setDestination)
  const world = momentWorld(), going = ACTIONS['dest-from-map'](), aim = c.dest;
  await going;
  if (!draftAims(c, aim, world)) return;
  if (c.routeError) mapNote(hit, refusalText(c.routeError, hit));
}
/**
 * Whether a request still owns what it asked for (2026-11-17, ⑦, corrected): `c` is the open draft, its place is the
 * very object this request gave it (`aim`, taken right after the request set it and before any wait — not a place of
 * the same coordinates chosen again since: that is a newer request's), and the pinned world, with its generation, is
 * the one the request was made in. controller.setDestination keeps the same identity for the route it writes.
 */
const draftAims = (c, aim, world) => !!c && !!aim && FS.compose === c && c.dest === aim && momentWorld() === world;

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
  if (!sub.host) return false;
  const mcNow = hand.marchCheck(FS, sub.host);
  // (lane B D2, 2026-11-16: a forming host is no actor on the map — map/actions.mjs actorsAt —, so with its March card
  //  open the march check answers first; the tap fell through to a plain selection without a word and dropped the host)
  if (!mcNow.ok && hand.popOf(FS, sub) === 'march') { mapNote(hit, () => mcNow.text); return true; }
  if (!A) return false;
  if (!mcNow.ok) {
    // (round 35: with its March card open the tap is a destination: why the host cannot set out — the province still
    //  resolving the last turn, stamina, rest — is said on the map and the host stays in hand. It fell through to a
    //  plain tile selection without a word, which read as a press that did nothing; seen in a ×10 world. Without the
    //  March card the tap selects the tile, as before.)
    if (hand.popOf(FS, sub) === 'march') { mapNote(hit, () => mcNow.text); return true; }
    return false;
  }
  if (t) { orderMarch(A, hit).catch(() => {}); return true; }
  // unlit: a second tap on the tile just refused selects it
  const n = FS.mapNote;
  // (workstream 07: "the rules are loading" is not a refusal — the planner loads on the first route asked for — so the
  // tap again asks for the route again; it used to select the tile and drop the host from the hand)
  if (n && n.say !== NOTE_TEXT.wait && n.p === hit.p && n.q === hit.q && n.tile === hit.idx && fxNow() - n.at < 6000) { FS.mapNote = null; return false; }
  // (a place that is not open land says which it is: beyond the season's map, not open yet, or being made; fog over open
  // land is the survey's and is answered by the route below)
  const where = placeNow(FS, hit.p, hit.q);
  if (where && where !== PLACE.open) { mapNote(hit, PLACE_NOTE[where]); return true; }
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
  const host = model?.kind === 'host' && model.pop !== OUTBOUND_POP && model.pop !== EXPEDITION_POP && keephand.conquestOn(FS) && model.host && model.host.unit !== SCOUT && model.host.unit !== SETTLER ? model.host : null;
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
/**
 * Local play only: the seal's strip apart from the boundary card (hud/hand.mjs localRevealStrip). A departed host has
 * left its tile, so the card it was sent from may no longer be open; the strip then stands by itself. While that
 * card is open the strip is the card's own, and this one is empty. Made on first need; never present outside local play.
 */
let localRevealEl = null;
/** Where the free-standing reveal strip stands: top right, or top left below the provinces bar while a drawer is open. */
export const localRevealCss = drawerOpen => (drawerOpen ? 'position:fixed;top:124px;left:12px;right:auto;bottom:auto;max-width:min(360px,calc(100vw - 24px));z-index:40'
  : 'position:fixed;top:72px;right:12px;left:auto;bottom:auto;max-width:min(360px,calc(100vw - 24px));z-index:40');
function renderLocalRevealStrip() {
  const doc = globalThis.document;
  const strip = FS.localPlay && FS.hand?.pop !== OUTBOUND_POP ? hand.localRevealStrip(FS) : '', markup = String(strip);
  if (!markup && !localRevealEl) return;
  if (!localRevealEl) {
    localRevealEl = doc.createElement('section'); localRevealEl.id = 'local-reveal'; localRevealEl.className = 'hand-pop local-reveal-strip';
    localRevealEl.setAttribute('aria-label', L`ローカルプレイ：封を開く`);
    doc.body.appendChild(localRevealEl);
  }
  // (fix-wide-breaks BREAK-3: at the top right it stood over the open drawer's header — the march order's among them;
  //  while a drawer is open it stands at the top left, below the provinces bar, instead)
  const css = localRevealCss(!!drawerOf(FS));
  if (localRevealEl.dataset.at !== css) { localRevealEl.style.cssText = css; localRevealEl.dataset.at = css; }
  if (localRevealEl.hidden !== !markup) localRevealEl.hidden = !markup;
  setHtmlIfChanged(localRevealEl, strip);
}

function renderHand() {
  if (!handEl) return;
  renderLocalRevealStrip();
  reconcileExpedition();
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
    clearInspection(FS); clearOutbound(FS);
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
  // (a press on the bar is under way: its write waits for the release — handLast is left as it was, so it is written then)
  if (bar !== handLast.bar && !handPress.hold(() => renderHand())) { keepState(handEl, () => setHtml(handEl, hand.renderHand(model))); handLast.bar = bar; }
  // the reserve's count rises when the record says so: the figure answers with a beat (visual only)
  if (model.kind === 'village') {
    if (handLast.key === model.key && handLast.reserve !== null && model.musterable > handLast.reserve && !calm()) { const fig = handEl.querySelector('.hand-train .hand-fig'); if (fig) { fig.classList.remove('bump'); void fig.offsetWidth; fig.classList.add('bump'); } }
    handLast.reserve = model.musterable;
  } else handLast.reserve = null;
  handLast.key = model.key;
  // (the view kept for the new host's card: gone back to once that card no longer stands)
  if (!(model.kind === 'village' && CARDS_OVER_BOARD.includes(model.pop)) && FS.hand?.pick?.kind !== 'dress' && model.pop !== 'keeps' && model.pop !== OUTBOUND_POP) camKeep.back('pop', { ms: calm() ? 0 : 260 });
  const pop = model.pop ? String(hand.renderPop(FS, model)) : '';
  if (handPopEl.hidden !== !pop) handPopEl.hidden = !pop;
  if ((handPopEl.dataset.pop ?? '') !== (model.pop ?? '')) handPopEl.dataset.pop = model.pop ?? '';
  // (a tile is being picked on the board for the card — the prototype's widening —: the card counts as covering the map's foot, hud/insets.mjs)
  { const pk = FS.hand?.pick?.kind === 'dress' ? 'dress' : ''; if ((handPopEl.dataset.pick ?? '') !== pk) handPopEl.dataset.pick = pk; }
  // (a press on the card is under way: its write waits for the release, as the bar's)
  // (round 20: right after the card is written, the forts card's wait slot takes the tallest height it has had for this
  //  host at this width — keephand.steadySlot; it does nothing on any other card)
  if (pop !== handLast.pop && !handPopPress.hold(() => renderHand())) { keepState(handPopEl, () => setHtml(handPopEl, pop ? hand.renderPop(FS, model) : '')); keephand.steadySlot(handPopEl, `${model.key}|${globalThis.innerWidth ?? 0}`); handLast.pop = pop; if (pop) handPopEl.setAttribute('aria-label', model.label); }
  if (model.pop === OUTBOUND_POP) scrollOutboundResult();
  placeHandPop(model);
  measureHand();
  publishNoGo();
}
/**
 * (fix-loop5, L5-3) The boundary card's newest answer — a route or departure read, its result, a dropped read — is
 * brought into view inside the card once, when it appears (the card scrolls; the page does not).
 */
let outboundSeen = null;
function scrollOutboundResult() {
  const s = FS.expeditionCompose;
  const now = s?.contextCheck ?? s?.routeCheck ?? (s?.dropped ? { dropped: s.dropped } : null);
  if (!now || now === outboundSeen || now.status === 'loading') { if (!now) outboundSeen = null; return; }
  outboundSeen = now;
  const el = handPopEl?.querySelector?.('.outbound-context-report, .outbound-route-report, .outbound-read-dropped');
  try { el?.scrollIntoView?.({ block: 'nearest', behavior: calm() ? 'auto' : 'smooth' }); } catch { /* an old engine: the card still scrolls by hand */ }
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
  clearInspection(FS); clearOutbound(FS);
  endPick();
  const next = pop && (hand.POPS.includes(pop) || (FS.proto && hand.PROTO_POPS.includes(pop)) || (keephand.conquestOn(FS) && hand.CONQUEST_POPS.includes(pop)) || ([...hand.INSPECTION_POPS, OUTBOUND_POP].includes(pop) && hand.popOf({ ...FS, hand: { ...FS.hand, pop } }, sub) === pop)) ? pop : null;
  FS.hand = { ...(FS.hand ?? {}), pop: next, unit: undefined, n: undefined, troops: undefined, tile: undefined, pick: null, strike: undefined, widen: undefined, more: undefined, protoWhy: undefined };
  if (next === OUTBOUND_POP) openOriginalOutbound();
  if (next === OUTBOUND_POP && sub?.kind === 'host') {
    camKeep.keep('pop');
    // Measure the newly rendered card before framing the editable tiles.
    requestAnimationFrame(() => {
      if (FS.hand?.pop !== OUTBOUND_POP || !originalOutboundMap() || !mapRef) return;
      mapRef.tick();
      mapRef.flyTo({ p: sub.host.p, q: sub.host.q, tile: sub.host.tile, zoom: Math.max(mapRef.view.zoom, 1.0) }, null, { auto: true });
    });
    summary(() => L`地図の破線のマスを押すと一歩追加します。「地形・時間を確認」で道の記録を読み取れます。`);
  }
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
  clearInspection(FS); clearOutbound(FS);
  endPick();
  FS.hand = { host: id ?? null, pop: null };
  FS.explore = null; FS.mapNote = null; FS.actor = null;
  invalidate('map', 'panel', 'tabs');
}
/** Select one of the viewer's hosts wherever it stands: its tile is the selection and it has the hand. `fly`: bring it into view. */
function selectHost(row, { fly = false } = {}) {
  if (!row) return false;
  clearInspection(FS); clearOutbound(FS);
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
  clearInspection(FS); clearOutbound(FS);
  endPick();
  clearWideSelect(FS);   // (a legacy village chosen: the wide card leaves the village screen)
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
  // (2026-11-16: from a host in hand, the hosts of ITS own village — as the bar's figure counts them (hud/hand.mjs); a host
  //  of another village in hand jumped to the open village's first host)
  const sub = hand.subjectOf(FS);
  const all = hand.ownHosts(sub?.kind === 'host' ? { ...FS, activeHolding: sub.holdingIndex } : FS);
  if (!all.length) return;
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
/** The words of a pick's tag over the lit tiles, as a function: asked at every paint (map/picktile.mjs pickLabelText). */
const PICK_LABEL = { muster: () => L`ここに集める`, explore: () => L`ここを調べる`, dress: () => L`ここを広げる` };
const pickLabel = kind => PICK_LABEL[kind] ?? (() => '');
// (the tag is on the canvas: a language change repaints it while a pick is open)
onLangChange(() => { if (FS.hand?.pick) { try { mapRef?.tick?.(); } catch { /* before the board is built */ } } });
const pickMemo = { key: null, model: null };
function startPick(kind, sub) {
  const h = sub.holding;
  // (where a host may form up: the Province's own mask, and the rules module's terrain where the page has it — the
  // generator's mountains and water are never offered)
  const land = kind === 'muster' ? terrainRef?.(h.p, h.q)?.passable ?? null : null;
  const open = t => { try { return land === null || ((BigInt(land) >> BigInt(t.tile)) & 1n) === 1n; } catch { return true; } };
  const tiles = kind === 'muster' ? hand.musterTiles(FS, h).filter(open) : (sub.host && hand.exploreCheck(FS, sub.host).targets.map(t => ({ p: sub.host.p, q: sub.host.q, tile: t }))) || [];
  const origin = kind === 'muster' ? { p: h.p, q: h.q, tile: h.tile } : { p: sub.host.p, q: sub.host.q, tile: sub.host.tile };
  // (fix-loop10, LP10-3: a function, not the words — the map's tag is painted in the page's language of that moment.
  //  loop-play10: 「ここに集める」 stayed Japanese on the canvas after the switch to English)
  const label = pickLabel(kind);
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
  // (fix-loop12, LP12-7: the reason is the control's text as shown, in the language of the press; a later switch of the
  //  language said it again as it was — the hidden live line kept 「軍勢・所有者・接続情報が変わりました…」 on the English
  //  page. In another language it is said through the English table when the words are a whole entry, else not at all)
  const at = lang();
  if (why) summary(() => (lang() === at ? why : at === 'ja' && EN[normalizeKey(why)] !== undefined ? tKey(why) : ''));
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
  // (B11: the threats' words in every language now — hud/words.mjs worded; threatsOf and threatGone are pure)
  const now = worded(() => pm.threatsOf(FS));
  P.threatsNow = new Set(now.map(t => t.id));
  for (const t of now) {
    standing.set(t.id, t);
    if (seen.has(t.id)) continue;
    seen.add(t.id); P.guide.threat = true;
    // (`own`: a notice of its own on the board even while a sheet is open or the turn's notices are gathered into one line)
    news.push({ id: t.id, kind: 'proto', proto: true, own: true, alarm: true, bell: FS.nowBell ?? null, p: t.p, q: t.q, tile: t.tile, text: t.text, ...(t.words ? { words: t.words } : {}), ...(Number.isInteger(t.slot) ? { banner: { p: t.p, q: t.q, slot: t.slot } } : {}), send: { p: t.p, q: t.q, tile: t.tile } });
  }
  // (a threat that was told of and stands no longer: what the records say became of it — the other nation's count is
  // gone, the banner was defended — said once; a tile a host of the viewer's now holds is the guide's next step)
  for (const [id, was] of standing) {
    if (now.some(t => t.id === id)) continue;
    const line = worded(() => pm.threatGone(FS, was));
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
  FS.hand = { ...(FS.hand ?? {}), tile: undefined, pick: { kind: 'dress', tiles, origin: { p: sub.host.p, q: sub.host.q, tile: s.banner.pole }, max: 1, label: pickLabel('dress'), token: ++pickSeq, external: false, t0: fxNow() } };
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
  // (2026-11-17, ⑦: as orderMarch — this request's own draft for this host, or nothing; and after the route's wait only
  //  that draft, still naming this place, is spoken of and has its arrival turn moved)
  const c = ACTIONS.compose({ host: row.id, stay: 'map' });
  if (!c || FS.compose !== c || String(c.host?.id) !== String(row.id)) return;
  FS.tab = 'map'; FS.report = null; FS.practice = null; FS.guideOpen = false; FS.explore = null; FS.inspectOpen = false;
  FS.selected = { kind: 'tile', p: to.p, q: to.q, idx: to.tile };
  invalidate('map', 'panel', 'tabs', 'rail');
  const world = momentWorld(), going = ACTIONS['dest-quick']({ p: String(to.p), q: String(to.q), tile: String(to.tile) }), aim = c.dest;
  await going;
  if (!draftAims(c, aim, world)) return;
  if (c.routeError) mapNote({ p: to.p, q: to.q, idx: to.tile }, refusalText(c.routeError, { p: to.p, q: to.q, idx: to.tile }));
  // (a march of the viewer's is already sealed for that province and that turn: the sample world lets one host of a
  // citizen in a turn, and the second would be turned back at its seal's opening — the answer to a threat was lost
  // that way, with a forecast that said it would win. The card the page makes names the next turn that is free, and
  // says why; the player can still step it back)
  if (FS.proto && FS.season && Number.isInteger(c.arriveBell) && pm.ownArrivalAt(FS, to, c.arriveBell, row.id)) {
    const w = arrivalWindow(FS.season, FS.nowBell ?? 0, c.earliest);
    let b = c.arriveBell;
    while (b < w.max && pm.ownArrivalAt(FS, to, b, row.id)) b++;
    if (!pm.ownArrivalAt(FS, to, b, row.id)) { c.protoShift = { from: c.arriveBell, to: b }; c.arriveBell = b; invalidate('panel', 'map'); }
  }
}
/** The province the guide's march goes to: the other province of the viewer's own nation in ring 2 (fgeo homeNation under the season's placement; the one whose land record is on the page, when one is), or null. */
function marchProvince(row) {
  if (!Number.isInteger(FS.citizen?.faction)) return null;
  const place = seasonPlace(FS.season);
  const near = ringProvinces(2).filter(pq => homeNation(pq.p, pq.q, place) === FS.citizen.faction && !(pq.p === row.p && pq.q === row.q));
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
// (fix-loop9, LP9-6: a caravan's arrival time as a turn of the season, for a route the feed gives without runs)
const caravanBellOfTs = ts => (FS.season ? bellAt(seasonClock(FS.season).genesisTs, ts) : null);
function s1MarksNow() {
  const s1 = FS.s1;
  if (!s1) return null;
  const bell = FS.nowBell ?? null;
  if (s1Memo?.c !== s1.caravans || s1Memo.s !== s1.structures || s1Memo.bell !== bell || s1Memo.n !== FS.holdings?.length) {
    // (the provinces' caravan slots say which caravans an open raid holds; they are read again at the next bell)
    s1Memo = { c: s1.caravans, s: s1.structures, bell, n: FS.holdings?.length, marks: s1Marks(s1, { own: ownTag(FS), bell, provinces: FS.provinces, bellOfTs: caravanBellOfTs }) };
  }
  // (the fog of war of a local test world, map/fog.mjs: another's vault, structure or caravan only where the viewer sees now)
  if (FS.fog?.on) {
    const fog = FS.fog, seen = x => !!x && fog.seen({ p: x.p, q: x.q, tile: x.tile });
    if (s1Memo.fog !== fog) s1Memo.fogged = { ...s1Memo.marks, vaults: s1Memo.marks.vaults.filter(v => v.own || seen(v)), structures: s1Memo.marks.structures.filter(x => x.own || seen(x)),
      caravans: s1Memo.marks.caravans.filter(c => c.own || (seen(c.from) && seen(c.to))) };
    s1Memo.fog = fog;
    return s1Memo.fogged;
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
// (2026-11-17, ⑦ the march card, corrected: one request at a time, known by ITSELF — `fcRun`, the object of the request
//  under way: its draft, its place (the very object), its key and the pinned world with its generation. Every end of
//  it — the answer, the failure, the tidy-up — asks `mine()` first, so a request for another draft with the same key,
//  one put away, one asked again, a place of the same coordinates chosen again, or another world (A → B → A) neither
//  writes into the newer one nor frees its place.
//  `unread`: the forecast could NOT be made because something was not read — the rules module, or the destination
//  province's record — which is not an answer of the rules (a refusal, PalisadeOnRoad) and not 見えていない土地
//  (OutOfSight: no forecast is made there, and none is asked again). An unread forecast stays "not known", is made
//  again by itself once the missing record is held, and at the person's request — HUD_ACTIONS['forecast-retry'].)
let fcRun = null;
/** (fix-loop22) A province envelope's revision as the forecast remembers it (controller.mjs latestEnvelope orders by these), or null. */
export const envRev = env => (env ? `${env.seq ?? ''}|${env.slot ?? ''}|${env.bell ?? ''}` : null);
function updateForecast({ again = false } = {}) {
  const c = FS.compose;
  // (fix-loop22, LP22-4: the turn the march would be sent in — the arrival stamina is the chain's, read from it: hud/forecast.mjs arrivalStamina)
  if (c && Number.isInteger(FS.nowBell)) c.departBell = FS.nowBell;
  const key = forecastKey(c);
  if (!key || !c.route || c.sending) return;
  if (fcRun && fcRun.c === c && fcRun.key === key && fcRun.dest === c.dest) return;
  const destKey = `${c.dest.p},${c.dest.q}`;
  // (made already for the order as it stands — unless it is only "being made" by a request that is not under way any
  //  more (its answer was not this order's to take: the place was asked again, a draft of the same key), or it was not
  //  read and is asked again, or the record it lacked is held now)
  // (fix-loop22, LP22-4: and the destination's record it was made from is still the one held — `rev`, the envelope's
  //  seq/slot/bell. A ×60 check: the forecast made when the camp's province had fewer villages said "274–278 left" beside
  //  "Unopposed" read from the record that had since filled to 12 — the camp no longer fights. The old figures stay on
  //  the card while the new ones are made: no "calculating…" at every re-read)
  const rev = envRev(FS.provinces.get(destKey));
  const stale = !!c.forecast?.ok && c.forecast.key === key && !c.forecast.pending && c.forecast.rev !== undefined && rev !== null && c.forecast.rev !== rev;
  if (!stale && c.forecast?.key === key && !c.forecast.pending && !(c.forecast.unread && (again || (c.forecast.why === 'NoRecord' && FS.provinces.has(destKey))))) return;
  // (a destination out of sight: no forecast. It would be worked out from the province's whole record, the hosts the
  // viewer cannot see among them, and its numbers would tell of them: a fort's tile out of sight said only "守り N"
  // while the forecast counted N and every host on it. The independent audit of 2026-10-24, older than the uplift,
  // which had made it easier to see. Same reading of sight as the card's: hud/marchcard.mjs)
  if (FS.survey && !FS.survey.showAll && FS.survey.levelOf(c.dest.p, c.dest.q, c.dest.tile) < 3) {
    c.forecast = { key, ok: false, why: 'OutOfSight' }; c.compare = null; invalidate('panel'); return;
  }
  // (the destination province's record is not held: nothing to forecast from — said as not read, and the record is
  //  asked for by the ordinary read, within its own limit and wait; in sight only — the check above came first)
  if (!FS.provinces.has(destKey)) {
    c.forecast = { key, ok: false, why: 'NoRecord', unread: true }; c.compare = null;
    if (FS.mode !== 'practice') { if (again) retryProvince(c.dest.p, c.dest.q, () => invalidate('map', 'panel')); else wantProvince(c.dest.p, c.dest.q, () => invalidate('map', 'panel')); }
    invalidate('panel'); return;
  }
  const run = fcRun = { c, key, dest: c.dest, world: momentWorld() };
  const mine = () => fcRun === run && FS.compose === c && c.dest === run.dest && forecastKey(c) === key && momentWorld() === run.world;
  if (!stale) { c.forecast = { key, pending: true }; invalidate('panel'); }
  seasonKernel().then(k => {
    if (!mine()) return;
    const env = FS.provinces.get(`${c.dest.p},${c.dest.q}`) ?? null, prov = env?.province ?? null, faction = FS.citizen?.faction ?? 0, made = envRev(env);
    // (the record went while the rules were read — another world's, or let go: not read, not a forecast of nothing)
    if (!prov) { c.forecast = { key, ok: false, why: 'NoRecord', unread: true }; c.compare = null; return; }
    // S1: the program's own clash model over the destination's bytes (the keep, the forts and the caravans are in it), the
    // arrival worn by the towers its road crosses (hud/forecastmodel.mjs, workstream 07); else the page's own builder
    const worn = s1On() && env?.provinceBytes ? marchWearOf(FS, { p: c.origin.p, q: c.origin.q, tile: c.host.tile }, c.route, c.host.unit) : null;
    const model = !!worn && !worn.blocked;
    const one = cc => (model ? modelForecast(k, cc, env.provinceBytes, faction, { wornBps: worn.bps }) : forecast(k, cc, prov, faction));
    let fc;
    // (a throw while it is worked out: not read — never taken for the rules' own refusal)
    try { fc = worn?.blocked ? { ok: false, why: 'PalisadeOnRoad' } : one(c); } catch (e) { fc = { ok: false, why: e?.code ?? 'Error', unread: true }; }
    c.forecast = { key, ...fc, ...(model ? { model: true } : {}), ...(made !== null ? { rev: made } : {}) };
    // the stances side by side (the card's comparison): once per destination, turn and retreat, not per stance chosen
    // (fix-loop22: and again when the destination's record changed under it, as the forecast is)
    const ck = compareKey(c);
    if (fc.ok && (c.compare?.key !== ck || c.compare?.rev !== made)) {
      c.compare = { key: ck, rev: made, rows: model ? [0, 1, 2, 3].map(s => { try { return { stance: s, ...modelForecast(k, { ...c, stance: s }, env.provinceBytes, faction, { wornBps: worn.bps, runs: COMPARE_RUNS }) }; } catch (e) { return { stance: s, ok: false, why: e?.code ?? 'Error' }; } })
        : compareStances(k, c, prov, faction) };
    }
  }).catch(e => { if (mine()) c.forecast = { key, ok: false, why: e?.code ?? 'NoWasm', unread: true }; })
    .finally(() => { if (fcRun === run) fcRun = null; invalidate('panel'); });
}

/** A holding as the next instruction will find it (hud/rulebook.mjs `settled`: a finished building already produces): what the strip shows can be spent now. */
const settledHolding = (h, now) => { try { return h ? settled(h, now) : h; } catch { return h; } };

/** Once a second: compare the page's state with the last look and start the moments it shows (people/moments.mjs). */
let momentPrev = null;
/** The viewer's villages ("P,Q,site") at the last look of checkMoments. */
let ownSitesSeen = new Set();
/**
 * The world the moments compare (2026-11-17): cluster, program and season account as fchainio.setPin pinned them
 * (`addresses.season`, derived and checked against the herald's record); null while none is pinned — nothing is made up:
 * "no pin" is a state of its own, and a pin that comes or changes is a change of world. Two looks are compared only within one world: another world's villages, buildings and hosts
 * at the same coordinates are not news here (a village "lost" or "taken", a building "finished").
 */
// (with the pin's generation — fchainio.setPin: A → B → A are three — so a look of the first A is not one of the last)
const momentWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.gen ?? 0}|${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);
/**
 * What may be looked at after the world changed (2026-11-17), by the providers' own records of the world they read for —
 * never by a key that seems to have gone or an object that was replaced: a province envelope carries `world`
 * (controller.mjs loadEnvelope, which drops an answer read for another world), the viewer's holdings `FS.holdingsWorld`
 * (applyMeResult), a holding's life `FS.lifeWorld` (refreshChronicle, once it has rebuilt the life from this world's
 * pages since its reset). Until the holdings are read for this world (when there are any) no look is taken. Until the
 * life is, neither its harvests nor its builds are looked at; the first look that has them is their baseline (the life
 * read up is not news), and the next change after it is told as usual. The page's first world — and a pin that comes
 * to a page that had none — fences nothing: its providers read for it.
 */
let momentFence = null;   // {world, first, waitHoldings, lifeReady}
function checkMoments() {
  if (!FS.provinces) return;
  const world = momentWorld();
  if (!momentFence || momentFence.world !== world) {
    const first = momentFence === null || (momentFence.first && momentFence.world === null);
    momentPrev = null; ownSitesSeen = new Set();
    momentFence = { world, first, waitHoldings: !first, lifeReady: first };
  }
  if (momentFence.waitHoldings) {
    if (Array.isArray(FS.holdings) && FS.holdings.length > 0 && FS.holdingsWorld !== world) return;
    momentFence.waitHoldings = false;
  }
  const lifeReady = momentFence.lifeReady || FS.lifeWorld === world;
  const fresh0 = new Map([...FS.provinces].filter(([, env]) => env?.world === world));
  const next = momentSnapshot({ life: lifeReady ? FS.life ?? new Map() : new Map(), constructions: constructionsNow(lifeReady ? FS.life : null), provinces: fresh0, bell: FS.nowBell ?? null, logged: FS.chronicle !== undefined && FS.isMine !== undefined });
  // (this world's life looked at for the first time: its harvests and builds are the baseline, not news)
  if (lifeReady && !momentFence.lifeReady) {
    momentFence.lifeReady = true;
    if (momentPrev) momentPrev = { ...momentPrev, harvest: next.harvest, builds: next.builds, logged: false };
  }
  const t = performance.now() / 1000;
  const fresh = detectMoments(momentPrev, next, t);
  momentPrev = next;
  // each is reported on the effects bus and played by fx/stage.mjs (`own`: the viewer's own village or host)
  // (`lost` / `taken`: a site that was a village of the viewer's at the last look and is someone else's now, or none; a
  // site the viewer holds now that another nation held: the two largest things that happen to a player, which played
  // as small as a finished sawmill. The holdings no longer list a village just taken, so the last look's are kept)
  const mineNow = new Set((FS.holdings ?? []).map(h => `${h.p},${h.q},${h.site}`));
  const shown = [];
  for (const m of fresh) {
    const key = `${m.p},${m.q},${m.site}`, village = m.kind === 'village';
    const lost = village && ownSitesSeen.has(key) && !mineNow.has(key);
    const taken = village && mineNow.has(key) && !ownSitesSeen.has(key) && Number.isInteger(m.from) && m.from < 6 && m.from !== FS.citizen?.faction;
    const own = lost || (FS.holdings ?? []).some(h => h.p === m.p && h.q === m.q && (h.site === m.site || h.tile === m.tile)) || (m.faction !== undefined && m.faction === FS.citizen?.faction && ['muster', 'depart'].includes(m.kind) && (FS.holdings ?? []).some(h => h.p === m.p && h.q === m.q));
    // (verify-pr117: under the local fog, another's moment — 「シンダーの新しい村」, a host setting out, an arrival, a camp
    //  gone — plays only where its tile is in sight now. The page reads whole provinces it cannot see: AI villages' were
    //  announced over blank, never-seen land)
    if (!own && !taken && !viewTile(m.p, m.q, m.tile)) continue;
    shown.push({ ...m, lost, taken, own });
  }
  // (fix-loop8, LP8-9: many new villages of one nation in one province, all in sight, get one caption with their count)
  for (const m of mergeNewVillages(shown)) fxEmit('moment', m);
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
/**
 * (2026-11-16, Lane C G2) A land record the page re-read redraws the board, whichever read brought it. The poll's refresh
 * and wantProvince redraw it themselves, but local play's sync reads (the waiting send, the muster wait, the half-second
 * sync) redraw only the panel: with reduced motion — no breathing frames — the land chip showed the new holder at once
 * and the board kept the old outline until the next poll. Compared by content, so an unchanged record redraws nothing.
 */
const landSigOf = new WeakMap();
let landSeen = null;
function landRevision() {
  let s = '';
  for (const [key, env] of FS.provinces ?? []) {
    const l = env?.land;
    if (!l) continue;
    let g = landSigOf.get(l);
    if (g === undefined) { g = `${l.nextBell}|${(l.owners ?? []).join(',')}|${(l.by ?? []).join(',')}|${(l.count ?? []).join(',')}|${[...(l.village ?? [])].join(',')}`; landSigOf.set(l, g); }
    s += `${key}:${g};`;
  }
  return s;
}
/** The turn of the chain time the herald last reported (ChainClock.seen), or null: never the local clock's extrapolation. */
function seenBell() {
  const t = FS.chain?.seen?.() ?? null;
  return FS.clock && t !== null ? bellAt(FS.clock.genesisTs, t) : null;
}
// (pt-first-battle) the "While you wait" panel's times are drawn again every few seconds of the viewer's time, not per frame
const WAIT_REDRAW_MS = 10_000;
let waitDrawnAt = 0;
function renderHudTick(now) {
  const m = hud.bellModel(FS.clock, now);
  tickTurn();
  if (FS.mode === 'play' && Date.now() - waitDrawnAt > WAIT_REDRAW_MS) { waitDrawnAt = Date.now(); invalidate('rail'); }
  if (FS.mode === 'play') { const lr = landRevision(); if (lr !== landSeen) { const had = landSeen !== null; landSeen = lr; if (had) mapRef?.invalidate(); } }
  if (FS.dialOpen) renderDialPop(now);
  if (instantHomeEnabled(FS.season)) {
    if (Number.isInteger(m.bell) && FS.nowBell !== m.bell) { FS.nowBell = m.bell; invalidate('panel'); }
    for (const el of globalThis.document?.querySelectorAll?.('[data-home-deadline]') ?? []) {
      const left = Number(el.dataset.homeDeadline) - now;
      el.textContent = countdown(left);
      // (asked once for a deadline: an element that is not drawn again — a sheet that is put away keeps its last
      // markup — would otherwise ask on every draw, and the draw it asks for would ask again, without end)
      if (left <= 0 && el.dataset.homeDue !== 'asked') { el.dataset.homeDue = 'asked'; invalidate('panel'); }
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
    const tokens = FS.mode === 'play' ? hud.resourceModel(settledHolding(hud.activeHolding(FS), now ?? 0), now ?? 0, { land: landUpkeepMilli(FS, hud.activeHolding(FS)) }) : [];
    strip.hidden = !tokens.length;
    // the room left of the dial: more tokens as the strip widens
    const w = globalThis.innerWidth ?? 1440;
    // (a phone's strip: the two most pressing and a chip for the rest, which opens them all; the second review:
    // a strip that scrolled sideways ended in half an icon at the plaque's point)
    const room0 = w < 380 ? 1 : w <= PHONE_MAX ? 2 : w < 900 ? 2 : w < 1040 ? 3 : w < 1280 ? 4 : w < 1600 ? 5 : 8;
    // the land preview (TEST-ONLY worlds with that option): the viewer's territory and its production bonus, beside the strip
    //  (2026-11-16: and, apart, the land the viewer's nation has claimed in other provinces the map has loaded — a take far
    //  from home showed 0 there, or no chip at all when the home province had no land record)
    const lh = FS.mode === 'play' ? hud.activeHolding(FS) : null, lf = FS.citizen?.faction;
    //  (2026-11-16: the per-hour figure reads the village as the strip does — settledHolding: a finished building or
    //  promotion already produces —, as ClaimLandYield's yield_for reads it after settle_tiered; the stored record lagged)
    const ls = lh ? landSummary(FS, settledHolding(lh, now ?? 0), lf) : null, le = lh ? landElsewhere(FS, lh, lf) : null;
    const landShown = !!ls || (le?.tiles ?? 0) > 0;
    // (fix-loop13, LP13-2: the land chip stands in the same plaque — one token fewer while it is shown, so neither is cut)
    const room = landShown && w > PHONE_MAX ? Math.max(1, room0 - 1) : room0;
    // (what does not fit is never cut: a strip that overflows its plaque shows one token fewer, and stays so at this width)
    // (tried again now and then: the first measure may have been taken before the fonts were in)
    if (stripFit.w !== w || (stripFit.n = (stripFit.n ?? 0) + 1) % 5 === 0) stripFit = { w, max: room, n: stripFit.w === w ? stripFit.n : 0 };
    setHtmlIfChanged(strip, hud.renderStrip(tokens, FS.resOpen ?? null, Math.min(room, stripFit.max)));
    // (verify-pr208: until it fits, within this pass — one step a pass left a token cut on screen for a pass at each
    //  retry: beside the land chip a third number came and went every few seconds, 「254 3 more」 measured live at 1280 px)
    while (tokens.length && stripFit.max > 1 && strip.scrollWidth > strip.clientWidth + 1) {
      stripFit.max = Math.min(room, stripFit.max, tokens.length) - 1;
      setHtmlIfChanged(strip, hud.renderStrip(tokens, FS.resOpen ?? null, Math.max(1, stripFit.max)));
    }
    resChanges(strip, tokens);
    let chip = $('land-chip-box');
    if (landShown && !chip && strip.parentElement) { chip = globalThis.document.createElement('span'); chip.id = 'land-chip-box'; strip.after(chip); }
    if (chip) { chip.hidden = !landShown; setHtmlIfChanged(chip, renderLandChip(ls, le)); }
  }
  renderSound();
  publishNoGo();
  renderResPop(now ?? 0);
  checkMilestones();
  checkOwnProfile();
  if (FS.pins === undefined) { const sc = scope(); if (sc) { FS.pins = pins.loadPins(uiStorage, sc.seasonId); if (FS.pins.length) { invalidate('map'); renderMinimap(); } } }
  tickFeed();
  renderFeed();
  notifyTick();
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
    // (verify-pr268: the tooltip is part of the key — the provisional village's confirm time rides it and stayed at the
    //  first render's 「遅くとも約 3 時間 32 分」 after the Province copy came in and the time was 2 minutes)
    const key = nx ? `${nx.kind}|${nx.act}|${JSON.stringify(nx.data)}|${nx.text}|${nx.hint ?? ''}|${nx.more}` : '';
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
/** The player's own marks on this device (hud/returnsum.mjs): what they said they have seen, per season and wallet. */
const awayStore = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const awayMe = () => ({ tag: (() => { try { return BigInt(ownTag(FS) ?? 0); } catch { return null; } })(), faction: FS.citizen?.faction, holdings: (FS.holdings ?? []).map(h => ({ p: h.p, q: h.q, site: h.site })),
  hostOf: id => { try { const h = hostParts(id); return h ? (FS.holdings ?? []).find(o => o.p === h.p && o.q === h.q && o.site === h.site) ?? null : null; } catch { return null; } } });
/**
 * The away summary's reading (hud/awayread.mjs): from the player's own mark on this device, or from AWAY_REACH events
 * behind the season's head on a first look, for one scope (herald, season, wallet). It runs on its own and tickFeed
 * takes what it found: on the first reading one head notice ("seen" moves the mark over what was read, never over a
 * gap) and one notice per item; after it, the S1 records read since, with the caravans' holders carried on.
 */
const awayReader = returnRead.createAwayReader({ events: a => (heraldRef ? heraldRef.events(a) : Promise.resolve({ ok: false })) });
let awayBusy = false, awayBook = null, awaySent = null, awayQueue = [];
// (workstream 07: an NFT resident (⑳) is another viewer than its wallet's own Citizen: its marks are kept apart)
const awayWho = () => ({ season: String(FS.season?.seasonId ?? ''), wallet: FS.wallet?.address ? (FS.resident?.asset ? `${FS.wallet.address}#nft:${FS.resident.asset}` : FS.wallet.address) : '' });
/**
 * The pinned world the away reading and its marks belong to: cluster, program and season account as fchainio.setPin
 * pinned them (`addresses.season` is the account setPin derived and checked against the herald's record). null before a
 * world is pinned: nothing is made up, and with no world there is no away scope (nothing is read, kept or saved).
 */
const awayWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);
// (the scope names the world too — 2026-11-17: two worlds can share a genesis time, a season number and a wallet, and a
// late answer read under one must not be taken, kept or confirmed under the other)
// (the scope also names the pin's generation: a reading of the first A is not taken, kept or confirmed under the A pinned
// again after B. The saved mark keeps the world itself — awayWorld — so that it still matches after a reload)
const awayScopeNow = () => { const { season, wallet } = awayWho(), world = awayWorld(); return season && wallet && world ? returnRead.awayScope({ herald: `${String(FS.season?.genesisTs ?? '')}|${FS.pin?.gen ?? 0}|${world}`, seasonId: season, wallet }) : null; };
const S1_NEWS = new Set(['CARAVAN_RAIDED', 'RAID_OPENED', 'CARAVAN_SETTLED', 'VAULT_SEIZED', 'STRUCTURE_SEIZED', 'SIEGE_DECLARED', 'CAPTURE_SETTLED', 'NATION_DECIDED', 'NATION_PROPOSED']);
/** The ends of caravans the away reader read: a caravan gone from the road's list is no longer "state unknown" once read. */
const awayEnds = records => { for (const x of records ?? []) if (x.record?.name === 'CARAVAN_SETTLED' || x.record?.name === 'CARAVAN_RAIDED') { const k = returnSum.caravanKey(x.record); if (k) caravanWatchOf(FS).ended(k); } };
/** The away head notice's words: what the summary covers and what "seen" will do (or why it is not offered). */
const awayHeadText = (s, saved = undefined) => `${returnWords.headText(s)} ${saved === undefined ? returnWords.confirmText(s) : returnWords.confirmedText(saved)}`;
/** The shortest time between two reads of the away pages after the last one read (awayPump). */
const AWAY_MORE_MS = 2000;
let awayMoreAt = 0;
function awayPump() {
  if (awayBusy || !heraldRef || !s1On()) return;
  const sc = awayScopeNow();
  if (sc === null) { if (awayReader.scope !== null) { awayReader.reset(); awayBook = null; awayQueue = []; caravanWatchOf(FS).reset(); } return; }
  awayBusy = true;
  if (sc !== awayReader.scope) {
    // (a new wallet or season, or the first look: what another scope told goes, with its book)
    FS.feed = (FS.feed ?? []).filter(x => !(x.away || x.awayOf) || x.scope === sc);
    awayBook = null; awayQueue = []; caravanWatchOf(FS).reset();
    const { season, wallet } = awayWho(), st = awayStore();
    const world = awayWorld();
    const marks = returnSum.loadMarks(st, season, wallet, world);
    const head = (() => { try { return FS.record?.headSeq === undefined ? null : BigInt(FS.record.headSeq); } catch { return null; } })();
    const usable = marks && !(head !== null && BigInt(marks.confirmedSeq) > head);
    const from = usable ? marks.confirmedSeq : head === null ? '0' : String(head > BigInt(returnRead.AWAY_REACH) ? head - BigInt(returnRead.AWAY_REACH) : 0n);
    awayReader.start({ scope: sc, from }).then(r => {
      if (r.stale || r.scope !== awayScopeNow()) return;
      awayEnds(r.records);
      const s = returnSum.summarize({ records: r.records, read: { after: r.after, complete: r.complete, failed: r.failed, bad: r.bad }, marks: returnSum.loadMarks(awayStore(), season, wallet, world), last: returnSum.loadLast(awayStore()),
        season, wallet, nowBell: FS.nowBell ?? 0, headSeq: head === null ? null : String(head), me: awayMe(), rules: { programVersion: FS.season?.programVersion }, world });
      awayBook = s.book; awaySent = s.sent;
      if (!s.items.length && !s.gap && !s.failed && !s.bad && s.windowFrom === null && s.mode !== 'markAhead') return;
      awayQueue.push({ id: `away:${sc}:${s.read.toSeq ?? r.after}`, kind: 'away', scope: sc, bell: FS.nowBell ?? null, text: awayHeadText(s), away: { ok: s.confirm.ok, summary: s, world } },
        ...s.items.map(i => ({ ...awayItem(i), scope: sc })));
    }).catch(() => {}).finally(() => { awayBusy = false; });
  } else {
    // (local-perf, 2026-11-21: the pages after the last one read are asked at most every AWAY_MORE_MS. The pump runs with
    //  every drawing of the HUD — the dial's each second, every panel render — and asked the herald up to four times a
    //  second, nearly always for nothing new)
    const t = Date.now();
    if (t - awayMoreAt < AWAY_MORE_MS) { awayBusy = false; return; }
    awayMoreAt = t;
    awayReader.more().then(r => {
      if (r.stale || r.scope !== awayScopeNow() || awayBook === null) return;
      awayEnds(r.records);
      const { items, book, sent } = returnSum.itemsSince(r.records, awayMe(), awayBook, awaySent, { programVersion: FS.season?.programVersion });
      awayBook = book; awaySent = sent;
      awayQueue.push(...items.filter(i => S1_NEWS.has(i.kind)).map(i => ({ ...awayItem(i), scope: sc })));
    }).catch(() => {}).finally(() => { awayBusy = false; });
  }
}
/**
 * The away summary's way in on a phone. A phone shows one notice over the map, the newest (frontier.css: one toast at a
 * time), so the summary of what happened while away waited under this turn's card, and only the list under その他 had
 * it. While a summary of this scope is not confirmed, a line under the strip says so and opens that list at it; it goes
 * when "seen" is pressed (closing the notice with × does not confirm, so the line stays). Wide screens show the
 * summary itself over the map, and the line is not drawn there (frontier.css).
 */
const awayConfirmed = new Set();
const awayHeadNow = () => { const sc = awayScopeNow(); return sc === null ? null : (FS.feed ?? []).find(x => x.kind === 'away' && x.away?.summary && x.scope === sc && !awayConfirmed.has(x.id)) ?? null; };
function renderAwayEntry() {
  const doc = globalThis.document;
  if (!doc?.body) return;
  const head = FS.mode === 'play' ? awayHeadNow() : null;
  let b = doc.getElementById('away-entry');
  if (!head) { if (b) b.hidden = true; delete doc.body.dataset.awayEntry; return; }
  if (!b) { b = doc.createElement('button'); b.type = 'button'; b.id = 'away-entry'; b.className = 'away-entry'; b.dataset.act = 'away-open'; doc.body.appendChild(b); }
  const s = head.away.summary, n = (s.items?.length ?? 0) + (s.more ?? 0);
  const text = n > 0 ? L`留守中の未確認の出来事 ${fmtNum(n)} 件` : L`留守中の記録に未確認があります`;
  if (b.dataset.text !== text) { setHtml(b, html`${icon('bell')}<span>${text}</span>`); b.dataset.text = text; b.setAttribute('aria-label', L`${text}（押すと要約を開きます）`); }
  b.dataset.id = head.id;
  b.hidden = false;
  doc.body.dataset.awayEntry = '1';
}
/**
 * What the away reading found since the last tick (and the next reading started). Only what belongs to the scope of this
 * moment is handed on (2026-11-17): a reading's items wait in the queue until the next tick, and the world, wallet or
 * season may change in between — items of another scope are dropped here, not shown in the new one's feed. With no
 * scope (no pinned world, no wallet or no season) nothing is handed on and the queue is emptied.
 */
function awayTake() {
  const sc = awayScopeNow();
  const out = awayQueue.splice(0).filter(x => sc !== null && x.scope === sc);
  awayPump();
  return out;
}
/** One item of the away summary as a notice; `awayOf` keeps the item so that a change of language words it again. */
const awayItem = i => ({ id: `aw:${i.seq}`, kind: i.battle ? 'battle' : 's1', bell: i.bell, text: returnWords.itemText(i), hint: returnWords.itemDetail(i) || undefined, awayOf: i, ...(i.at ? { p: i.at.p, q: i.at.q, ...(Number.isInteger(i.at.tile) ? { tile: i.at.tile } : {}) } : {}), ...(i.battle ? { battle: i.battle } : {}) });
/** The away notices in the page's language (they are kept as words; the language may change after they were told). */
// (B11, loop-play2: and every other notice, by the words it keeps in every language — hud/words.mjs)
const reword = () => { if (FS.feed?.some(x => x.awayOf || x.away || x.words)) FS.feed = FS.feed.map(x => (x.awayOf ? { ...x, text: returnWords.itemText(x.awayOf), hint: returnWords.itemDetail(x.awayOf) || undefined } : x.away?.summary ? { ...x, text: awayHeadText(x.away.summary, x.away.saved) } : reworded(x))); };
onLangChange(() => { reword(); try { renderFeed(); } catch { /* before the page is built */ } });
let feedBell = null;
/** Compare what the page knows with the last tick's; new changes become notifications; a new bell folds the last one into a summary. */
function tickFeed() {
  if (FS.mode !== 'play' || !FS.citizen || !FS.chronicle) return;
  const snap = feed.snapshot(FS, undefined, feedPrev);
  let fresh = [...feed.diffFeed(feedPrev, snap), ...(!s1On() ? [] : awayTake())];
  // (fix-loop22, LP22-4: the viewer's own clashes outlive their march rows — the report list, "Other → Battles", the guide)
  if (feedPrev) FS.ownClashes = feed.ownClashesFrom(FS.ownClashes, feedPrev, snap);
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
      const lost = Number.isFinite(me.before) && Number.isFinite(me.after) ? Math.max(0, me.before - me.after) : null;
      // (B11: the words in every language now — hud/words.mjs said — so that a switch of language shows the same line)
      // (`attacked`: a host of the viewer's stood and was attacked — it is among the tile's defenders; a host of the viewer's
      //  that arrived there is the attacker, its own march's clash, told as its report — hud/notify.mjs; live, pt-notify)
      if ((tile.defenders ?? []).some(s0 => mine(s0.id)) && !(tile.attackers ?? []).some(s0 => mine(s0.id))) item = { ...item, attacked: true };
      item = { ...item, tile: tile.idx, ...said(() => {
        const where = tileNameOf({ p, q, tile: tile.idx }), who = foe && foe.faction >= 0 && foe.faction < 6 ? factionName(foe.faction) : null;
        return who
        ? (lost !== null ? L`${where}で、あなたの軍勢が${who}の軍勢と戦いました（ターン ${fmtNum(bell)}・${fmtNum(lost)} 兵を失いました）` : L`${where}で、あなたの軍勢が${who}の軍勢と戦いました（ターン ${fmtNum(bell)}）`)
        : L`${where}で、あなたの軍勢が戦いました（ターン ${fmtNum(bell)}）`;
      }) };
    } else if (scene) {
      // (nobody of the viewer's fought: a public fact of the province, in the list with its report)
      item = { ...item, quiet: true, tile: scene.tiles[0]?.idx ?? null, ...said(() => L`${noticeProvince(p, q)}で、ほかの国どうしの戦いがありました（ターン ${fmtNum(bell)}）`) };
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
  // (2026-11-17, ⑦: the replay asked for outside a report says how its read goes, here — replayNotice)
  const items = held ? [] : [...(st ? [{ id: 'tx', markup: status.renderStatus(st) }] : []),
    ...(FS.replayAsk ? [{ id: 'replay', markup: replayNotice(FS.replayAsk) }] : []),
    ...feed.stackOrder(stripItem, toasts, { alarmsFirst: phone() })];
  syncStack(el, items);
  publishNoGo();
  renderAwayEntry();
}
/** How long a notice of how a fight ended waits for that fight's battle to be told (ms), and the timer that shows it. */
const OUTCOME_BEAT_MS = 1500;
let outcomeTimer = null;
/** A standing threat's notice as it is now: the count the records give, and whether the answer is on its way. */
function protoAlarmNow(x, up) {
  // (the live words are made by the hand's model as the notice is drawn, in every language: proto/hand-model.mjs alarmNow)
  return pm.alarmNow(FS, x, up);
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
      if (next) { node.className = `${next.className} shown`; node.setAttribute('role', next.getAttribute('role') ?? 'status'); node.replaceChildren(...next.childNodes); stackHtml.set(node, markup);
        // (verify-pr137: and its hover title — a caravan's careful account, LP7-8 — follows a change of language too;
        //  it stayed in the first language while the toast's words changed)
        if (next.hasAttribute('title')) node.setAttribute('title', next.getAttribute('title')); else node.removeAttribute('title'); }
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
let waitRefocus = false;
/**
 * (pt-first-battle) The "While you wait" control that has the keyboard focus, as a selector that finds it again in new
 * markup ('.waitp-tab' or a suggestion by its `data-wait-suggest`), or null. The panel's times change as the turns pass,
 * so its markup is replaced while a keyboard user is on it; the focus must not fall to the page.
 */
const waitFocusSel = () => {
  const a = globalThis.document?.activeElement;
  if (!a?.closest?.('.waitp')) return null;
  return a.classList?.contains('waitp-tab') ? '.waitp-tab' : a.dataset?.waitSuggest ? `[data-wait-suggest="${String(a.dataset.waitSuggest).replace(/[^\w-]/g, '')}"]` : '.waitp-tab';
};
const waitRefocusTo = sel => { if (!sel) return; const d = globalThis.document; if (d?.activeElement?.closest?.('.waitp')) return; d?.querySelector?.(`.waitp ${sel}`)?.focus?.({ preventScroll: true }); };
function renderRail() {
  const small = phone();
  const el = $('rail');
  const focusSel = waitFocusSel() ?? (waitRefocus ? '.waitp-tab' : null);
  waitRefocus = false;
  if (el) { setHtmlIfChanged(el, small ? '' : hud.renderRail(FS, { todoOpen: !!FS.todoOpen, wait: waitMarkup(FS) })); el.hidden = small || !el.firstElementChild; }
  // (pt-first-battle: the key the person was on — the fold's, or a suggestion — has the focus again in the new markup; on a
  //  phone the sheet is drawn by the panel's own pass, so the same is asked again on the next frame)
  waitRefocusTo(focusSel);
  if (focusSel) globalThis.requestAnimationFrame?.(() => waitRefocusTo(focusSel));
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
  const owner0 = t && t.state === 1 && t.site !== undefined ? rosterRef?.ownerOf(hit.p, hit.q, t.site) : null;
  // (the fog of war of a local test world, map/fog.mjs — verify-pr93: the roster and the lords' lives are live, so out of
  //  sight now a village of another nation is not named, nor what its lord is doing)
  const owner = owner0 && FS.fog?.on && FS.survey?.levelOf?.(hit.p, hit.q, hit.idx) !== 3 && t.owner !== FS.citizen?.faction ? null : owner0;
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
// (2026-11-17, ⑦: of one pinned world — with its generation: what was seen in another is forgotten, and that world's
//  envelopes still held are not looked at, so the first sight of each province in this world is not news)
let battleWorldNow;
/**
 * Make the battle state this pinned world's (2026-11-17, ⑦), at once and in one place: the first thing peopleSource does
 * (before its second's cache is returned or built) and the first thing playBattle does after its wait (before a scene is
 * compared). At a change of world: the sightings are forgotten, the scenes of other worlds end on the map and in the
 * effects layer (endOtherWorldBattles: that world's plays only — a play of this world, also one just placed where an old
 * one stood, stays), a camera place kept for a battle in another world is let go with its timer, and the cache is built
 * again. The same world changes nothing. Returns the world.
 */
function syncBattleWorld() {
  const world = momentWorld();
  if (battleWorldNow === world) return world;
  battleWorldNow = world;
  battleSeen.clear();
  endOtherWorldBattles(world);
  if (battleKeepWorld !== undefined && battleKeepWorld !== world) { clearTimeout(battleBack); battleBack = null; camKeep.drop('battle'); battleKeepWorld = undefined; }
  peopleCache.at = -1;
  // (a replay asked for in another world: its notice goes with it — the request itself is called off by playBattle.
  //  Corrected: only a notice of ANOTHER world. One asked in this world — the person pressed before this sync came
  //  round — is this world's own: it stays, being read or not read, and its answer still finds it)
  if (FS.replayAsk && FS.replayAsk.world !== world) { FS.replayAsk = null; renderFeed(); }
  return world;
}
let battleBack = null;
// (2026-11-17, ⑦: the camera's place kept for a battle — camKeep 'battle' — belongs to the pinned world it was kept in
//  (battleKeepWorld), and to the map as the person had last touched it then (`map.touchedAt`: every pointerdown — also
//  a touch that only stops a flight, which the map's move count does not see —, the wheel, the map's keys). The way
//  back is not taken into another world, nor after a person touched the map since: the kept place is let go instead)
let battleKeepWorld, battleTouched = null;
/** Scenes of another pinned world are ended where they are drawn: the map's own (FS.battles) and the effects layer's. */
function endOtherWorldBattles(world) {
  const gone = (FS.battles ?? []).filter(b => b.world !== undefined && b.world !== world);
  if (!gone.length) return;
  FS.battles = (FS.battles ?? []).filter(b => !gone.includes(b));
  for (const b of gone) { endBattle(b); fxEmit('battle:end', { play: b }); }
  mapRef?.invalidate();
}
/** Load a clash and play its scene on the map; `focus` moves the camera to it first. */
export async function playBattle(p, q, bell, { focus = false, auto = false, still = null, asked = null } = {}) {
  const fx = FS.ui?.battleFx ?? 'normal';
  if (auto && fx === 'off') return false;
  if (!heraldRef || ![p, q, bell].every(Number.isInteger)) return false;
  // (2026-11-17, ⑦: a clash belongs to the herald and the pinned world — with its generation — it was asked of. One the
  //  change overtakes is not staged: its inputs are another world's and this world's province would stand beside them,
  //  and its flight would take the camera to a place of another map. `still`: the caller's own condition, asked again
  //  after the wait (the spectator's follow: the same herald and world, the watch still on, no report opened, no move
  //  of the camera the map counts). A request the change overtook answers null — called off, nothing to make up for —
  //  and false stays "no scene" (no clash, nothing to stage): only false lets a caller fall back.
  //  A scene the page stages by itself (`auto`, or the follow's `still`) whose answer comes after a later turn's scene
  //  of the same province is already playing is called off too: the older answer does not replace the newer picture.
  //  A scene asked for by name — the report's 見る — plays as before.)
  const world = momentWorld(), source = heraldRef;
  const r = await source.clash(p, q, bell).catch(() => null);
  // (`asked`: an explicit request's own validity — app playAsked: still the last press, still the report it was pressed
  //  in (or still none). Checked here, before anything is staged, flown to or put on the map, like `still`; unlike
  //  `still` it does not make the request one the page stages by itself: a newer scene of the province does not call off
  //  a clash the person asked for by name, an older one included)
  if (momentWorld() !== world || heraldRef !== source || (still && !still()) || (asked && !asked())) return null;
  // (the battle state is this world's before anything is compared: an older world's scene with a higher bell is ended
  //  here, not taken for "a later turn of this province" — syncBattleWorld; and only this world's scenes are compared)
  syncBattleWorld();
  if ((auto || still) && (FS.battles ?? []).some(b => (b.world === undefined || b.world === world) && b.scene.p === p && b.scene.q === q && b.scene.bell > bell && battleLive(b, performance.now() / 1000))) return null;
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
    // (a place kept in another world is not this world's to go back to: let go, with its timer)
    if (battleKeepWorld !== world) { clearTimeout(battleBack); battleBack = null; camKeep.drop('battle'); }
    battleKeepWorld = world;
    if (camKeep.keep('battle')) battleTouched = mapRef.touchedAt ?? null;
    mapRef.flyTo({ p, q, tile: scene.tiles[0].idx, zoom: 2.1 }, 500);
    const secs = PHASE.end / (BATTLE_SPEEDS[fx] || 1) + 0.9;
    clearTimeout(battleBack);
    // (the flights to the scene are the page's and the effects layer's own; a place the player goes to meanwhile is
    // reported by name: goToItem, the plate, a selection that flies)
    battleBack = setTimeout(() => {
      battleBack = null;
      if (momentWorld() !== world || (mapRef?.touchedAt ?? null) !== battleTouched) { camKeep.drop('battle'); return; }
      camKeep.back('battle', { ms: calm() ? 0 : 420, slack: Infinity });
    }, secs * 1000);
  }
  const play = startBattle(scene, performance.now() / 1000, BATTLE_SPEEDS[fx] || 1);
  play.world = world;
  FS.battles = [...(FS.battles ?? []).filter(b => !(b.scene.p === p && b.scene.q === q)), play];
  // staged by the effects layer (fx/battle.mjs): the dimmed map, the scene on its own canvas, the title
  fxEmit('battle', { play, focus, zoom: focus ? 2.1 : null, viewerFaction: FS.citizen?.faction ?? null, lossText: n => L`−${fmtNum(n)} 兵`, numText: n => fmtNum(n) });
  mapRef?.invalidate();
  return true;
}
/** A clash that resolved in a province the page has loaded plays once, when it is new. */
function autoBattles() {
  const world = syncBattleWorld();
  for (const [key, env] of FS.provinces) {
    if (env.world !== undefined && env.world !== world) continue;
    const b = env.province?.resolveSummary?.bell;
    if (!Number.isInteger(b) || b <= 0) continue;
    const prev = battleSeen.get(key);
    battleSeen.set(key, b);
    if (prev === undefined || prev >= b) continue;  // the first sight of a province is not news
    // a clash the notifications announce (the viewer's own province, or where a march of theirs arrived) is one of
    // the turn's own results: it plays once, in its place after the toll (tickFeed, mountTurnStrip), not here as well
    if (FS.mode === 'play' && feedAnnounces(env.province.p, env.province.q, b)) continue;
    // (fix-loop5, L5-6: under the fog, a clash out of sight now does not play by itself either)
    if (!clashHere(env.province.p, env.province.q, b)) continue;
    playBattle(env.province.p, env.province.q, b, { auto: true });
  }
}
/** Whether hud/feed.mjs makes a notification of the clash of (p, q) at `bell`: a province of the viewer's, or the destination of a march of theirs arriving then. */
const feedAnnounces = (p, q, bell) => !!FS.citizen && ((FS.holdings ?? []).some(h => h.p === p && h.q === q)
  || (FS.marches ?? []).some(m => m.dest && m.dest.p === p && m.dest.q === q && (m.entry?.arriveBell ?? m.transit?.arriveBell) === bell));

// ------------------------------------------------------------------ the minimap and the lenses (hud/minimap.mjs)
let miniQueued = false, miniPulse = null, miniOverview = null;
function renderMinimap() {
  if (miniQueued) return;
  miniQueued = true;
  requestAnimationFrame(() => {
    miniQueued = false;
    const cv = $('minimap-canvas');
    if (!cv || !mapRef || !cv.getContext) return;
    const px = minimap.MINIMAP_PX, dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (cv.width !== px * dpr) { cv.width = px * dpr; cv.height = px * dpr; }
    // Herald adoption replaces overview envelopes. Camera movement and the
    // home pip keep the same envelopes and can reuse their flattened map.
    const entries = [...shownOverviews()];
    if (!miniOverview || entries.length !== miniOverview.entries.length ||
        entries.some(([key, value], i) => key !== miniOverview.entries[i][0] || value !== miniOverview.entries[i][1])) {
      const recs = new Map();
      for (const [, ov] of entries) for (const r of ov.provinces) recs.set(`${r.p},${r.q}`, r);
      miniOverview = { entries, recs };
    }
    const recs = miniOverview.recs;
    const sv = FS.survey ?? null, pulse = !!sv?.home && !sv.showAll && !reducedMotion();
    minimap.paintMinimap(cv.getContext('2d'), { recs, revision: miniOverview, rings: ringsOpenNow(), seeded: worldNow().seeded ?? null, own: (FS.holdings ?? []).map(h => ({ p: h.p, q: h.q })),
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
  for (const ov of shownOverviews().values()) for (const r of ov.provinces) recs.set(`${r.p},${r.q}`, r);
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
  // (verify-pr180) a season whose orders are over says so on the title (終了 / 閉鎖 / 受付終了（終了の確定待ち）), not its turn
  const s = FS.season, now = FS.chain?.now() ?? 0;
  const st = s ? effectiveStatus(s, now) : null, words = s ? seasonStatusText(s, now) : null;
  const over = st === 'Ended' || st === 'Closed' || words === SEASON_STATUS_TEXT.Over ? words : null;
  return title.liveLine({ seasonId: FS.record?.season ?? null, bell, holdings: total, over });
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
  nationChatPlace();
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
/**
 * A clash asked for by name (2026-11-17, ⑦: 戦いを再生 / 見る — the report, the notices, the tracker, the inspector, the turn
 * list). The report it was pressed in stays open while the clash is read, and is left only once the scene is on the map
 * (playBattle true). "No scene" (false, or a throw) keeps the report as it was and says so under its button, which reads
 * again when pressed. A request the change of world or herald called off (null) is not a failure: nothing is said and
 * nothing is restored. Only the last press answers: an earlier one that comes back later neither closes nor marks the
 * report. A report the person opened or closed meanwhile is theirs: it is neither closed nor marked by this request.
 * The scene itself is playBattle's, unchanged (an explicit request, not the follow's or the page's own).
 */
let playAskSeq = 0;
async function playAsked(p, q, bell) {
  // (fix-loop5, L5-6: the scene of another nation's clash out of sight now is not played)
  if (!clashHere(p, q, bell)) return;
  const req = ++playAskSeq;
  const rep = FS.report ?? null, world = reportWorld();
  closeDialPop();
  if (rep) { rep.playing = true; rep.playFailed = false; invalidate('panel'); }
  // (2026-11-17, ⑦: a press made outside a report — a notice, the tracker, the inspector — has no report to say how the
  //  read goes: it said nothing, also when the clash could not be read. `FS.replayAsk` is that press's own state — being
  //  read, then gone when the scene plays, or "not read" with the same request to make again — shown as one notice on
  //  the map's stack (renderFeed). It is not a record: nothing of the notices' list or its seen marks is touched. A
  //  press inside a report keeps to the report's own line.)
  //  (corrected: the notice carries the world it was asked in — `world`, the pin with its generation, the same string
  //  as momentWorld — so the battle state's sync lets go of another world's notice only, never one asked in this world
  //  before that sync came round)
  FS.replayAsk = rep ? null : { p, q, bell, state: 'loading', req, world };
  renderFeed();
  // (2026-11-17 correction: the request's validity reaches playBattle before its effects — `asked`: the last press, and
  //  the report open now is the one it was pressed in (none for none) in the same world. A later press, a report opened,
  //  switched or closed meanwhile, or another world: no scene, no flight, nothing on the map (null). Not `still`: the
  //  person's replay of an older clash is not called off by a newer scene there)
  const asked = () => req === playAskSeq && (FS.report ?? null) === rep && reportWorld() === world;
  let ok = false;
  try { ok = await playBattle(p, q, bell, { focus: true, asked }); } catch (e) { console.error('frontier battle play:', e); ok = false; }
  if (req !== playAskSeq) return;
  if (rep) rep.playing = false;
  // (outside a report: the scene plays → the notice goes; "no scene" (false, or a throw) with nothing changed since →
  //  "not read", to ask again; called off (null: another world or herald, a report opened meanwhile) → the notice goes
  //  without a word, as nothing failed. Only this press's own notice is touched: `req`)
  if (!rep && FS.replayAsk?.req === req) { FS.replayAsk = ok === false && asked() ? { p, q, bell, state: 'failed', req, world } : null; renderFeed(); }
  if (ok === true) { if (rep && FS.report === rep) leaveReport(); return; }
  if (rep && ok === false && FS.report === rep && reportWorld() === world) rep.playFailed = true;
  if (rep) invalidate('panel');
}
/** The notice of a replay asked for outside a report (FS.replayAsk): being read, or not read with the way to ask again. */
function replayNotice(a) {
  const again = html`<button type="button" class="btn small primary" data-act="battle-play" data-p="${a.p}" data-q="${a.q}" data-bell="${a.bell}">${icon('return')}${L`もう一度読み込む`}</button>`;
  return html`<div class="toast replay-ask" role="status" data-state="${a.state}"><span class="toast-icon">${icon(a.state === 'failed' ? 'alert' : 'hourglass')}</span>
    <span class="toast-text">${a.state === 'failed' ? L`戦いを読み込めませんでした（ターン ${fmtNum(a.bell)}）。戦いがなかったという意味ではありません。記録はそのままです。` : L`戦いを読み込んでいます…`}</span>
    ${a.state === 'failed' ? html`<span class="toast-acts">${again}</span>` : ''}
    <button type="button" class="toast-x" data-act="replay-dismiss" aria-label="${L`閉じる`}">${icon('close')}</button></div>`;
}
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

// ------------------------------------------------------------------ notices outside the page (pt-notify, Q-PT-8 a, Q-PT-10)
let notifyPrefs = notify.loadNotify(uiStorage);
const notifier = notify.createNotifier({ env: notify.browserEnv(), prefs: () => notifyPrefs });
const notifyWatch = notify.createWatch();
let notifyAt = 0;
/**
 * Whether a hidden tab keeps reading (controller poll: a full read at the hidden pace instead of the reveal-only one):
 * only for a player who turned notices on — with browser notifications, or, where the browser refuses them, with the
 * count in the tab's title (live, pt-notify: a refused permission left a hidden tab reading nothing, so the count never came).
 */
function notifyBackgroundSync() {
  FS.notifyBackground = notifyPrefs.enabled && notify.NOTIFY_KINDS.some(k => notifyPrefs.on[k]);
}
/** The page's names for a place, for the herald's alerts. */
const notifyNames = {
  village: (p, q, site) => { const h = (FS.holdings ?? []).find(o => o.p === p && o.q === q && o.site === site); return h ? holdingName(h) : holdingName({ p, q, site }, 0); },
  // (fix-loop24, BREAK-4: one form for a province in every notice — hud/place.mjs noticeProvince)
  province: (p, q) => noticeProvince(p, q),
};
/** Every host of the viewer's villages the page holds: whether it can march now (the to-do rail's "idle" rule), or rests / is on the road. */
function notifyHostRows() {
  const bell = FS.nowBell ?? 0, out = [];
  for (const h of FS.holdings ?? []) for (const env of FS.provinces?.values?.() ?? []) for (const r of hostsIn(env.province, h, bell)) {
    const standing = r.state === 1 && !r.inTransit && !r.pending, rested = r.stamina >= DEPART_STAMINA && !(r.readyBell > bell);
    out.push({ id: r.id, p: env.province.p, q: env.province.q, tile: r.tile, village: holdingName(h), ready: standing && rested, busy: !!r.inTransit || (standing && !rested) });
  }
  return out;
}
/**
 * Once a second at most: the lines the feed has no source for (the herald's alerts, a host ready again, land upkeep
 * unpaid — added only when their kind is on, so a player who has not chosen them sees the feed as before), then every
 * new line of the feed told once by its kind's choice (hud/notify.mjs).
 */
function notifyTick() {
  if (FS.mode !== 'play' || !FS.citizen) return;
  const now = Date.now();
  if (now - notifyAt < 1000) return;
  notifyAt = now;
  const bell = FS.nowBell ?? null, on = notifyPrefs.on;
  const add = [];
  for (const x of notifyWatch.alerts(FS.meAlerts ?? null, notifyNames)) {
    // (the same event already told by another line — the keep events, the away summary — is not added twice)
    if (on.attacked && !notifier.toldRecently(x.notice.key, bell) && !(FS.feed ?? []).some(y => notify.noticeOf(y)?.key === x.notice.key)) add.push(x);
  }
  const hosts = notifyWatch.hosts(notifyHostRows(), bell);
  if (on.hostReady) add.push(...hosts);
  const land = FS.ownLand?.player ? ownLandView(FS.ownLand.player, bell ?? 0) : null;
  const first = (FS.holdings ?? [])[0] ?? null;
  const upkeep = notifyWatch.upkeep(land, bell, first);
  if (on.upkeep) add.push(...upkeep);
  if (add.length) { FS.feed = feed.pushFeed(FS.feed ?? [], add); invalidate('panel'); }
  notifier.observe(FS.feed ?? [], { bell, onOpen: x => goToItem(x) });
}
/** The settings card's test: one notice by the channel a real one would take now (a system one needs the tab behind). */
function notifyTest() {
  const st = globalThis.Notification?.permission ?? 'unsupported';
  if (st === 'granted' && notifyPrefs.enabled) {
    try { notify.browserEnv().show(`${L`お知らせのテスト`} — Wylls`, { body: L`ブラウザ通知は届いています。`, tag: 'wylls:test', lang: lang() }, null); } catch (e) { console.error('notify test:', e); }
  }
  FS.notice = { ok: true, text: st === 'granted' && notifyPrefs.enabled ? L`テストの通知を送りました。` : L`ブラウザ通知はオンになっていません。タブが後ろにあるあいだは、タブの題名に件数を出します。` };
  renderFeed();
}
/** The "More" drawer's card: the browser's notices per event, and the calendar file of the player's own timers. */
function notifyMarkup(FS) {
  // (the browser's permission as it is now, not as it was at the press: a permission changed later in the site settings —
  //  denied → allowed — showed the old "refused" text while notices already went out; verify-pr262)
  const st = typeof globalThis.Notification === 'function' ? globalThis.Notification.permission : (FS.notifyPermission ?? 'unsupported');
  const on = notifyPrefs.enabled, refused = st === 'unsupported' || st === 'denied';
  const evs = calendar.calendarEvents(FS), blocked = calendar.calendarBlocked(FS);
  const when = e => { try { return new Date(e.startMs).toLocaleString(lang() === 'en' ? 'en' : 'ja', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  return html`<section class="vcard notify-card" aria-labelledby="notify-title">${cardHead({ id: 'notify-title', ic: 'bell', title: L`お知らせ（ページの外）` })}
    <p class="hint" data-notify-state="${st}">${notify.permissionText(st, notifyPrefs.enabled)}</p>
    <div class="actions">${on
      ? html`<button type="button" class="btn" data-act="notify-disable">${refused ? L`タブの題名で知らせるのをやめる` : L`ブラウザ通知をオフにする`}</button>`
      : html`<button type="button" class="btn primary" data-act="notify-enable">${icon('bell')}${refused ? L`タブの題名で知らせる` : L`ブラウザ通知をオンにする`}</button>`}
      <button type="button" class="btn small" data-act="notify-test">${L`テスト`}</button></div>
    <fieldset class="notify-kinds"><legend>${L`知らせる出来事`}</legend>
      ${notify.NOTIFY_KINDS.map(k => html`<label class="choice"><input type="checkbox" data-act="notify-kind" data-k="${k}" ${notifyPrefs.on[k] ? 'checked' : ''}>${notify.KIND_LABEL[k]()}</label>`)}
    </fieldset>
    <p class="hint">${L`知らせるのは、このページが読んでいるあなたの出来事だけです。何もこのブラウザの外へは送りません。`}</p>
    <h4>${L`カレンダー（.ics）`}</h4>
    <p class="hint">${blocked === 'stopped' ? L`この世界の時計が止まっているため、予定の時刻を出せません。` : blocked === 'paceUnknown' ? L`この世界の時計の速さを測っています。速さが分かるまで、予定の時刻は出しません。` : blocked ? L`世界の時刻を読み込み中です。` : evs.length ? L`これからの予定 ${fmtNum(evs.length)} 件（軍勢の出陣・進軍の到着・報告・砦）。ファイルをカレンダーのアプリに読み込んでください。時刻は目安です。予定が変わったら、もう一度書き出して読み込むと同じ予定が動きます。` : L`いまカレンダーに入れる予定はありません（出陣を待つ軍勢・進軍・砦の攻防があると出ます）。`}</p>
    ${evs.length ? html`<ul class="notify-ics">${evs.slice(0, 5).map(e => html`<li>${when(e)} · ${e.title[lang()] ?? e.title.ja}</li>`)}</ul>` : ''}
    <div class="actions"><button type="button" class="btn" data-act="ics-download" ${evs.length ? '' : 'disabled'}>${L`カレンダーのファイルを保存`}</button>${FS.icsLast ? html`<span class="hint">${L`保存しました（${fmtNum(FS.icsLast.n)} 件）`}</span>` : ''}</div>
  </section>`;
}
{
  // the tab in front again: the count in its title goes; a switch of language rewrites the title (data-i18n): the count comes back
  const front = () => { if (notify.browserEnv().focused()) notifier.clearBadge(); };
  globalThis.document?.addEventListener?.('visibilitychange', front);
  globalThis.addEventListener?.('focus', front);
  onLangChange(() => { try { notifier.reapplyBadge(); } catch { /* before the page is built */ } });
  notifyBackgroundSync();
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
  clearInspection(FS); clearOutbound(FS);
  const hs = FS.holdings ?? [];
  if (!hs.length) return;
  const i = (((FS.activeHolding ?? 0) + dir) % hs.length + hs.length) % hs.length;
  clearWideSelect(FS);
  FS.activeHolding = i;
  goToItem({ p: hs[i].p, q: hs[i].q, tile: hs[i].tile, tab: 'holding', holding: hs[i] });
}

/** Close the drawer ("Map", the drawer's ×, Escape): back to the world. */
function shutDrawer({ focus = false } = {}) {
  clearInspection(FS); clearOutbound(FS);
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

const LOCAL_RETURN_ACTS = Object.freeze(['local-return-prepare', 'local-return-send', 'local-return-reconcile']);
const LOCAL_CONQUEST_ACTS = Object.freeze(['local-conquest-prepare', 'local-conquest-send', 'local-conquest-reconcile', 'local-conquest-orders']);
const LOCAL_REVEAL_ACTS = Object.freeze(['local-reveal-check', 'local-reveal-send', 'local-reveal-reconcile', 'local-reveal-clear']);
export const HUD_ACTIONS = {
  // (pt-notify) notices outside the page: the permission is asked only here, from the player's press
  'notify-enable': async () => { const st = await notify.askPermission(); notifyPrefs = notify.saveNotify(uiStorage, { enabled: true }); FS.notifyPermission = st; notifyBackgroundSync(); invalidate('panel'); },
  'notify-disable': () => { notifyPrefs = notify.saveNotify(uiStorage, { enabled: false }); notifyBackgroundSync(); invalidate('panel'); },
  'notify-kind': d => { if (!notify.NOTIFY_KINDS.includes(d.k)) return; notifyPrefs = notify.saveNotify(uiStorage, { on: { [d.k]: !notifyPrefs.on[d.k] } }); notifyBackgroundSync(); invalidate('panel'); },
  'notify-test': () => { notifyTest(); },
  'ics-download': () => { const now = Date.now(), evs = calendar.calendarEvents(FS, { nowMs: now }); FS.icsLast = { at: now, n: evs.length }; calendar.downloadIcs(calendar.icsText(evs, { nowMs: now }), calendar.icsFileName(now)); invalidate('panel'); },
  // A read only. No handOrder, ACTIONS, SENT classification or accepted-order effects.
  'expedition-inspect': () => inspectOriginalExpedition(),
  'expedition-prepare': () => prepareOriginalExpedition(),
  // Local play only (flocalplay-return.mjs; the departure's gate, asked at every step): the return's two player-signed
  // steps from the return card. Prepare first (nothing is signed), then the player's own send; an outcome not known is asked about.
  'local-return-prepare': () => prepareLocalPlayReturn(),
  'local-return-send': () => sendLocalPlayReturn(),
  'local-return-reconcile': () => reconcileLocalPlayReturn(),
  // Local play only, closed by default (flocalplay-conquest.mjs): the siege of the Free City in the province the host
  // stays in. Prepare first (nothing is signed), then the player's own send; an outcome not known is asked about.
  'local-conquest-prepare': () => prepareLocalPlayConquest(),
  'local-conquest-send': () => sendLocalPlayConquest(),
  'local-conquest-reconcile': () => reconcileLocalPlayConquest(),
  'local-conquest-orders': () => readLocalPlayConquestOrders(),
  'outbound-step': d => editOriginalOutbound('step', d.direction),
  'outbound-undo': () => editOriginalOutbound('undo'),
  'outbound-reset': () => editOriginalOutbound('reset'),
  'outbound-route-read': () => inspectOriginalOutboundRoute(),
  'outbound-context-read': () => inspectOriginalOutboundContext(),
  // The earliest observed arrival turn into the draft's own field, then the same read again. A local edit and a read.
  'outbound-arrival-earliest': () => useEarliestOriginalOutboundArrival(),
  // Local play only (flocalplay-depart.mjs; the controller asks its gate at every step): the boundary draft's departure
  // from the page's memory-only wallet, and the status look-up of a departure whose outcome is not settled.
  'outbound-local-depart': () => sendLocalPlayDeparture(),
  'outbound-local-reconcile': () => reconcileLocalPlayDeparture(),
  // Devnet play only (fdevnet-depart.mjs; the controller asks the devnet gate at every step): the preview of the boundary
  // departure, then the connected wallet's signature and the one send; the status look-up; a finished run cleared.
  'outbound-devnet-preview': () => prepareDevnetPlayDeparture(),
  'outbound-devnet-send': () => sendDevnetPlayDeparture(),
  'outbound-devnet-reconcile': () => reconcileDevnetPlayDeparture(),
  'outbound-devnet-clear': () => { clearDevnetPlayDeparture(); },
  // Local play only (flocalplay-reveal.mjs; the same gate, asked at every step): the explicit opening of a seal this
  // page holds. A read first, then the player's own press; an outcome not known is asked about, never sent again.
  'local-reveal-check': () => checkLocalPlayReveal(),
  'local-reveal-send': () => sendLocalPlayReveal(),
  'local-reveal-reconcile': () => reconcileLocalPlayReveal(),
  'local-reveal-clear': () => { clearLocalPlayReveal(); },
  // Resolve the current inventory at click time. DOM coordinates/world are never navigation pins.
  'wide-map': () => {
    const e = FS.mode === 'play' ? selectedWide(FS) : null;
    const holding = e?.status === 'captured-unverified' ? e.holding : null;
    return wideModeRef?.focusHolding(holding, { isCurrent: () => {
      const current = selectedWide(FS);
      return FS.mode === 'play' && !!holding && current?.status === 'captured-unverified'
        && current.inventorySlot === e.inventorySlot && current.holding?.key === holding.key
        && current.holding?.ownerCitizen === holding.ownerCitizen;
    } });
  },
  // nations' cooperation (hud/coopentry.mjs): the entry workstream 01 registers, pressed in the S1 village card
  'coop-open': d => { if (coopEntryOpen(FS, d.id)) invalidate('panel'); },
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
  // (w2-wipeout, D-verify-pr137-3: an ended expedition's 「村で次の軍勢を作る」 — screens/tracker.mjs renderExpedition —: the
  //  village that sent it, with its 編成 card open when its reserve holds a host's worth of combat troops, else 訓練.
  //  Opens the card only; nothing is sent)
  'next-army': d => {
    if (FS.mode !== 'play') return;
    const hi = Number(d.holding), h = (FS.holdings ?? [])[hi];
    if (!Number.isInteger(hi) || !h) return;
    leaveReport(); if (FS.compose) ACTIONS['compose-close'](); FS.guideOpen = false;
    selectVillage(hi, [0, 1, 2, 3, 4, 5].some(u => Number(h.reserve?.[u] ?? 0) >= 100) ? 'muster' : 'train');
  },
  // the conquest guide's press (screens/conquestguide.mjs): the village with the step's card open, or a host with its list of keeps
  'cg-go': d => {
    if (FS.mode !== 'play' || !keephand.conquestOn(FS)) return;
    // (2026-11-16: a draft is put away as 「やめる」 puts it away — controller.mjs compose-close: an armed waiting send is
    //  cancelled first and says so. The pill's press dropped it, and the waiting send was withdrawn as if the order had changed)
    leaveReport(); if (FS.compose) ACTIONS['compose-close'](); FS.guideOpen = false; FS.tab = 'map';
    if (d.pop === 'keeps' || d.pop === 'march') {
      const r = hand.ownHosts(FS).find(x => x.id === String(d.host)) ?? hand.ownHosts(FS).find(x => x.unit !== 6 && x.unit !== 7 && hand.marchCheck(FS, x).ok) ?? null;
      if (!r) { HUD_ACTIONS.tab({ tab: 'hosts' }); return; }
      endPick(); FS.selected = { p: r.p, q: r.q, idx: r.tile }; FS.hand = { host: r.id }; FS.inspectOpen = false;
      // (fix-loop6, LP6-4: 'march' — the guide's next step when no seen keep is in reach: the host's march card)
      setPop(d.pop); invalidate('map', 'panel', 'tabs', 'rail');
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
    const host = String(d.host ?? sub.host.id), before = FS.compose, world = momentWorld();
    const going = ACTIONS['march-home']({ host });
    // (2026-11-17, ⑦, corrected: the draft and its place are taken HERE, before the wait — march-home opens the draft and
    //  gives it the village at once, so what stands now is this request's own: a new draft, marked home, of this host.
    //  A host that is not there any more opens none, and another host's draft standing from before is left as it is.
    //  After the wait the page moves and speaks only if that very draft, with that very place, in that world, still
    //  stands: the same host sent home again, the same place chosen again, a draft put away or another world, and this
    //  request says and changes nothing)
    const c = FS.compose, aim = c?.dest ?? null;
    const own = !!c && c !== before && !!c.home && String(c.host?.id) === host;
    await going;
    if (!own || !draftAims(c, aim, world)) return;
    FS.tab = 'map'; FS.report = null; FS.practice = null; FS.guideOpen = false; FS.explore = null;
    invalidate('map', 'panel', 'tabs', 'rail');
    if (c.routeError) { const h = hud.activeHolding(FS); mapNote({ p: h.p, q: h.q, idx: h.tile }, refusalText(c.routeError)); }
  },
  'hand-unit': d => { FS.hand = { ...(FS.hand ?? {}), unit: num(d.unit), n: undefined, troops: undefined }; invalidate('panel'); },
  'hand-n': d => { FS.hand = { ...(FS.hand ?? {}), n: num(d.n) }; invalidate('panel'); },
  'hand-troops': d => { FS.hand = { ...(FS.hand ?? {}), troops: num(d.n), troopsAll: d.all === '1' }; invalidate('panel'); },
  'hand-info': () => { clearInspection(FS); clearOutbound(FS); endPick(); FS.inspectOpen = true; FS.hand = { ...(FS.hand ?? {}), pop: null }; FS.tab = 'map'; invalidate('map', 'panel', 'tabs', 'rail'); },
  'hand-close': () => { clearInspection(FS); clearOutbound(FS); endPick(); FS.selected = null; FS.hand = null; FS.inspectOpen = false; FS.actor = null; FS.mapNote = null; FS.explore = null; invalidate('map', 'panel', 'tabs', 'rail'); $('frontier-map')?.focus?.({ preventScroll: true }); },
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
    // (2026-11-17, ⑦: the draft the entry returned, or nothing — a host that is not there any more opens none, and the
    //  selection and the camera are not moved to another host's draft that stood from before)
    const c = ACTIONS.compose(d);
    if (!c || FS.compose !== c) return;
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
    clearWideSelect(FS);
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
    clearWideSelect(FS);
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
    // (the field the keyboard was in is put away: the keyboard goes to the map, where the place found now is — it was
    // left on nothing. A card or an order opened below may still take it.)
    $('frontier-map')?.focus?.({ preventScroll: true });
    // a host that can march has the hand: what was searched for is where it may go (the camera goes there, the host stays in hand)
    const sub = FS.mode === 'play' && !FS.compose ? hand.subjectOf(FS) : null;
    if (sub?.kind === 'host' && FS.hand?.pop !== OUTBOUND_POP && FS.hand?.pop !== EXPEDITION_POP && hand.marchCheck(FS, sub.host).ok) {
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
  // the away summary's "seen": the player's own mark moves to the last record it told (closing it with × does not)
  // the away summary's way in on a phone (renderAwayEntry): the list under その他, at the summary, its "seen" in focus
  'away-open': () => {
    if (FS.mode !== 'play') return;
    FS.feedFilter = 'all';
    if (drawerOf(FS)?.kind !== 'more') HUD_ACTIONS.tab({ tab: 'more' });
    else invalidate('panel');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const row = globalThis.document?.querySelector('.panel .feed-away, .panel li.feed-away');
      row?.scrollIntoView?.({ block: 'center' });
      (row?.querySelector('[data-act="away-seen"]') ?? row)?.focus?.({ preventScroll: true });
    }));
  },
  'away-seen': d => {
    const x = (FS.feed ?? []).find(y => y.id === d.id);
    // (only a summary of this scope whose reading has no gap moves the mark: returnsum.confirm; twice is harmless)
    // (and only under the world it was read in: the scope names it, and the save uses the world kept with the summary)
    if (!x?.away?.summary?.confirm?.ok || x.scope !== awayScopeNow() || !x.away.world || x.away.world !== awayWorld()) return;
    const { season, wallet } = awayWho();
    const saved = returnSum.confirm(awayStore(), { seasonId: season, wallet, confirm: x.away.summary.confirm, at: FS.chain?.now?.() ?? 0, world: x.away.world });
    if (!saved) {
      // (storage refused: the notice stays, says so, and the next look starts from the same place)
      FS.feed = FS.feed.map(y => (y.id === x.id ? { ...y, text: awayHeadText(y.away.summary, null), away: { ...y.away, saved: null } } : y));
      renderFeed();
      return;
    }
    awayConfirmed.add(x.id);
    // (the mark moved. When only the device's "last used" could not be saved, the summary's head stays — no second "seen":
    // the mark is saved — and says so in confirmedText's words; the items go as usual. 2026-11-17)
    const keepHead = saved.lastSaved === false;
    FS.feedDismissed = new Set([...(FS.feedDismissed ?? []), ...(FS.feed ?? []).filter(y => y.scope === x.scope && (y.kind === 'away' || String(y.id).startsWith('aw:')) && !(keepHead && y.id === x.id)).map(y => y.id)]);
    if (keepHead) FS.feed = FS.feed.map(y => (y.id === x.id ? { ...y, text: awayHeadText(y.away.summary, saved), away: { ...y.away, ok: false, saved } } : y));
    renderFeed();
  },
  'feed-filter': d => { FS.feedFilter = feed.FEED_FILTERS.includes(d.f) ? d.f : 'all'; invalidate('panel'); },
  // the status at the map: put a refusal away, or send the refused action once more
  'notice-close': () => { FS.notice = null; renderFeed(); invalidate('panel'); },
  'notice-retry': () => { const r = retryLast(); renderFeed(); return r; },
  autopan: () => { const sc = scope(); const v = !FS.ui?.autoPan; FS.ui = sc ? saveUiOver(sc, { autoPan: v }) : { ...(FS.ui ?? {}), autoPan: v }; invalidate('panel'); },
  'battle-play': d => { playAsked(num(d.p), num(d.q), num(d.bell)); },
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
  'guide-level': d => { if (!guide.GUIDE_LEVELS.includes(d.v)) return; const sc = scope(); FS.ui = sc ? saveUiOver(sc, { guide: d.v }) : { ...(FS.ui ?? {}), guide: d.v }; guideCache.at = 0; invalidate('panel', 'map', 'rail'); renderHudTick(FS.chain?.now?.() ?? 0); },
  'mile-close': () => closeMilestone(),
  'sel-clear': () => { FS.selected = null; invalidate('map', 'panel'); },
  // (2026-11-17, ⑦ the wide map: the inspector's "read again" — the province's record now, and the ring overviews still
  //  wanted; reads only. The selection and the camera stay where the person put them)
  // (2026-11-17, ⑦ the march card: the forecast that could not be made is asked again, from the same draft — only one
  //  that was not read; 見えていない土地 and the rules' own refusals are answers and are not asked around)
  // (2026-11-17, ⑦: the replay's notice put away by the person. While the clash is still being read that is a "no": the
  //  press is not the last one any more, so its scene is not staged and the camera does not go there — playAsked `asked`)
  // (2026-11-17, ⑦ the march tracker: one march's records read again — a pure read, controller.rereadMarchFacts: no
  //  reveal, no settle, no book)
  'march-reread': d => { if (FS.mode === 'play' && d.host) rereadMarchFacts(d.host).catch(() => {}); },
  // (2026-11-17, ⑦ from the map to the trade card: the place chosen on the map is handed to the caravan or fort form —
  //  controller.planS1Place, which reads and sends nothing — and the village screen opens on that card; the form's
  //  amounts are the person's own)
  's1-plan': d => {
    const id = planS1Place(d);
    if (!id) return;
    // (corrected 2026-11-17: the village screen may be showing a wide village's cards — the trade card is the legacy
    //  village's: back to it, the way 'wide-close' goes — and the form may already stand on the screen with a choice of
    //  the person's in it, which a redraw keeps over the markup's first choice: landS1Plan puts the place in once)
    clearWideSelect(FS);
    leaveReport(); FS.tab = 'holding'; invalidate('panel', 'tabs', 'rail');
    requestAnimationFrame(() => landS1Plan(id));
  },
  's1-plan-clear': () => clearS1Plan(),
  // (2026-11-17, ⑦ the keep and the march toward it. Both only open something that exists, after keepStill.)
  // from the keep's card to the tracker's row of the viewer's own march bound for it: the march must still be in the
  // list read for this world, for that host, with that keep's province as its destination; the row comes into view one
  // frame later, only while this is still the last such press and the marches screen is still open
  'keep-track': d => {
    const k = keepStill(d), req = ++keepAsk, host = String(d.host ?? '');
    if (!k || !/^\d+$/.test(host) || !keepMarch(d, k, host)) { invalidate('panel'); return; }
    leaveReport(); FS.practice = null; FS.guideOpen = false;
    ACTIONS.tab({ tab: 'marches' });
    invalidate('rail');
    requestAnimationFrame(() => {
      const again = keepStill(d);
      if (req !== keepAsk || !again || FS.tab !== 'marches' || !keepMarch(d, again, host)) return;
      globalThis.document?.querySelector?.(`[data-march-host="${host}"]`)?.scrollIntoView?.({ block: 'start', behavior: calm() ? 'auto' : 'smooth' });
    });
  },
  // from a march's row back to the keep it is bound for: the keep's tile on the map (its card stands there)
  'march-keep': d => { const k = keepStill(d), host = String(d.host ?? ''); ++keepAsk; if (!k || !keepMarch(d, k, host)) { invalidate('panel'); return; } leaveReport(); closeResPop(); goToItem({ p: k.p, q: k.q, tile: k.tile, tab: 'map' }); },
  // (2026-11-17, ⑦ the hosts screen, from a village to its hosts, their plans and marches, and back. Each of these only
  //  OPENS something that exists, after hostStill; none sends, settles or collects.)
  // another of the viewer's villages: found by place, site and generation at the press, taken in hand the way
  // 'holding-pick' does; the hosts screen stays open and shows that village's hosts
  'hosts-village': d => {
    ++hostAsk;
    if (FS.mode !== 'play' || !Number.isInteger(FS.contextSeq) || String(FS.contextSeq) !== String(d.ctx ?? '')) { invalidate('panel'); return; }
    const p = num(d.p), q = num(d.q), site = num(d.site), gen = num(d.gen);
    const i = (FS.holdings ?? []).findIndex(o => o.p === p && o.q === q && o.site === site && (o.gen ?? 0) === gen);
    if (i < 0) { invalidate('panel'); return; }
    clearWideSelect(FS);
    FS.activeHolding = i; FS.explore = null;
    invalidate('panel', 'tabs', 'rail', 'map');
  },
  // a host on the march: the marches screen opens, and its own row of the tracker comes into view — one frame later, and
  // only while this is still the last such press, the press still belongs and the marches screen is still open
  'host-track': d => {
    const at = hostStill(d), req = ++hostAsk;
    if (!at) { invalidate('panel'); return; }
    leaveReport(); FS.practice = null; FS.guideOpen = false;
    ACTIONS.tab({ tab: 'marches' });
    invalidate('rail');
    requestAnimationFrame(() => {
      if (req !== hostAsk || !hostStill(d) || FS.tab !== 'marches' || !/^\d+$/.test(String(d.host ?? ''))) return;
      globalThis.document?.querySelector?.(`[data-march-host="${d.host}"]`)?.scrollIntoView?.({ block: 'start', behavior: calm() ? 'auto' : 'smooth' });
    });
  },
  // a host standing away from its village: the EXISTING plan of a march home (controller 'march-home' opens the draft
  // from the host's own village and gives it the village as its place); the marches screen, where the plan stands, opens
  'host-return': d => {
    const at = hostStill(d); ++hostAsk;
    if (!at || at.row.inTransit || at.row.state !== 1 || (at.row.p === at.h.p && at.row.q === at.h.q && at.row.tile === at.h.tile)) { invalidate('panel'); return; }
    // (a plan being sent, or armed to be sent once, is the send's own: it is not replaced from here)
    if (FS.compose && (FS.compose.sending || FS.compose.pending)) { invalidate('panel'); return; }
    const host = String(d.host);
    ACTIONS['march-home']({ host });
    if (!FS.compose || String(FS.compose.host?.id) !== host || FS.compose.home !== true) { invalidate('panel'); return; }
    leaveReport(); FS.practice = null; FS.guideOpen = false;
    ACTIONS.tab({ tab: 'marches' });
    invalidate('rail', 'map');
  },
  // where a host stands: it is selected on the map, as the hand's own choice of a host does
  'host-show': d => { const at = hostStill(d); ++hostAsk; if (!at) { invalidate('panel'); return; } const row = hand.ownHosts(FS).find(r => r.id === String(d.host)); if (row) selectHost(row, { fly: true }); },
  // (2026-11-17, ⑦ the warning's way on: the village a warning names is taken in hand BY WHAT IT IS — place, site and
  //  generation, looked up at the press; never by an index kept in the markup — and the village screen opens, the way
  //  'holding-pick' goes; `to: garrison` brings its garrison form into view. Nothing is sent.
  //  Corrected: every press of the card first asks incomingStill — a button drawn for another pinned world, another
  //  viewer, an earlier context or a warning that no longer stands does NOTHING, also when a village of the same place
  //  and generation exists where the page is now. The later step (the jump to the garrison form) runs only while it is
  //  still the last such request and the same village and screen are still the ones in hand.)
  'incoming-village': d => {
    const at = incomingStill(d), req = ++incomingAsk;
    if (!at) { invalidate('panel'); return; }
    clearWideSelect(FS);
    FS.activeHolding = at.i;
    goToItem({ p: at.h.p, q: at.h.q, tab: 'holding' });
    if (d.to !== 'garrison') return;
    requestAnimationFrame(() => {
      if (req !== incomingAsk || !incomingStill(d) || FS.tab !== 'holding' || FS.activeHolding !== at.i || FS.holdings?.[at.i] !== at.h) return;
      HUD_ACTIONS['hp-jump']({ id: 'hp-garrison' });
    });
  },
  // (the same press rule for the card's two other ways on: the map — goToItem, as `goto` does — and the EXISTING plan of
  //  a march home — controller 'march-home', for a host the card lists as standing away from that very village)
  'incoming-goto': d => { const at = incomingStill(d); ++incomingAsk; if (!at) { invalidate('panel'); return; } leaveReport(); closeResPop(); goToItem({ p: at.h.p, q: at.h.q, tab: 'map' }); },
  'incoming-return': d => {
    const at = incomingStill(d); ++incomingAsk;
    if (!at || !incomingScreen.defendersOf(FS, at.w)?.away.some(r => r.id === String(d.host ?? ''))) { invalidate('panel'); return; }
    ACTIONS['march-home']({ host: String(d.host) });
  },
  // (2026-11-17, ⑦ exploration: another of the viewer's villages has an exploration waiting — that village is taken in
  //  hand the way 'holding-pick' does, the hosts screen with its explore card opens, and its result is asked for once:
  //  controller 'explore-check', a read; nothing is settled or sent)
  'explore-village': d => {
    const i = num(d.i), h = FS.holdings?.[i];
    if (!h || FS.mode !== 'play') return;
    clearWideSelect(FS);
    FS.activeHolding = i; FS.explore = null; leaveReport(); FS.tab = 'hosts';
    invalidate('panel', 'tabs', 'rail', 'map');
    ACTIONS['explore-check']?.();
  },
  'replay-dismiss': () => { if (FS.replayAsk?.state === 'loading') playAskSeq += 1; FS.replayAsk = null; renderFeed(); },
  'forecast-retry': () => { const c = FS.compose; if (!c || c.sending || !c.forecast?.unread) return; updateForecast({ again: true }); invalidate('panel'); },
  'province-reread': d => { const p = num(d.p), q = num(d.q); if (!Number.isInteger(p) || !Number.isInteger(q) || FS.mode === 'practice') return; if (heraldRef && FS.world) { forgetOverviewRefusals(FS); loadOverviews(heraldRef).then(() => invalidate('map', 'panel'), () => {}); } retryProvince(p, q, () => { mapRef?.invalidate(); invalidate('panel'); }); invalidate('panel'); },
  dial: () => { FS.dialOpen = !FS.dialOpen; closeTermPop(); renderDialPop(); if (FS.dialOpen) $('dial-pop')?.querySelector('button')?.focus?.({ preventScroll: true }); },
  'dial-close': () => closeDialPop({ focus: true }),
  // the plate's one key while the viewer's record cannot be read (hud/hud.mjs renderPlate): the page again, from the start
  reload: () => globalThis.location?.reload?.(),
  term: d => {
    // (the key the keyboard is on when the popover opens: where it goes back to — closeTermPop)
    const a = globalThis.document?.activeElement, opener = a?.matches?.('[data-act="term"]') && a.dataset.term === d.term ? a : null;
    FS.term = FS.term === d.term || !glossary.TERMS[d.term] ? null : d.term; renderTermPop();
    termFrom = FS.term && opener ? { term: d.term, nth: Math.max(0, [...globalThis.document.querySelectorAll(`[data-act="term"][data-term="${String(d.term).replace(/[^\w-]/g, '')}"]`)].indexOf(opener)) } : null;
    $('term-pop')?.querySelector('button')?.focus?.();
  },
  'term-close': () => closeTermPop({ focus: true }),
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
  'fx-level': d => { if (!['full', 'reduced', 'off'].includes(d.v)) return; const sc = scope(); FS.ui = sc ? saveUiOver(sc, { effects: d.v }) : { ...(FS.ui ?? {}), effects: d.v }; invalidate('panel', 'map'); },
  'fx-sound': d => { fxAudio().setMuted(d.v !== 'on'); renderSound(); invalidate('panel'); },
  'battle-fx': d => { if (!['normal', 'fast', 'off'].includes(d.v)) return; const sc = scope(); FS.ui = sc ? saveUiOver(sc, { battleFx: d.v }) : { ...(FS.ui ?? {}), battleFx: d.v }; invalidate('panel'); },
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
    clearWideSelect(FS);
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
/** Local play, launcher worlds: the watch that asks the launcher about this world after a failed herald read (flocalplay-ended.mjs). */
let worldWatch = null;
/** Whether this page's launcher keeps its worlds (flocalplay.mjs `localPersistPage`): its stopped world is paused, not ended. */
let worldKept = false;
/**
 * This page's world was confirmed ended (B5): the clock stands at the herald's last sample from now on (ChainClock.halt:
 * what the local clock added after it never happened), the turn the panels use is that sample's, the season poll's own
 * "could not connect" gives way to the banner that says the world ended, and everything is drawn again. Never undone.
 */
export function worldEnded() {
  // (a KEPT world — the launcher keeps its worlds — is paused, not ended: its progress is on disk and a start resumes it)
  FS.worldEnded = { at: Date.now(), ...(worldKept ? { paused: true } : {}) };
  FS.chain?.halt?.();
  if (FS.error?.source === 'season') FS.error = null;
  // B21: the "About this test world" box says so too (an earlier "services running" answer is dropped)
  FS.launcherLost = null;
  try { sessionNoticeOf(globalThis.document)?.worldState('ended'); } catch { /* the box's own failure does not undo the end */ }
  const m = FS.clock ? hud.bellModel(FS.clock, FS.chain?.now() ?? null) : null;
  if (m && Number.isInteger(m.bell)) FS.nowBell = m.bell;
  invalidate('chip', 'status', 'map', 'panel', 'tabs', 'rail');
}
/** B21, local play, launcher worlds: the watch for a launcher that stopped answering (flocalplay-ended.mjs createLauncherWatch). */
let launcherWatch = null;
/** B21: the launcher cannot be reached (`lost`), or answers again: the banner's plain line and the test-world box follow. */
export function launcherLost(lost) {
  if (FS.worldEnded || !!FS.launcherLost === !!lost) return;
  FS.launcherLost = lost ? { at: Date.now() } : null;
  try { sessionNoticeOf(globalThis.document)?.worldState(lost ? 'lost' : 'live'); } catch { /* the box's own failure */ }
  invalidate('chip', 'status');
}
const num = x => Number.parseInt(x, 10);

/** Save the onboarding flags (ps-fui `dismissed`) of the pinned season; in memory only before a season is pinned. */
function setFlags(next) {
  const sc = scope();
  FS.ui = sc ? saveUiOver(sc, { dismissed: next }) : { ...(FS.ui ?? loadUi(uiStorage, '')), dismissed: next };
  invalidate('panel');
}
const setFlag = (flag, add = true) => setFlags(withFlag(FS.ui?.dismissed ?? [], flag, add));

/** The page's kernel, with the season's ruleset required (practice and verify refuse another). */
async function seasonKernel() {
  // (TEST-ONLY coexist lane: its Season's kernel is the S1 one under flocalplay-lane.mjs's one alias; every other hash: itself)
  const k = await loadKernel(FS.season ? { ruleset: kernelRulesetFor(FS.season.rulesetHash), url: new URL(`./wasm/${kernelFile(FS.season)}`, import.meta.url) } : undefined);
  if (FS.season && k.rulesetHash() !== kernelRulesetFor(FS.season.rulesetHash)) { const e = new Error('ruleset'); e.code = 'RulesetMismatch'; throw e; }
  return k;
}

/** Open the report of (P, Q, bell): the herald's /h/clash file, the ClashInputs decoded by this page. */
/**
 * The pinned world a report is read for: cluster, program and season account as fchainio.setPin pinned them
 * (`addresses.season`, derived and checked against the herald's record); null before a pin (nothing is made up).
 */
// (with the pin's generation: a report read under the first A is not shown under the A pinned again after B)
const reportWorld = () => (FS.pin?.programId && FS.pin?.addresses?.season ? `${FS.pin.gen ?? 0}|${FS.pin.cluster ?? ''}|${FS.pin.programId}|${FS.pin.addresses.season}` : null);
/** The keep tile of (p, q) as the overviews carry it (null: none, or the province not in an overview read). */
const keepTileOf = (p, q) => { for (const o of FS.overviews?.values?.() ?? []) { const r = o.provinces?.find(x => x.p === p && x.q === q); if (r) return r.keepTile ?? null; } return null; };
/**
 * (fix-loop5, L5-6) Whether the clash of (p, q) at `bell` may be read, offered or played under the fog of a local test
 * world (map/fog.mjs clashSeen): the viewer's own, or its place in sight now. Without fog: always.
 */
export const clashHere = (p, q, bell) => viewClash({ p, q, keepTile: keepTileOf(p, q),
  mine: inspect.ownClashPlace(FS, p, q, bell) || myReports(FS).some(r => r.p === p && r.q === q && r.bell === bell) });
export async function openReport(p, q, bell) {
  if (!heraldRef || ![p, q, bell].every(Number.isInteger)) return;
  // (fix-loop5, L5-6: another nation's clash out of sight now is not read — not even asked of the herald)
  if (!clashHere(p, q, bell)) { FS.report = { p, q, bell, world: reportWorld(), hidden: true }; FS.practice = null; invalidate('panel'); return; }
  // (2026-11-17: the herald may start serving another season or world while a report is read — loadSeason re-pins every
  // poll. A report read under one world is never shown, or added to, under another: it is dropped, not told as read)
  const world = reportWorld();
  const rep = { p, q, bell, loading: true, world };
  FS.report = rep; FS.practice = null;
  invalidate('panel');
  const r = await heraldRef.clash(p, q, bell);
  if (FS.report !== rep) return;
  if (reportWorld() !== world) { FS.report = null; invalidate('panel'); return; }
  FS.report = r.ok ? { p, q, bell, world, clash: r } : { p, q, bell, world, error: r.code ?? 'Error' };
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
    if (k?.ok && FS.report === open && reportWorld() === world) { open.keep = k.keep; invalidate('panel'); }
  }
  // (fix-loop14, LP14-4: a record that does not say what was left of a side is checked at once — the same check as the
  //  button's, in this browser —, so the report is not read as 「316 → —」; see screens/report.mjs outcomeUnknown)
  if (r.ok && FS.report === open && reportWorld() === world && reportScreen.outcomeUnknown(open, mineOf(FS.holdings))) verifyReport();
}

async function verifyReport() {
  const rep = FS.report;
  if (!rep?.clash || rep.verifying || !FS.clock) return;
  rep.verifying = true;
  invalidate('panel');
  const v = await reportScreen.verifyClash({ p: rep.p, q: rep.q, bell: rep.bell, clash: rep.clash, herald: heraldRef, kernel: seasonKernel, clock: FS.clock, season: FS.season,
    kernelRuleset: FS.season?.rulesetHash ? kernelRulesetFor(FS.season.rulesetHash) : null });
  rep.verifying = false;
  if (FS.report === rep) { rep.verify = v; invalidate('panel'); }
  // (pt-first-battle: the first 「一致」 this browser saw is kept, so the "While you wait" panel stops offering a battle to check)
  if (v?.result === 'match' && FS.mode === 'play' && !(FS.ui?.dismissed ?? []).includes(FLAG.verified)) { setFlag(FLAG.verified); invalidate('rail'); }
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

/** (pt-first-battle) Recompute the practice result in this browser (screens/practice.mjs recheckPractice): practice only. */
async function recheckPractice() {
  const st = FS.practice;
  if (!st?.result?.ok) return;
  let k;
  try { k = await seasonKernel(); FS.practiceError = null; } catch (e) { FS.practiceError = e?.code ?? 'NoWasm'; invalidate('panel'); return; }
  if (FS.practice !== st) return;
  st.recheck = practiceScreen.recheckPractice(k, st.result);
  if (st.recheck.result === 'match' && FS.pin && FS.mode === 'play') { setFlag(FLAG.practiceMatch); invalidate('rail'); } else invalidate('panel');
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
  // (pt-first-battle, Q-PT-3: no real battle may be opened yet) the practice battle, labelled so, and its recompute
  'practice-first': () => { const st = practiceScreen.practiceState({ faction: FS.citizen?.faction, scenario: 'camp' }); st.firstBattle = true; FS.report = null; FS.practice = st; invalidate('panel'); },
  'practice-recheck': () => recheckPractice(),
  // (the fold redraws the rail — or the phone's sheet —: the key keeps the focus, refocused once the new markup stands)
  'wait-toggle': () => { const sc = scope(); const v = waitPanel.waitOpen(FS) ? 'closed' : 'open'; FS.ui = sc ? saveUiOver(sc, { waitPanel: v }) : { ...(FS.ui ?? {}), waitPanel: v }; waitRefocus = true; invalidate('rail', 'panel'); },
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
export const SENDS = Object.freeze(new Set(['wide-claim', 'territory-tile', 'harvest', 'build', 'train', 'muster', 'garrison', 'dissolve', 'join', 'session', 'session-replace', 'auto-ticket', 'nudge', 'explore-send', 'settle-explore', 'settle-transit', 'march-send',
  // S1 (screens/s1.mjs)
  's1-vault', 's1-structure', 's1-raid', 's1-raid-open', 's1-vote', 's1-seize', 's1-siege', 's1-expel', 's1-readmit',
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
const chosenNation = () => (drawerOf(FS)?.kind === 'nation' && Number.isInteger(FS.joinDraft?.faction) ? FS.joinDraft.faction : null);
function nationFocus(faction, picked = chosenNation()) {
  const f = Number.isInteger(faction) && faction >= 0 && faction < 6 ? faction : null;
  // the confirm line says the looked-at nation's leader and creed (screens/join.mjs renders all six; the stylesheet shows one)
  // (fix-loop14, LP14-11: once a nation is CHOSEN the line stays that nation's — the pointer resting on another banner
  //  put "Cinder — Doctrine: Flame…" beside the button 「Join Aster」. Before a choice the looked-at banner's line is
  //  shown as before; the map's lit wedge still follows the pointer either way. `picked`: the choice a click just made)
  const look = Number.isInteger(picked) ? picked : f;
  const panel = $('panel'); if (panel?.dataset) panel.dataset.look = look === null ? '' : String(look);
  if (f === nationShown) return;
  nationShown = f;
  try { globalThis.dispatchEvent?.(new CustomEvent('wylls:nation-focus', { detail: { faction: f } })); } catch { /* no events here (tests) */ }
}
function mountNationFocus(doc) {
  const chosen = () => (drawerOf(FS)?.kind === 'nation' && Number.isInteger(FS.joinDraft?.faction) ? FS.joinDraft.faction : null);
  const at = e => { const el = e.target?.closest?.('[data-nation]'); return el ? Number(el.dataset.nation) : null; };
  doc.addEventListener('pointerover', e => { if (e.target?.closest?.('.nations')) nationFocus(at(e) ?? chosen()); else if (nationShown !== null && nationShown !== undefined) nationFocus(chosen()); });
  doc.addEventListener('focusin', e => { const f = at(e); if (f !== null) nationFocus(f); });
  doc.addEventListener('focusout', e => { if (at(e) !== null && !e.relatedTarget?.closest?.('[data-nation]')) nationFocus(chosen()); });
  doc.addEventListener('click', e => { const f = at(e); if (f !== null) nationFocus(f, e.target?.closest?.('[data-act="pick-faction"]:not([disabled])') ? f : undefined); });
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
    if (e.key === 'Escape' && FS.term) { e.preventDefault(); closeTermPop({ focus: true }); return; }
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
  // (fix-loop12, LP12-5) presses that only look — a tab of the drawer, closing it — and keep the boundary card's draft
  const OUTBOUND_LOOKS = Object.freeze(['tab', 'drawer-close']);
  doc.addEventListener('click', e => {
    const el = e.target.closest?.('[data-act]');
    const fn = el && !el.disabled ? action(el.dataset.act) : undefined;
    if (!fn) return;
    if (el.tagName !== 'INPUT') e.preventDefault();
    // a control that cannot be pressed now stays reachable and says why (`aria-disabled`): it does nothing else
    if (el.getAttribute('aria-disabled') === 'true') { refuseInPlace(el); return; }
    // (the return card's local-play controls act on the card's own observation: pressing them keeps it)
    if (FS.hand?.pop === EXPEDITION_POP && !LOCAL_CONQUEST_ACTS.includes(el.dataset.act) && !LOCAL_RETURN_ACTS.includes(el.dataset.act) && !['expedition-inspect', 'expedition-prepare'].includes(el.dataset.act)) clearInspection(FS);
    // (the seal's strip stands on the boundary card too: pressing it keeps the draft, like the card's own controls)
    // (fix-loop12, LP12-5: so does a look at a list — a tab of the drawer, or closing it. loop-play12: the refusal notice
    //  said to press 「出発条件を確認」 on the card; the player first opened 進軍 to see that nothing had left, and that press
    //  emptied the card's road (0/32) and greyed every control, so the card had to be closed, reopened and the road
    //  entered again. Viewing changes nothing the draft stands on; every read and the send still check its source.)
    if (FS.hand?.pop === OUTBOUND_POP && !LOCAL_REVEAL_ACTS.includes(el.dataset.act) && !['outbound-step', 'outbound-undo', 'outbound-reset', 'outbound-route-read', 'outbound-context-read', 'outbound-devnet-preview', 'outbound-devnet-send', 'outbound-devnet-reconcile', 'outbound-devnet-clear', 'outbound-arrival-earliest', 'outbound-local-depart', 'outbound-local-reconcile'].includes(el.dataset.act) && !OUTBOUND_LOOKS.includes(el.dataset.act)) clearOutbound(FS);
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
    const inspection = e.target.closest?.('[data-bind^="expedition-"]');
    if (inspection && play) { bind(inspection.dataset.bind, inspection.value); return; }
    const outbound = e.target.closest?.('[data-bind^="outbound-"]');
    if (outbound && play) { bind(outbound.dataset.bind, outbound.value); return; }
    const muster = e.target.closest?.('form[data-form="muster"]');
    if (muster) {
      const u = muster.querySelector('input[name="unit"]:checked');
      if (holdingScreen.keepMusterDraft(FS, hud.activeHolding(FS), { unit: u ? Number(u.value) : null, troops: muster.elements.troops?.value })) invalidate('panel');
      return;
    }
    const form = e.target.closest?.('form[data-form="train"]');
    if (!form) return;
    FS.trainingDraft = { unit: Number(form.elements.unit.value), n: Number(form.elements.n.value) };
    invalidate('panel');
  });
  doc.addEventListener('change', e => {
    // (fix-loop6, LP6-13: the caravan's amounts are bounded by the stock of the source now selected)
    const src = e.target.closest?.('form[data-form="s1-caravan"] select[name="src"]');
    if (src) { capCaravanAmounts(src); return; }
    // (verify-pr244: the destination the person chose, by its place — the send refuses if the list no longer holds it there)
    const dst = e.target.closest?.('form[data-form="s1-caravan"] select[name="dst"]');
    if (dst) { if (dst.form?.elements?.picked) dst.form.elements.picked.value = dst.selectedOptions?.[0]?.dataset?.key ?? ''; return; }
    const el = e.target.closest?.('[data-bind]');
    if (!el) return;
    if (w4Bind(el.dataset.bind, el.value)) invalidate('panel');
    else if (play) bind(el.dataset.bind, el.value);
  });
}

/** The spectator's poll: the events and the bell sheet at load, then every 30 s (§4.2), paused while hidden. */
/** A clash newer than the last one seen: the spectator's camera goes there and plays it (unless turned off). */
// (2026-11-17, ⑦: of one pinned world — with its generation, A → B → A are three. The clash compared is from a chronicle
//  read for this world (FS.chronicleWorld, controller refreshChronicle): until this world's chronicle is read nothing is
//  compared, and the first clash seen in a world is its baseline — another world's last clash never makes this one's
//  first "new". A follow whose clash answers after the world changed, the watch was turned off or a report was opened
//  neither plays nor flies, also not to the fallback place.)
let watchSeen = null, watchWorld;
function followBattles() {
  const world = momentWorld();
  if (FS.chronicleWorld !== world) return;
  if (watchWorld !== world) { watchWorld = world; watchSeen = null; }
  const c = reportScreen.clashesFrom(FS.chronicle ?? [], 1)[0];
  if (!c) return;
  const key = `${c.p},${c.q},${c.bell}`;
  if (watchSeen === null) { watchSeen = key; return; }   // the first look is not news
  if (key === watchSeen) return;
  watchSeen = key;
  const f = FS.watch?.faction;
  if (FS.watch?.auto === false || FS.report || (Number.isInteger(f) && !provinceFactions(FS.overviews, c.p, c.q).includes(f))) return;
  // (the request's own origin is kept from the ask to the fallback: the same herald object as well as the same world —
  //  the herald can be replaced within one world — and no camera move the map counts since (map/fmap.mjs `moves`: a
  //  drag, the wheel, a pinch, the map's keys and buttons, a "go there"; the count map.restore's ifStill reads). A
  //  called-off request (null) never falls back; only "no scene" (false) does, while all of it still holds)
  //  (and `map.touchedAt`: a touch of the map since the ask — also one that only stops a flight, which the move count
  //  does not see — calls the follow off as well)
  const source = heraldRef, moves = mapRef?.moves ?? 0, touched = mapRef?.touchedAt ?? null;
  const still = () => momentWorld() === world && heraldRef === source && FS.watch?.auto !== false && !FS.report && (mapRef?.moves ?? 0) === moves && (mapRef?.touchedAt ?? null) === touched;
  playBattle(c.p, c.q, c.bell, { focus: true, still }).then(ok => { if (ok === false && still()) mapRef?.flyTo({ p: c.p, q: c.q, zoom: 0.6 }); });
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

/**
 * The page banner's error from the season poll (2026-11-17, ⑦): a failed read of the season record, a refused pin, a
 * beacon that does not match. It is marked as the season's (`source: 'season'`), so a later read that succeeds clears
 * it — and only it: an error of another operation (local play's changed connection, controller.mjs) is neither
 * replaced by a season failure nor cleared by a season success. A failure or success asked before one already applied
 * reaches neither (loadSeason returns at seasonStale first).
 */
function seasonError(e) { if (!FS.error || FS.error.source === 'season') FS.error = { ...e, source: 'season' }; }
function seasonRecovered() { if (FS.error?.source === 'season') FS.error = null; }

/**
 * (page-not-open-yet) The world is not open yet (`FS.notOpen = {opensAt}`; world-not-open.mjs). When it opens is the
 * operator's file beside the page, read at the first such answer and again every tenth (the poll asks every 30 s, so
 * about every five minutes): a file put there later reaches a page that is already open. No file: "soon". The time
 * last read is kept (`worldOpensAt`): "not open" that comes back after a failed connection names it at once.
 */
let notOpenAsked = 0, worldOpensAt = null;
function noteNotOpen() {
  if (!FS.notOpen) FS.notOpen = { opensAt: worldOpensAt };
  if (notOpenAsked++ % 10 !== 0) return;
  readWorldOpen().then(w => { worldOpensAt = w.opensAt; if (FS.notOpen && FS.notOpen.opensAt !== w.opensAt) { FS.notOpen = { opensAt: w.opensAt }; invalidate('status', 'chip', 'rail', 'panel'); } }, () => {});
}

async function loadSeason(herald) {
  // (2026-11-17, ⑦: refreshOverviews asks the same record on its own, and the answers can cross — controller.askSeason.
  //  An answer, or a failure, asked before one already applied changes nothing: the pin, the record, the season, the
  //  clock and the beacon stay as the later answer set them, and the poll counts no error. Otherwise as before.
  //  The read below is this function's only wait: from the stale check to the end nothing waits, so no other answer
  //  can come between the check and the writes. The answer is recorded as applied (takeSeason) only at the end, once
  //  the pin was accepted and everything was set: a refused pin (PinMismatch, RulesetMismatch), a failure, or a throw
  //  while setting records nothing, and an answer asked earlier may still be applied after it.)
  const seq = askSeason();
  const r = await herald.season();
  if (seasonStale(seq)) return true;
  // B21: a read that worked takes the "launcher cannot be reached" line away
  if (r.ok) launcherWatch?.readOk();
  // (page-not-open-yet) the herald answers, and says the world is not created yet (503 NoSeasonYet): not an error and
  // not the connection — the page says "not open yet" and keeps asking. Only while no world was ever read here (and none
  // ended here): a page that already shows a world keeps the failure's own words below. A season error that stood (a failed connection
  // before this answer) is over.
  if (isNotOpen(r) && !FS.season && !FS.worldEnded) { seasonRecovered(); noteNotOpen(); invalidate('status', 'chip', 'rail', 'panel'); return false; }
  if (FS.notOpen) { FS.notOpen = null; invalidate('status', 'chip', 'rail', 'panel'); }
  // (verify-pr226) "no world yet" from a herald whose world this page already shows (a herald that has just restarted
  // answers so until it has read the chain again): the world IS open, so the red line does not say "not open yet" —
  // it says what it said before this answer had a name (the status). An ended world keeps its own banner (below)
  if (isNotOpen(r) && !FS.worldEnded) { const code = `HTTP${r.httpStatus || 503}`; clearInspection(FS); clearOutbound(FS); seasonError({ code, text: clientText(code) }); invalidate('status'); return false; }
  // (the loop-play report B5, launcher worlds only: a read that failed by the network is the one reason to ask the
  //  launcher whether it still runs this world — flocalplay-ended.mjs; a herald that answers is never doubted. Once the
  //  world is confirmed ended, a read that fails says nothing new: the banner says the world ended, and the season
  //  poll's "could not connect" is not raised beside it)
  if (!r.ok && r.code === 'network') worldWatch?.readFailed();
  if (!r.ok && FS.worldEnded) { clearInspection(FS); clearOutbound(FS); return false; }
  if (!r.ok) { clearInspection(FS); clearOutbound(FS); seasonError({ code: r.code, text: clientText(r.code) }); invalidate('status'); return false; }
  const { record, season } = r;
  const reportWas = reportWorld();
  try {
    FS.pin = setPin({ programId: record.programId, cluster: record.cluster, seasonId: record.season, seasonAddress: record.seasonAddress ?? null, rulesetHash: toHex(season.rulesetHash) });
  } catch (e) {
    clearInspection(FS); clearOutbound(FS);
    seasonError({ code: e.code, text: e.message });
    invalidate('status');
    return false;
  }
  herald.pin(record.season, FS.pin.addresses);
  fogWorldPinned();
  // (2026-11-17, ⑦: the overviews, ring lists, conquest and S1 state read for another pinned world are forgotten before
  //  this world's record is applied — controller.adoptPinnedWorld; the same world forgets nothing)
  adoptPinnedWorld();
  // (2026-11-17, ⑦: the read succeeded and the pin was accepted: the season poll's own error, if one stands, is over —
  //  the beacon below may set its own again. Another operation's error stays)
  seasonRecovered();
  // (a report read under another pinned world is closed: it is not this world's — 2026-11-17)
  if (FS.report && reportWas !== null && reportWorld() !== reportWas) { FS.report = null; if (FS.practice?.whatif) FS.practice = null; invalidate('panel'); }
  FS.beacon = checkBeacon({ drand: record.drand, seasonPkHash: season.quicknetPkHash, cluster: record.cluster, seasonNetwork: season.network });
  if (!FS.beacon.ok) seasonError({ code: FS.beacon.code, text: clientText(FS.beacon.code) });
  FS.season = season;
  // (⑭ R2: a centre-free season draws no Seat camps on ring 1 — map/sprites.mjs)
  setCentreLand(centreIsLand(season));
  reconcileExpedition();
  // the world's extent (map/world.mjs): which rings are open, pending or beyond the season's map; a ring only partly on
  // chain is asked for its list (again with each season record, until it is whole). The record, the world and the
  // ring lists move together (applySeasonRecord), on every poll: a map that grew on chain is on the page by the next
  // poll, no reload
  applySeasonRecord(FS, record, { herald, onRings: () => invalidate('map', 'panel') });
  // a ring opened since the overviews were taken, or one whose Provinces are still being created, wants its overview
  // (boot also streams them progressively through the shared bounded queue)
  if (FS.overviewsBooted) loadOverviews(herald).catch(() => {});
  setS1(season);
  // (fix-loop8, LP8-10: null while a fast clock's pace is not known yet: the page then says no real time rather than a wrong one)
  // (fix-loop16, LP16-10: a capture demo's clock is measured at about ×1 until the player has joined — the join card
  //  said "about 5 days left" in a ×60 world that lasts minutes. The launcher states the world's clock (`clockScale`; a
  //  wide world's `wideLand.scale`): while the measured pace is unknown or under half of it, the stated one is used)
  setTermsPace(() => {
    const stated = Number(FS.localPlay?.clockScale ?? FS.localPlay?.wideLand?.scale ?? 0);
    const r = FS.chain?.accelerated ? (FS.chain.rateKnown === false ? null : FS.chain.rate) : 1;
    return stated > 1 && (r === null || Number(r) < stated / 2) ? stated : r;
  });
  FS.clock = seasonClock(season);
  // Only a localnet Clock runs accelerated (§8.7); every other cluster's rate is 1.
  // (2026-11-17, ⑦: another pinned world's samples are not this world's: its chain time, slot and offset would hold
  //  this one back — observe drops a sample of a lower slot as "an older answer", and now() never goes back — so a
  //  restarted local stack's clock stood still and read "behind" for good. The clock starts again with no sample —
  //  unknown, not fresh — and takes this record's sample just below. The same world keeps its clock.
  //  The clock carries the world its samples are of (FS.chainWorld) and is judged by that, not by adoptPinnedWorld's
  //  answer of this call: that answer is given once, so a throw between the two in the call that re-pinned would have
  //  left the former world's clock standing through every later good read)
  const clockWorld = momentWorld();
  if (FS.chainWorld !== undefined && FS.chainWorld !== clockWorld) FS.chain = new ChainClock();
  FS.chainWorld = clockWorld;
  FS.chain.setAccelerated(record.cluster === 'localnet');
  FS.chain.observe(record.latestUnix, record.latestSlot);
  // A sample world (the screenshot fixture's world that keeps going, UX design 14.5) says so in its season record and
  // declares its clock's rate: the dial is right from the first sample, and the page says 見本の世界 for as long as it
  // is open. Only a localnet record is believed (`declare` refuses on any other cluster).
  FS.chain.declare(record.sample?.rate);
  setClockPace(() => (FS.chain?.accelerated ? FS.chain.rate : 1));
  // (fix-loop22, LP22-3: a due time is said on the viewer's wall clock — screens/shell.mjs wallOf — from the chain's "now")
  setChainNow(() => FS.chain?.now?.());
  FS.sample = record.cluster === 'localnet' && record.sample?.world === 'sample' ? record.sample : null;
  // (the prototype rule "banners" is on exactly while that record carries it: the chip stands from this moment)
  syncProto();
  invalidate('chip', 'status', 'map');
  // (applied in full: no answer asked before this one is applied after it)
  takeSeason(seq);
  return true;
}

/**
 * The overviews of the rings that want one (map/world.mjs overviewRings): every open ring the page has none of, and
 * every ring whose Province count changed since its overview was taken. Before map growth this ran once at boot over
 * the rings open then, so a ring opened later had land (its seed was in the record) but no records on it until the
 * page was reloaded; now the season poll calls it after each record.
 */
/**
 * What the wide map says of reads that did not come (2026-11-17, ⑦): `[{p, q, state, text}]` for the map's own pass
 * (map/fmap.mjs topPass). Land whose record is not there is not empty land, and the map says so where it is:
 *  - a province whose record the map or the person asked for and that was not read (`failed`), or that waits for a free
 *    read place (`waiting`) — controller's FS.provinceReads, this world's only, and only while no record is held;
 *  - a ring whose overview was asked for and did not come (`ring`) — FS.overviewMisses, kept by loadOverviews for the
 *    world it asked in: without it the ring's villages are not known, which is not "no villages".
 *    Said only while the person looks at that ring, and never for a ring the herald refused (map/overviews.mjs
 *    ringMissMarks).
 * Nothing is marked that was not asked: no province out of the viewer's sight is asked by the map, and a read still
 * under way is not marked (every province would flicker as the map moves). Selecting the province opens its card,
 * whose button reads again (hud/inspect.mjs readState → province-reread). Marks only: nothing of the land is drawn.
 */
function readMarksNow() {
  const out = [];
  for (const [key, st] of FS.provinceReads ?? []) {
    if ((st.state !== 'failed' && st.state !== 'waiting') || FS.provinces.has(key)) continue;
    const [p, q] = key.split(',').map(Number);
    if (!Number.isInteger(p) || !Number.isInteger(q)) continue;
    out.push({ p, q, state: st.state, text: st.state === 'failed' ? L`読めていません（選ぶと読み直せます）` : L`読み込みの順番待ち` });
  }
  // (fix-stale-tooltip, 2026-11-19: a ring miss is said only on the ring the person is looking at — the selected
  //  province, or the province at the view's centre once the map is zoomed in past the World chart — and never for a
  //  ring the herald refused (NoSuchRing) or one outside the open land: map/overviews.mjs ringMissMarks. Before, every
  //  miss stood on its ring's first province for ever, refused rings 0 and 1 included)
  for (const m of ringMissMarks(FS, { key: momentWorld(), looking: lookingAt() }))
    out.push({ p: m.p, q: m.q, state: 'ring', ring: m.ring, text: L`この輪の村の一覧を読めていません（州を選ぶと読み直せます）` });
  return out;
}
/** The places the person is looking at, for the ring marks: the selected province; the view's centre when zoomed in. */
function lookingAt() {
  const out = [];
  if (Number.isInteger(FS.selected?.p) && Number.isInteger(FS.selected?.q)) out.push({ p: FS.selected.p, q: FS.selected.q });
  const view = mapRef?.view;
  if (view && mapRef?.lod && mapRef.lod !== 'world') { const h = hexAtPixel(view.x, view.y), c = locate(h.q, h.r); if (c) out.push({ p: c.p, q: c.q }); }
  return out;
}
function loadOverviews(herald, rings = overviewRings(FS.world, FS.overviewTaken)) {
  // (2026-11-17, ⑦: the pinned world with its generation — the same as controller.providerWorld — so the shared queue
  //  stores no overview read for another world)
  const world = momentWorld(), asked = [...new Set(rings)];
  const read = readOverviews(FS, { herald, rings, v2: conquestEnabled(FS.season), source: momentWorld,
    focus: () => {
      const view = mapRef?.view;
      if (!view) return null;
      const h = hexAtPixel(view.x, view.y);
      return locate(h.q, h.r);
    },
    onChange: () => invalidate('map', 'panel'),
  });
  // (which of the rings asked for still have no overview once this read is over — for the map's marks, readMarksNow.
  //  Kept for the world it was asked in; a ring whose overview is held is no miss, whenever it came. The answer of the
  //  read itself is passed on unchanged)
  const note = () => {
    if (momentWorld() !== world || !FS.world) return;
    const rings0 = FS.overviewMisses?.world === world ? FS.overviewMisses.rings : new Map();
    const seeded = seededRings(FS.world);
    for (const d of asked) { if (seeded.includes(d) && !FS.overviews.has(d)) { if (!rings0.has(d)) rings0.set(d, ringProvinces(d)[0] ?? null); } else rings0.delete(d); }
    for (const d of [...rings0.keys()]) if (FS.overviews.has(d) || !seeded.includes(d)) rings0.delete(d);
    FS.overviewMisses = { world, rings: rings0 };
    invalidate('map');
  };
  read.then(note, note);
  return read;
}

/** Start the page. */
export async function boot() {
  let cfg = config();
  // Local play (flocalplay.mjs), only for `?localPlay=1` on a loopback page: before anything of the game boots, the
  // page makes its memory-only test wallet, shows the public address and waits for a verified Connect to the
  // operator's herald. The page then boots ONCE, below, against that herald, with the dev wallet off. Any other page
  // takes none of this path.
  if (localPlayRequested(cfg)) cfg = (await openLocalPlayGate({ cfg, makeHerald: base => createHerald({ base }) }).ready).cfg;
  FS.mode = cfg.mode;
  // (the local test world's fog of war, map/fog.mjs: never-seen land is plain paper — set before anything is painted)
  if (LOCAL_FOG && cfg.localPlay && FS.mode === 'play') setBlankChart(FOG_RULES.blankChart);
  // (a devnet page: the same, once its pinned season says devnet — fogWorldPinned, map/fog.mjs DEVNET_FOG)
  // (the loop-play report B5: a launcher world that its launcher has ended is said to have ended, and its clock stands
  //  at the herald's last sample — worldEnded; the launcher is asked only after a herald read failed by the network)
  // (B21: the same one answer is also counted by launcherWatch — a launcher that gives no answer at all, twice in a row,
  //  is said in a plain line; no second question is asked)
  // (owner decision 2026-11-24, LP14-1: a kept world that its launcher stopped is said to be paused, not ended)
  worldKept = localPersistPage(cfg);
  { const check = localPlayWorldCheck(cfg); if (check) { launcherWatch = createLauncherWatch({ onLost: () => launcherLost(true), onBack: () => launcherLost(false) }); worldWatch = createWorldWatch({ ask: () => check().then(r => { launcherWatch?.heard(r); return worldStateOf(r); }), onEnded: worldEnded }); } }
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
  // (B13, TEST-ONLY: in a launcher world ①'s co-op board is the launcher's, under that world's mount, and its records
  //  are signed with this page's memory-only key — hud/coopboard-local.mjs; elsewhere the board is looked for as before)
  const coopOptions = cfg.localPlay ? localCoopBoardOptions({ herald: cfg.herald, handle: currentEphemeralWallet(), launcher: localLauncherRequested(cfg) }) : null;
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
        if (rosterRef) for (const d of rosterRingsNow()) rosterRef.ensure(d);
        const own = ownNow(), survey = surveyNow();
        // A feed or clock can change while the pointer stays still. Refresh
        // its ribbon from the same inputs as a tap, without scheduling a draw
        // from inside this draw. The path cache keeps the planner work bounded.
        hoverPlan(hoverHit, { redraw: false });
        return { overviews: shownOverviews(), ringsOpen: ringsOpenNow(), seeded: worldNow().seeded ?? null, own, selected: FS.selected, terrainOf,
          // the recorded wide land (rings 129+), read in the background: map/wideland.mjs (null while the herald serves none)
          wideLand: wideLandRef?.land() ?? null,
          // where the season's map ends (map/world.mjs: its border is drawn once it is near the open land)
          rMax: FS.world?.rMax ?? null,
          rMaxCeiling: FS.world?.rMaxCeiling ?? null,
          // the rings a first village may be placed in (home.mjs homeRingsOpen: the open rings, no further than the
          // heartland): the wait view's site marks, 「村を置ける場所」, stop there (map/waitview.mjs wedgeSites)
          homeRings: homeRingsOpen(FS.season, contiguousRings(worldNow())),
          // what this viewer has surveyed (map/survey.mjs): the one rule for the map, the minimap, tips, the inspector and search
          survey,
          // art mode: the decoded Province (holdings' tiers, hosts on tiles, camp), loaded on demand
          viewerFaction: FS.citizen?.faction ?? null,
          // who is looking, for the opening view (map/opening.mjs)
          open: openHint(FS, { ready: viewerKnown, title: titleUp(), frame: stageFrame() }),
          // the nation that is looked at in the nation choice: its home region is lit on the chart (map/chart.mjs paintWedge)
          focusNation: stageFrame()?.nation ?? null,
          // the season's first-home placement (home.mjs seasonPlace: the rule the home planner reads): the map lights,
          // frames and marks a nation's home region from it (map/homeland.mjs); without a readable one it shows none
          place: seasonPlace(FS.season),
          demoRoads: ART_ROADS,
          demoSpecials: ART_RELICS,
          demoRivers: ART_RIVERS,
          alliedPairs: ART_ALLY,
          artReplayRing: ART_RINGOPEN ? Math.max(0, ringsOpenNow() - 1) : null,
          clashOf: ART_ON ? artClashOf : undefined,
          pendingOf: ART_ON ? (p, q) => FS.provinces.get(`${p},${q}`)?.inputs ?? null : undefined,
          people: ART_ON && FS.mode !== 'practice' ? peopleSource : undefined,
          // the world view's labels: the faction names, in the page's language (no centre is named: ⑭ abolished)
          realmName: f => factionName(f),
          lens: FS.view.lens ?? 'realm',
          // incoming risk around the viewer's holdings (hud/hud.mjs attention, controller incoming warnings)
          threats: (FS.incoming ?? []).map(w => ({ p: w.holding.p, q: w.holding.q, tile: w.holding.tile, bell: w.bell })),
          threatLabel: w => L`来襲 ターン ${fmtNum(w.bell)}`,
          // the bell now (an overview older than the last bell no longer says "a clash this bell")
          bell: FS.nowBell ?? null,
          // (the turn of the herald's own latest sample, never extrapolated: what "has arrived" is judged by — B5)
          seenBell: seenBell(),
          // what the selected host can do, lit on the map (map/actions.mjs); the route under the pointer; the map's own answer to a tap
          actions: actionsNow(),
          hoverRoute,
          outboundRoute: originalOutboundMap(),
          outboundInput: FS.hand?.pop === OUTBOUND_POP ? FS.expeditionCompose?.map ?? FS.expeditionCompose : null,
          note: FS.mapNote ?? null,
          // (2026-11-17, ⑦: reads that did not come, said on the map where they are — readMarksNow)
          readMarks: readMarksNow(),
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
          // the land preview: a province with a land record shows who holds each tile (its own fill, the keeps' as before)
          landOf: (p, q) => landOf(FS, p, q),
          provinceOf: ART_ON ? (p, q, { far = false } = {}) => { if (!far) wantProvince(p, q, () => map?.invalidate()); return FS.provinces.get(`${p},${q}`)?.province ?? null; } : undefined };
      },
      onSelect: hit0 => {
        // a tap selects what the zoom shows: a province from afar, a tile up close
        const hit = FS.view.lod === 'tile' ? hit0 : { kind: 'province', p: hit0.p, q: hit0.q };
        // Boundary preparation owns the gesture before host/keep/legacy routing.
        // A refused/repeated tap keeps the original observed host in the hand.
        const outbound = tapOriginalOutbound(hit);
        if (outbound.handled) {
          lastPress = null;
          if (outbound.code === 'SourceChanged') summary(() => L`出発点の情報が変わりました。境界への道を開き直してください。`);
          else if (!Number.isInteger(hit.idx)) {
            map.flyTo({ p: hit.p, q: hit.q, zoom: 1.0 });
            summary(() => L`拡大した地図で、終点に隣り合う破線のマスを押してください。`);
          } else if (outbound.changed) summary(() => L`道に一歩追加しました。地形・移動時間は未検証です。`);
          else if (outbound.code === 'PathTooLong' || outbound.code === 'PathProvinces') summary(() => L`道の形は 32 マス・4 州までです。`);
          else summary(() => L`終点に隣り合う破線のマスを押してください。軍勢の選択は変わりません。`);
          return;
        }
        // the press was on the figures or the token of one of the viewer's hosts (the board says so: map.hostAt): that host takes the hand
        const pressed = FS.mode === 'play' && !FS.compose && !FS.hand?.pick && FS.view.lod === 'tile' ? hostUnderPress() : null;
        lastPress = null;
        if (pressed && hand.subjectOf(FS)?.host?.id !== pressed.id) { selectHost(pressed); return; }
        // from afar, with a host that can march in the hand: the tap chooses where to look for its destination (the
        // camera goes there at tile detail and the host stays in hand: the next tap, on a tile, is the order)
        if (FS.mode === 'play' && !FS.compose && FS.hand?.pop !== OUTBOUND_POP && FS.hand?.pop !== EXPEDITION_POP && !Number.isInteger(hit.idx)) {
          const sub = hand.subjectOf(FS);
          if (sub?.kind === 'host' && !FS.hand?.pick && hand.marchCheck(FS, sub.host).ok) { goFar(); map.flyTo({ p: hit.p, q: hit.q, zoom: 1.0 }); summary(() => L`行き先のマスを押してください`); return; }
        }
        // a conquest season, a fighting host in the hand: the press was on a keep of the lit reach (the board says so:
        // `hit.keep`, map/fmap.mjs). A keep in reach is the order for it, the same as its row of the card 砦へ進軍; a keep
        // out of reach is answered on the board with the reason (map/keeps.mjs `tapped`) and no order card opens
        if (hit0?.keep && FS.mode === 'play' && !FS.compose && FS.hand?.pop !== OUTBOUND_POP && FS.hand?.pop !== EXPEDITION_POP && !FS.hand?.pick) {
          const sub = hand.subjectOf(FS);
          if (sub?.kind === 'host' && keephand.conquestOn(FS)) {
            if (hit0.keep.reachable && keephand.choosableWait(keephand.waitOf(FS, sub.host), sub.host)) Promise.resolve(ACTIONS['cq-march']({ host: sub.host.id, p: hit0.keep.p, q: hit0.keep.q, tile: hit0.idx })).catch(() => {});
            return;
          }
        }
        // the hand holds something: the tap is its order, or the map answers it (map/actions.mjs)
        if (mapTap(hit)) return;
        clearInspection(FS); clearOutbound(FS);
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
          // (a tile past the heartland is no home candidate, however open its ring: PlaceHome refuses it, home.mjs homeRingsOpen)
          const candidate = homeSites(FS.provinces.get(`${hit.p},${hit.q}`)?.province, { faction: FS.citizen?.faction ?? null, nowBell: FS.nowBell, ringsOpen: homeRingsOf(FS, FS.record ? contiguousRings(worldNow()) : 0), place: homePlaceOf(FS) }).find(s => s.tile === hit.idx);
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
        // (2026-11-17, ⑦: the refusal is said only by the request that asked for THIS place of THIS draft in THIS world —
        //  draftAims: the place's own object, taken before the wait — not for a place the person chose since)
        if (FS.mode === 'play' && c && !c.sending && Number.isInteger(hit.idx) && !(hit.p === c.origin.p && hit.q === c.origin.q && hit.idx === c.host.tile)) {
          const world = momentWorld(), going = ACTIONS['dest-from-map'](), aim = c.dest;
          Promise.resolve(going).then(() => { if (draftAims(c, aim, world) && c.routeError) mapNote(hit, refusalText(c.routeError, hit)); }).catch(() => {});
        }
        invalidate('map', 'panel');
      },
      onView: (_, lod) => { FS.view.lod = lod; renderMinimap(); },
      onHover: (hit, at) => { tipAt = hit && at ? { hit, at } : null; showTip(hit, at); hoverPlan(hit); protoHover(hit); },
      // the camera centres in the part of the map the HUD leaves free (hud/insets.mjs): the strip, the open drawer, the dock, the phone's sheet
      insets: () => hudInsets(),
      // what follows the picture on screen: the minimap's frame while the camera travels
      onDraw: () => { if (map?.cam?.moving) renderMinimap(); if (handPopEl && !handPopEl.hidden && handPopEl.dataset.mode === 'fan') placeHandPop(); },
      // (territory-video-3: the wide land's key follows what the frame drew — the fogged land's holders only. verify-pr205:
      //  none before the first village — the fog view needs one (verify-pr198), the home-picking map shows the raw land)
      onPainted: () => wideLegendRef?.update(fogActive(FS) && !FS.holdings?.length ? null : map?.wideDrawn ?? null, FS.citizen?.faction ?? null),
      // Sprite art at tile LOD, opt-in with ?art=1 (docs/frontier/art/tiles/LOD.md).
      art: ART_ON,
    });
    mapRef = map;
    try { wideLegendRef = mountWideLegend({ onLang: onLangChange }); } catch (e) { console.error('frontier wide legend:', e); }
    // the recorded wide world (read-only, experimental): refused on a sample world, explicit when the herald has
    // none; it reads the season record's pins (season, Season address, program) so a manifest of another season or
    // namespace is never shown
    // (the local test world's fog of war, map/fog.mjs: the recorded world's sheet lists every captured province, its keep
    //  nation and villages — a full-map view — so a fogged world does not offer it: a player sees only what they saw)
    // (fog-devnet: a devnet page is known only once its season is pinned — fogWorldLaid, or fogWorldPinned unmounts the
    //  sheet then)
    const fogWorld = (LOCAL_FOG && !!cfg.localPlay && FS.mode === 'play') || !!fogWorldLaid;
    if (!fogWorld) try { wideModeRef = mountWideMode({ herald, canvas, isSample: () => !!FS.sample, recordOf: () => FS.record ?? null }); } catch (e) { console.error('frontier wide world:', e); }
    // the same record on this map and its chart (rings 129+ in their terrain and keep nations' colours): read in the background
    try { wideLandRef = mountWideLand({ herald, isSample: () => !!FS.sample, recordOf: () => FS.record ?? null, onChange: () => mapRef?.invalidate() }); } catch (e) { console.error('frontier wide land:', e); }
    // (the map reads the wide land through this: under the fog of war of a local test world, the fogged copy — map/fog.mjs)
    if (wideLandRef) { wideLandRaw = wideLandRef; const raw = wideLandRaw; wideLandRef = { ...raw, land: () => shownWide(raw.land()) }; }
    // (territory-map: and the tiles players own laid on what the map shows — the viewer's own always, others' in sight)
    if (wideLandRef) { const shown = wideLandRef.land; wideLandRef = { ...wideLandRef, land: () => withTerritory(shown()) }; }
    // (territory-map: the tiles players own — a local wide world's page only; read-only, nothing is sent)
    // (territory-map-2, Q-TM-4 (c): read from the herald, so a devnet territory world's page draws them too — controller.mjs territoryMapReads)
    if (!territoryRef) try { territoryRef = mountTerritoryTiles({ reads: territoryMapReads, candidates: territoryCandidatesNow, keep: territoryKeep, onChange: () => mapRef?.invalidate() }); } catch (e) { console.error('frontier territory:', e); }
    // (devnet play, devnet gap P1: the opened wide provinces a wide claim may name — the herald's record, unfogged. Under
    //  the devnet fog (fog-devnet) nothing of it is SHOWN: fdevnetplay.mjs wideTargetsOf keeps each opened province's
    //  coordinates and ring only — the ring's opening is public geometry, as the open rings on the chart — never a holder,
    //  a village or a terrain)
    FS.wideLandNow = () => wideLandRaw?.land?.() ?? null;
    // (fix-loop18, LP18-4: the tile owners the map's territory read KEEPS — the viewer's own always, others' only in
    //  sight, territoryKeep above — for the village card's "no tile left in this province": screens/holding.mjs)
    FS.territoryTilesNow = () => territoryRef?.now?.() ?? null;
    // >>> proto-board: the banner rule's PROTOTYPE (a design, not in the program; the sample world serves its records only when
    // it was started with claims=1). The page's one reading of its records (FS.proto) reaches the map here and nowhere
    // else: proto/board-mount.mjs builds the board's model from it each time the page has drawn itself (renderProto)
    protoBoard = mountProtoBoard({ map, want: wantPreview });
    // <<< proto-board
    // >>> keep-board: the keeps of a conquest season on the board (map/keeps.mjs). The page's conquest records reach the
    // map here and nowhere else: map/keepmount.mjs hands it the keep events and the viewer's nation, and lights the
    // keeps the host in hand can reach until the hand lights its own (`map.setKeepReach`)
    mountKeepBoard({ map, clash: (p, q, bell) => herald.clash(p, q, bell) });
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
        if (!row || !keephand.choosableWait(keephand.waitOf(FS, sub.host), sub.host)) return;
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
    // (fix-loop5, B-13: an illustrated icon that failed to load — the server out of reach for a moment — is asked again)
    watchArtIcons(globalThis.document);
    startFx({ map, canvas, effects: () => FS.ui?.effects });   // the effects layer and, with ?fx=, its demo switch (fx/index.mjs)
    // `?fx=hand-…`: the conquest panels alone, from records of finished runs, under the demo tag (hud/handdemo.mjs; loaded on demand)
    try { const q = new URLSearchParams(globalThis.location?.search ?? ''); if (/(^|,)\s*hand-/.test(q.get('fx') ?? '')) import('./hud/handdemo.mjs').then(m => m.startHandDemo({ params: q })).catch(e => console.warn('hand demo:', e)); } catch { /* no address */ }
    renderLenses();
    const mini = $('minimap-canvas');
    mini?.addEventListener('pointerup', e => {
      const r = mini.getBoundingClientRect();
      const fr = minimap.frameOf(ringsOpenNow() + 1, r.width);
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
  // (2026-11-17, ⑦: what needs a season starts once, at the first good season read — at boot, or, when the season could
  //  not be read then, at the first good read of the season poll. It started only from boot's read, so a page opened
  //  while the herald was briefly unreachable showed the season once it came back but never started play, spectating
  //  or practice: the viewer's record was never asked and the drawer said "reading" for good. A read that throws at
  //  boot no longer ends the boot before the season poll starts: the poll reads again.)
  // (each step is marked done once it has run, and a step that registers a loop, a timer or a listener — spectating,
  //  the cooperation board, play — runs at most once: a step that threw is tried again at the next good read, the others
  //  are not run twice. startPlay is async and never throws here: a failure inside it is its own promise's. A throw no
  //  longer leaves the start marked as done with the rest never run, nor ends the boot or the season poll's tick.)
  let seasonStarted = false;
  const started = { practice: false, spectate: false, coop: false, play: false };
  const startWithSeason = () => {
    if (seasonStarted || !FS.pin || !FS.season) return;
    // Ring summaries stream in while viewer setup starts; no whole-world boot barrier.
    loadOverviews(herald).catch(e => console.error('frontier overviews:', e));
    try {
      // Practice runs without a season too (the kernel only needs its own ruleset); a season pins it and keeps its flags.
      if (FS.mode === 'practice' && !started.practice) { FS.ui = loadUi(uiStorage, uiKey(scope())); invalidate('panel'); started.practice = true; }
      if (FS.mode === 'spectate' && !started.spectate) { startSpectate(herald); started.spectate = true; }
      if (FS.mode === 'play') {
        // the first answer about the viewer decides whether the join flow opens by itself (hud/drawer.mjs) and where the map opens (map/opening.mjs)
        // (workstream 07: 01's cooperation board, when this server has one — hud/coopboard.mjs; nothing shown when not)
        // (on its own: a board that cannot be installed does not hold play back; it is tried again at the next good read)
        if (!started.coop) { try { installCoopBoard({ changed: () => invalidate('panel'), ...(coopOptions ?? {}) }); started.coop = true; } catch (e) { console.error('frontier coop board:', e); } }
        // (nation chat, owner Q-PT-11 (a): the herald's /h/chat/* when it has one — hud/nationchat.mjs; nothing drawn when not)
        if (!nationChatRef) { try { nationChatRef = installNationChat({ base: cfg.herald ?? '', anchor: $('lang-box'), host: document.body, state: nationChatState, onOpen: nationChatOpening, focusDrawer: focusDrawerHead }); } catch (e) { console.error('frontier nation chat:', e); } }
        // (workstream 15, ruleset B: the titles and chronicle of cooperation 01's board judges — read only, a record that
        //  changes no standing; nothing drawn on a server without them. Installs once — hud/coopoutcomes.mjs)
        //  (B13: in a launcher world they are read under that world's board mount, beside its board — hud/coopboard-local.mjs)
        try { coopTitles.installCoopOutcomes({ changed: () => invalidate('panel'), ...(coopOptions?.base ? { base: coopOptions.base } : {}) }); } catch (e) { console.error('frontier coop titles:', e); }
        // (world goals, first slice: the flag keeps judged off chain by the local-play launcher — read only, no money;
        //  the card in Territory and the gold pennants on the map; nothing on a server without the judge — hud/worldgoals.mjs)
        const goalsBase = cfg.localPlay ? worldGoals.localGoalsBase(cfg.herald) : null;
        // (fix-loop13, LP13-9: an achievement is also a feed line — a notice when it happens while the page is open)
        let goalsFirst = true;
        const goalNews = b => { const items = worldGoals.achievementNews(FS, b, { first: goalsFirst }); if (!items) return; goalsFirst = false; if (items.length) { FS.feed = feed.pushFeed(FS.feed ?? [], items); renderFeed(); } };
        // (pt-world-goals-devnet: a devnet page reads its relay's off-chain judge, /gw/f/goals/state, once a minute; the card
        //  shows the goals as planned until a good answer comes — a relay without the judge answers 404 and is not asked again)
        const goalsDevnet = !cfg.localPlay && worldGoals.devnetGoalsPage(FS);
        if (goalsDevnet && !goalsBase) { try { worldGoals.installWorldGoals({ base: worldGoals.DEVNET_GOALS_BASE, every: worldGoals.DEVNET_GOALS_EVERY_MS, changed: b => { invalidate('panel'); try { goalNews(b); } catch (e) { console.error('frontier world goals news:', e); } } }); } catch (e) { console.error('frontier world goals:', e); } }
        if (goalsBase) { try { worldGoals.installWorldGoals({ base: goalsBase, changed: b => { invalidate('panel'); mapRef?.keeps?.setGoalFlags?.(worldGoals.mapFlags(FS, b)); try { goalNews(b); } catch (e) { console.error('frontier world goals news:', e); } } }); } catch (e) { console.error('frontier world goals:', e); } }
        if (!started.play) {
          started.play = true;
          startPlay({ herald, cfg }).catch(e => console.error('frontier play:', e)).then(() => { FS.playReady = true; FS.viewerMissed = !!FS.wallet && !FS.land; invalidate('panel', 'tabs', 'rail', 'chips'); }).finally(() => { viewerKnown = true; map?.invalidate(); });
          // the drawer starts closed: the tab of the last visit is not reopened over the map
          FS.tab = 'map';
        }
      }
      seasonStarted = FS.mode !== 'play' || started.coop;
    } catch (e) { console.error('frontier start:', e); }
  };
  let bootRead = false;
  try { bootRead = await loadSeason(herald); } catch (e) { console.error('frontier season:', e); }
  if (bootRead) startWithSeason();
  // from here the season poll loads the overviews of rings that newly want one (a season that failed to load at boot
  // has no rings yet: its first good poll then loads them all)
  FS.overviewsBooted = true;
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
    // (local play's test march: the province an open order or card waits on, read again every half second — controller localSyncTick)
    if (FS.mode === 'play') { try { localSyncTick(); } catch (e) { console.error('frontier local sync:', e); } }
    if (++chipTick % 4 === 0) { invalidate('chip'); return; }
    if (!(Number(FS.chain?.rate) >= 10) || !FS.clock || tollBell === null) return;
    let b = null;
    try { b = hud.bellModel(FS.clock, FS.chain.now()).bell; } catch { b = null; }
    if (Number.isInteger(b) && b > tollBell) invalidate('chip');
  }, 250);
  // The season record every 30 s (own data poll), paused while hidden. It is the only read that moves the page's chain
  // clock (FS.chain.observe), so it is woken like the play loop: shown again, back from the browser's cache, or the
  // stale banner's re-read — otherwise a page shown again kept counting "behind" from its last read before it was
  // hidden, and the re-read button (which woke only the play loop) left that banner standing.
  let errors = 0;
  const seasonHidden = () => !!globalThis.document?.hidden;
  const seasonLoop = createPollLoop({
    tick: async () => {
      if (seasonHidden()) return;
      const ok = await loadSeason(herald);
      errors = ok ? 0 : errors + 1;
      // (page-not-open-yet: "not open yet" is an answer, not a failure — asked again at the usual pace, never backed off)
      if (FS.notOpen) errors = 0;
      // (the first good read after a boot that could not read the season starts what needs one — startWithSeason)
      if (ok) startWithSeason();
    },
    // (a clock that runs fast is read more often: a quarter of a turn at most, clock.mjs pollCap; hidden: look again in 5 s)
    delay: () => { const wait = nextPoll({ kind: 'own', hidden: seasonHidden(), errors }); return wait === null ? 5 : Math.min(wait, pollCap(FS.chain)); },
  });
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (!seasonHidden()) seasonLoop.wake(); });
  globalThis.addEventListener?.('pageshow', e => { if (e?.persisted && !seasonHidden()) seasonLoop.wake(); });
  onReread(() => seasonLoop.wake());
  seasonLoop.start(Math.min(30, pollCap(FS.chain)));
}

/**
 * The page's one start. Ordinarily: `boot()`, at once. With `?trace=title` in the address the diagnostic (ftrace.mjs:
 * it names the work under way in the tab's title; a loopback page only, by its own check) is loaded and its install
 * is AWAITED first, so nothing of the game has begun before the trace is whole; then `boot()`. A page whose address
 * does not ask never loads that module. A diagnostic that cannot be loaded or installed is said in the console and
 * the game starts all the same.
 */
export async function startPage({ loc = globalThis.location, load = () => import('./ftrace.mjs'), start = boot } = {}) {
  if (/[?&]trace=title(?:&|$)/.test(String(loc?.search ?? ''))) {
    try { const trace = await load(); if (trace.traceRequested(loc)) await trace.install(); } catch (e) { console.error('frontier trace:', e); }
  }
  return start();
}
/** (fix-loop6, LP6-11) Bring node `keep` up to `next`'s markup in place (attributes and content): the same element stays. */
function morphStable(keep, next) {
  if (keep.tagName !== next.tagName) return;
  for (const a of [...keep.attributes]) if (!next.hasAttribute(a.name)) keep.removeAttribute(a.name);
  for (const a of [...next.attributes]) if (keep.getAttribute(a.name) !== a.value) keep.setAttribute(a.name, a.value);
  if (keep.innerHTML !== next.innerHTML) keep.innerHTML = next.innerHTML;
  // (an attribute is not the live state: `disabled` follows it, set as the new markup says)
  if ('disabled' in keep) keep.disabled = next.hasAttribute('disabled');
}

/** (fix-loop6, LP6-13) Each amount of the caravan form bounded by the selected source's stock (its option's `data-have`). */
export function capCaravanAmounts(select) {
  const have = String(select?.selectedOptions?.[0]?.dataset?.have ?? '').split(',').map(Number);
  for (const input of select?.form?.querySelectorAll?.('input[name^="c"]') ?? []) {
    const i = Number(String(input.name).slice(1));
    if (!Number.isInteger(i)) continue;
    const max = Number.isFinite(have[i]) ? have[i] : 0;
    input.max = String(max);
    if (Number(input.value) > max) input.value = String(max);
  }
}

if (globalThis.document && !globalThis.process?.versions?.node) startPage().catch(e => console.error('frontier boot:', e));
