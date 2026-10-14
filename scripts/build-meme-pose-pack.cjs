// Rebuild manifest entries after generated transparent WebP cutouts have been saved.
const fs = require('node:fs');
const path = require('node:path');
const pack = require('./meme-pose-pack.cjs');
const root = path.resolve(__dirname, '..');
const manifest = path.join(root, 'src/pose/poses/photo-assets.json');
const existing = JSON.parse(fs.readFileSync(manifest, 'utf8'));
const ids = new Set(pack.map(pose => pose.scene.id));
for (const pose of pack) {
  const asset = path.join(root, 'public', pose.assetPath);
  if (!fs.existsSync(asset) || fs.statSync(asset).size < 10000) throw new Error(`Missing cutout: ${pose.scene.id}`);
}
const merged = [...existing.filter(asset => !ids.has(asset.id)), ...pack.map(pose => ({id:pose.scene.id, assetPath:pose.assetPath, alt:pose.description, accent:pose.accent}))];
fs.writeFileSync(manifest, JSON.stringify(merged, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'src/pose/poses/meme-pose-pack.json'), JSON.stringify({packId:'meme-pack-2026', poses:pack}, null, 2) + '\n');
require('./generate-pose-library.cjs');
console.log('Registered all 40 meme pose cutouts.');
