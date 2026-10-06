// Generated portraits share one local atlas; names and on-chain identity
// remain independent of the presentation artwork.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { identityOf, withProfile } from '../../permutation-server/web/frontier/people/identity.mjs';
import { avatarSvg, FACTION_DARK } from '../../permutation-server/web/frontier/people/avatar.mjs';
import { PORTRAIT_ART_URL, PORTRAIT_COLUMNS, PORTRAIT_ROWS, portraitCell } from '../../permutation-server/web/frontier/people/portrait-art.mjs';

const avatarUrl = new URL('../../permutation-server/web/frontier/people/avatar.mjs', import.meta.url).href;
const atlasUrl = new URL('../../permutation-server/web/frontier/people/portrait-art.mjs', import.meta.url).href;

test('portrait art: the bundled PNG supplies twelve square cells without fractional crops', () => {
  const bytes = readFileSync(new URL(PORTRAIT_ART_URL));
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  assert.equal(PORTRAIT_COLUMNS * PORTRAIT_ROWS, 12);
  assert.equal(width % PORTRAIT_COLUMNS, 0);
  assert.equal(height % PORTRAIT_ROWS, 0);
  assert.equal(width / PORTRAIT_COLUMNS, height / PORTRAIT_ROWS);
  assert.ok(width / PORTRAIT_COLUMNS >= 96, 'enough source detail for the largest map portrait');
});

test('portrait art: every faction has two stable variants, unaffected by a signed name change', () => {
  const seen = new Set();
  for (const tag of [42n, 43n]) {
    const id = identityOf(tag), renamed = withProfile(id, { name: 'New name' });
    for (let faction = 0; faction < 6; faction++) {
      const cell = portraitCell(id, faction);
      assert.deepEqual(cell, portraitCell(renamed, faction));
      assert.deepEqual(cell, portraitCell({ ...id, face: { ...id.face, skin: 5 } }, faction), 'faction costumes do not depend on skin palette');
      assert.equal(Math.floor(cell.index / 2), faction);
      assert.equal(cell.row * PORTRAIT_COLUMNS + cell.column, cell.index);
      assert.ok(cell.column >= 0 && cell.column < PORTRAIT_COLUMNS);
      assert.ok(cell.row >= 0 && cell.row < PORTRAIT_ROWS);
      seen.add(cell.index);
    }
  }
  assert.equal(seen.size, 12);
  const id = identityOf(43n);
  for (const faction of [undefined, null, -1, 6, 1.5, '2', NaN]) {
    assert.deepEqual(portraitCell(id, faction), portraitCell(id, 0));
  }
});

test('portrait SVG: a same-origin clipped image preserves its fallback, faction frame, badge and accessibility', () => {
  const id = identityOf(43n);
  for (let faction = 0; faction < 6; faction++) {
    const svg = avatarSvg(id, faction, { size: 64, title: 'Player <name>' });
    const renamed = avatarSvg(withProfile(id, { name: 'Changed' }), faction, { size: 64 });
    const image = svg.match(/<image [^>]+\/>/)?.[0];
    assert.ok(image);
    assert.equal(image, renamed.match(/<image [^>]+\/>/)?.[0]);
    assert.ok(image.includes(`href="${PORTRAIT_ART_URL}"`));
    assert.match(svg, /role="img" aria-label="Player name"/);
    assert.doesNotMatch(svg, /\bstyle=|<script|\bon(?:load|error)=|<foreignObject/);
    const imageOffset = svg.indexOf(image);
    assert.ok(svg.indexOf('<path ') < imageOffset, 'the procedural portrait remains underneath the art');
    assert.ok(svg.indexOf('clip-path="url(') < imageOffset);
    assert.ok(svg.indexOf(`fill="none" stroke="${FACTION_DARK[faction]}"`, imageOffset) > imageOffset, 'the faction frame overlays the image');
    assert.ok(svg.indexOf('translate(52 52)', imageOffset) > imageOffset, 'the faction badge overlays the image');
  }
  assert.doesNotMatch(avatarSvg(id, 0, { art: false }), /<image/);
  const small = avatarSvg(id, 0, { size: 20 });
  assert.match(small, /aria-hidden="true"/);
  assert.doesNotMatch(small, /translate\(52 52\)/);
});

// Each browser lifecycle runs in its own process: both runtime modules
// intentionally cache images for a page's lifetime, including failures.
// Manual image events exercise both decode orders without network timing.
function browserLifecycle(scenario) {
  execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const imageInstances = [], canvases = [];
    class FakeImage {
      constructor() { this.naturalWidth = 0; this.naturalHeight = 0; imageInstances.push(this); }
      load(width = 96, height = 96) { this.naturalWidth = width; this.naturalHeight = height; this.onload?.(); }
      fail() { this.onerror?.(new Error('image decode failed')); }
    }
    globalThis.Image = FakeImage;
    const calls = [];
    const ctx = Object.fromEntries(['save', 'restore', 'clearRect', 'scale', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'closePath', 'rect', 'arc', 'clip', 'drawImage'].map(name => [name, (...args) => calls.push([name, ...args])]));
    globalThis.document = { createElement(name) { assert.equal(name, 'canvas'); const canvas = { getContext: () => ctx }; canvases.push(canvas); return canvas; } };
    const A = await import(${JSON.stringify(avatarUrl)});
    const P = await import(${JSON.stringify(atlasUrl)});
    const id = { tag: '000000000000002b' };
    ${scenario}
  `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('portrait atlas: one request notifies all waiting consumers and stays settled after success', () => {
  browserLifecycle(`
    let first = 0, second = 0;
    const a = P.portraitAtlas(() => first++), b = P.portraitAtlas(() => second++);
    assert.equal(a, b);
    assert.equal(a.status, 'loading');
    assert.equal(imageInstances.length, 1);
    assert.equal(imageInstances[0].src, P.PORTRAIT_ART_URL);
    imageInstances[0].load(1448, 1086);
    assert.equal(a.status, 'ready');
    assert.equal(a.image, imageInstances[0]);
    assert.deepEqual([first, second, a.listeners.size], [1, 1, 0]);
    assert.equal(P.portraitAtlas(), a);
    assert.equal(imageInstances.length, 1);
  `);
});

test('portrait atlas: network errors and unusable dimensions settle all consumers without retry loops', () => {
  for (const finish of ['imageInstances[0].fail()', 'imageInstances[0].load(0, 0)']) {
    browserLifecycle(`
      let first = 0, second = 0;
      const a = P.portraitAtlas(() => first++);
      P.portraitAtlas(() => second++);
      ${finish};
      assert.equal(a.status, 'failed');
      assert.equal(a.image, null);
      assert.deepEqual([first, second, a.listeners.size], [1, 1, 0]);
      assert.equal(P.portraitAtlas(), a);
      assert.equal(imageInstances.length, 1);
    `);
  }
});

test('map portrait: fallback is immediately usable, then all waiting consumers receive the composed art', () => {
  browserLifecycle(`
    let first = 0, second = 0, late = 0;
    assert.equal(A.avatarImage(id, 4, () => first++), null);
    assert.equal(A.avatarImage(id, 4, () => second++), null);
    assert.equal(imageInstances.length, 2, 'one SVG fallback and one shared atlas');
    const fallback = imageInstances.find(x => x.src.startsWith('data:'));
    const atlas = imageInstances.find(x => x.src === P.PORTRAIT_ART_URL);
    assert.doesNotMatch(decodeURIComponent(fallback.src), /<image/, 'SVG-as-image never fetches external artwork');
    fallback.load();
    assert.deepEqual([first, second], [1, 1]);
    assert.equal(A.avatarImage(id, 4, () => late++), fallback);
    atlas.load(1448, 1086);
    assert.deepEqual([first, second, late], [2, 2, 1]);
    const surface = A.avatarImage(id, 4);
    assert.equal(surface, canvases[0]);
    assert.deepEqual([surface.width, surface.height], [96, 96]);
    const draw = calls.filter(x => x[0] === 'drawImage');
    assert.equal(draw[0][1], fallback);
    const cell = P.portraitCell(id, 4);
    assert.deepEqual(draw[1], ['drawImage', atlas, cell.column * 362, cell.row * 362, 362, 362, 2, 2, 60, 60]);
    assert.ok(calls.some(x => x[0] === 'clip' && x[1] === 'evenodd'), 'the badge is cut out of the painting aperture');
    assert.ok(calls.some(x => x[0] === 'arc' && x[1] === 52 && x[2] === 52 && x[3] === 11.6), 'the mask preserves the enlarged badge and its rim');
    assert.equal(calls.at(-1)[0], 'restore');
    assert.equal(A.avatarImage({ ...id, given: { en: 'New name' } }, 4), surface);
    assert.equal(A.avatarImage(id, 5), null, 'faction costumes have distinct rendered surfaces');
    assert.equal(imageInstances.filter(x => x.src === P.PORTRAIT_ART_URL).length, 1);
  `);
});

test('map portrait: an atlas decoded first is composed once the fallback becomes ready', () => {
  browserLifecycle(`
    let loaded = 0;
    A.avatarImage(id, 2, () => loaded++);
    const fallback = imageInstances.find(x => x.src.startsWith('data:'));
    imageInstances.find(x => x.src === P.PORTRAIT_ART_URL).load(1448, 1086);
    assert.equal(loaded, 0);
    assert.equal(A.avatarImage(id, 2), null);
    fallback.load();
    assert.equal(loaded, 1);
    assert.equal(A.avatarImage(id, 2), canvases[0]);
  `);
});

test('map portrait: failed artwork and canvas composition retain the decoded procedural portrait', () => {
  for (const failure of ['atlas', 'canvas']) {
    browserLifecycle(`
      let loaded = 0;
      A.avatarImage(id, 1, () => loaded++);
      const fallback = imageInstances.find(x => x.src.startsWith('data:'));
      const atlas = imageInstances.find(x => x.src === P.PORTRAIT_ART_URL);
      fallback.load();
      ${failure === 'atlas' ? 'atlas.fail();' : "ctx.drawImage = () => { throw new Error('canvas unavailable'); }; atlas.load(1448, 1086);"}
      assert.equal(A.avatarImage(id, 1), fallback);
      assert.equal(loaded, 2);
      if (${JSON.stringify(failure)} === 'canvas') assert.equal(calls.at(-1)[0], 'restore');
      assert.equal(imageInstances.length, 2);
    `);
  }
});

test('map portrait: environments without canvas support keep the procedural image', () => {
  browserLifecycle(`
    delete globalThis.document;
    let loaded = 0;
    assert.equal(A.avatarImage(id, 0, () => loaded++), null);
    assert.equal(imageInstances.length, 1, 'no atlas is requested without a usable canvas');
    imageInstances[0].load();
    assert.equal(A.avatarImage(id, 0), imageInstances[0]);
    assert.equal(loaded, 1);
    delete globalThis.Image;
    assert.equal(A.avatarImage({ tag: 'another' }, 0), null);
  `);
});
