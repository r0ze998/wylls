// The fixture world read back by the page's own modules in node, before any
// browser runs: the herald client decodes and checks every file the scenes
// use (season pins, the `me` key checks for each viewer stage, envelopes,
// overviews, the bell-region record, the clash report), and flog decodes
// every event. A world the page would refuse fails here, not as a blank
// screenshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';
import * as W from './world.mjs';
import { createHerald } from '../../permutation-server/web/frontier/herald.mjs';
import { setPin } from '../../permutation-server/web/frontier/fchainio.mjs';
import { decodePage } from '../../permutation-server/web/frontier/flog.mjs';
import { landState, siteAllowed } from '../../permutation-server/web/frontier/fland.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { regionOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { createSurveyor, L1, L3 } from '../../permutation-server/web/frontier/map/survey.mjs';
import { surveyInput } from '../../permutation-server/web/frontier/map/viewer.mjs';

test('the fixture herald: every file the scenes read decodes and passes the page\'s checks', async () => {
  const srv = await startServer();
  try {
    const h = createHerald({ base: srv.url });
    const s = await h.season();
    assert.ok(s.ok, `${s.code} ${s.error ?? ""}`);
    const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
    h.pin(s.record.season, pin.addresses);
    for (let d = 0; d <= 2; d++) {
      const o = await h.overview(d);
      assert.ok(o.ok, `overview ${d}: ${o.code}`);
      assert.ok(o.provinces.length >= 1);
    }
    const expect = { none: 'none', joined: 'joined', ticket: 'ticket', provisional: 'provisional', holding: 'final' };
    assert.deepEqual(Object.keys(expect), [...W.STAGES], 'every stage of the fixture is read back here');
    const held = new Map();
    for (let d = 0; d <= 2; d++) for (const r of (await h.overview(d)).provinces) held.set(`${r.p},${r.q}`, r);
    for (const stage of W.STAGES) {
      srv.stage(stage);
      const me = await h.me(srv.viewer.wallet);
      assert.ok(me.ok, `${stage}: ${me.code} ${me.error ?? ''}`);
      const land = landState(me.citizen);
      assert.equal(land.stage, expect[stage], stage);
      if (me.citizen) assert.equal(me.citizen.session.length, 32);
      if (stage === 'ticket') {
        // the wait for the village: three candidate sites, each a free site the viewer's nation may ask for
        assert.equal(land.ticket.bell, W.TICKET_BELL);
        assert.deepEqual(land.ticket.sites, W.TICKET_SITES.map(x => ({ ...x })));
        for (const x of land.ticket.sites) {
          assert.ok(siteAllowed(me.citizen.faction, x), `${x.p},${x.q} site ${x.site} is in the home wedge`);
          assert.equal(held.get(`${x.p},${x.q}`).sites[x.site], 0, `${x.p},${x.q} site ${x.site} is free`);
        }
        assert.equal(me.holdings.length, 0);
      }
      if (stage === 'provisional') {
        // a provisional village: a hamlet on the home tile, no hosts of its own in its province
        assert.equal(me.holdings.length, 1);
        assert.deepEqual([me.holdings[0].state, me.holdings[0].tier, me.holdings[0].tile], [1, 0, W.HOME.tile]);
        const pv = await h.province(W.HOME.p, W.HOME.q, 'latest');
        assert.ok(pv.ok, pv.code);
        assert.equal(pv.province.entries.filter(e => e.state >= 1).length, 0);
        assert.equal(pv.province.siteMirror[W.HOME.site].tier, 0);
      }
    }
    srv.stage('holding');
    const env = await h.province(W.HOME.p, W.HOME.q, 'latest');
    assert.ok(env.ok, env.code);
    assert.equal(env.province.entries.filter(e => e.state >= 1).length, 3);
    assert.equal(env.province.camp.state, 1);
    const other = await h.province(3, -1, 'latest');
    assert.ok(other.ok, other.code);
    const b = await h.bellRegion(W.BELL, regionOf(W.HOME.p, W.HOME.q));
    assert.ok(b.ok && b.anchor, b.code);
    const c = await h.clash(W.HOME.p, W.HOME.q, W.REPORT_BELL);
    assert.ok(c.ok && c.inputs, c.code);
    assert.equal(c.inputs.nPresent, 2);
    const ev = await h.events(0);
    assert.ok(ev.ok);
    const page = decodePage(ev.events);
    assert.equal(page.records.length, ev.events.length, 'every fixture event decodes');
    assert.ok(page.records.some(r => r.record.name === 'CLASH' && r.record.bell === W.REPORT_BELL));
    // Only the paths the page asks for exist; nothing failed so far.
    assert.deepEqual(srv.requests.filter(r => r.code >= 400), []);
  } finally {
    await srv.close();
  }
});

// UX brief §3: what each viewer stage of the fixture has surveyed, read through the page's own modules
// (herald → land state → the survey's input → the survey). The screenshots of the stages show exactly this.
test('the fixture stages and the survey: chart only before a village; small discs on the candidates; a disc on the village; hosts add to it', async () => {
  const srv = await startServer();
  try {
    const h = createHerald({ base: srv.url });
    const s = await h.season();
    const pin = setPin({ programId: s.record.programId, cluster: s.record.cluster, seasonId: s.record.season, seasonAddress: s.record.seasonAddress, rulesetHash: toHex(s.season.rulesetHash) });
    h.pin(s.record.season, pin.addresses);
    // the candidates' tiles: the home province's real sites, and a stand-in for province (1,1) (the page asks the rules module)
    const terrainOf = (p, q) => (p === W.HOME.p && q === W.HOME.q ? { sites: [...W.HOME_SITES] } : { sites: [2, 5, 9, 14, 20, 24, 30, 36, 41, 47, 52, 58] });
    const seen = {};
    for (const stage of W.STAGES) {
      srv.stage(stage);
      const me = await h.me(srv.viewer.wallet);
      const provinces = new Map();
      for (const o of me.holdings ?? []) { const env = await h.province(o.p, o.q, 'latest'); provinces.set(`${o.p},${o.q}`, env); }
      const fs = { mode: 'play', record: { rings: s.record.rings }, wallet: { address: srv.viewer.wallet }, citizen: me.citizen, holdings: me.holdings ?? [], land: landState(me.citizen), provinces, nowBell: W.BELL + 2, chronicle: [], marches: [] };
      const sv = createSurveyor({ storage: { get: () => null, set: () => true } })(surveyInput(fs, { terrainOf, ready: true, scope: { cluster: 'localnet', programId: W.PROGRAM, seasonId: W.SEASON_ID } }));
      seen[stage] = sv.count.sight;
      assert.equal(sv.showAll, false, stage);
      assert.equal(sv.levelOf(-2, 1, 30), L1, `${stage}: the far side of the world is chart`);
      if (stage === 'ticket') for (const x of W.TICKET_SITES) assert.equal(sv.levelOf(x.p, x.q, terrainOf(x.p, x.q).sites[x.site]), L3, 'a candidate site is in sight');
      if (stage === 'provisional' || stage === 'holding') assert.equal(sv.levelOf(W.HOME.p, W.HOME.q, W.HOME.tile), L3);
      if (stage === 'holding') assert.equal(sv.ownHosts.size, 3, 'the viewer\'s three hosts');
    }
    assert.deepEqual([seen.none, seen.joined], [0, 0], 'nothing in sight before there is land');
    // (a candidate site is a disc of two tiles about it since the second review: at most 19 tiles each, less where two overlap or water lies)
    assert.ok(seen.ticket > 21 && seen.ticket <= 57, `three discs of two tiles about each site (${seen.ticket} tiles)`);
    assert.equal(seen.provisional, 61, 'a hamlet sees 4 tiles around it');
    assert.equal(seen.holding, 91, 'a town sees 5 (its hosts stand inside that)');
  } finally {
    await srv.close();
  }
});
