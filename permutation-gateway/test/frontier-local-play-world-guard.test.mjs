// The launcher's world guard counts a world's output while the herald renames and compresses its files: an entry that
// vanishes mid-count holds no bytes (ENOENT counts 0); any other error still stops the world. No process, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../src/frontier/local-play-launcher.mjs';
test('the world guard: a file the herald renames mid-count is not a guard failure; any other error still is', async () => {
  const ent = (name, dir = false) => ({ name, isDirectory: () => dir, isFile: () => !dir });
  const enoent = Object.assign(new Error('gone'), { code: 'ENOENT' }), eacces = Object.assign(new Error('denied'), { code: 'EACCES' });
  const io = (statOf, dirs = { '/w': [ent('runner.out'), ent('h', true)], '/w/h': [ent('1.bin'), ent('1.bin.gz')] }) => ({
    readdir: async d => { if (!(d in dirs)) throw enoent; return dirs[d]; }, stat: async p => statOf(p) });
  assert.equal(await L.bytesUnder('/w', io(p => ({ size: p.endsWith('1.bin') ? 7 : 10 }))), 27, 'everything present');
  assert.equal(await L.bytesUnder('/w', io(p => { if (p.endsWith('1.bin')) throw enoent; return { size: 10 }; })), 20, 'renamed to .gz meanwhile: counts 0, no failure');
  assert.equal(await L.bytesUnder('/w', io(() => ({ size: 1 }), { '/w': [ent('h', true)] })), 0, 'a directory gone meanwhile: 0');
  await assert.rejects(L.bytesUnder('/w', io(() => ({ size: 1 }), {})), e => e.code === 'ENOENT', 'the world\'s own directory gone: still a guard failure');
  await assert.rejects(L.bytesUnder('/w', { readdir: async () => { throw eacces; }, stat: async () => ({ size: 1 }) }), e => e.code === 'EACCES', 'the root unreadable: a guard failure');
  await assert.rejects(L.bytesUnder('/w', io(p => { if (p.endsWith('1.bin')) throw eacces; return { size: 1 }; })), e => e.code === 'EACCES', 'any other error still stops the world');
});
