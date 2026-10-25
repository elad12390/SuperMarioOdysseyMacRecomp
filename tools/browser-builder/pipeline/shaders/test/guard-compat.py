"""Fresh CPU reference analysis; imports the two unchanged, hash-pinned modules."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

PIN = "0045c1dfb639f9775891382646ad38c2a11c56bf"
GUARD_SHA = "3f3926ad03ed6b1859e5a74b1b63d5f54c508d4a298f0686c70458d86cf5523b"
CHAIN_SHA = "ae7a91d6d7e18a487b8925f7515e2277e8e878213cbfbf7ccce3b2782fb1e0a8"
CONSUMER_SHA = "38401583647b55002cb28deca7d6a860d5f5808f4803fbe09b263c6e5fb3245c"
ROOT = Path(__file__).resolve().parents[5]
sha = lambda data: hashlib.sha256(data).hexdigest()
canonical = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
sys.dont_write_bytecode = True

def metadata_digest(files):
    rows = [{k: file[k] for k in ("path", "size", "sha256")} for file in files if file["path"] != "shader-chain.json"]
    return sha(canonical(sorted(rows, key=lambda row: row["path"])).encode())

def runtime_provenance(game, chain, explicit):
    actual = (game / "../../MacOS/dmhost").resolve()
    actual_data = actual.read_bytes()
    cache = ROOT / "tmp/odyssey/browser-release-tools/runtime-cache"
    candidates = [Path(explicit)] if explicit else sorted(path for path in cache.iterdir() if path.is_dir())
    failures = []
    for directory in candidates:
        try:
            manifest = json.loads((directory / "public/manifest.json").read_text())
            recipe = manifest["sourceRecipe"]
            if manifest["shaderChain"] != chain or manifest["architecture"] != "arm64":
                continue
            host = next(file for file in manifest["files"] if file["path"].endswith("/MacOS/dmhost"))
            if sha(actual_data) != host["sha256"]:
                continue
            if recipe["identity"] != sha(canonical(recipe["inputs"]).encode()):
                raise ValueError("Runtime recipe identity is invalid")
            if manifest["source"]["commit"] != PIN or recipe["inputs"]["source"]["commit"] != PIN:
                raise ValueError("Runtime source pin differs")
            if recipe["inputs"]["shaderChain"] != chain:
                raise ValueError("Runtime recipe chain differs")
            cached = directory / "public/files" / host["path"]
            if len(actual_data) != host["size"] or sha(cached.read_bytes()) != sha(actual_data):
                raise ValueError("Shipped/cached runtime identity differs")
            source = directory / "src/dm/gfx/nvn/nvn_mtl.m"
            if sha(source.read_bytes()) != CONSUMER_SHA:
                raise ValueError("Runtime C1 consumer is not the independently audited implementation")
            header = (directory / "src/dm/gfx/nvn/dmsh_chain.h").read_text()
            if not re.search(r'#define DMSH_CHAIN "' + re.escape(chain) + r'"', header):
                raise ValueError("Compiled runtime header chain differs")
            patches = {file["path"]: file["sha256"] for file in recipe["inputs"]["sources"] if file["path"].startswith("scripts/patches/")}
            if patches != manifest["source"]["patches"]:
                raise ValueError("Runtime patch provenance differs")
            return dict(passed=True, runtime_directory=str(directory), recipe=recipe["identity"],
                        shipped_sha256=sha(actual_data), consumer_sha256=CONSUMER_SHA,
                        lookup="base key: strip _b; BF is function specialization on the existing NvShader")
        except (OSError, KeyError, ValueError, StopIteration) as error:
            failures.append(str(directory) + ": " + str(error))
    raise ValueError("No validated shipped-runtime consumer: " + "; ".join(failures))

def analyze(args):
    start = time.monotonic()
    work, game = Path(args.work), Path(args.game).resolve()
    source_manifest = json.loads(Path(args.sources).read_text())
    if source_manifest["revision"] != PIN:
        raise ValueError("Reference source revision differs")
    pinned = work / "pinned"
    pinned.mkdir()
    for name, expected in (("c1_guard.py", GUARD_SHA), ("dmsh_chain.py", CHAIN_SHA)):
        file = next(file for file in source_manifest["files"] if file["path"].endswith("/" + name))
        data = file["text"].encode()
        if sha(data) != expected or file["sha256"] != expected:
            raise ValueError("Pinned reference analyzer changed: " + name)
        (pinned / name).write_bytes(data)
    manifest = json.loads((game / "shader-chain.json").read_text())
    if manifest["chain"] != args.chain or manifest["inputs"] != args.inputs:
        raise ValueError("Current embedded chain/input stamp differs")
    if metadata_digest(manifest["files"]) != args.manifest_digest:
        raise ValueError("Current embedded manifest differs from the caller's checked manifest")
    files = {}
    for file in manifest["files"]:
        name = file["path"]
        if name.startswith("/") or "\\" in name or "\0" in name or any(part in ("", ".", "..") for part in name.split("/")):
            raise ValueError("Unsafe artifact path")
        if name in files:
            raise ValueError("Duplicate artifact path")
        data = (game / name).read_bytes()
        if len(data) != file["size"] or sha(data) != file["sha256"]:
            raise ValueError("Current actual file size/SHA differs: " + name)
        files[name] = file
    print("CURRENT_ACTUAL_FILES_VERIFIED=" + str(len(files)), flush=True)
    chain, inputs = manifest["chain"], manifest["inputs"]
    cache = game / ("shader/cache/b-" + chain)
    prefix = "shader/cache/b-" + chain + "/"
    declared = {name[len(prefix):] for name in files if name.startswith(prefix)}
    if set(os.listdir(cache)) != declared:
        raise ValueError("Actual cache contains undeclared or missing files")
    profile = game / "profile/0100000000010000"
    h = hashlib.sha256()
    for name in ("shader_facts.tsv", "shader_map.tsv", "shader_map.tsv.conflicts.tsv", "shader_pairs.tsv", "bf_want.tsv"):
        file = profile / name
        h.update(("game/" + name + "\0").encode() + (file.read_bytes() if file.exists() else b"missing") + b"\0")
    h.update("".join(line + "\n" for line in (profile / "game.tsv").read_text().splitlines() if line.startswith(("nvn_", "shader_"))).encode())
    if h.hexdigest()[:12] != inputs:
        raise ValueError("Current profile input digest differs")
    stamp = dict(line.split("\t", 1) for line in (cache / "inputs.tsv").read_text().splitlines() if "\t" in line and not line.startswith("#"))
    if stamp != dict(game="0100000000010000", inputs=inputs):
        raise ValueError("Current library stamp differs")
    provenance = runtime_provenance(game, chain, args.runtime)
    actual = (profile / "c1_full.tsv").read_bytes()
    head, actual_body = actual.split(b"\n", 1)
    if not head.decode().startswith("# chain b-" + chain + " inputs " + inputs + " "):
        raise ValueError("Current C1 table stamp differs")
    derived = work / "native-derived.tsv"
    command = [sys.executable, str(pinned / "c1_guard.py"), str(cache), str(derived)]
    proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"))
    (work / "native-reference.pid").write_text(str(proc.pid))
    print("NATIVE_REFERENCE_PID=" + str(proc.pid), flush=True)
    out, err = proc.communicate()
    (work / "native-reference.log").write_text(out)
    (work / "native-reference.stderr").write_text(err)
    (work / "native-reference.status").write_text(str(proc.returncode))
    if proc.returncode:
        raise ValueError("Pinned native reference failed: " + err)
    native_body = derived.read_bytes().split(b"\n", 1)[1]
    rows = lambda data: [line for line in data.decode().splitlines() if line and not line.startswith("#")]
    actual_rows, legacy_rows = rows(actual), rows(Path(args.native_c1).read_bytes())
    bf_row = lambda key: re.fullmatch(r"[0-9a-f]{16}_bf", key) is not None
    effective = sorted(key for key in actual_rows if not bf_row(key))
    legacy_effective = sorted(key for key in legacy_rows if not bf_row(key))
    protected_base = {key for key in legacy_effective if re.fullmatch(r"[0-9a-f]{16}", key)}
    sys.path.insert(0, str(pinned))
    spec = importlib.util.spec_from_file_location("pinned_guard", pinned / "c1_guard.py")
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    fetch_names = sorted(name for name in declared if re.fullmatch(r"[0-9a-f]{16}_bf\.metal", name))
    required_fetch = set()
    for name in declared:
        if re.fullmatch(r"[0-9a-f]{16}_b\.json", name) and json.loads((cache / name).read_text()).get("fetch"):
            required_fetch.add(name[:16] + "_bf.metal")
    counts = dict(analyzed=0, with_c1_reads=0, same_expressions=0, same_bounds_outcome=0, associated_span_known=0)
    new_base_keys, changed_expressions, phantom_json, source_rows = [], [], [], set()
    digest = hashlib.sha256()
    for i, name in enumerate(fetch_names):
        key = name[:16]
        source = (cache / name).read_text()
        base = (cache / (key + "_b.metal")).read_text()
        span = guard.c1_span(str(cache / (key + "_b.json")))
        a, b = set(guard.ACCESS.findall(source)), set(guard.ACCESS.findall(base))
        da = guard.definitions_of(source) if a else {}
        db = guard.definitions_of(base) if b else {}
        unsafe = any(not guard.proven(expr, da, span) for expr in a)
        base_unsafe = any(not guard.proven(expr, db, span) for expr in b)
        counts["analyzed"] += 1
        counts["with_c1_reads"] += bool(a)
        counts["same_expressions"] += a == b
        counts["same_bounds_outcome"] += unsafe == base_unsafe
        counts["associated_span_known"] += span is not None
        if a:
            source_rows.add(key + "_bf")
        if a != b:
            changed_expressions.append(key)
        if unsafe and key not in protected_base:
            new_base_keys.append(key)
        if (cache / (key + "_bf_b.json")).exists():
            phantom_json.append(key)
        digest.update((canonical(dict(key=key, span=span, expressions=sorted(a), unsafe=unsafe, base_unsafe=base_unsafe)) + "\n").encode())
        if (i + 1) % 1000 == 0:
            print("BF_ANALYZED=" + str(i + 1), flush=True)
    issues = []
    if actual_body != native_body:
        issues.append("Actual guard body differs from fresh unchanged native reference")
    if effective != legacy_effective:
        issues.append("Effective native base/GS guard flags differ")
    if set(fetch_names) != required_fetch:
        issues.append("Required BF source-name set differs from current base reflection")
    if counts["associated_span_known"] != len(fetch_names) or phantom_json:
        issues.append("Associated base reflection span/variant-reflection assumptions differ")
    if changed_expressions:
        issues.append("BF C1 expression set differs from its base")
    if new_base_keys:
        issues.append("BF requires additional base full-C1 buffers")
    if counts["same_bounds_outcome"] != len(fetch_names):
        issues.append("BF C1 bounds outcome differs from its base")
    if {key for key in actual_rows if bf_row(key)} != source_rows:
        issues.append("BF guard rows differ from the independently analyzed current C1-read source set")
    return dict(passed=not issues, mode="fresh-native-retained-bf", issues=issues,
                reference=dict(executed=True, guard_sha256=GUARD_SHA, chain_sha256=CHAIN_SHA,
                               exact_body=actual_body == native_body, actual_rows=len(actual_rows), derived_rows=len(rows(native_body)),
                               actual_body_sha256=sha(actual_body), derived_body_sha256=sha(native_body)),
                effective_flags=dict(exact=effective == legacy_effective, actual=effective, native=legacy_effective),
                fetch=counts, additional_base_full_required=new_base_keys, changed_expression_keys=changed_expressions,
                actual_files_verified=len(files), current_manifest_digest=args.manifest_digest,
                provenance=provenance, analysis_rows_sha256=digest.hexdigest(), elapsed_seconds=time.monotonic()-start)

parser = argparse.ArgumentParser()
for name in ("game", "work", "sources", "chain", "inputs", "manifest-digest", "native-c1"):
    parser.add_argument("--" + name, required=True)
parser.add_argument("--runtime")
args = parser.parse_args()
try:
    result = analyze(args)
except Exception as error:
    result = dict(passed=False, mode="fresh-native-retained-bf", issues=[str(error)])
(Path(args.work) / "result.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key not in ("effective_flags",)}, separators=(",", ":")), flush=True)
raise SystemExit(0 if result["passed"] else 1)
