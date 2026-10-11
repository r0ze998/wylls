// The older twelve-cell atlas remains an independently tested artwork module.
// Public player portraits use the latest six nation characters; names and
// on-chain identities stay independent of both presentation systems.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { identityOf, withProfile } from '../../permutation-server/web/frontier/people/identity.mjs';
import { avatarSvg, FACTION_DARK } from '../../permutation-server/web/frontier/people/avatar.mjs';
import { playerFace } from '../../permutation-server/web/frontier/people/faces.mjs';
import { leaderHexUrl, leaderPortraitUrl } from '../../permutation-server/web/frontier/people/leader-art.mjs';
import { personChip } from '../../permutation-server/web/frontier/people/ui.mjs';
import { PORTRAIT_ART_URL, PORTRAIT_COLUMNS, PORTRAIT_ROWS, portraitCell } from '../../permutation-server/web/frontier/people/portrait-art.mjs';

const avatarUrl = new URL('../../permutation-server/web/frontier/people/avatar.mjs', import.meta.url).href;
const facesUrl = new URL('../../permutation-server/web/frontier/people/faces.mjs', import.meta.url).href;
const leadersUrl = new URL('../../permutation-server/web/frontier/people/leader-art.mjs', import.meta.url).href;
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

test('legacy procedural portrait remains self-contained and accessible without restoring atlas art to public screens', () => {
  const id = identityOf(43n);
  for (let faction = 0; faction < 6; faction++) {
    const svg = avatarSvg(id, faction, { size: 64, title: 'Player <name>' });
    assert.match(svg, /role="img" aria-label="Player name"/);
    assert.doesNotMatch(svg, /<image|\bstyle=|<script|\bon(?:load|error)=|<foreignObject/);
    assert.ok(svg.includes(`fill="none" stroke="${FACTION_DARK[faction]}"`));
    assert.match(svg, /translate\(52\.5 52\.5\)/);
  }
  const small = avatarSvg(id, 0, { size: 20 });
  assert.match(small, /aria-hidden="true"/);
  assert.doesNotMatch(small, /translate\(52\.5 52\.5\)/);
});

test('public portraits use six current characters, preserve player names, and never request the older atlas', () => {
  const id = identityOf(43n), renamed = withProfile(id, { name: 'Changed' }), icons = new Set();
  for (let faction = 0; faction < 6; faction++) {
    const icon = playerFace(faction, { size: 64, title: 'Player <name>', own: true });
    const card = playerFace(faction, { size: 96 });
    assert.ok(icon.includes(`href="${leaderHexUrl(faction)}"`));
    assert.ok(card.includes(`href="${leaderPortraitUrl(faction)}"`));
    assert.match(icon, /role="img" aria-label="Player name"/);
    assert.match(icon, /data-own="1"/);
    assert.doesNotMatch(icon + card, /wylls-citizens|class="avatar|\bstyle=|<script|\bon(?:load|error)=|<foreignObject/);
    const original = String(personChip(id, faction)), changed = String(personChip(renamed, faction));
    assert.equal(original.match(/<svg.*?<\/svg>/s)?.[0], changed.match(/<svg.*?<\/svg>/s)?.[0], 'changing a signed name never changes the nation character');
    assert.notEqual(original, changed, 'the name itself still updates');
    icons.add(leaderHexUrl(faction));
  }
  assert.equal(icons.size, 6);
  for (const invalid of [undefined, null, -1, 6]) assert.equal(playerFace(invalid), '');
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
    const ctx = Object.fromEntries(['save', 'restore', 'clearRect', 'scale', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'closePath', 'rect', 'arc', 'clip', 'drawImage', 'stroke'].map(name => [name, (...args) => calls.push([name, ...args])]));
    globalThis.document = { createElement(name) { assert.equal(name, 'canvas'); const canvas = { getContext: () => ctx }; canvases.push(canvas); return canvas; } };
    const A = await import(${JSON.stringify(avatarUrl)});
    const P = await import(${JSON.stringify(atlasUrl)});
    const F = await import(${JSON.stringify(facesUrl)});
    const L = await import(${JSON.stringify(leadersUrl)});
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

test('public map portraits load each nation icon once and paint the own-player ring over the decoded character', () => {
  browserLifecycle(`
    for (let faction = 0; faction < 6; faction++) {
      assert.equal(F.paintPlayerFace(ctx, faction, 10, 20, 48), false);
      assert.equal(imageInstances.length, faction + 1);
      const picture = imageInstances[faction];
      assert.equal(picture.src, L.leaderHexUrl(faction));
      picture.load(128, 128);
      assert.equal(F.paintPlayerFace(ctx, faction, 10, 20, 48), true);
      assert.deepEqual(calls.filter(x => x[0] === 'drawImage').at(-1), ['drawImage', picture, 10, 20, 48, 48]);
      assert.equal(F.paintPlayerFace(ctx, faction, 10, 20, 48, { own: true }), true);
      assert.ok(calls.some(x => x[0] === 'stroke'), 'a second ring identifies the viewer');
      assert.equal(calls.at(-1)[0], 'restore');
      assert.equal(imageInstances.length, faction + 1, 'repainting a cached icon makes no request');
    }
    assert.equal(imageInstances.length, 6);
    assert.ok(imageInstances.every(x => x.src !== P.PORTRAIT_ART_URL && !x.src.startsWith('data:')));
    assert.equal(F.paintPlayerFace(ctx, 6, 0, 0, 48), false);
    assert.equal(canvases.length, 0, 'a pre-rendered icon needs no atlas composition canvas');
  `);
});

test('public map portrait decode failures remain settled without substituting the obsolete atlas', () => {
  browserLifecycle(`
    assert.equal(F.paintPlayerFace(ctx, 2, 0, 0, 48), false);
    imageInstances[0].fail();
    for (let i = 0; i < 3; i++) assert.equal(F.paintPlayerFace(ctx, 2, 0, 0, 48), false);
    assert.equal(imageInstances.length, 1, 'a broken picture does not enter a retry loop');
    assert.equal(imageInstances[0].src, L.leaderHexUrl(2));
    assert.ok(!calls.some(x => x[0] === 'drawImage'));
    delete globalThis.Image;
    assert.equal(F.paintPlayerFace(ctx, 4, 0, 0, 48), false);
  `);
});

test('legacy map avatar keeps a standalone SVG without requiring canvas or fetching an atlas', () => {
  browserLifecycle(`
    delete globalThis.document;
    let loaded = 0;
    assert.equal(A.avatarImage(id, 0, () => loaded++), null);
    assert.equal(imageInstances.length, 1);
    assert.ok(imageInstances[0].src.startsWith('data:image/svg+xml'));
    assert.doesNotMatch(decodeURIComponent(imageInstances[0].src), /<image/);
    imageInstances[0].load();
    assert.equal(A.avatarImage(id, 0), imageInstances[0]);
    assert.equal(loaded, 1);
    delete globalThis.Image;
    assert.equal(A.avatarImage({ tag: 'another' }, 0), null);
  `);
});
