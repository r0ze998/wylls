// 自分・依頼・協力の進捗の往復（2026-11-17）：crosslinks.mjs と、画面の結線（読むだけ）。
// 2026-11-18：coordinator's final rerun, including the blank and padded-string fixtures — 7/7 passed, 0 fail/skip.
// 鍵・署名・送信・HTTP・起動なし。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sameCtx, jointOfRequest, requestsOfJoint, personalLinks } from '../coop/crosslinks.mjs';

const NOW = { programId: 'P', seasonId: '90' }, OLD = { programId: 'P', seasonId: '89' };
const G = 'crossing-storehouse-v1';
const req = (id, requester, ctx = NOW, o = {}) => ({ id, goalId: G, requester, ctx, stateNow: 'open', responses: {}, ...o });
const view = (requests, joint, personal = null) => ({ requests, joint, personal });

test('a request links to the one joint progress of its goal and requester, in this world only', () => {
  const v = view([req('r1', 'A'), req('r2', 'A', NOW, { stateNow: 'expired' }), req('r3', 'B')], [{ goalId: G, host: 'A' }, { goalId: G, host: 'B' }]);
  assert.deepEqual(jointOfRequest(v, v.requests[0], NOW), { state: 'one', goalId: G, host: 'A' });
  assert.deepEqual(jointOfRequest(v, v.requests[1], NOW), { state: 'one', goalId: G, host: 'A' }, 'a closed request too');
  assert.deepEqual(requestsOfJoint(v, v.joint[0], NOW), { state: 'ok', ids: ['r1', 'r2'] });
  assert.deepEqual(requestsOfJoint(v, v.joint[1], NOW), { state: 'ok', ids: ['r3'] });
});

test('not linked when it cannot be one: another world, a progress with an older world mixed in, none, two, or not readable', () => {
  const mixed = view([req('r1', 'A'), req('r0', 'A', OLD)], [{ goalId: G, host: 'A' }]);
  assert.equal(jointOfRequest(mixed, mixed.requests[0], NOW).state, 'mixed');
  assert.equal(jointOfRequest(mixed, mixed.requests[1], NOW).state, 'other-world');
  assert.equal(requestsOfJoint(mixed, mixed.joint[0], NOW).state, 'mixed');
  assert.equal(jointOfRequest(view([req('r1', 'A')], []), req('r1', 'A'), NOW).state, 'none');
  assert.equal(jointOfRequest(view([req('r1', 'A')], [{ goalId: G, host: 'A' }, { goalId: G, host: 'A' }]), req('r1', 'A'), NOW).state, 'ambiguous');
  assert.equal(jointOfRequest(view([req('r1', 'A')], undefined), req('r1', 'A'), NOW).state, 'ambiguous');
  assert.equal(jointOfRequest(view([], [{ goalId: G, host: 'A' }]), req('r9', 'A'), NOW).state, 'ambiguous', 'the request is not among the progress requests');
  assert.equal(jointOfRequest(view([req('r1', 'A', null)], [{ goalId: G, host: 'A' }]), req('r1', 'A', null), NOW).state, 'other-world', 'no world named');
  // the same coordinates or another goal are never guessed into the same progress
  const other = view([req('r1', 'A', NOW, { goalId: 'other' })], [{ goalId: G, host: 'A' }]);
  assert.equal(jointOfRequest(other, other.requests[0], NOW).state, 'none');
  assert.equal(requestsOfJoint(view([], [{ goalId: G, host: 'A' }]), { goalId: G, host: 'A' }, NOW).state, 'none');
  assert.equal(sameCtx({ programId: 'P', seasonId: 90 }, NOW), true);
  assert.equal(sameCtx({ programId: 'Q', seasonId: '90' }, NOW), false);
});

test('(2026-11-18) a world that cannot be read is never the same world: unknown, both ways', () => {
  // the coordinator's repro: board season {programId:'P'} (no seasonId) and requests with the same missing seasonId
  const noSeason = { programId: 'P' };
  const v = view([req('r', 'A', noSeason)], [{ goalId: G, host: 'A' }]);
  assert.equal(jointOfRequest(v, v.requests[0], noSeason).state, 'other-world', 'forward: missing season on both sides is not one');
  assert.equal(requestsOfJoint(v, v.joint[0], noSeason).state, 'mixed', 'reverse: not ok');
  for (const [c, s, why] of [
    [{ programId: 'P' }, { programId: 'P' }, 'both seasonId missing'],
    [{ programId: 'P', seasonId: null }, { programId: 'P', seasonId: null }, 'both null'],
    [{ programId: 'P', seasonId: undefined }, { programId: 'P', seasonId: null }, 'undefined vs null'],
    [{ programId: 'P', seasonId: '' }, { programId: 'P', seasonId: '' }, 'both empty'],
    [{ programId: 'P', seasonId: 'undefined' }, { programId: 'P' }, 'the string "undefined" vs missing'],
    [{ programId: 'P', seasonId: 'null' }, { programId: 'P', seasonId: null }, 'the string "null" vs null'],
    [{ programId: '', seasonId: '90' }, { programId: '', seasonId: '90' }, 'empty programId'],
    [{ seasonId: '90' }, { seasonId: '90' }, 'missing programId'],
    [{ programId: 'P', seasonId: { toString: () => '90' } }, NOW, 'an object is not coerced'],
    [{ programId: 'P', seasonId: ['90'] }, NOW, 'an array is not coerced'],
    [{ programId: 'P', seasonId: NaN }, { programId: 'P', seasonId: NaN }, 'NaN'],
    [{ programId: 'P', seasonId: Infinity }, { programId: 'P', seasonId: 'Infinity' }, 'Infinity'],
    [{ programId: 'P', seasonId: true }, { programId: 'P', seasonId: 'true' }, 'boolean'],
    [{ programId: 'P', seasonId: ' ' }, { programId: 'P', seasonId: ' ' }, 'space-only seasonId'],
    [{ programId: 'P', seasonId: '\t' }, { programId: 'P', seasonId: '\t' }, 'tab-only seasonId'],
    [{ programId: 'P', seasonId: ' \t ' }, { programId: 'P', seasonId: ' \t ' }, 'space/tab seasonId'],
    [{ programId: ' ', seasonId: '90' }, { programId: ' ', seasonId: '90' }, 'space-only programId'],
    [{ programId: '\t', seasonId: '90' }, { programId: '\t', seasonId: '90' }, 'tab-only programId'],
    [{ programId: 'P', seasonId: ' 90' }, NOW, 'padded season is not normalized'],
    [{ programId: 'P\t', seasonId: '90' }, NOW, 'padded program is not normalized'],
  ]) {
    assert.equal(sameCtx(c, s), false, why);
    assert.equal(sameCtx(s, c), false, `${why} (swapped)`);
    const w = view([req('r', 'A', c)], [{ goalId: G, host: 'A' }]);
    assert.notEqual(jointOfRequest(w, w.requests[0], s).state, 'one', `forward: ${why}`);
    assert.notEqual(requestsOfJoint(w, w.joint[0], s).state, 'ok', `reverse: ${why}`);
  }
});

test('(2026-11-18) known worlds still link: numeric and string season, and zero', () => {
  for (const [c, s, why] of [
    [{ programId: 'P', seasonId: 90 }, NOW, 'number 90 vs string "90"'],
    [NOW, { programId: 'P', seasonId: 90 }, 'string "90" vs number 90'],
    [{ programId: 'P', seasonId: 0 }, { programId: 'P', seasonId: '0' }, 'zero, number vs string'],
    [{ programId: 'P', seasonId: '0' }, { programId: 'P', seasonId: '0' }, 'zero, strings'],
    [{ programId: 'P', seasonId: 0 }, { programId: 'P', seasonId: 0 }, 'zero, numbers'],
    [{ programId: 'P', seasonId: ' 90' }, { programId: 'P', seasonId: ' 90' }, 'non-blank strings compare as they are (trim only tests blankness)'],
  ]) {
    assert.equal(sameCtx(c, s), true, why);
    const w = view([req('r', 'A', c)], [{ goalId: G, host: 'A' }]);
    assert.deepEqual(jointOfRequest(w, w.requests[0], s), { state: 'one', goalId: G, host: 'A' }, `forward: ${why}`);
    assert.deepEqual(requestsOfJoint(w, w.joint[0], s), { state: 'ok', ids: ['r'] }, `reverse: ${why}`);
  }
  assert.equal(sameCtx({ programId: 'P', seasonId: 89 }, NOW), false, 'a different known season is still another world');
});

test('my requests and answers link to the requests shown, by id; a missing one says so', () => {
  const v = view([req('r1', 'Me'), req('r2', 'A', NOW, { stateNow: 'cancelled' })], [], {
    myRequests: [{ id: 'r1' }, { id: 'gone' }],
    myResponses: [{ id: 'r2', response: { answer: 'accept', withdrawn: true } }],
  });
  assert.deepEqual(personalLinks(v), {
    requests: [{ id: 'r1', found: true, state: 'open' }, { id: 'gone', found: false, state: null }],
    responses: [{ id: 'r2', found: true, state: 'cancelled', answer: 'accept', withdrawn: true }],
  });
  assert.equal(personalLinks(view([], [], null)), null, 'no viewer: nothing');
});

const ui = readFileSync(new URL('../coop/coop-ui.mjs', import.meta.url), 'utf8');
const xl = readFileSync(new URL('../coop/crosslinks.mjs', import.meta.url), 'utf8');
const between = (a, b) => ui.slice(ui.indexOf(a), ui.indexOf(b, ui.indexOf(a)));

test('the page: links only move within the page; nothing is sent, linked, posted or read', () => {
  const nav = between('function onNav(e) {', '\n}\n');
  for (const src of [nav, xl, between('function jointRequestsHtml(j) {', '\n}\n'), between('function personalLinksHtml() {', '\n}\n'), between('function requestLinksHtml(q, mine, resp) {', '\n}\n')]) {
    assert.doesNotMatch(src, /post\(|followSend\(|sendOnce\(|sendFor\(|sendPlanned\(|signRecord\(|fetch\(|api\(|apiRead\(|refresh\(/);
  }
  assert.match(nav, /\[\.\.\.document\.querySelectorAll\('#requests \.req'\)\]\.find\(x => x\.dataset\.req === b\.dataset\.target\)/, 'compared as data, never put in a selector');
  assert.match(nav, /x\.dataset\.goal === b\.dataset\.goal && x\.dataset\.host === b\.dataset\.host/);
  assert.match(ui, /for \(const id of \['joint', 'personal', 'requests'\]\) \$\(id\)\.addEventListener\('click', onNav\);/);
  assert.equal((ui.match(/document\.addEventListener\('click'/g) ?? []).length, 1, 'the action handler stays the only document click handler');
});

test('the page: every request, the joint progress and my section show the links or why not', () => {
  assert.match(ui, /\n      \$\{requestLinksHtml\(q, mine, resp\)\}\n      <div class="row">/, 'on every request, outside the open/accepted conditions');
  assert.match(ui, /<div class="req" data-host="\$\{esc\(j\.host\)\}" data-goal="\$\{esc\(j\.goalId\)\}">/);
  assert.match(ui, /\$\{jointRequestsHtml\(j\)\}/);
  assert.match(ui, /\$\{personalLinksHtml\(\)\}/);
  assert.match(between('function requestLinksHtml(q, mine, resp) {', '\n}\n'), /協力の進捗とは結ばない：\$\{esc\(j\.why\)\}/);
  assert.match(between('function personalLinksHtml() {', '\n}\n'), /いまの表示にない/);
});
