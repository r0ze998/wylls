// ⑦ a start that comes late or fails partway goes on: the first read's failure does not stop the play poll; a step that
// threw is tried again without running the others twice; a wallet whose record is still asked for is "pending", never
// "not joined" (Lane C, 2026-11-17). WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert /
// node:fs: controller.mjs, app.mjs, hud/drawer.mjs and map/fmap.mjs are read as TEXT, not imported (they load fi18n.mjs
// and lang.mjs, the subjects of refused tests). A text check; it runs no page, herald, wallet or world. (A behaviour case
// for viewerState would import hud/drawer.mjs: left to the coordinator's decision.)
//   P1 startPlay: the reconnect, the kernel, the wallet sync and the first refresh are one guarded block; after it the
//      local-play identity check, walletEventsReady, the second sync (guarded) and the poll always follow
//   P2 startPlay returns nothing and the page's own chain is unchanged: playReady and viewerMissed after it, viewerKnown
//      in finally
//   V1 viewerState: a wallet with meStatus 'loading', no answer yet, no Citizen or village is 'pending', before the
//      FS.land line; the existing 'unreachable' rule stays first
//   B1 startWithSeason: steps marked done once they have run; spectating, the board and play at most once; play marked
//      before startPlay (async); the board in its own guard; the whole in a guard; done only when every step is
//   M1 the opening plan is asked every frame until a person moves the camera, and a new subject (the village) is aimed
//      at again (unchanged: why a late start reaches the player's village and never takes a moved camera)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const ctl = read('controller.mjs'), app = read('app.mjs'), drawer = read('hud/drawer.mjs'), fmap = read('map/fmap.mjs');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };
const sp = fnOf(ctl, 'export async function startPlay({ herald: h, cfg }) {');
const boot = fnOf(app, 'export async function boot() {');

test('P1 the first read is guarded; the poll always follows', () => {
  order(sp, 'wallet.onChange(listWallets);', '  try {', 'const last = localPlay ? null : wallet.lastWalletName();', 'const restored = await fsession.restore(scope(), c.address);',
    'await kernelOrNull();', 'await syncConnectedWallet();', 'await refresh();', "} catch (e) { console.error('frontier first read:', e); }",
    'if (localPlay && FS.wallet && !localPlayIdentityOk(localPlay, io.pinned(), FS.season, FS.citizen)) {', 'walletEventsReady = true;',
    "try { if ((wallet.connected()?.address ?? null) !== (FS.wallet?.address ?? null)) await syncConnectedWallet(); } catch (e) { console.error('frontier wallet sync:', e); }",
    'const poll = pollLoop = createPollLoop({', 'poll.start(Math.min(10, pollCap(FS.chain)));');
  const tail = sp.slice(sp.indexOf("} catch (e) { console.error('frontier first read:', e); }"));
  assert.doesNotMatch(tail.replace("try { if ((wallet.connected()?.address ?? null) !== (FS.wallet?.address ?? null)) await syncConnectedWallet(); }", ''), /\n  await (refresh|syncConnectedWallet)\(\);/, 'no unguarded read is left before the poll');
});

test('P2 the page\'s chain after startPlay is unchanged', () => {
  assert.doesNotMatch(sp, /\n  return [^;]/, 'startPlay returns nothing');
  assert.ok(boot.includes("startPlay({ herald, cfg }).catch(e => console.error('frontier play:', e)).then(() => { FS.playReady = true; FS.viewerMissed = !!FS.wallet && !FS.land; invalidate('panel', 'tabs', 'rail', 'chips'); }).finally(() => { viewerKnown = true; map?.invalidate(); });"));
});

test('V1 a record still asked for is pending, never "not joined"', () => {
  const vs = fnOf(drawer, 'export function viewerState(FS) {');
  order(vs, "if ((FS.mode ?? 'play') !== 'play') return 'known';",
    "if (FS.meStatus === 'error' && !FS.meAnswered && !FS.citizen && !(FS.holdings ?? []).length) return 'unreachable';",
    "if (FS.wallet && FS.meStatus === 'loading' && !FS.meAnswered && !FS.citizen && !(FS.holdings ?? []).length) return 'pending';",
    "if (FS.land || FS.citizen || (FS.holdings ?? []).length) return 'known';");
  assert.ok(ctl.includes("FS.meStatus = next ? 'loading' : 'ready';"), 'a wallet adopted is loading until answered');
});

test('B1 each step once; a throw is tried again', () => {
  const sw = boot.slice(boot.indexOf('let seasonStarted = false;'), boot.indexOf('let bootRead = false;'));
  order(sw, 'const started = { practice: false, spectate: false, coop: false, play: false };', 'if (seasonStarted || !FS.pin || !FS.season) return;',
    "loadOverviews(herald).catch(e => console.error('frontier overviews:', e));", '    try {',
    "if (FS.mode === 'practice' && !started.practice) {", 'started.practice = true; }',
    "if (FS.mode === 'spectate' && !started.spectate) { startSpectate(herald); started.spectate = true; }",
    "if (!started.coop) { try { installCoopBoard({ changed: () => invalidate('panel') }); started.coop = true; } catch (e) { console.error('frontier coop board:', e); } }",
    'if (!started.play) {', 'started.play = true;', 'startPlay({ herald, cfg })', "FS.tab = 'map';",
    "seasonStarted = FS.mode !== 'play' || started.coop;", "} catch (e) { console.error('frontier start:', e); }");
  assert.doesNotMatch(sw, /seasonStarted = true;/, 'never marked done before its steps ran');
  assert.ok(boot.includes("try { bootRead = await loadSeason(herald); } catch (e) { console.error('frontier season:', e); }"));
  assert.ok(boot.includes('if (ok) startWithSeason();'));
  assert.doesNotMatch(sw, /prize|faucet|payAndJoin|paidJoin|claim/i);
});

test('M1 the opening follows the viewer until a person moves the camera (unchanged)', () => {
  assert.ok(fmap.includes('if (this.cam.userMoved) return true;'));
  assert.ok(fmap.includes('let plan = openingPlan(src?.open, src, size, { inset, dpr });'));
  assert.ok(fmap.includes('if (key === this.openKey) return true;'));
});
