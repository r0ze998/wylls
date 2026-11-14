// The battle reports of the viewer's own host (map/ownclash.mjs) are read from the world's herald, not from the page's origin.
// Trial 3 (2026-11-14, a local-play test world): the page was served by the launcher (localhost:41980) and its herald was
// another port (41986). The watch built its own reader from `config().herald` — the page's origin — and asked the launcher for
// /h/clash/-2,4/15..17 again and again: 404 each time, so no battle notice could come from a report. Now the board hands the
// watch the page's own reader (app.mjs: the checked `cfg.herald`, the same reader every other report uses).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountKeepBoard } from '../../permutation-server/web/frontier/map/keepmount.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');

test('the app gives the keep board its own herald reader for the battle reports', () => {
  const app = src('app.mjs');
  assert.match(app, /const herald = createHerald\(\{ base: cfg\.herald \}\);/, 'the reader of the checked herald');
  assert.match(app, /mountKeepBoard\(\{ map, clash: \(p, q, bell\) => herald\.clash\(p, q, bell\) \}\);/);
  assert.doesNotMatch(app, /mountKeepBoard\(\{ map \}\);/, 'no mount without it');
  const mount = src('map/keepmount.mjs');
  assert.match(mount, /export function mountKeepBoard\(\{ map, state = \(\) => FS, clash = null \} = \{\}\) \{/);
  assert.match(mount, /const own = mountOwnClash\(\{ state, enabled: fs => keepFeedOf\(fs\)\.enabled, clash \}\);/);
  // the watch uses a given reader as is; only without one does it build its own (tests and pages that have no app reader)
  const own = src('map/ownclash.mjs');
  assert.match(own, /const read = clash \?\? \(\(p, q, bell\) => \{ herald = herald \?\? createHerald\(\{ base: config\(\)\.herald \}\); return herald\.clash\(p, q, bell\); \}\);/);
});

test('without a map there is no board, whatever reader is given', () => {
  assert.equal(mountKeepBoard({ map: null, clash: async () => null }), null);
  assert.equal(mountKeepBoard({ map: {}, clash: async () => null }), null);
});
