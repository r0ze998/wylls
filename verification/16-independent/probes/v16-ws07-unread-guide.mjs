// ⑯ pure-function probe (2026-11-09) of ⑦'s guide with the village's province unread: screens/onboarding.mjs
// scoutObjective / marchObjective and screens/host.mjs homeProvinceUnread on a plain FS with one village and an EMPTY
// FS.provinces (a failed /h/province). No page, no key: the modules are imported and only these functions are called.
// Usage: node v16-ws07-unread-guide.mjs <worktree>
const root = process.argv[2];
const ob = await import(`${root}/permutation-server/web/frontier/screens/onboarding.mjs`);
const host = await import(`${root}/permutation-server/web/frontier/screens/host.mjs`);
const home = { p: 2, q: 0, site: 3, kind: 1 };
const FS = { mode: 'play', playReady: true, nowBell: 100, citizen: { faction: 1 }, holdings: [home], activeHolding: 0, land: { stage: 'final' }, provinces: new Map(), chain: { now: () => 0 } };
const show = f => { try { const r = f(); return r && typeof r === 'object' ? JSON.stringify(r).slice(0, 160) : String(r); } catch (e) { return `throws: ${e.message.slice(0, 80)}`; } };
console.log(JSON.stringify({
  homeProvinceUnread: show(() => host.homeProvinceUnread?.(FS)),
  hostRows: show(() => host.hostRows(FS).length),
  scoutObjective: show(() => ob.scoutObjective?.(FS)),
  marchObjective: show(() => ob.marchObjective(FS)),
}, null, 1));
