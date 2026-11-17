// 自分・依頼・協力の進捗の往復（2026-11-17。WRITTEN ONLY, NOT RUN）：crosslinks.mjs と、画面の結線（読むだけ）。
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
