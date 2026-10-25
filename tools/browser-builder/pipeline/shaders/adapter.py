"""Execution adapters only; shader algorithms remain pinned upstream source."""
import ast
import concurrent.futures
import contextlib
import gc
import hashlib
import importlib.abc
import importlib.util
import io
import json
import multiprocessing
import os
import runpy
import shutil
import subprocess
import sys

from js import shader_process, shader_event, shader_tool_identity

CONFIG = json.loads(_browser_config)
SOURCE = '/source/dm/gfx/tools'
PROFILE = '/job/profile/0100000000010000'
CHAIN = CONFIG['chain']
RECORD = 'browser-msl-source-v1; preserve-invariance; first-launch Metal'
MAX_CANDIDATE = 512 * 1024 * 1024


def bounded_scan(function, args):
    """Skip only blobs that the unchanged scan_file predicate cannot match.

    Large audio/video/data files are streamed, not read into WASM memory merely
    to discover that none of the upstream shader signatures occurs in them.
    """
    path = args[0]
    size = os.path.getsize(path)
    with open(path, 'rb') as stream:
        head = stream.read(16)
        if head[:4] == b'Yaz0' and int.from_bytes(head[4:8], 'big') > MAX_CANDIDATE:
            raise RuntimeError(f'{args[1]}: decompressed shader archive exceeds the 512 MiB worker bound')
        # Specialized archive jobs have their own random-access upstream reader.
        if len(args) > 2:
            return function(args)
        specialized = (b'Yaz0', b'SARC', b'UnityFS', b'\x28\xb5\x2f\xfd', b'MSHD', b'\0\0\1\0') + tuple(
            function.__globals__[name] for name in ('NLG_DICT', 'IDRK', 'PDRK', 'SPKG', 'MTARC', 'SCNE', 'GFPAK')
            if isinstance(function.__globals__.get(name), bytes))
        may_be_unity = head[8:11] == b'\0\0\0'
        if size > 8 * 1024 * 1024 and not head.startswith(specialized) and not may_be_unity:
            stream.seek(0)
            tail = b''
            needles = (b'BNSH\0\0\0\0', b'BAHS', b'\x91\x68\x86\x19', b'MGFX')
            found = False
            while block := stream.read(4 * 1024 * 1024):
                window = tail + block
                if any(magic in window for magic in needles):
                    found = True
                    break
                tail = window[-16:]
            if not found:
                return args[1], {}, set(), {}
        if size > MAX_CANDIDATE:
            raise RuntimeError(f'{args[1]}: shader candidate exceeds the 512 MiB worker bound')
    return function(args)


def event(stage, **values):
    shader_event(json.dumps(dict(stage=stage, **values)))


class SerialExecutor:
    """Real synchronous execution for a nonisolated worker without pthreads."""
    def __init__(self, *args, initializer=None, initargs=(), **kwargs):
        if initializer:
            initializer(*initargs)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def map(self, function, *iterables, **kwargs):
        for index, args in enumerate(zip(*iterables)):
            result = bounded_scan(function, args[0]) if function.__name__ == 'scan_file' else function(*args)
            if function.__name__ == 'scan_file':
                event('split', completed=index + 1, file=args[0][1])
            elif function.__name__ == 'fin':
                event('translate', completed=index + 1, shader=args[0], status=result[1])
            yield result

    def shutdown(self, **kwargs):
        pass


concurrent.futures.ThreadPoolExecutor = SerialExecutor
concurrent.futures.ProcessPoolExecutor = SerialExecutor
multiprocessing.Pool = SerialExecutor


def emit_source(msl, air, target):
    """The target is actual MSL text (.metal), not a fabricated metallib."""
    if os.path.abspath(msl) != os.path.abspath(target):
        shutil.copyfile(msl, target)


class SourceEmission(ast.NodeTransformer):
    """Change native artifact storage and compiler invocation, never shader rules."""
    def visit_Constant(self, node):
        if isinstance(node.value, str) and '.metallib' in node.value:
            return ast.copy_location(ast.Constant(node.value.replace('.metallib', '.metal')), node)
        return node

    def visit_FunctionDef(self, node):
        if node.name == 'mac_compile':
            node.body = ast.parse('_emit_source(msl, air, lib)').body
        elif node.name == 'compiler_id':
            node.body = ast.parse('return _browser_tool_record').body
        elif node.name == 'fetch_finish':
            # Its intermediate MSL is also this backend's final library.
            cleanup = [item for item in ast.walk(node) if isinstance(item, ast.For)
                       and isinstance(item.iter, ast.Tuple) and item.iter.elts
                       and isinstance(item.iter.elts[0], ast.Name)
                       and item.iter.elts[0].id == 'fmsl']
            if len(cleanup) != 1:
                raise RuntimeError('Pinned fetch source cleanup shape changed')
            cleanup[0].iter.elts = cleanup[0].iter.elts[1:]
        return self.generic_visit(node)

    def visit_Assign(self, node):
        if any(isinstance(t, ast.Name) and t.id == '_clonefile' for t in node.targets):
            node.value = ast.Constant(None)
        elif any(isinstance(t, ast.Name) and t.id == 'MAC_RECORD' for t in node.targets):
            node.value = ast.Constant(RECORD)
        return self.generic_visit(node)


def execute(path, argv, *, namespace=None, source_emission=False):
    previous = sys.argv
    sys.argv = list(argv)
    scope = dict(__name__='__main__', __file__=path, _emit_source=emit_source,
                 _browser_tool_record=RECORD + '\0' + json.dumps(CONFIG['identity'], sort_keys=True))
    if namespace:
        scope.update(namespace)
    try:
        tree = ast.parse(open(path, encoding='utf-8').read(), filename=path)
        if source_emission:
            tree = ast.fix_missing_locations(SourceEmission().visit(tree))
        exec(compile(tree, path, 'exec'), scope)
        return scope
    finally:
        sys.argv = previous


class CacheLoader(importlib.abc.Loader):
    def create_module(self, spec):
        return None

    def exec_module(self, module):
        path = SOURCE + '/dmsh_mtlcache.py'
        module.__dict__.update(__file__=path, _emit_source=emit_source,
                              _browser_tool_record=RECORD + '\0' + json.dumps(CONFIG['identity'], sort_keys=True))
        tree = ast.fix_missing_locations(SourceEmission().visit(ast.parse(open(path).read(), filename=path)))
        exec(compile(tree, path, 'exec'), module.__dict__)


class CacheFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'dmsh_mtlcache':
            return importlib.util.spec_from_loader(fullname, CacheLoader())


sys.meta_path.insert(0, CacheFinder())
sys.path[:0] = [SOURCE, '/source/dm/games', '/source/dm/tools']
os.environ.update(DM_GAME='0100000000010000', DM_GAMES_DIR='/job/profile', DM_GAMES_FIRST='1',
                  DM_ROOT='/job', WORK='/job/work', J='1', XLATE='/browser/dmsh_xlate',
                  DMSH_CAS='/job/cas', XLATE_DEBUG='1', XLATE_REDUCED='1')
os.environ.pop('IOSOUT', None)
os.makedirs('/job/work', exist_ok=True)

import dmsh_chain

# Verify an explicit browser tool lock against the already integrity-checked
# actual WASM assets. Keep the upstream check_tools comparison and source check.
dmsh_chain.LOCK = '/job/browser-chain.lock'
dmsh_chain.tools_now = lambda: json.loads(str(shader_tool_identity()))
dmsh_chain.version = lambda: CHAIN
with open(dmsh_chain.LOCK, 'w') as stream:
    for key, value in sorted(CONFIG['identity'].items()):
        stream.write(f'{key}\t{value}\n')
bad = dmsh_chain.check_tools()
if bad:
    raise RuntimeError('Browser shader tool identity mismatch: ' + '; '.join(bad))
os.makedirs(os.path.dirname(dmsh_chain.HEADER), exist_ok=True)
with open(dmsh_chain.HEADER, 'w') as stream:
    stream.write(dmsh_chain.header_text(CHAIN))


def process(argv, *, capture_output=False, text=False, check=False, **kwargs):
    argv = [str(x) for x in argv]
    if len(argv) > 1 and os.path.basename(argv[1]) in ('c1_guard.py', 'cb_extent.py'):
        output, errors = io.StringIO(), io.StringIO()
        code = 0
        try:
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                execute(argv[1], argv[1:])
        except SystemExit as error:
            code = error.code if isinstance(error.code, int) else 1
            errors.write(str(error))
        result = dict(code=code, stdout=output.getvalue(), stderr=errors.getvalue())
    else:
        result = json.loads(str(shader_process(json.dumps(argv))))
    stdout, stderr = result.get('stdout', ''), result.get('stderr', '')
    if not text:
        stdout, stderr = stdout.encode(), stderr.encode()
    completed = subprocess.CompletedProcess(argv, result['code'], stdout, stderr)
    if check:
        completed.check_returncode()
    return completed


subprocess.run = process


def split():
    event('split', completed=0)
    os.makedirs('/job/pkg', exist_ok=True)
    execute(SOURCE + '/shader_split.py', [SOURCE + '/shader_split.py', '/input/RomFS', '/input/ExeFS/main',
            '/job/pkg', PROFILE + '/shader_map.tsv', PROFILE + '/shader_facts.tsv', PROFILE + '/shader_pairs.tsv'])
    # Original splitter produces this empty optional conflict table only on some
    # paths. The build unconditionally opens it; no entries are invented here.
    open(PROFILE + '/shader_map.tsv.conflicts.tsv', 'a').close()
    gc.collect()


def build():
    event('translate', completed=0)
    scope = execute(SOURCE + '/dmsh_build.py', [SOURCE + '/dmsh_build.py', '/job/pkg', '/job/cache'], source_emission=True)
    failures = [dict(key=r[0], status=r[1], error=r[2]) for r in scope['res'] if r[1] != 'ok']
    if failures or not scope['res']:
        raise RuntimeError('Shader source build incomplete: ' + json.dumps(failures[:8]))
    directory = '/job/cache/b-' + CHAIN
    stamp = dmsh_chain.read_stamp(directory)
    if stamp != dict(game='0100000000010000', inputs=dmsh_chain.inputs(dmsh_chain.load_game())):
        raise RuntimeError('Browser shader stamp does not match its generated profile')
    expected = dmsh_chain.table_head(directory)
    for name in ('c1_full.tsv', 'cb_extent.tsv'):
        if not open(PROFILE + '/' + name).readline().startswith(expected + ' '):
            raise RuntimeError('Generated shader guard table has a stale chain/input stamp: ' + name)
    return dict(chain=CHAIN, inputs=stamp['inputs'], shaders=len(scope['res']), directory='cache/b-' + CHAIN)
