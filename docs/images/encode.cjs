// Encode PNG renders as mozjpeg: node encode.cjs <png-dir> <out-dir>
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const [src, out] = process.argv.slice(2);
(async () => {
  for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.png'))) {
    const name = f.replace(/\.png$/, '.jpg');
    await sharp(path.join(src, f)).jpeg({ quality: 76, mozjpeg: true }).toFile(path.join(out, name));
    console.log(name);
  }
})();
