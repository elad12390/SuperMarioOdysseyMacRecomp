import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assemble, repoRoot } from '../assemble.mjs';
import { defaultAssets } from '../options.mjs';
import { verifyBundle } from '../verify.mjs';
import { listFiles, sha256 } from '../files.mjs';
import { runLogged } from '../processes.mjs';

const scratch = path.join(repoRoot, 'tmp/odyssey/browser-release/public-marker-proof');
await mkdir(scratch, { recursive: true });
const work = await mkdtemp(path.join(scratch, 'run-'));
const site = path.join(work, 'site'), output = path.join(site, 'tools');
const assets = await defaultAssets(process.env.PUBLIC_MARKER_ASSET_ROOT ? path.resolve(process.env.PUBLIC_MARKER_ASSET_ROOT) : repoRoot);
const options = { ...assets, outDir: output, scratch: work };
const tar = process.env.GNU_TAR ?? (process.platform === 'darwin' ? 'gtar' : 'tar');
await runLogged([tar, '--version'], { directory: work, label: 'tar-version', cwd: work });
assert.match(await readFile(path.join(work, 'tar-version.log'), 'utf8'), /GNU tar/);

const unowned = path.join(work, 'unowned');
await mkdir(unowned);
await writeFile(path.join(unowned, 'keep.txt'), 'unowned directory\n');
await assert.rejects(() => assemble({ ...options, outDir: unowned }), /unowned nonempty/);
assert.equal(await readFile(path.join(unowned, 'keep.txt'), 'utf8'), 'unowned directory\n');
assert.deepEqual(await readdir(unowned), ['keep.txt']);

const first = await assemble(options);
const initialAudit = await verifyBundle(output);
const manifestBytes = await readFile(path.join(output, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
assert.deepEqual(JSON.parse(await readFile(path.join(output, 'browser-tools.json'))), {
  format: 1, kind: 'switchrecomp-public-browser-tools',
});
assert(manifest.files.some(file => file.path === 'browser-tools.json'));
assert(!manifest.files.some(file => file.path === '.browser-tools.json'));
assert.match(await readFile(path.join(output, 'SHA256SUMS'), 'utf8'), /^[a-f0-9]{64}  browser-tools\.json$/m);

// Exercise the same GNU tar dotfile exclusion used by upload-pages-artifact@v4.
// A nested legacy marker is a control proving the old name would be excluded.
await mkdir(path.join(site, 'hidden-control'));
await writeFile(path.join(site, 'hidden-control/.browser-tools.json'), '{}\n');
await writeFile(path.join(site, '.pages-hidden-control'), 'excluded\n');
const archive = path.join(work, 'artifact.tar');
const archiveArgs = ['--dereference', '--hard-dereference', '--directory', site, '-cf', archive,
  '--exclude=.git', '--exclude=.github', '--exclude=.[^/]*', '.'];
await runLogged([tar, ...archiveArgs], { directory: work, label: 'pages-archive', cwd: work });
const unpacked = path.join(work, 'unpacked');
await mkdir(unpacked);
await runLogged([tar, '-xf', archive, '--directory', unpacked], { directory: work, label: 'pages-unpack', cwd: work });
assert.deepEqual((await listFiles(unpacked)).sort(),
  ['manifest.json', 'SHA256SUMS', ...manifest.files.map(file => file.path)].map(name => 'tools/' + name).sort());
const archiveAudit = await verifyBundle(path.join(unpacked, 'tools'));
assert.deepEqual(archiveAudit, initialAudit);

// Both marker generations authorize replacement; neither is published as a dotfile.
await writeFile(path.join(output, 'stale-output.txt'), 'replace owned output\n');
assert.deepEqual(await assemble(options), first);
await verifyBundle(output);
assert.deepEqual(await readFile(path.join(output, 'manifest.json')), manifestBytes);
await rename(path.join(output, 'browser-tools.json'), path.join(output, '.browser-tools.json'));
await writeFile(path.join(output, 'stale-output.txt'), 'replace legacy owned output\n');
assert.deepEqual(await assemble(options), first);
const finalAudit = await verifyBundle(output);
assert.deepEqual(finalAudit, initialAudit);
assert.deepEqual(await readFile(path.join(output, 'manifest.json')), manifestBytes);

const proof = {
  passed: true, work, assets, output, archive, archiveArgs, unpacked,
  generatedPublicMarker: true, markerManifestedAndHashed: true,
  legacyMarkerExcludedByPages: true, allDeclaredArchivePathsSurvive: true,
  publicMarkerReplacement: true, legacyMarkerReplacement: true,
  unownedNonemptyDirectoryPreserved: true, deterministicReplacement: true,
  manifestSha256: sha256(manifestBytes), initialAudit, archiveAudit, finalAudit,
};
await writeFile(path.join(scratch, 'proof.json'), JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
