// ⑯ pure-function probe (2026-11-09) of ⑦'s hud/drawer.mjs viewerState / joinOpen: the FS states that the viewer's
// /h/me answers produce (controller.applyMeResult: found → ready, NotFound → ready with no Citizen and land {stage:
// 'none'}, anything else → error, leaving citizen/holdings as they were). No page, no key: drawer.mjs is imported and
// only these two functions are called on plain objects. Usage: node v16-ws07-viewer-state.mjs <worktree>
const d = await import(`${process.argv[2]}/permutation-server/web/frontier/hud/drawer.mjs`);
const none = { stage: 'none' };
const base = { mode: 'play', playReady: true, land: none, citizen: null, holdings: [] };
const states = {
  'first read failed (nothing known)': { ...base, meStatus: 'error' },
  'NotFound: not joined': { ...base, meStatus: 'ready' },
  'NotFound, then a refresh failed': { ...base, meStatus: 'error' },
  'Citizen known, then a refresh failed': { ...base, meStatus: 'error', citizen: { faction: 1 }, land: { stage: 'joined' } },
  'village known, then a refresh failed': { ...base, meStatus: 'error', citizen: { faction: 1 }, holdings: [{ p: 0 }], land: { stage: 'final' } },
  'still loading': { ...base, meStatus: 'loading', playReady: false, land: undefined },
};
const out = {};
for (const [k, FS] of Object.entries(states)) out[k] = `${d.viewerState(FS)} / join ${d.joinOpen(FS) ? 'open' : 'closed'}`;
console.log(JSON.stringify(out, null, 1));
