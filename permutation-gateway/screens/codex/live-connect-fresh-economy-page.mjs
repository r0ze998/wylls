// The fresh ECONOMY test page's HTML (static: no value of a run is written into it). Its script is
// live-connect-fresh-economy-page-script.mjs, served by the entry from this same directory. TEST ONLY.
export const E_PAGE_SCRIPT_PATH = '/permutation-gateway/screens/codex/live-connect-fresh-economy-page-script.mjs';
const box = (id, title, text, choice) => `<div class="step" id="${id}-box"><h2>${title}</h2>
<p>${text}</p>
${choice}<button id="${id}" type="button" disabled>Sign and send</button><button id="${id}-status" type="button" disabled>Ask status</button><div class="out" id="${id}-out"></div></div>`;
export const E_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fresh economy test — page-signed Build, Train, Muster, Harvest</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:1.5rem auto;max-width:52rem;padding:0 1rem;color:#1c1c1c;background:#f7f6fb}
h1{font-size:1.3rem;margin:.2rem 0 .6rem}h2{font-size:1.05rem;margin:.2rem 0 .3rem}h3{font-size:1rem;margin:1.2rem 0 .2rem}
.note{border:2px solid #a60;background:#fff7e6;padding:.6rem .8rem;border-radius:6px}
.stop{border:2px solid #a22;background:#fdeaea;padding:.6rem .8rem;border-radius:6px}
dl{display:grid;grid-template-columns:11rem 1fr;gap:.15rem .8rem;margin:.4rem 0}dd{margin:0;font-family:ui-monospace,monospace;word-break:break-all}
button,select,input{font:inherit;padding:.35rem .8rem;margin:.15rem .3rem .15rem 0}button:disabled,select:disabled,input:disabled{opacity:.45}
.step{border:1px solid #c4bfd6;border-radius:6px;padding:.5rem .8rem;margin:.5rem 0;background:#fff}
.out{font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;margin:.3rem 0 0}
#log{font-family:ui-monospace,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-all;border:1px solid #c4bfd6;border-radius:6px;padding:.5rem;background:#fff;max-height:16rem;overflow:auto}
[hidden]{display:none}
</style></head><body>
<h1>Fresh economy test — page-signed Build, Train, Muster, Harvest</h1>
<p class="note" id="note">Test page. Waiting for the entry…</p>
<p class="note">This page builds each command from the values the test runner announces. It is not the game's own screens, and nothing shown here is a player's play. Costs and amounts are not shown or claimed here.</p>
<p class="stop" id="stop" hidden></p>
<dl>
<dt>Phase</dt><dd id="phase">–</dd>
<dt>Time left</dt><dd id="left">–</dd>
<dt>Test wallet (public key)</dt><dd id="wallet">–</dd>
<dt>Runner announced</dt><dd id="steps">–</dd>
<dt>Sending</dt><dd id="send">–</dd>
<dt>Now</dt><dd id="now">–</dd>
</dl>
<h3>Prerequisites (not this test's evidence)</h3>
${box('join', 'Join (prerequisite)', 'Joins the chosen nation with this page\'s test key (fee payer, player and its own session).', '<label>Nation <select id="join-nation" disabled></select></label>')}
${box('placehome', 'PlaceHome (prerequisite)', 'Founds the home village at one of the free sites the runner announced.', '<label>Site <select id="placehome-site" disabled></select></label>')}
<h3>The four commands of this test</h3>
${box('build', '1. Build', 'One of the announced first buildings. When sent and landed it is accepted and queued; it completes at the first command of the village at or after its done-at time.', '<label>Item <select id="build-item" disabled></select></label>')}
${box('train', '2. Train', 'Trains the announced number of one announced unit: they go to the village\'s reserve at once.', '<label>Unit <select id="train-unit" disabled></select></label>')}
${box('muster', '3. Muster', 'Asks to form up troops of the trained unit on an announced tile. In this test it is accepted only: a pending entry.', '<label>Troops <input id="muster-troops" type="number" step="1" disabled></label><label>Tile <select id="muster-tile" disabled></select></label>')}
${box('harvest', '4. Harvest', 'Announced once the Build\'s done-at time has passed. Accepted; no amount is claimed.', '')}
<h3>Log</h3><div id="log"></div>
<script type="module" src="${E_PAGE_SCRIPT_PATH}"></script>
</body></html>`;
