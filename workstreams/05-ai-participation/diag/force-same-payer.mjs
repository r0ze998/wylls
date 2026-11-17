// Test-only preload: every fee-payer draw of the relay's pool returns the same payer (the worst case of the random draw).
//   node --import ./workstreams/05-ai-participation/diag/force-same-payer.mjs --test ...
import { PayerPool } from '../../../permutation-gateway/src/frontier/payers.mjs';
PayerPool.prototype.draw = function draw() { return this.keys[0]; };
