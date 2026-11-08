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
  '同じ村（holding）','残高は共有しません','ブラウザで計算・予測しません','固定fixture','未知・データなし','生成済みの遊べる土地ではありません','2^62','表示のみ','ホストへは何も送りません',
  // the route chooser is honestly a validation, not a sent march
  '経路を選んで到達可否を検証（行軍は送りません）','ホストが返した州（固定の2州とこのセッションで開いた州）の返却バイトのみ','任意の行き先への行軍は今後の作業です','verify_route',
  // opening land: the real handler, local synthetic records, and what it is not
  'WideOpenProvince','合成リテラル（検証済みビーコン出力ではありません）','製品の規則決定ではありません','ローカルの模擬資金','開き直して書き出しと一致したときだけ導入','まだ行軍先ではなく、無限の土地や同期した世界でもありません'])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/<form|https?:\/\/|style=|<style/);
});
test('page script states the horizon and the demo budget as limits, and sends only fixed intents',async()=>{
 const js=await readFile(resolve(repo,'permutation-gateway/screens/wide-march-local/local.mjs'),'utf8');
 for(const text of ['全世界を同期したシミュレーションではありません','経済操作は時計を進めません','ゲーム規則ではありません','行軍先の指定ではありません',
  '経路検証のみ。行軍は送りません','到達扱いにしません'])assert.ok(js.includes(text),text);
 // the only mutating requests are the client's fixed intents (and an opening of a cell the map offers, whose
 // coordinate strings come from the BigInt camera); the route quote is a non-mutating read
 assert.equal((js.match(/client\.submit\(/g)??[]).length,3);
 assert.ok(js.includes("client.submit({kind})") && js.includes("client.submit({kind:'reset'})"));
 assert.ok(js.includes("client.submit({ kind: 'open_province', p: c.p, q: c.q })"));
 for(const text of ['成功するまで土地として表示しません','事前計算ではありません','ゲーム規則ではありません'])assert.ok(js.includes(text),text);
 assert.equal((js.match(/client\.quote\(/g)??[]).length,1);
 for(const bad of ['fetch(\'/','innerHTML','eval(','new Function','.style.'])assert.ok(!js.includes(bad),bad);
});
