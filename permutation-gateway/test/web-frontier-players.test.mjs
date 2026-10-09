// The six are the players (UX design 13; DECISIONS ZP1 to ZP3): every place that shows a player's face shows the
// character of that player's nation, the viewer's own in the gold ring; the flat generated portrait is on no screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { playerFace, paintPlayerFace, FACE_MIN } from '../../permutation-server/web/frontier/people/faces.mjs';
import { leaderHex, HEX_OUTLINE, YOURS } from '../../permutation-server/web/frontier/people/leader-art.mjs';
import { leaderSvg } from '../../permutation-server/web/frontier/people/leaders.mjs';
import { personChip, renderHighlights, isOwnIdentity } from '../../permutation-server/web/frontier/people/ui.mjs';
import { identityOf } from '../../permutation-server/web/frontier/people/identity.mjs';
import { contrast } from '../../permutation-server/web/frontier/palette.mjs';
import * as P from '../../permutation-server/web/frontier/palette.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const KEYS = ['aster', 'borealis', 'cinder', 'dunmar', 'ember', 'fjordal'];
const flat = x => String(x);

test('a player\'s face is the character of the player\'s nation: the hexagon icon up to 64 px, the portrait card above; no nation, no face', () => {
  for (let f = 0; f < 6; f++) {
    const face = playerFace(f, { size: 36 });
    assert.match(face, new RegExp(`^<svg [^>]*width="36" height="36" class="leader leader-hex" data-leader="${KEYS[f]}" aria-hidden="true"`));
    assert.doesNotMatch(face, /data-own|leader-own|class="avatar/);
    assert.equal(face, leaderHex(f, { size: 36 }), 'one source for the icon');
    assert.match(playerFace(f, { size: 96 }), /class="leader leader-card-art"/, 'large: the portrait card');
    assert.match(playerFace(f, { size: 20 }), new RegExp(`width="${FACE_MIN}" height="${FACE_MIN}"`), 'never smaller than the icon reads');
    assert.doesNotMatch(face, /style=/);
  }
  for (const none of [6, -1, null, undefined, 2.5, '1']) assert.equal(playerFace(none), '', 'a camp or an unknown owner has no face');
});

test('the viewer\'s own face carries the gold ring: a second hexagon outside the icon, bright gold with an ivory core on a dark keyline', () => {
  for (let f = 0; f < 6; f++) {
    const own = playerFace(f, { size: 48, own: true });
    assert.match(own, new RegExp(`class="leader leader-hex leader-own" data-leader="${KEYS[f]}" data-own="1"`));
    assert.ok(own.includes(`<path d="${HEX_OUTLINE}" stroke="${YOURS.key}" stroke-width="11"/><path d="${HEX_OUTLINE}" stroke="${YOURS.gold}" stroke-width="6.5"/><path d="${HEX_OUTLINE}" stroke="${YOURS.core}" stroke-width="1.6"/>`));
    assert.match(own, /<image [^>]*x="9\.94" y="9\.64" width="80" height="80"\/>/, 'the icon at four fifths inside the ring');
    // the ring is told from every nation's own frame: by the dark keyline between them, and by its colour against the nation's
    assert.ok(contrast(YOURS.gold, YOURS.key) >= 7, 'gold on its keyline');
    const card = leaderSvg(f, { size: 120, own: true });
    assert.match(card, /class="leader leader-card-art leader-own"[^>]*data-own="1"/);
    assert.ok(card.includes(`stroke="${YOURS.gold}" stroke-width="5"`));
  }
  // yellow Cinder and orange Fjordal: the ring is not their cloth's colour
  assert.notEqual(YOURS.gold.toLowerCase(), P.NATION_FILL[2].toLowerCase());
  assert.notEqual(YOURS.gold.toLowerCase(), P.NATION_FILL[5].toLowerCase());
});

test('a person chip: the nation\'s character and the player\'s own name; the viewer\'s is marked', () => {
  setLang('ja');
  const id = identityOf(0x1234567890abcdefn);
  const chip = flat(personChip(id, 3, { full: true }));
  assert.match(chip, /^<span class="person"><svg [^>]*width="30" height="30" class="leader leader-hex" data-leader="dunmar"/);
  assert.match(chip, /<span class="person-name" data-name>[^<]+<\/span><\/span>$/, 'the player\'s own name stays');
  const mine = flat(personChip(id, 3, { own: true, size: 44 }));
  assert.match(mine, /^<span class="person person-own"><svg [^>]*width="44" height="44" class="leader leader-hex leader-own" data-leader="dunmar" data-own="1"/);
  assert.doesNotMatch(chip + mine, /class="avatar|<linearGradient id="av/);
  // a side that is no nation: the name alone
  assert.match(flat(personChip(id, 6)), /^<span class="person"><span class="person-name" data-name>/);
  assert.equal(personChip(null, 3), '');
  // AI citizens look exactly like people: the face depends on the nation alone
  const other = identityOf(0xfedcba0987654321n);
  const svgOf = m => m.slice(0, m.indexOf('</svg>'));
  assert.equal(svgOf(flat(personChip(other, 3))), svgOf(chip), 'two players of one nation wear the same face');
  // the viewer's own identity is told by the citizen tag
  assert.equal(isOwnIdentity({ holdings: [] }, id), false);
  assert.equal(isOwnIdentity({}, null), false);
});

test('the spectator\'s highlights: who did it wears the nation\'s character; a clash of several nations has a dot', () => {
  setLang('ja');
  const id = identityOf(77n);
  const out = flat(renderHighlights([{ kind: 'depart', bell: 40, faction: 1, identity: id, text: 'x' }, { kind: 'clash', bell: 40, faction: null, identity: null, text: 'y', clash: true }]));
  assert.match(out, /<li class="hl-depart"><svg [^>]*width="30" height="30" class="leader leader-hex" data-leader="borealis"/);
  assert.match(out, /<li class="hl-clash"><span class="hl-dot" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(out, /class="avatar/);
});

test('a face on a canvas: the icon, and for the viewer\'s own the ring round it; nothing for no nation or before the picture is here', () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (k === 'drawImage' ? (...a) => calls.push(['drawImage', ...a.slice(1)]) : typeof k === 'string' && /^(save|restore|beginPath|moveTo|lineTo|closePath|stroke)$/.test(k) ? (...a) => calls.push([k, ...a]) : undefined), set: () => true });
  assert.equal(paintPlayerFace(ctx, 6, 0, 0, 20), false);
  assert.equal(paintPlayerFace(ctx, 2, 0, 0, 20), false, 'no Image in a test: the caller draws its stand-in');
  assert.equal(calls.length, 0);
});

test('no screen of the client draws the flat generated portrait any more', () => {
  const files = [];
  const walk = dir => { for (const e of readdirSync(new URL(dir, WEB), { withFileTypes: true })) { if (e.isDirectory()) { if (!['council', 'art', 'wasm'].includes(e.name)) walk(`${dir}${e.name}/`); } else if (e.name.endsWith('.mjs')) files.push(`${dir}${e.name}`); } };
  walk('');
  const users = files.filter(f => f !== 'people/avatar.mjs' && /\bavatarSvg\(|\bavatarImage\(/.test(readFileSync(new URL(f, WEB), 'utf8')));
  assert.deepEqual(users, [], 'avatarSvg / avatarImage are called nowhere (the file keeps the colours and the sigils)');
  // the identity module's exports are as they were (other code imports them)
  const idSrc = readFileSync(new URL('people/identity.mjs', WEB), 'utf8');
  for (const name of ['identityOf', 'displayName', 'tagOf', 'placeName', 'withProfile', 'tagKey', 'IDENTITY_VERSION', 'SKIN', 'HAIR', 'EYES']) assert.match(idSrc, new RegExp(`export (const|function) ${name}\\b`), name);
});
