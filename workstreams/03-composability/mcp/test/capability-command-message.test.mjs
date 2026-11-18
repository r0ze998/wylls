// (2026-11-18) A write consent without the right capability command is refused with the command THIS relay kind takes
// (auth.mjs capabilityCommandFor). Before, every per-sender relay was told `issue-capability`, which ⑤'s relay
// (`senderCapabilities`, this repository's gateway) does not have; it takes `rotate-capability {source: mcp}`.
// No relay is called: the refusal comes before the owner's command would be forwarded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, OAuthError } from '../src/auth.mjs';
import { JsonStore } from '../src/store.mjs';
import { Sealer } from '../src/seal.mjs';

const issuer = 'http://127.0.0.1:41999';
const calls = [];
const game = { relay: 'http://relay.test', ownerCommand: async x => { calls.push(x); return { status: 500 }; } };
const auth = () => new Auth({ issuer, resource: `${issuer}/mcp`, store: new JsonStore(null), sealer: new Sealer(null), game, allowGlobalRotate: true });
const refusal = async (view, command) => {
  try { await auth().capabilityFromRelay({ owner: 'O', agentId: 'A', view, command, signature: 'x' }); } catch (e) { return e; }
  assert.fail('expected a refusal');
};

for (const [name, view, want, notWant] of [
  ['⑤ relay (senderCapabilities)', { senderCapabilities: {} }, /rotate-capability command \(source mcp\)/, /issue-capability/],
  ['③ 0008 relay (capabilities)', { capabilities: {} }, /issue-capability command \(source mcp\)/, /rotate-capability/],
  ['one capability per agent (opted in)', {}, /rotate-capability command for/, /issue-capability|source mcp/],
]) {
  test(`C1 ${name}: a missing command is refused naming the command this relay takes`, async () => {
    const e = await refusal(view, undefined);
    assert.ok(e instanceof OAuthError);
    assert.equal(e.status, 400);
    assert.match(e.message, want);
    assert.doesNotMatch(e.message, notWant);
  });
}

test('C2 ⑤ relay: the 0008 command (issue-capability) is refused, not forwarded', async () => {
  const e = await refusal({ senderCapabilities: {} }, { op: 'issue-capability', owner: 'O', agentId: 'A', params: { source: 'mcp' } });
  assert.match(e.message, /rotate-capability command \(source mcp\)/);
  assert.equal(calls.length, 0, 'nothing reached the relay');
});
