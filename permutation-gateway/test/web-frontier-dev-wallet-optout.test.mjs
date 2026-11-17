// Pure configuration regression. No app boot, wallet code or test setup is imported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../../permutation-server/web/frontier/config.mjs';
const loc = href => new URL(href);

test('local inspection can opt out of automatic Dev Wallet creation', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'player.localhost']) {
    const c = config(loc(`http://${host}:41940/frontier/?devWallet=off`));
    assert.equal(c.dev, true, 'loopback endpoint behavior remains available');
    assert.equal(c.devWallet, false);
  }
});

test('the opt-out preserves existing endpoint and default-wallet behavior', () => {
  const c = config(loc('http://localhost:41940/frontier/?devWallet=off&herald=http://127.0.0.1:41941'));
  assert.equal(c.herald, 'http://127.0.0.1:41941');
  assert.equal(c.devWallet, false);
  for (const query of ['', '?devWallet=on', '?devWallet=0']) {
    assert.equal(config(loc(`http://localhost:41940/frontier/${query}`)).devWallet, undefined);
  }
});

test('a URL can never enable a Dev Wallet on a remote origin', () => {
  for (const value of ['off', 'on', 'true']) {
    const c = config(loc(`https://play.example/frontier/?devWallet=${value}`));
    assert.equal(c.dev, false); assert.equal(c.devWallet, undefined);
  }
});

test('startPlay checks the opt-out before calling the Dev Wallet entrypoint', () => {
  const source = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(cfg\.dev && cfg\.devWallet !== false && pin\?\.cluster === 'localnet'\) await wallet\.enableDevWallet/);
});
