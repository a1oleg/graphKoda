const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'bloom-demo-next');
const files = ['manifest.json', 'content.js', 'README.md'];
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.content_scripts[0].js.some(file => !files.includes(file))) {
  throw new Error('Invalid extension manifest');
}
fs.mkdirSync(output, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(output, file));
console.log(`Unpacked extension: ${output}`);
