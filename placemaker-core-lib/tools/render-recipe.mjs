// 把 out/recipes/*.svg 里指定的几张转成 PNG，便于肉眼看。
// 用法：node tools/render-recipe.mjs c02_roads_park c07_roads_split_parks ...
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/Administrator/WorkBuddy/2026-10-29-10-34-07/townforge-enhance/package.json');
const sharp = require('sharp');

const dir = 'C:/Users/Administrator/WorkBuddy/2026-10-29-10-34-07/placemaker-core-lib/out/recipes';
const names = process.argv.slice(2);
for (const n of names) {
  const svg = path.join(dir, n.replace(/\.svg$/, '') + '.svg');
  if (!fs.existsSync(svg)) { console.log('missing', svg); continue; }
  const png = svg.replace(/\.svg$/, '.png');
  await sharp(fs.readFileSync(svg), { density: 96 }).png().toFile(png);
  console.log('ok', path.basename(png));
}
