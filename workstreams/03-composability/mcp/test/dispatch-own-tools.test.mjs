// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only with its
// own approval, through the repository's key-free guard.
//
// tools/call finds a tool only among the tools' own names (dispatch.mjs toolNamed); everything else is the existing
// "unknown tool" answer (-32602):
//   T1 the eight tools resolve to their own functions
//   T2 inherited names (constructor, __proto__, hasOwnProperty, toString, valueOf, isPrototypeOf, propertyIsEnumerable,
//      toLocaleString, __defineGetter__, __lookupGetter__) are not tools
//   T3 names that are not strings, as JSON gives them (null, numbers, booleans, arrays, objects — one whose own
//      toString is not a function included), or none, are not tools, and the answer text does not throw or echo them
//   T4 server.mjs tools/call uses toolNamed and unknownToolText, and keeps -32602; the old lookup is gone
// KEY-FREE: imports dispatch.mjs (no imports); reads server.mjs as text (not imported). Nothing is sent or fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolNamed, unknownToolText } from '../src/dispatch.mjs';

const NAMES = ['get_connection', 'get_village_status', 'check_resource_shortfall', 'prepare_caravan', 'send_caravan', 'get_operation_status', 'get_run_status', 'list_operations'];
const tools = Object.fromEntries(NAMES.map(n => [n, async () => n])); // the same plain-object shape as server.mjs's map

test('T1 own tools', () => {
  for (const n of NAMES) assert.equal(toolNamed(tools, n), tools[n], n);
});

test('T2 inherited names are not tools', () => {
  for (const n of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupGetter__']) {
    assert.equal(toolNamed(tools, n), null, n);
    assert.equal(unknownToolText(n), `unknown tool ${n}`);
  }
});

test('T3 names that are not strings, or none', () => {
  const odd = JSON.parse('[null, 0, 5, true, false, [], ["get_connection"], {}, {"toString": 1, "valueOf": 1}]');
  for (const v of [undefined, ...odd]) {
    assert.equal(toolNamed(tools, v), null, JSON.stringify(v));
    assert.doesNotThrow(() => unknownToolText(v));
    assert.match(unknownToolText(v), /^unknown tool (undefined|null|number|boolean|array|object)$/);
  }
  assert.equal(unknownToolText('x'.repeat(100)), `unknown tool ${'x'.repeat(40)}`, 'a string is cut at 40 as before');
});

test('T4 wired in tools/call', () => {
  const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ toolNamed, unknownToolText \} from '\.\/dispatch\.mjs';/);
  assert.match(src, /const fn = toolNamed\(tools, name\);\n\s+if \(!fn\) return error\(-32602, unknownToolText\(name\)\);/);
  assert.doesNotMatch(src, /const fn = tools\[name\];/);
});
