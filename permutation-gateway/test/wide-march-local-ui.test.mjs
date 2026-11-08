import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_FILES } from '../screens/wide-march-local/local-server.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const screen=resolve(repo,'permutation-gateway/screens/wide-march-local');
test('browser import closure has no wallet/router/transaction/network source, and every screen file in it is served',async()=>{
 const seen=new Set();async function visit(file){if(seen.has(file))return;seen.add(file);const s=await readFile(file,'utf8');assert.doesNotMatch(file,/\/(controller|app|session|herald|marchbook|fmarch|solana-tx|seal)\.mjs$/);
 for(const m of s.matchAll(/(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)){assert.ok(m[1].startsWith('.'));await visit(resolve(dirname(file),m[1]));}}
 await visit(resolve(screen,'local.mjs'));
 assert.ok(seen.size>=12);
 const own=[...seen].filter(f=>f.startsWith(screen+'/')).map(f=>relative(screen,f));
 for(const f of own)assert.ok(LOCAL_FILES.includes(f),`${f} is imported by the page but not served`);
 for(const f of ['local-receipts.mjs','local-route.mjs','local-evidence.mjs'])assert.ok(own.includes(f),f);
});
test('permanent honest limitations and separate session remain static markup',async()=>{
 const html=await readFile(resolve(screen,'index.html'),'utf8');
 for(const text of ['MOCK AUTH','NO WALLET / CHAIN / REAL TRANSACTION','秘密性はありません','CPI','独立セッション','固定経路',
  '同じ村（holding）','残高は共有しません','ブラウザで計算・予測しません','固定fixture','未知・データなし','生成済みの遊べる土地ではありません','2^62','表示のみ','ホストへは何も送りません','verify_route',
  'WideOpenProvince','合成リテラル（検証済みビーコン出力ではありません）','製品の規則決定ではありません','ローカルの模擬資金','開き直して書き出しと一致したときだけ導入','無限の土地や同期した世界ではありません',
  // v4: the chosen march, its exact limits, and what it is not
  '経路を選んで検証し、明示的に出発する','検証しても行軍は送りません','depart_route','送るのは検証した方向と表示中のリビジョンだけです','捨てるコピーで予行','固定経路への置き換えや自動の再送はしません',
  '出発元・固定fixtureの到着先・解決履歴のある州への出発、bell 20 以外の到着、留まる以外の到着結果は未対応です','到着 bell 20 のみ・リング129のみ・最大4州',
  '公開のテスト素材から作り直した命令（だれでも開けます。秘密性・署名はありません）','合成の非到着ビーコン対','時計は戻しません','チェーン実行・署名済み命令・秘匿命令・同期した世界ではありません','交戦0回も正当な結果'])assert.ok(html.includes(text),text);
 // the v3 statements that v4 makes untrue are gone
 for(const stale of ['任意の行き先への行軍は今後の作業です','まだ行軍先ではなく','自由な行軍先指定は未対応','経路を選んで到達可否を検証（行軍は送りません）'])assert.ok(!html.includes(stale),stale);
 assert.doesNotMatch(html,/<form|https?:\/\/|style=|<style/);
});
test('page script states its limits, sends only fixed intents, and sends a chosen march only by its one explicit button',async()=>{
 const js=await readFile(resolve(screen,'local.mjs'),'utf8');
 for(const text of ['全世界を同期したシミュレーションではありません','経済操作は時計を進めません','ゲーム規則ではありません','行軍先の指定ではありません',
  '検証は読み取りのみ。行軍は送りません','到達扱いにしません','これは検証だけで、行軍はまだ送っていません','ブラウザは命令の封印を開かず認証もしません','合成の非到着ビーコン対','チェーン実行・署名済み命令・秘匿命令・同期した世界ではありません',
  'LOCAL SIMULATION','MOCK AUTH','PUBLIC ORDER MATERIAL','SYNTHETIC PREPARATION','受領記録の中身の事実やダイジェストは再計算しません'])assert.ok(js.includes(text),text);
 assert.equal((js.match(/client\.submit\(/g)??[]).length,3);
 assert.ok(js.includes("client.submit({kind})") && js.includes("client.submit({kind:'reset'})"));
 assert.ok(js.includes("client.submit({ kind: 'open_province', p: c.p, q: c.q })"));
 for(const text of ['成功するまで土地として表示しません','事前計算ではありません'])assert.ok(js.includes(text),text);
 // the quote is a read; the chosen march is sent by exactly one handler, gated on the current reachable quote
 assert.equal((js.match(/client\.quote\(/g)??[]).length,1);
 assert.equal((js.match(/client\.departRoute\(/g)??[]).length,1);
 assert.ok(js.includes("$('route-depart-btn').addEventListener('click', () => { if (chosenSend(client.snapshot).can) client.departRoute(); });"));
 assert.ok(js.includes("$('route-quote-btn').addEventListener('click', () => { if (chosen) client.quote(chosen); });"),'a quote never departs');
 // depart_route needs directions: no generic step button for it
 assert.ok(js.includes("k!=='depart_route'"));
 // the march panel shows the host's tokens verbatim
 for(const t of ['b.order.labels','p.labels','b.trail','b.accounts'])assert.ok(js.includes(t),t);
 for(const bad of ['fetch(\'/','innerHTML','eval(','new Function','.style.','setTimeout(','setInterval('])assert.ok(!js.includes(bad),bad);
});
test('the client sends a chosen march only from the current quote and never retries it',async()=>{
 const js=await readFile(resolve(screen,'local-client.mjs'),'utf8');
 assert.ok(js.includes("if (intent?.kind === 'depart_route' && fromQuote === null)"),'a free depart_route intent is refused locally');
 assert.ok(js.includes('bindingMatchesQuote(r.parsed.marchBinding, fromQuote.dirs, fromQuote.quote)'));
 // exactly two POST sites (a submission and a quote), each sent once per call: no resend loop, no extra fields
 assert.equal((js.match(/send\('POST'/g)??[]).length,2);
 assert.ok(js.includes("['depart_route', { expectedRevision: revision, dirs: intent.dirs }]"));
});
