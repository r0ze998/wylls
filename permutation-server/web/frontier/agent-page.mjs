// Boots agent.html: the herald at this origin, the relay at /gw, the wallet
// modules shared with the play page. Nothing runs at import time elsewhere.
import * as wallet from '../wallet.mjs';
import * as fsession from './fsession.mjs';
import * as fprize from './fprize.mjs';
import { createHerald } from './herald.mjs';
import { setRelay } from './fchainio.mjs';
import { ata } from '../sdk/frontier/prize.mjs';
import { mountAgentPage } from './fagent.mjs';

const base = globalThis.location.origin;
setRelay(`${base}/gw`);
mountAgentPage({ root: document.getElementById('agent-root'), wallet, fsession, herald: createHerald({ base }), prize: { ...fprize, ata } });
