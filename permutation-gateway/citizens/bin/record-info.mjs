// What the operator needs on screen during the recording run (`ai-citizens-run.sh --seat-live`; docs/frontier/ai-citizens/RECORDING-RUN.md):
// the page addresses, where the presenter key is and how to copy it, the council timeline in bells and minutes after genesis, what not to
// do, and how to stop. It prints text only: it reads the citizens config for the council geometry and starts nothing. Local addresses only.
//
//   node record-info.mjs --config CITIZENS.json --run-id ID --serve http://127.0.0.1:41902 --keys DIR --stop-file FILE --hold SECS --scale N [--periods 3] [--date YYYY-MM-DD]
//   node record-info.mjs --urls-only --run-id ID --serve URL --keys DIR --stop-file FILE --hold SECS     (the shorter block printed while the stack is held)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { councilSchedule, PRESENTER_KEY_FILE } from '../ab/seat.mjs';

const PAGE_PATH = 'council.html';
const MAP_PATH = 'frontier/frontier/spectate.html?art=1'; // the herald's latest client under the serve proxy (RUNTREE-NOTES section 8)

/** The info block as an array of lines (pure: the tests read it). `date` is the YYYY-MM-DD for the page's `?recorded=` banner date. */
export function infoLines({ runId, serve, keys, stopFile, hold = 0, scale = 10, config = {}, periods = 3, date = null, urlsOnly = false }) {
  const base = String(serve).replace(/\/+$/, '');
  const keyFile = path.join(keys, PRESENTER_KEY_FILE);
  const q = date ? `?recorded=${date}` : '';
  const L = [];
  L.push(`=== RECORDING RUN (live seat), run ${runId} ===`);
  L.push(`council page   ${base}/${PAGE_PATH}${q}   (nation 0 is Aster: the tab is selected for the presenter)`);
  L.push(`map            ${base}/${MAP_PATH}`);
  L.push(`presenter key  ${keyFile}`);
  L.push(`  copy it without showing it:  pbcopy < ${keyFile}   then paste into "Presenter key" on the page and press "Use this key"`);
  L.push('  (the file holds the seat\'s session key only, no wallet secret; the seat process writes it about a minute after the start; the page keeps the key in memory only: a reload needs it pasted again)');
  if (!urlsOnly) {
    const bellMin = (Number(config.time?.bell_secs ?? 600) / Number(scale || config.time?.scale || 10)) / 60;
    const fmt = (b) => `bell ${b} (+${Math.round(b * bellMin * 10) / 10} min)`;
    L.push(`council timeline (1 bell = ${Math.round(bellMin * 100) / 100} real minute(s) at ${scale}x; bell 0 = genesis, about 2 minutes after this script started; "+N min" counts from genesis):`);
    for (let k = 1; k <= periods; k++) {
      const c = councilSchedule(config.council, k);
      L.push(`  period ${k}: C0 ${fmt(c.c0)}; motions bells ${c.motions_from}-${c.motions_to}; BALLOT WINDOW bells ${c.ballots_from}-${c.ballots_to} (${fmt(c.ballots_from)} to ${fmt(c.close)}); strike ${fmt(c.strike)}; the order opens ${fmt(c.opens)}`);
    }
    L.push('  The seat\'s village is expected to become final at about bell 35 (pilot ai-pilot-A1): period 1 (bell 24) is then not votable for nation 0, the first votable council is period 2.');
    L.push('  A [seat] line below says when each council opens, when the ballot window opens and how it closed.');
    L.push('NOT to do: do not start the scripted seat (--seat-script or the A/B seat): it would cast an origin-2 ballot and mark the seat "scripted". This run\'s seat casts no ballot; only your ballot on the page counts as the live human ballot.');
    L.push('NOT to do: do not close this terminal or press Ctrl-C before you have finished recording: that stops the stack.');
  }
  L.push(hold > 0
    ? `stop: after the run is complete the stack stays up for at most ${hold} s; end it earlier with:  touch ${stopFile}   (or Ctrl-C in this terminal)`
    : 'stop: no --hold was given: the stack stops as soon as the run is complete (Ctrl-C stops it at any time)');
  return L;
}

function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
if (isMain()) {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { if (argv[i] === '--urls-only') a['urls-only'] = '1'; else a[argv[i].slice(2)] = argv[++i]; }
  for (const k of ['run-id', 'serve', 'keys', 'stop-file']) if (!a[k]) { console.error(`record-info: --${k} is required`); process.exit(2); }
  let config = {};
  if (a.config) { try { config = JSON.parse(fs.readFileSync(path.resolve(a.config), 'utf8')); } catch { config = {}; } }
  const d = new Date();
  const date = a.date ?? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  for (const l of infoLines({ runId: a['run-id'], serve: a.serve, keys: path.resolve(a.keys), stopFile: path.resolve(a['stop-file']), hold: Number(a.hold ?? 0), scale: Number(a.scale ?? 10), config, periods: Number(a.periods ?? 3), date, urlsOnly: a['urls-only'] === '1' })) console.log(l);
}
