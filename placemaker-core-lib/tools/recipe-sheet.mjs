// 把 out/recipes/ 里手写的 c01…c13 拼成一张联系表（3 列），供一眼过完 13 种嵌套形态。
// 用法：node tools/recipe-sheet.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/Administrator/WorkBuddy/2026-10-29-10-34-07/townforge-enhance/package.json');
const sharp = require('sharp');

const root = 'C:/Users/Administrator/WorkBuddy/2026-10-29-10-34-07/placemaker-core-lib/out';
const dir = path.join(root, 'recipes');

const files = fs.readdirSync(dir).filter((f) => /^c\d\d_.*\.svg$/.test(f)).sort();
console.log('拼版条目:', files.length, files.join(' '));

const COLS = 3;
const CELL = 360;
const LABEL = 20;
const PAD = 6;
const ROWS = Math.ceil(files.length / COLS);
const W = COLS * CELL;
const H = ROWS * (CELL + LABEL);

const composites = [];
for (let k = 0; k < files.length; k++) {
  const col = k % COLS;
  const row = Math.floor(k / COLS);
  const x = col * CELL;
  const y = row * (CELL + LABEL);
  const png = await sharp(fs.readFileSync(path.join(dir, files[k])), { density: 72 })
    .resize(CELL - 2 * PAD, CELL - 2 * PAD, { fit: 'inside' })
    .png()
    .toBuffer();
  composites.push({ input: png, left: x + PAD, top: y + LABEL });
  const label = files[k].replace(/\.svg$/, '');
  const svgLabel = Buffer.from(
    `<svg width="${CELL}" height="${LABEL}"><text x="4" y="14" font-family="monospace" font-size="12" fill="#222">${label}</text></svg>`
  );
  composites.push({ input: svgLabel, left: x, top: y });
}

await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
  .composite(composites)
  .png()
  .toFile(path.join(root, 'recipes-sheet.png'));
console.log('ok out/recipes-sheet.png', W + 'x' + H);
