"""Prepare all real Odyssey geometry jobs and native reference outputs, never public assets."""
import ast
import importlib.util
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[5]
WORK = ROOT / 'tmp/odyssey/browser-shaders'
GAME = ROOT / 'game-data/super-mario-odyssey'
FIXTURES = WORK / 'geometry-fixtures'
RAW = WORK / 'geometry-native'
PREPARED = WORK / 'geometry-prepared'
for directory in (FIXTURES, RAW, PREPARED):
    directory.mkdir(parents=True, exist_ok=True)
native_source = (ROOT / 'external/nxnative/dm/gfx/tools/dmsh_build.py').read_text()
tree = ast.parse(native_source)
functions = {}
for name in ('gs_slice', 'precise', 'vs_init', 'vs_layer'):
    node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    functions[name] = ast.get_source_segment(native_source, node)
namespace = {'re': re, 'subprocess': subprocess}
for source in functions.values():
    exec(source, namespace)
geometry_path = ROOT / 'external/nxnative/dm/gfx/tools/dmsh_geometry.py'
spec = importlib.util.spec_from_file_location('native_geometry', geometry_path)
geometry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geometry)

rows = [line.split('\t') for line in (GAME / 'profile/0100000000010000/shader_map.tsv').read_text().splitlines() if line.startswith('gs_')]
assert len(rows) == 3
data = (GAME / 'shader/pkg/gs_shaderdata.bin').read_bytes()
starts = [match.start() for match in re.finditer(b'BTCDBTCD', data)]
jobs, samples = [], []
for package, index, _, key, origin in rows:
    index = int(index)
    record = data[starts[index]:starts[index + 1] if index + 1 < len(starts) else len(data)]
    control = record.index(bytes.fromhex('34127698'))
    code = record[0x38:control][0x30:]
    c1_start, c1_end = struct.unpack_from('<2I', record, control + 0x700)
    c1 = record[0x38 + c1_start:0x38 + c1_end]
    code_path = FIXTURES / (key + '.bin')
    code_path.write_bytes(code)
    job = {'key': key, 'stage': 'gs', 'code': str(code_path), 'tex': {}, 'img': {}, 'attr': {}, 'fout': {}, 'c1': c1.hex(), 'debug': True, 'reduced': True}
    jobs.append(job)
    jobs.extend({**job, 'key': key + '_g' + str(topology), 'geometry_topology': topology} for topology in range(5))
    w2, w3, w4 = struct.unpack_from('<3I', code, 8)
    samples.append({'key': key, 'package': package, 'index': index, 'bytes': len(code), 'vertices': w4 & 4095, 'invocations': w2 >> 24, 'output': w3 >> 24 & 15})
(FIXTURES / 'jobs.json').write_text(json.dumps(jobs, indent=2) + '\n')
(FIXTURES / 'functions.json').write_text(json.dumps({'functions': functions, 'geometrySource': geometry_path.read_text()}) + '\n')
subprocess.run(['dotnet', str(WORK / 'native/bin/dmsh_xlate/release/dmsh_xlate.dll'), str(FIXTURES / 'jobs.json'), str(RAW)], check=True)
cross = WORK / 'cross/native-spirv-cross'
for sample in samples:
    key = sample['key']
    spirv = RAW / (key + '.spv')
    pinned = subprocess.run([str(cross), str(spirv), '--glsl'], check=True, capture_output=True, text=True).stdout
    installed = subprocess.run(['spirv-cross', str(spirv), '--version', '450'], check=True, capture_output=True, text=True).stdout
    assert pinned == installed, 'Pinned and installed native GLSL differ: ' + key
    (PREPARED / (key + '.glsl')).write_text(pinned)
    sample['gsSlice'] = namespace['gs_slice'](str(spirv))
    # These are actual line-strip emitters, not the triangle layer-only fold.
    assert sample['gsSlice'] is None
    for topology in range(5):
        name = key + '_g' + str(topology)
        for suffix in ('', '.reader'):
            prepared = PREPARED / (name + suffix + '.spv')
            shutil.copyfile(RAW / (name + suffix + '.spv'), prepared)
            geometry.flatten_sets(str(prepared))
            msl = subprocess.run([str(cross), str(prepared)], check=True, capture_output=True, text=True).stdout
            (PREPARED / (name + suffix + '.raw.metal')).write_text(msl)
            msl = namespace['precise'](msl)
            final = geometry.topology_pointer(msl) if not suffix else namespace['vs_layer'](namespace['vs_init'](msl))
            (PREPARED / (name + suffix + '.metal')).write_text(final)
(FIXTURES / 'samples.json').write_text(json.dumps(samples, indent=2) + '\n')
print(json.dumps({'samples': samples, 'jobs': len(jobs), 'nativeSpirv': True, 'nativeGlsl': True, 'kernelAndReaderVariants': 30}, indent=2))
