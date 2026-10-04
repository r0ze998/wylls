// Registers the Japanese dictionary of the council page (council/lang.ja.json) for tests that print Japanese.
// Import it before the modules whose output is checked in ja: `import './fixtures/ai-page-lang.mjs';`
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerJa } from '../../../permutation-server/web/frontier/council/lang.mjs';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../permutation-server/web/frontier/council/lang.ja.json');
registerJa(JSON.parse(fs.readFileSync(file, 'utf8')));
