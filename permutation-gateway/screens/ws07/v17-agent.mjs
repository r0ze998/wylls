// The agent page's history (fagent.mjs renderHistory) under the agent page's own stylesheet (agent.css), FIXTURE
// state: one action in each of workstream 4's seven send states (not-sent: a failure before anything was sent, as 04's
// fate route answers for one), and a history not read again. No wallet, no key.
import { setLang, lang } from '../../../permutation-server/web/lang.mjs';
import { setHtml } from '../../../permutation-server/web/util.mjs';
import * as AG from '../../../permutation-server/web/frontier/fagent.mjs';
import { SEND_STATES } from '../../../permutation-server/web/frontier/hud/statusview.mjs';

const q = new URLSearchParams(location.search);
setLang(q.get('lang') === 'en' ? 'en' : 'ja');
document.documentElement.lang = lang();
const history = SEND_STATES.map((s, i) => ({ type: 'action', name: ['Muster', 'Depart', 'Harvest', 'Build', 'Train', 'Explore', 'Settle'][i], status: s === 'not-sent' ? 'failed' : 'sent', ...(s === 'not-sent' ? { code: 'Unavailable' } : {}), key: `k${i}`, at: Date.UTC(2026, 10, 6, 3, i) }));
setHtml(document.getElementById('agent'), AG.renderHistory({ agentId: 'ag1', history }, { fates: new Map(SEND_STATES.map((s, i) => [`k${i}`, s])), read: { ok: false, code: 'HTTP502' } }));
window.ws07 = { ready: true };
