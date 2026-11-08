// ⑯ independent challenge of ⑥'s journal lock (workstreams/06-creation/src/connect/dispatch.mjs fileJournal,
// ⑥ 7232c86b in ④'s 4d44f021). fileJournal takes an injected `fs` and `alive`, so two processes' interleaving
// is reproduced deterministically in one test. Keyless: JSON files in a fresh temp dir; no key, no network.
// Each case RECORDS what happens (console) and asserts only the fail-closed control (J4).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as realfs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { fileJournal } = await import(process.env.V16_WS06_DISPATCH);

const fresh = () => join(mkdtempSync(join(tmpdir(), 'v16-ws06-')), 'journal.json');
const lockOf = p => realfs.readFileSync(`${p}.lock`, 'utf8').trim();

test('J1 two restarts after a crash, interleaved: does more than one process hold the journal?', () => {
  const path = fresh();
  realfs.writeFileSync(`${path}.lock`, '999\n'); // the crashed holder
  const dead = p => p !== 999;
  let b = null;
  let once = false;
  // A's fs: right after A reads the stale holder, B runs its whole open (it reads the same stale holder).
  const fsA = new Proxy(realfs, { get(t, k) {
    if (k !== 'readFileSync') return t[k];
    return (p, ...r) => { const v = t.readFileSync(p, ...r); if (!once && p === `${path}.lock`) { once = true; b = fileJournal(path, realfs, { pid: 222, alive: dead }); } return v; };
  } });
  let a = null, aErr = null;
  try { a = fileJournal(path, fsA, { pid: 111, alive: dead }); } catch (e) { aErr = e.code ?? e.message; }
  console.log(`J1 A opened: ${!!a}${aErr ? ' (' + aErr + ')' : ''}; B opened: ${!!b}; lock file now holds pid ${lockOf(path)}`);
  if (a && b) {
    a.save({ who: 'A' }); b.save({ who: 'B' });
    console.log(`J1 both wrote; the journal holds ${realfs.readFileSync(path, 'utf8').trim()} (A's state was overwritten without A knowing)`);
  }
});

test('J2 the same process opens the journal twice: is the second open refused?', () => {
  const path = fresh();
  const j1 = fileJournal(path, realfs, { pid: 111, alive: () => true });
  let j2 = null, e2 = null;
  try { j2 = fileJournal(path, realfs, { pid: 111, alive: () => true }); } catch (e) { e2 = e.code; }
  console.log(`J2 second open in the same pid: ${j2 ? 'ACCEPTED (two writers in one process)' : 'refused ' + e2}`);
  j1.close(); j2?.close();
});

test('J3 a writer whose lock was taken over keeps saving: is it fenced?', () => {
  const path = fresh();
  const a = fileJournal(path, realfs, { pid: 111, alive: () => true });
  // B decides A is gone (a hung A, or a reused pid answering "dead") and takes the lock over.
  const b = fileJournal(path, realfs, { pid: 222, alive: p => p === 222 });
  b.save({ who: 'B', step: 'sent' });
  let aErr = null;
  try { a.save({ who: 'A', step: 'stale' }); } catch (e) { aErr = e.code ?? e.message; }
  console.log(`J3 A.save after the takeover: ${aErr ? 'refused ' + aErr : 'ACCEPTED'}; journal: ${realfs.readFileSync(path, 'utf8').trim()}; lock: ${lockOf(path)}`);
});

test('J4 control: a live holder in another process is refused (JournalLocked)', () => {
  const path = fresh();
  const a = fileJournal(path, realfs, { pid: 111, alive: () => true });
  assert.throws(() => fileJournal(path, realfs, { pid: 222, alive: () => true }), e => e.code === 'JournalLocked');
  a.close();
  assert.equal(realfs.existsSync(`${path}.lock`), false);
});
