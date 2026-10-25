const BUILDS = {
  main: '3ca12dfaaf9c82da064d1698df79cda1',
  subsdk0: '798c30e126697f2222cf843f78f5c140',
  sdk: 'ae34e75d02925f4417b24499ad80c394',
};
const SUFFIXES = ['patched.bin', 'fixups.tsv', 'gates.tsv', 'sites.tsv', 'cuts.tsv', 'obs.tsv'];
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const digest = async bytes => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const progress = event => postMessage({ type: 'progress', event });

async function validate(inputDirectory, modules) {
  const inputs = {};
  for (const name of modules) {
    let file;
    try { file = await (await inputDirectory.getFileHandle(name)).getFile(); }
    catch { throw new Error(`Missing original ExeFS module: ${name}`); }
    if (file.size < 0x100 || file.size > 128 * 1024 * 1024) throw new Error(`${name}: invalid NSO size`);
    const header = new Uint8Array(await file.slice(0, 0x100).arrayBuffer());
    if (new TextDecoder().decode(header.slice(0, 4)) !== 'NSO0') throw new Error(`${name}: expected original NSO0 file`);
    const buildId = hex(header.slice(0x40, 0x50));
    if (buildId !== BUILDS[name]) throw new Error(`${name}: unsupported build ${buildId}; expected ${BUILDS[name]}`);
    const view = new DataView(header.buffer);
    let lastMemoryEnd = 0;
    for (let i = 0; i < 3; i++) {
      const fileOffset = view.getUint32(0x10 + 16 * i, true);
      const memoryOffset = view.getUint32(0x14 + 16 * i, true);
      const size = view.getUint32(0x18 + 16 * i, true);
      const compressed = view.getUint32(0x0c, true) & (1 << i);
      const storedSize = compressed ? view.getUint32(0x60 + 4 * i, true) : size;
      if (fileOffset < 0x100 || fileOffset + storedSize > file.size || !storedSize || memoryOffset < lastMemoryEnd || memoryOffset + size > 256 * 1024 * 1024) throw new Error(`${name}: corrupt or truncated NSO segment ${i}`);
      lastMemoryEnd = memoryOffset + size;
    }
    if (lastMemoryEnd + view.getUint32(0x3c, true) > 256 * 1024 * 1024) throw new Error(`${name}: invalid NSO memory size`);
    inputs[name] = { file, buildId };
  }
  return inputs;
}

async function execute({ inputDirectory, outputDirectory, modules, bundleURL }) {
  progress({ stage: 'validate', completed: 0, total: 3 });
  const inputs = await validate(inputDirectory, modules);
  const outputNames = [...modules.flatMap(n => SUFFIXES.map(s => `${n}.${s}`)), 'build_src.sha256'];
  for (const name of outputNames) {
    try { await outputDirectory.getFileHandle(name); }
    catch (error) { if (error.name === 'NotFoundError') continue; throw error; }
    throw new Error(`Output already exists: ${name}; select an empty output directory`);
  }
  progress({ stage: 'bootstrap', completed: 0, total: 1 });
  const { loadPyodide } = await import(new URL('pyodide/pyodide.mjs', bundleURL).href);
  const py = await loadPyodide({ indexURL: new URL('pyodide/', bundleURL).href, stdout: text => progress({ stage: 'python', text }), stderr: text => progress({ stage: 'python', text }) });
  const dependencyResponse = await fetch(new URL('dependencies.json', bundleURL));
  if (!dependencyResponse.ok) throw new Error(`Dependency checksums unavailable (${dependencyResponse.status})`);
  const dependencies = await dependencyResponse.json();
  await py.loadPackage([new URL('lz4-4.4.4-cp313-cp313-pyodide_2025_0_wasm32.whl', bundleURL).href]);
  // unpackArchive installs the unmodified official Python binding and its real
  // Emscripten shared library, not an alternate disassembler implementation.
  const wheel = await fetch(new URL('capstone-5.0.6-py3-none-pyodide_2025_0_wasm32.whl', bundleURL));
  if (!wheel.ok) throw new Error(`Capstone dependency unavailable (${wheel.status})`);
  const wheelBytes = await wheel.arrayBuffer();
  if (await digest(wheelBytes) !== dependencies['capstone-5.0.6-py3-none-pyodide_2025_0_wasm32.whl']) throw new Error('Capstone wheel checksum mismatch');
  py.unpackArchive(wheelBytes, 'zip', { extractDir: '/lib/python3.13/site-packages' });
  const response = await fetch(new URL('sources.json', bundleURL));
  if (!response.ok) throw new Error(`Pinned source bootstrap unavailable (${response.status})`);
  const source = await response.json();
  if (source.provenance.nxnativeRevision !== '0045c1dfb639f9775891382646ad38c2a11c56bf' || source.provenance.odysseyPatchSha256 !== '98cfcc7d1456941d75c3c3ef7be1b0e9194a0d73d6fae7a1604f90cdc157aaff') throw new Error('Unsupported rewriter source pin');
  for (const file of source.files) {
    const bytes = new TextEncoder().encode(file.text);
    if (await digest(bytes) !== file.sha256) throw new Error(`Pinned source checksum failed: ${file.path}`);
    const path = `/source/${file.path}`;
    py.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
    py.FS.writeFile(path, bytes);
  }
  py.runPython(`
import sys, struct, gc, runpy, hashlib
sys.path.insert(0, '/source/dm/tools')
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
from capstone.arm64 import ARM64_OP_REG
import lz4.block
_md = Cs(CS_ARCH_ARM64, CS_MODE_ARM); _md.detail = True
_ins = next(_md.disasm(bytes.fromhex('12000091'), 0x1000))
assert _ins.mnemonic == 'add' and _ins.operands[0].type == ARM64_OP_REG
assert _ins.reg_name(_ins.operands[0].reg) == 'x18'
assert _ins.regs_access()[1], 'Capstone register detail unavailable'
assert lz4.block.decompress(lz4.block.compress(b'WASM LZ4 check')) == b'WASM LZ4 check'
del _md, _ins
def _verify_nso(path):
    raw = open(path, 'rb').read()
    flags = struct.unpack_from('<I', raw, 12)[0]
    for i in range(3):
        offset, memory, size = struct.unpack_from('<III', raw, 0x10 + 16 * i)
        stored = struct.unpack_from('<I', raw, 0x60 + 4 * i)[0] if flags & (1 << i) else size
        segment = raw[offset:offset + stored]
        if flags & (1 << i):
            segment = lz4.block.decompress(segment, uncompressed_size=size)
        if len(segment) != size:
            raise ValueError(f'Corrupt NSO segment {i}: decompressed size mismatch')
        if not flags & (1 << (i + 3)):
            raise ValueError(f'NSO segment {i}: supported original requires segment hashes')
        if hashlib.sha256(segment).digest() != raw[0xa0 + 32 * i:0xc0 + 32 * i]:
            raise ValueError(f'Corrupt NSO segment {i}: SHA-256 mismatch')
`);
  progress({ stage: 'bootstrap', completed: 1, total: 1, capstone: 'ARM64 detail and register access verified', lz4: 'WASM round trip verified' });
  const files = [];
  const moduleManifest = [];
  for (const [index, name] of modules.entries()) {
    progress({ stage: 'rewrite', module: name, completed: index, total: modules.length });
    py.FS.mkdirTree('/job/input'); py.FS.mkdirTree('/job/output');
    const bytes = new Uint8Array(await inputs[name].file.arrayBuffer());
    py.FS.writeFile('/job/input/module.nso', bytes, { canOwn: true });
    py.globals.set('_module_name', name);
    // run_path uses its own global namespace; deleting the result releases the
    // large image, decoded instructions and patch state between modules.
    py.runPython(`
sys.argv = ['/source/dm/tools/patch_nso.py', '/job/input/module.nso', '/job/output', _module_name]
_verify_nso(sys.argv[1])
runpy.run_path(sys.argv[0], run_name='__main__')
gc.collect()
`);
    for (const filename of [...SUFFIXES.map(s => `${name}.${s}`), ...(index === modules.length - 1 ? ['build_src.sha256'] : [])]) {
      const data = py.FS.readFile(`/job/output/${filename}`);
      const sha256 = await digest(data);
      // Announce ownership before the asynchronous filesystem operation so an
      // abort during createWritable/write can still clean the partial file.
      postMessage({ type: 'created', name: filename });
      const handle = await outputDirectory.getFileHandle(filename, { create: true });
      const stream = await handle.createWritable();
      try { await stream.write(data); await stream.close(); }
      catch (error) { await stream.abort().catch(() => {}); throw error; }
      files.push({ name: filename, size: data.byteLength, sha256 });
      py.FS.unlink(`/job/output/${filename}`);
    }
    for (const remaining of py.FS.readdir('/job/output').filter(n => n !== '.' && n !== '..')) py.FS.unlink(`/job/output/${remaining}`);
    py.FS.unlink('/job/input/module.nso');
    moduleManifest.push({ name, buildId: inputs[name].buildId, inputSize: inputs[name].file.size });
    progress({ stage: 'rewritten', module: name, completed: index + 1, total: modules.length });
  }
  return { files, modules: moduleManifest, provenance: source.provenance };
}

onmessage = async ({ data }) => {
  onmessage = null;
  try { postMessage({ type: 'result', manifest: await execute(data) }); }
  catch (error) { postMessage({ type: 'error', message: error?.message || String(error) }); }
};
