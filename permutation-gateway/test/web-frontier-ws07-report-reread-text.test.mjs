// ⑦ a battle report that could not be read can be asked for again from where it failed (Lane C, 2026-11-17): entry
// (報告 from the tracker, a notice, the inspector) → being read → not read → the same request again, or the place on the
// map → the report. WRITTEN, NOT RUN. KEY-FREE and import-free beyond node:test / node:assert / node:fs: app.mjs,
// screens/report.mjs and the English dictionary are read as TEXT, not imported.
//   Expected, case by case:
//   P1 the read fails: the report page says it could not be read (with the code) and that this is not "no clash", and
//      offers "load again" (the same province and turn) and "see it on the map"; 戻る stays in its head
//   P2 "load again": openReport makes a new request — being read, then the report or the failure again; an earlier
//      request that answers late is dropped (its report object is not the open one)
//   P3 another world while it is read: the report is closed, not shown as this world's (openReport's own check)
//   P4 "see it on the map": the existing goto — it leaves the report and goes to the place
//   P5 checking the report in this browser was already recoverable: verifyClash never rejects and its button stays
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = f => readFileSync(new URL(`../../permutation-server/web/${f}`, import.meta.url), 'utf8');
const app = read('frontier/app.mjs'), rep = read('frontier/screens/report.mjs'), en = read('lang/en-frontier-play.mjs');
const order = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };

test('P1 the failed report: not read, not "no clash", two ways on', () => {
  const at = rep.indexOf('if (r.error) return html`'), block = rep.slice(at, rep.indexOf('const rep = r.clash?.report ?? {};', at));
  order(block, '${head}', 'L`報告を読めませんでした（${r.error}）`', 'L`戦いがなかったという意味ではありません。もう一度読み込めます。`',
    'data-act="report-open" data-p="${r.p}" data-q="${r.q}" data-bell="${r.bell}"', 'L`もう一度読み込む`', 'data-act="goto" data-p="${r.p}" data-q="${r.q}"', 'L`地図で見る`');
  assert.ok(rep.includes('data-act="report-close">${icon(\'return\')}${L`戻る`}</button>'), 'the way back stays in the head');
  for (const k of ['戦いがなかったという意味ではありません。もう一度読み込めます。', 'もう一度読み込む']) {
    const line = en.split('\n').find(l => l.startsWith(`  '${k}':`));
    assert.ok(line, k);
    assert.doesNotMatch(line.split("': ")[1], /\b(settle[ds]?|settling|keeper|beacon|seed)\b/i);
  }
});

test('P2 P3 the same request again keeps openReport\'s own checks', () => {
  assert.ok(app.includes("'report-open': d => openReport(num(d.p), num(d.q), num(d.bell)),"));
  const at = app.indexOf('export async function openReport(p, q, bell) {'), or = app.slice(at, app.indexOf('\n}\n', at) + 2);
  order(or, 'const world = reportWorld();', 'const rep = { p, q, bell, loading: true, world };', 'FS.report = rep; FS.practice = null;', 'const r = await heraldRef.clash(p, q, bell);',
    'if (FS.report !== rep) return;', "if (reportWorld() !== world) { FS.report = null; invalidate('panel'); return; }",
    "FS.report = r.ok ? { p, q, bell, world, clash: r } : { p, q, bell, world, error: r.code ?? 'Error' };");
});

test('P4 the place on the map: the existing way', () => {
  assert.ok(app.includes("goto: d => { leaveReport(); closeResPop(); goToItem({ p: num(d.p), q: num(d.q), tab: 'map' }); },"));
});

test('P5 checking was already recoverable', () => {
  assert.ok(rep.includes(' * why?, detail?}}, args?, outcome?, digest?, builder?}`. Never rejects.'));
  assert.ok(rep.includes('data-act="report-verify" ${raw(r.verifying ? \'disabled\' : \'\')}>'));
});
