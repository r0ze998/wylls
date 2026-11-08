// ⑯ third round on ⑥'s journal lock (⑥ 5f74a270): J7, the lock file removed out of band (a temp-directory cleaner,
// an operator's cleanup) while its holder is ALIVE. No liveness answer is wrong here: `alive` and `startOf` are the
// real process table (not injected), so this is ⑥'s own condition for "J6 needs a lying alive". Keyless; temp files.
import test from 'node:test';
import * as realfs from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
globalThis.__v16exec = execFileSync;
const { fileJournal } = await import(process.env.V16_WS06_DISPATCH);
const fresh = () => join(mkdtempSync(join(tmpdir(), 'v16-ws06c-')), 'journal.json');

test('J7a the lock is removed while A holds it: does a second opener get in, and does A notice?', () => {
  const path = fresh();
  const a = fileJournal(path, realfs);                 // this process, real liveness
  a.save({ who: 'A', step: 1 });
  realfs.rmSync(`${path}.lock`);                        // out of band (cleaner / operator)
  let b = null, bErr = null;
  // a second writer in ANOTHER process: a worker thread has the same pid, so use a child process instead
  const child = realfs.writeFileSync(join(path + '.child.mjs'), `
    import * as fs from 'node:fs';
    const { fileJournal } = await import(${JSON.stringify(process.env.V16_WS06_DISPATCH)});
    try { const b = fileJournal(${JSON.stringify(path)}, fs); b.save({ who: 'B', step: 'sent' }); console.log('B opened and wrote'); }
    catch (e) { console.log('B refused ' + (e.code ?? e.message)); }
  `);
  const { execFileSync } = await_import();
  const out = execFileSync(process.execPath, [path + '.child.mjs'], { encoding: 'utf8' }).trim();
  let aErr = null; try { a.save({ who: 'A', step: 2 }); } catch (e) { aErr = e.code; }
  console.log(`J7a B: ${out}; A's next save: ${aErr ? 'refused ' + aErr : 'WROTE'}; journal: ${realfs.readFileSync(path, 'utf8').trim()}`);
});

function await_import() { return { execFileSync: globalThis.__v16exec }; }

test('J7b the lock is removed inside A\'s save window (after its fence check): liveness real, nothing injected but the timing', () => {
  const path = fresh();
  const childFile = path + '.childb.mjs';
  realfs.writeFileSync(childFile, `
    import * as fs from 'node:fs';
    const { fileJournal } = await import(${JSON.stringify(process.env.V16_WS06_DISPATCH)});
    try { const b = fileJournal(${JSON.stringify(path)}, fs); b.save({ who: 'B', step: 'sent' }); console.log('B opened and wrote'); }
    catch (e) { console.log('B refused ' + (e.code ?? e.message)); }
  `);
  let armed = false, bOut = null;
  const fsA = new Proxy(realfs, { get(t, k) {
    if (k !== 'openSync') return t[k];
    return (p, ...r) => {
      if (armed && String(p).startsWith(path + '.') && String(p).endsWith('.tmp') && !String(p).includes('.lock')) {
        armed = false;
        t.rmSync(`${path}.lock`, { force: true });                       // the cleaner, at this moment
        bOut = globalThis.__v16exec(process.execPath, [childFile], { encoding: 'utf8' }).trim();
      }
      return t.openSync(p, ...r);
    };
  } });
  const a = fileJournal(path, fsA);                                       // real liveness: no alive, no startOf
  a.save({ who: 'A', step: 1 });
  armed = true;
  let aErr = null; try { a.save({ who: 'A', step: 'stale' }); } catch (e) { aErr = e.code; }
  console.log(`J7b B: ${bOut}; A's save in the window: ${aErr ? 'refused ' + aErr : 'WROTE'}; journal: ${realfs.readFileSync(path, 'utf8').trim()}`);
});
