import { mkdir, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const out = resolve(root, 'dist');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ['index.html', 'styles.css']) await copyFile(resolve(root, 'web', file), resolve(out, file));
const repositoryUrl = process.env.SWITCHRECOMP_REPOSITORY_URL;
if (repositoryUrl) {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryUrl)) throw new Error('Use a complete GitHub repository URL for the source link.');
  const html = await Bun.file(resolve(out, 'index.html')).text();
  await Bun.write(resolve(out, 'index.html'), html.replace('https://github.com/elad12390/SuperMarioOdysseyMacRecomp', repositoryUrl));
}
const result = await Bun.build({ entrypoints: [resolve(root, 'web/app.ts'), resolve(root, 'web/build-worker.ts')], outdir: out, target: 'browser', minify: true, sourcemap: 'external' });
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
await Bun.write(resolve(out, '.nojekyll'), '');
console.log(`Static website built at ${out}`);
