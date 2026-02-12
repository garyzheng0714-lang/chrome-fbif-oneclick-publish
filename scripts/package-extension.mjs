import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import crx3 from 'crx3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const extensionDir = path.join(distDir, 'extension');
const zipPath = path.join(distDir, 'fbif-oneclick-publish.zip');
const crxPath = path.join(distDir, 'fbif-oneclick-publish.crx');
const keyPath = path.join(rootDir, '.keys', 'fbif-oneclick-publish.pem');

const extensionFiles = ['manifest.json', 'background.js', 'app.html', 'fallback.html', 'styles', 'src'];

await fs.ensureDir(path.dirname(keyPath));
await fs.emptyDir(distDir);
await fs.ensureDir(extensionDir);

for (const file of extensionFiles) {
  const source = path.join(rootDir, file);
  const target = path.join(extensionDir, file);

  if (!(await fs.pathExists(source))) {
    throw new Error(`打包失败，缺少文件: ${file}`);
  }

  await fs.copy(source, target, {
    filter: (sourcePath) => !sourcePath.includes('node_modules')
  });
}

await createZip(extensionDir, zipPath);
await buildCrx(extensionDir, keyPath, crxPath);

console.log('打包完成:');
console.log(`- ZIP: ${zipPath}`);
console.log(`- CRX: ${crxPath}`);
console.log(`- KEY: ${keyPath}`);

async function createZip(sourceDir, outputPath) {
  await fs.ensureDir(path.dirname(outputPath));

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function buildCrx(sourceDir, pemPath, outputCrxPath) {
  await crx3([sourceDir], {
    keyPath: pemPath,
    crxPath: outputCrxPath
  });
}
