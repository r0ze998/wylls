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
 for(const text of ['MOCK AUTH','NO WALLET / CHAIN / REAL TRANSACTION','秘密性はありません','CPI','独立セッション','固定経路',
  '同じ村（holding）','残高は共有しません','ブラウザで計算・予測しません','固定fixture','未知・データなし','生成済みの遊べる土地ではありません','2^62','表示のみ','ホストへは何も送りません'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/<form|https?:\/\/|style=|<style/);
});
test('page script states the horizon and the demo budget as limits, and sends only fixed intents',async()=>{
 const js=await readFile(resolve(repo,'permutation-gateway/screens/wide-march-local/local.mjs'),'utf8');
 for(const text of ['全世界を同期したシミュレーションではありません','経済操作は時計を進めません','ゲーム規則ではありません','行軍先の指定ではありません'])assert.ok(js.includes(text),text);
 // the only requests are the client's fixed intents; camera controls never reach the client
 assert.equal((js.match(/client\.submit\(/g)??[]).length,2);
 assert.ok(js.includes("client.submit({kind})") && js.includes("client.submit({kind:'reset'})"));
 for(const bad of ['fetch(\'/','innerHTML','eval(','new Function','.style.'])assert.ok(!js.includes(bad),bad);
});
