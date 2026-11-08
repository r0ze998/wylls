#!/usr/bin/env node
// Checks a running wylls-mcp against one client's documented OAuth and discovery requirements (src/preflight.mjs).
//
//   node bin/wylls-mcp-preflight.mjs http://127.0.0.1:41960/mcp claude-code
//   node bin/wylls-mcp-preflight.mjs http://127.0.0.1:41960/mcp chatgpt      # scheme fails on loopback by design
//
// Loopback servers only (it registers OAuth clients). Exit 0 when every check passes.
import { preflight, PREFLIGHT_CLIENTS } from '../src/preflight.mjs';

const [url, client = 'claude-code'] = process.argv.slice(2);
if (!url) { console.error(`usage: wylls-mcp-preflight <mcp url> [${PREFLIGHT_CLIENTS.join('|')}]`); process.exit(2); }
const r = await preflight(url, { client });
console.log(JSON.stringify(r, null, 2));
process.exit(r.ok ? 0 : 1);
