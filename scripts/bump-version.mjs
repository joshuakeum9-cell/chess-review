/* Stamp a fresh build version onto every asset reference.
 *
 * Why this exists: GitHub Pages caches static assets for ~10 minutes while
 * HTML revalidates quickly, so right after a deploy a visitor can get NEW
 * index.html with STALE app.js or style.css. That exact mix has broken the
 * site for a real user: the old script reached for elements the new markup
 * had removed and every game load died with "Cannot set properties of null".
 *
 * The fix is to version-lock the whole module graph: every import and asset
 * link carries ?v=<build>, so new HTML can only ever load the matching new
 * assets. This script rewrites the version everywhere. Run it before every
 * commit that touches html/css/js:
 *
 *   node scripts/bump-version.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const build = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);

const targets = [
  ...readdirSync(join(root)).filter((f) => f.endsWith('.html')),
  ...readdirSync(join(root, 'js'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `js/${f}`),
];

let stamped = 0;
for (const rel of targets) {
  const path = join(root, rel);
  if (!existsSync(path)) continue;
  const before = readFileSync(path, 'utf8');
  const after = before.replace(/\?v=[A-Za-z0-9]+/g, `?v=${build}`);
  if (after !== before) {
    writeFileSync(path, after);
    stamped++;
  }
}
console.log(`build ${build}: restamped ${stamped} files`);
