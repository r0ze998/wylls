// The harness page of ws07-v17.screen.mjs: this round's parts of the real client in a real browser, fed FIXTURE
// state (no chain, no relay, no wallet, no key): workstream 20's NFT card as workstream 07 connected it (a list not
// read, a list, an NFT played), the agent page's history with workstream 4's seven send states and a history not read
// again, and the chronicle's read states (loading, not read, older).
import { setLang, lang, L } from '../../../permutation-server/web/lang.mjs';
import { setHtml, html } from '../../../permutation-server/web/util.mjs';
import { renderNfts } from '../../../permutation-server/web/frontier/screens/join.mjs';
import * as chron from '../../../permutation-server/web/frontier/screens/chronicle.mjs';

const q = new URLSearchParams(location.search);
setLang(q.get('lang') === 'en' ? 'en' : 'ja');
document.documentElement.lang = lang();
const en = lang() === 'en';
document.getElementById('title').textContent = en ? 'Workstream 07: this round\'s parts (fixture state)' : '⑦ この回の部品（固定データ）';
document.getElementById('h-nft').textContent = en ? 'Resident NFTs (20)' : '住民NFT（⑳）';
document.getElementById('h-chron').textContent = en ? 'Chronicle read states' : '年代記の読み込みの状態';

const W = { address: 'Wa11et1111111111111111111111111111111111111' };
const A = n => `NFTasset${String(n).repeat(35)}`;
setHtml(document.getElementById('nft'), html`${[
  renderNfts({ wallet: W, nftsRead: { ok: false, code: 'HTTP503' } }),
  renderNfts({ wallet: W, nftsRead: { ok: true }, joinDraft: { faction: 2 }, nfts: { residents: [{ asset: A(1), generation: 3, joined: true }, { asset: A(2), generation: 1, joined: false }, { asset: A(3), generation: null }] } }),
  renderNfts({ wallet: W, resident: { asset: A(1) } }),
]}`);
setHtml(document.getElementById('chron'), html`${[
  chron.render({ chronicle: undefined, chronicleRead: undefined }),
  chron.render({ chronicle: undefined, chronicleRead: { ok: false, code: 'HTTP503' } }),
  chron.render({ chronicle: [], chronicleRead: { ok: false, code: 'network' } }),
]}`);
window.ws07 = { ready: true };
