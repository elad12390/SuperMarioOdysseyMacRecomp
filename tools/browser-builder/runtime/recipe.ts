import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, mkdir, open, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_SOURCE_PIN = '0045c1dfb639f9775891382646ad38c2a11c56bf';
export const RUNTIME_APP = 'Super Mario Odyssey.app';
const builderDefault = fileURLToPath(new URL('..', import.meta.url));
const rootDefault = resolve(builderDefault, '../..');
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value);
}
export type RuntimeRecipe = { format: 1; identity: string; inputs: Record<string, unknown> };
export type RuntimeToolchain = Record<string, unknown>;

export async function runRuntimeCommand(args: string[], options: { directory: string; label: string; cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) {
  await mkdir(options.directory, { recursive: true });
  const log = resolve(options.directory, options.label + '.log'), output = await open(log, 'w');
  const child = spawn(args[0]!, args.slice(1), { cwd: options.cwd ?? rootDefault, env: options.env ?? process.env, detached: true, stdio: ['ignore', output.fd, output.fd] });
  const completion = new Promise<number>((accept, reject) => { child.once('error', reject); child.once('exit', code => accept(code ?? 1)); });
  await writeFile(resolve(options.directory, options.label + '.pid'), String(child.pid) + '\n');
  await output.close();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 120000);
  let code: number;
  try { code = await completion; } finally { clearTimeout(timer); }
  await writeFile(resolve(options.directory, options.label + '.status'), String(code) + '\n');
  if (code || timedOut) throw new Error(`${options.label} ${timedOut ? 'timed out' : 'failed with exit ' + code}; inspect ${log}`);
  return { log, pid: child.pid, exitCode: code };
}

export async function runtimeToolchain(logDirectory = resolve(rootDefault, 'tmp/odyssey/browser-release-tools/recipe-probes', randomUUID())): Promise<RuntimeToolchain> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('The public runtime requires an Apple Silicon macOS build host.');
  const probes: [string, string[]][] = [
    ['sdk', ['xcrun', '--sdk', 'macosx', '--show-sdk-version']],
    ['xcrun-clang', ['xcrun', 'clang', '--version']],
    ['make-clang', ['clang', '--version']],
    ['developer-directory', ['xcode-select', '-p']],
    ['make', ['make', '--version']],
    ['uv', ['uv', '--version']],
    ['macos', ['sw_vers', '-buildVersion']],
  ];
  const tools: Record<string, unknown> = { platform: process.platform, architecture: process.arch, bun: Bun.version };
  for (const [name, args] of probes) {
    const job = await runRuntimeCommand(args, { directory: logDirectory, label: name });
    const text = (await readFile(job.log, 'utf8')).trim();
    tools[name] = { description: text.split('\n')[0], outputSha256: hash(text) };
  }
  const variables = ['MACOSX_DEPLOYMENT_TARGET', 'SDKROOT', 'DEVELOPER_DIR', 'CC', 'CXX', 'CFLAGS', 'CPPFLAGS', 'LDFLAGS', 'MAKEFLAGS', 'MFLAGS', 'CPATH', 'LIBRARY_PATH', 'ARCHFLAGS', 'SOURCE_DATE_EPOCH'];
  tools.environment = Object.fromEntries(variables.map(name => [name, process.env[name] ? { sha256: hash(process.env[name]!) } : null]));
  return tools;
}

export async function createRuntimeRecipe(options: { shaderChain: string; root?: string; builder?: string; toolchain?: RuntimeToolchain; logDirectory?: string }): Promise<RuntimeRecipe> {
  const { shaderChain } = options, root = options.root ?? rootDefault, builder = options.builder ?? resolve(root, 'tools/browser-builder');
  if (!/^[a-z0-9-]{12,40}$/.test(shaderChain)) throw new Error('Invalid runtime recipe shader-chain identity.');
  const names = ['build.ts', 'recipe.ts', 'Info.plist', 'launcher.m', 'source-shaders.h', 'source-shaders.m', 'build-fonts.py'].map(name => 'tools/browser-builder/runtime/' + name);
  names.push('scripts/patches/nxnative-odyssey-sdk3.patch', 'scripts/patches/nxnative-browser-source-shaders.patch');
  const sources = [];
  for (const name of names.sort()) {
    const full = resolve(root, name), info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Runtime recipe input must be an ordinary file: ${name}`);
    const bytes = await readFile(full);
    sources.push({ path: name, sha256: hash(bytes), size: bytes.length });
  }
  const font = resolve(builder, 'node_modules/@fontsource/nunito');
  const packageBytes = await readFile(resolve(font, 'package.json'));
  const metadata = JSON.parse(packageBytes.toString('utf8'));
  const fontFiles = [];
  for (const name of ['files/nunito-latin-700-normal.woff2', 'LICENSE', 'package.json']) {
    const bytes = await readFile(resolve(font, name));
    fontFiles.push({ path: name, sha256: hash(bytes), size: bytes.length });
  }
  const inputs = {
    format: 1, source: { repository: 'https://github.com/seedds/nxnative', commit: RUNTIME_SOURCE_PIN },
    shaderChain, architecture: 'arm64', minimumMacOS: '26.0', signing: 'ad-hoc',
    sources, font: { name: metadata.name, version: metadata.version, files: fontFiles },
    toolchain: options.toolchain ?? await runtimeToolchain(options.logDirectory),
  };
  return { format: 1, identity: hash(canonical(inputs)), inputs };
}

function safeRelative(name: string): string {
  if (!name || name.startsWith('/') || /[\\\0]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe public runtime path.');
  return name;
}

export async function validateRuntimeTemplate(options: { directory: string; expectedRecipe: RuntimeRecipe; logDirectory?: string }) {
  const directory = resolve(options.directory), expected = options.expectedRecipe;
  if (expected.format !== 1 || expected.identity !== hash(canonical(expected.inputs))) throw new Error('The expected runtime recipe identity is invalid.');
  for (const name of [directory, resolve(directory, 'files')]) {
    const info = await lstat(name);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Runtime template roots must be ordinary directories.');
  }
  const manifestInfo = await lstat(resolve(directory, 'manifest.json'));
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error('Runtime manifest must be an ordinary file.');
  const manifestBytes = await readFile(resolve(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!manifest.sourceRecipe) throw new Error('Runtime source-recipe identity is missing. Rebuild into a fresh scratch directory; this legacy template was preserved.');
  const stored = manifest.sourceRecipe as RuntimeRecipe;
  if (stored.format !== 1 || stored.identity !== hash(canonical(stored.inputs)) || stored.identity !== expected.identity) throw new Error('Runtime source-recipe identity mismatch. Rebuild this recipe in a fresh scratch directory.');
  if (manifest.format !== 1 || manifest.kind !== 'open-source-runtime-template' || manifest.architecture !== 'arm64' || manifest.minimumMacOS !== '26.0' || manifest.shaderChain !== expected.inputs.shaderChain || manifest.gameAssetsIncluded !== false || manifest.notarized !== false || manifest.source?.commit !== RUNTIME_SOURCE_PIN || manifest.source.repository !== 'https://github.com/seedds/nxnative') throw new Error('The runtime template metadata does not match its source recipe.');
  const patchHashes = Object.fromEntries((expected.inputs.sources as { path: string; sha256: string }[]).filter(file => file.path.startsWith('scripts/patches/')).map(file => [file.path, file.sha256]));
  if (canonical(manifest.source.patches) !== canonical(patchHashes)) throw new Error('Runtime patch provenance differs from the current recipe.');
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('The runtime manifest has no files.');
  const names = new Set<string>(), caseNames = new Set<string>();
  let bytes = 0;
  for (const file of manifest.files) {
    const name = safeRelative(file.path);
    if (!name.startsWith(RUNTIME_APP + '/Contents/') || names.has(name) || caseNames.has(name.toLowerCase())) throw new Error('Invalid or duplicate public runtime file.');
    names.add(name); caseNames.add(name.toLowerCase());
    if (file.url !== 'files/' + name.split('/').map(encodeURIComponent).join('/') || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256) || file.mode !== (name.includes('/Contents/MacOS/') ? 0o755 : 0o644)) throw new Error(`Invalid runtime file metadata: ${name}`);
    const full = resolve(directory, 'files', name), info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Runtime file is not an ordinary file: ${name}`);
    const data = await readFile(full);
    if (info.size !== file.size || hash(data) !== file.sha256) throw new Error(`Runtime file hash mismatch: ${name}`);
    bytes += data.length;
  }
  const actual: string[] = [];
  async function walk(folder: string) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const full = resolve(folder, item.name);
      if (item.isSymbolicLink()) throw new Error('Runtime templates must not contain symlinks.');
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) actual.push(relative(resolve(directory, 'files'), full).split(sep).join('/'));
      else throw new Error('Runtime template contains an unsupported file type.');
    }
  }
  await walk(resolve(directory, 'files'));
  if (actual.length !== names.size || actual.some(name => !names.has(name))) throw new Error('Runtime template contains unmanifested files.');
  for (const name of [`${RUNTIME_APP}/Contents/Info.plist`, `${RUNTIME_APP}/Contents/MacOS/Launcher`, `${RUNTIME_APP}/Contents/MacOS/dmhost`, `${RUNTIME_APP}/Contents/_CodeSignature/CodeResources`]) if (!names.has(name)) throw new Error(`Runtime template is missing ${name}`);
  const logDirectory = options.logDirectory ?? resolve(rootDefault, 'tmp/odyssey/browser-release-tools/runtime-verification', randomUUID());
  const app = resolve(directory, 'files', RUNTIME_APP);
  await runRuntimeCommand(['codesign', '--verify', '--deep', '--strict', app], { directory: logDirectory, label: 'runtime-codesign' });
  for (const name of ['Launcher', 'dmhost']) await runRuntimeCommand(['lipo', resolve(app, 'Contents/MacOS', name), '-verify_arch', 'arm64'], { directory: logDirectory, label: 'runtime-arch-' + name.toLowerCase() });
  return { manifest, manifestSha256: hash(manifestBytes), recipeIdentity: expected.identity, files: names.size, bytes };
}
