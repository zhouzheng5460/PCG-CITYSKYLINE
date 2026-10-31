// 把 out/sweep/*.svg 拼成一张联系表（contact sheet），供人工快速过一遍。
// 依赖：sharp（借用 townforge-enhance 的 node_modules，本工程不装依赖）
//
// 用法：node tools/contact-sheet.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/Administrator/WorkBuddy/2026-10-29-10-34-07/townforge-enhance/package.json');
const sharp = require('sharp');

const root = 'C:/Users/Administrator/WorkBuddy/2026-10-29-10-34-07/placemaker-core-lib/out';
const svgDir = path.join(root, 'sweep');

// 1) 从 sweep.csv 取顺序（= AreaGenerator(order)），并只保留真的出了图的
const csv = fs.readFileSync(path.join(root, 'sweep.csv'), 'utf8').split(/\r?\n/);
const head = csv.shift().split(',');
const iId = head.indexOf('id');
const seen = [];
const seenSet = new Set();
for (const line of csv) {
  if (!line) continue;
  const id = line.split(',')[iId];
  if (seenSet.has(id)) continue;
  seenSet.add(id);
  seen.push(id);
}
const items = seen.filter((id) => fs.existsSync(path.join(svgDir, id.replace(/[^A-Za-z0-9_-]/g, '_') + '.svg')));
console.log('拼版条目:', items.length);

const COLS = 11;
const CELL = 226;
const LABEL = 22;
const PAD = 6;
const ROWS = Math.ceil(items.length / COLS);
const W = COLS * CELL;
const H = ROWS * (CELL + LABEL);

const composites = [];
for (let k = 0; k < items.length; k++) {
  const id = items[k];
  const file = path.join(svgDir, id.replace(/[^A-Za-z0-9_-]/g, '_') + '.svg');
  const left = (k % COLS) * CELL;
  const top = Math.floor(k / COLS) * (CELL + LABEL);
  try {
    const png = await sharp(fs.readFileSync(file), { density: 96 })
      .resize(CELL - 8, CELL - 8, { fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
    composites.push({ input: png, left: left + 4, top: top + 4 });
  } catch (e) {
    console.log('渲染失败', id, e.message);
  }
  const label = `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL}" height="${LABEL}">
    <rect width="100%" height="100%" fill="#fafafa"/>
    <text x="6" y="15" font-family="Consolas,monospace" font-size="12" fill="#222">${id}</text></svg>`;
  const lab = await sharp(Buffer.from(label)).png().toBuffer();
  composites.push({ input: lab, left, top: top + CELL });
}

await sharp({ create: { width: W, height: H, channels: 3, background: '#fafafa' } })
  .composite(composites)
  .png({ compressionLevel: 9 })
  .toFile(path.join(root, 'sweep-sheet.png'));

const st = fs.statSync(path.join(root, 'sweep-sheet.png'));
console.log('WROTE', path.join(root, 'sweep-sheet.png'), W + 'x' + H, (st.size / 1024 / 1024).toFixed(1) + 'MB');
