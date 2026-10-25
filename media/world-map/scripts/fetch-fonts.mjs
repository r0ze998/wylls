// Fetch the label faces (SIL Open Font License) into media/world-map/.cache/fonts and write a local
// fonts.css for the render page: Shippori Mincho B1 (the display Mincho, as the game's own
// --display stack) and Noto Sans JP (small labels). Run once; the cache is not committed.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'fonts');
mkdirSync(dir, { recursive: true });
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const css = await (await fetch('https://fonts.googleapis.com/css2?family=Shippori+Mincho+B1:wght@700;800&family=Noto+Sans+JP:wght@500;700&family=Cinzel:wght@700&display=swap', { headers: { 'user-agent': UA } })).text();
let i = 0, out = css;
for (const m of css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)) {
  const name = `f${String(i++).padStart(4, '0')}.woff2`, file = join(dir, name);
  if (!existsSync(file)) writeFileSync(file, Buffer.from(await (await fetch(m[1])).arrayBuffer()));
  out = out.replace(m[1], name);
}
writeFileSync(join(dir, 'fonts.css'), out);
console.log(`${i} font files in ${dir}`);
