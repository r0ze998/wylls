import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
test('browser import closure has no wallet/router/transaction/network source',async()=>{
 const seen=new Set();async function visit(file){if(seen.has(file))return;seen.add(file);const s=await readFile(file,'utf8');assert.doesNotMatch(file,/\/(controller|app|session|herald|marchbook|fmarch|solana-tx|seal)\.mjs$/);
 for(const m of s.matchAll(/(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)){assert.ok(m[1].startsWith('.'));await visit(resolve(dirname(file),m[1]));}}
 await visit(resolve(repo,'permutation-gateway/screens/wide-march-local/local.mjs'));
 assert.ok(seen.size>=10);
});
test('permanent honest limitations and separate session remain static markup',async()=>{
 const html=await readFile(resolve(repo,'permutation-gateway/screens/wide-march-local/index.html'),'utf8');
 for(const text of ['MOCK AUTH','NO WALLET / CHAIN / REAL TRANSACTION','秘密性はありません','CPI','独立セッション','固定経路'])assert.ok(html.includes(text));
 assert.doesNotMatch(html,/<form|https?:\/\//);
});
