// ⑯ second round on ⑥'s journal lock (⑥ 11be9d44): the takeover mutex's own stale takeover (J5) and the window
// between save()'s fence check and its rename (J6). Same method as v16-ws06-journal-lock.test.mjs: injected fs,
// alive and startOf, two "processes" interleaved in one test. Keyless; temp files only. RECORDS what happens; asserts
// only that a writer that does not hold the lock never ends up with its state in the journal unnoticed (J5).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as realfs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { fileJournal } = await import(process.env.V16_WS06_DISPATCH);
const fresh = () => join(mkdtempSync(join(tmpdir(), 'v16-ws06b-')), 'journal.json');
const deadExcept = (...live) => p => live.includes(p);
const opts = (pid, live) => ({ pid, alive: deadExcept(...live), startOf: () => undefined });

test('J5 two takers find the takeover mutex of a dead taker: does a loser ever write?', () => {
  const path = fresh();
  realfs.writeFileSync(`${path}.lock`, JSON.stringify({ pid: 999, token: 'dead' }) + '\n');
  realfs.writeFileSync(`${path}.lock.takeover`, JSON.stringify({ pid: 998, token: 'dead-taker' }) + '\n');
  let b = null, bErr = null, once = false;
  const fsA = new Proxy(realfs, { get(t, k) {
    if (k !== 'readFileSync') return t[k];
    return (p, ...r) => { const v = t.readFileSync(p, ...r); if (!once && String(p).endsWith('.lock.takeover')) { once = true; try { b = fileJournal(path, realfs, opts(222, [222, 111])); } catch (e) { bErr = e.code; } } return v; };
  } });
  let a = null, aErr = null;
  try { a = fileJournal(path, fsA, opts(111, [111, 222])); } catch (e) { aErr = e.code; }
  const lock = JSON.parse(realfs.readFileSync(`${path}.lock`, 'utf8'));
  console.log(`J5 A: ${a ? 'opened' : 'refused ' + aErr}; B: ${b ? 'opened' : 'refused ' + bErr}; lock pid ${lock.pid}`);
  const wrote = [];
  for (const [n, j] of [['A', a], ['B', b]]) { if (!j) continue; try { j.save({ who: n }); wrote.push(n); } catch (e) { console.log(`J5 ${n}.save: ${e.code}`); } }
  console.log(`J5 wrote: ${wrote.join(',') || 'none'}; journal: ${realfs.existsSync(path) ? realfs.readFileSync(path, 'utf8').trim() : 'absent'}`);
  assert.ok(wrote.length <= 1, 'at most one writer');
  if (wrote.length === 1) assert.equal(lock.pid, wrote[0] === 'A' ? 111 : 222, 'the writer is the holder');
});

test('J6 a takeover between save()\'s fence check and its rename', () => {
  const path = fresh();
  let b = null, armed = false;
  const fsA = new Proxy(realfs, { get(t, k) {
    if (k !== 'openSync') return t[k];
    return (p, ...r) => {
      // A's save opens its temp file right after its fence check passed: B takes the lock over at that moment.
      if (armed && String(p).includes('journal.json.') && String(p).endsWith('.tmp')) { armed = false; b = fileJournal(path, realfs, opts(222, [222])); b.save({ who: 'B', step: 'sent' }); }
      return t.openSync(p, ...r);
    };
  } });
  const a = fileJournal(path, fsA, opts(111, [111, 222]));
  armed = true;
  let aErr = null;
  try { a.save({ who: 'A', step: 'stale' }); } catch (e) { aErr = e.code; }
  console.log(`J6 A.save inside the window: ${aErr ? 'refused ' + aErr : 'WROTE'}; journal: ${realfs.readFileSync(path, 'utf8').trim()}; lock pid ${JSON.parse(realfs.readFileSync(`${path}.lock`, 'utf8')).pid}`);
  let again = null; try { a.save({ who: 'A', step: 'next' }); } catch (e) { again = e.code; }
  console.log(`J6 A's next save: ${again ? 'refused ' + again : 'WROTE'}`);
});
