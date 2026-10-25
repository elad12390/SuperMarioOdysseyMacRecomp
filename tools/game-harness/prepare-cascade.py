#!/usr/bin/env python3
"""Copy a private Cascade arrival into explicit source prerequisite fixtures.

Run: uv run --no-project tools/game-harness/prepare-cascade.py --seed DIR --out DIR
Optional --checkpoint IDs supply observed map destinations, not a reconstruction
of their acquisition history. No game calls. Inputs/outputs are never overwritten.
Native verification
of the resulting checkpoint and its 3 -> 4 -> 5 moon count is a separate step.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import sys
import zlib

ROOT = Path(__file__).resolve().parents[2]
CHECKPOINTS = ROOT / "tmp/odyssey/checkpoints"
RUNS = ROOT / "tmp/odyssey/runtime-tests/runs"
MOONS = (216, 206, 212)
CHECKPOINT_IDS = ("obj601", "obj3139", "obj1724", "obj2832", "obj597")


def require(condition, message):
    if not condition:
        raise ValueError(message)


class ByamlReader:
    """Scalar cells: (type, absolute pointer/inline slot, absolute payload, width)."""
    def __init__(self, raw, base, length):
        self.base, self.data, self.cells, self.active = base, raw[base:base+length], {}, set()
        require(self.data[:4] == b"YB\x03\0", "Expected little-endian BYAML v3")
        self.keys, self.strings = self.table(self.u32(4)), self.table(self.u32(8))
        self.root = self.node(self.u32(12), ())

    def span(self, pos, size):
        require(0 <= pos <= len(self.data)-size, "BYAML offset outside declared payload")
        return self.data[pos:pos+size]

    def u32(self, pos):
        return struct.unpack("<I", self.span(pos, 4))[0]

    def u24(self, pos):
        return int.from_bytes(self.span(pos, 3), "little")

    def table(self, pos):
        if not pos:
            return []
        require(self.span(pos, 1) == b"\xc2", "Invalid BYAML string table")
        result = []
        for i in range(self.u24(pos+1)):
            start = pos + self.u32(pos+4+i*4)
            self.span(start, 1)
            result.append(self.data[start:self.data.index(0, start)].decode("utf-8"))
        return result

    def value(self, kind, slot, path):
        word, pos, width = self.u32(slot), slot, 4
        if kind in (0xc0, 0xc1):
            return self.node(word, path)
        if kind in (0xd4, 0xd5, 0xd6):
            pos, width = word, 8
        formats = {0xd1: "i", 0xd2: "f", 0xd3: "I", 0xd4: "q", 0xd5: "Q", 0xd6: "d"}
        if kind in formats:
            value = struct.unpack("<"+formats[kind], self.span(pos, width))[0]
        elif kind == 0xd0:
            require(word in (0, 1), "Noncanonical BYAML bool")
            value = bool(word)
        elif kind == 0xa0:
            value = self.strings[word]
        elif kind == 0xff:
            value = None
        else:
            raise ValueError(f"Unsupported BYAML type {kind:#x}")
        self.cells[path] = (kind, self.base+slot, self.base+pos, width)
        return value

    def node(self, pos, path):
        require(pos not in self.active and len(path) < 100, "Cyclic/deep BYAML")
        self.active.add(pos)
        kind, count = self.span(pos, 1)[0], self.u24(pos+1)
        require(count <= 100000, "Oversized BYAML node")
        if kind == 0xc1:
            self.span(pos+4, count*8)
            result = {}
            for i in range(count):
                entry = pos+4+i*8
                key = self.keys[self.u24(entry)]
                require(key not in result, "Duplicate BYAML key")
                result[key] = self.value(self.data[entry+3], entry+4, path+(key,))
        else:
            require(kind == 0xc0, "Expected BYAML hash/array")
            slots = (pos+4+count+3) & ~3
            self.span(slots, count*4)
            result = [self.value(self.data[pos+4+i], slots+i*4, path+(i,)) for i in range(count)]
        self.active.remove(pos)
        return result


def safe_path(value):
    path = Path(os.path.abspath(value))
    for part in (*reversed(path.parents), path):
        if os.path.lexists(part):
            require(not stat.S_ISLNK(part.lstat().st_mode), f"Symlink forbidden: {part}")
    return path


def read_regular(path):
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, f"Linked/special file: {path}")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    with os.fdopen(os.open(path, flags), "rb") as handle:
        info = os.fstat(handle.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, f"Linked/special file: {path}")
        require((before.st_dev, before.st_ino) == (info.st_dev, info.st_ino), "Input file replaced during open")
        return handle.read()


def save_reader(raw, common=False):
    require(len(raw) >= 76, "Save too short")
    crc, version, size = struct.unpack_from("<III", raw)
    require(version == 1 and size == len(raw), "Invalid save version/length")
    require(crc == zlib.crc32(raw[4:]), "Invalid save CRC32")
    base, length_slot = (72, 68) if common else (16, 12)
    length = struct.unpack_from("<I", raw, length_slot)[0]
    require(16 <= length <= min(0x200000, len(raw)-base), "Invalid BYAML declared length")
    reader = ByamlReader(raw, base, length)
    require(reader.keys == sorted(reader.keys) and reader.strings == sorted(reader.strings), "Native BYAML tables must be lexically sorted")
    return reader


def crc_update(data):
    struct.pack_into("<I", data, 0, zlib.crc32(data[4:]))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def add_checkpoints(reader, patched, expected, ids, whitelist, differences):
    require(len(set(ids)) == len(ids) and all(uid in CHECKPOINT_IDS for uid in ids), "Invalid/repeated checkpoint ID")
    if not ids:
        return None
    stage = "WaterfallWorldHomeStage"
    strings = sorted(set((*reader.strings, stage, *ids)))
    storage = None
    if strings != reader.strings:
        # Native verifiByamlStringTable requires lexical ordering. Rebuild the
        # sorted value table in unused padding and remap every value-string
        # cell; hash keys, node offsets and numeric payloads stay in place.
        old_length = struct.unpack_from("<I", patched, 12)[0]
        start = (old_length+3) & ~3
        values = [text.encode("utf-8")+b"\0" for text in strings]
        offset = 4+4*(len(values)+1)
        offsets = []
        for value in values:
            offsets.append(offset)
            offset += len(value)
        offsets.append(offset)
        table = b"\xc2"+len(values).to_bytes(3, "little")+struct.pack("<"+"I"*len(offsets), *offsets)+b"".join(values)
        end = start+len(table)
        require(end <= len(patched)-16 and not any(patched[16+old_length:16+end]), "No unused zero padding for checkpoint strings")
        patched[16+start:16+end] = table
        struct.pack_into("<I", patched, 24, start)
        struct.pack_into("<I", patched, 12, end)
        whitelist.update((*range(12, 16), *range(24, 28), *range(16+old_length, 16+end)))
        remapped = 0
        for kind, slot, pos, width in reader.cells.values():
            if kind == 0xa0:
                text = reader.strings[reader.u32(slot-reader.base)]
                struct.pack_into("<I", patched, slot, strings.index(text))
                whitelist.update(range(slot, slot+4))
                remapped += 1
        storage = {"byamlLengthBefore": old_length, "byamlLengthAfter": end, "valueStringTable": start,
                   "sortedValueStrings": True, "valueStringCellsRemapped": remapped, "nodeOffsetsPreserved": True}
    entries = expected["Checkpoint"]
    for uid in ids:
        require(not any(r == {"ObjId": uid, "StageName": stage} for r in entries), "Checkpoint already acquired")
        index = next((i for i, r in enumerate(entries) if r == {"ObjId": "", "StageName": ""}), None)
        require(index is not None, "No empty checkpoint slot")
        for key, value in (("ObjId", uid), ("StageName", stage)):
            kind, slot, pos, width = reader.cells[("Checkpoint", index, key)]
            require(kind == 0xa0 and width == 4 and slot == pos, "Invalid checkpoint string cell")
            struct.pack_into("<I", patched, pos, strings.index(value))
            whitelist.update(range(pos, pos+4))
            differences.append({"checkpoint": uid, "field": key, "before": "", "after": value, "offset": pos, "width": 4})
            entries[index][key] = value
    return storage


def prepare(seed, out, checkpoint_ids=()):
    seed, out = safe_path(seed), safe_path(out)
    manifest = safe_path(str(out)+".json")
    require(not any(p.casefold() == "player" for p in seed.parts), "Player seed forbidden")
    require(any(seed.is_relative_to(p) and seed != p for p in (RUNS, CHECKPOINTS)), "Seed must be private runs/checkpoints child; Player forbidden")
    require(out.is_relative_to(CHECKPOINTS) and out != CHECKPOINTS, "Output must be a checkpoints child")
    require(seed.is_dir() and out.parent.is_dir(), "Seed/output parent must already exist")
    require(not out.is_relative_to(seed) and not seed.is_relative_to(out), "Overlapping seed/output")
    require(not os.path.lexists(out) and not os.path.lexists(manifest), "Output/manifest already exists")
    for item in seed.iterdir():
        info = item.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, f"Linked/special seed entry: {item}")
    original = {name: read_regular(seed/name) for name in ("File1.bin", "Common.bin")}
    file, common = save_reader(original["File1.bin"]), save_reader(original["Common.bin"], True)
    state = file.root
    require(state.get("StageName") == "WaterfallWorldHomeStage" and state.get("WorldId") == 1, "Seed is not a saved Cascade arrival (refusing Cap conversion)")
    require(state.get("PlayerStartIdForSave") in ("", "start") and state.get("StartShineIndex") == -1 and state.get("CheckpointName") == "", "Seed is not at the initial entrance")
    progress, world = state["GameProgressData"], state["WorldInfo"][1]
    require(progress["WaterfallWorldProgress"] == 0 and progress["HomeStatus"] == 0 and progress["HomeLevel"] == 0, "Seed has story/Odyssey progression")
    require(world["PayShineNum"] == 0 and world["ShopShine"] == 0, "Seed has paid/shop Cascade moons")
    records = state["ShineData"]
    by_id = {r["UniqueId"]: i for i, r in enumerate(records)}
    require(len(by_id) == len(records), "Duplicate moon IDs")
    require(all(not r["IsGet"] for r in records), "Strict fresh-zero seed required: acquired moon exists")
    for uid in (*MOONS, 205, 207, 218):
        require(uid in by_id, f"Missing moon {uid}")
        record = records[by_id[uid]]
        require(record["Status"] == 0 and record["GetTime"] == 0, f"Moon {uid} is not pristine")
    require(common.root["GameConfigData"]["CameraStickSensitivityLevel"] == 2, "Camera stick speed must already equal 2")
    require(original["Common.bin"][24:28] in (b"USen", b"TWzh"), "Unexpected Common locale")
    # Original DateTime::setNow (v0 0x764c20) uses calendar seconds/setUnixTime.
    # Anchor to native saved time, avoiding host timezone/epoch reinterpretation.
    anchor = state["LastUpdateTime"]
    require(type(anchor) is int and 3 < anchor < 2**63, "Invalid native timestamp anchor")
    patched, expected, whitelist, differences = bytearray(original["File1.bin"]), json.loads(json.dumps(state)), set(range(4)), []
    for order, uid in enumerate(MOONS):
        index = by_id[uid]
        for key, value, kind, fmt in (("IsGet", True, 0xd0, "I"), ("Status", 2, 0xd1, "i"), ("GetTime", anchor-3+order, 0xd5, "Q")):
            path = ("ShineData", index, key)
            actual_kind, slot, pos, width = file.cells[path]
            require(actual_kind == kind, f"Wrong type for moon {uid}/{key}")
            require(not any(other != path and pos < c[2]+c[3] and c[2] < pos+width for other, c in file.cells.items()), f"Shared/overlapping moon payload: {uid}/{key}")
            struct.pack_into("<"+fmt, patched, pos, value)
            whitelist.update(range(pos, pos+width))
            expected["ShineData"][index][key] = value
            differences.append({"uniqueId": uid, "field": key, "before": records[index][key], "after": value, "offset": pos, "width": width})
    checkpoint_storage = add_checkpoints(file, patched, expected, checkpoint_ids, whitelist, differences)
    crc_update(patched)
    require(save_reader(patched).root == expected, "Unexpected decoded File1 field diff")
    require(all(a == b or i in whitelist for i, (a, b) in enumerate(zip(original["File1.bin"], patched))), "File1 byte diff escaped whitelist")
    locale = bytearray(original["Common.bin"])
    locale[24:28] = b"TWzh"
    crc_update(locale)
    require(save_reader(locale, True).root == common.root, "Unexpected Common BYAML diff")
    require(all(a == b or i in (*range(4), *range(24, 28)) for i, (a, b) in enumerate(zip(original["Common.bin"], locale))), "Unexpected Common byte diff")
    output = {"File1.bin": bytes(patched), "Common.bin": bytes(locale)}
    def unchanged():
        require(all(read_regular(seed/n) == data for n, data in original.items()), "Input changed during preparation")
    unchanged()
    report = {"seed": str(seed), "out": str(out), "sourceUnchanged": True, "expectedMoonIds": list(MOONS), "checkpointIds": list(checkpoint_ids), "checkpointStorage": checkpoint_storage, "nativeCountVerification": "not run; must prove 3 -> 4 -> 5", "timestampUnit": "native DateTime seconds", "timestampAnchor": anchor, "fieldDiff": differences, "localeDiff": {"offset": 24, "before": original["Common.bin"][24:28].decode(), "after": "TWzh"}, "files": {n: {"inputSHA256": sha(original[n]), "outputSHA256": sha(data), "length": len(data)} for n, data in output.items()}}
    created = []
    out.mkdir(mode=0o700)
    try:
        for name, data in output.items():
            path = out/name
            with path.open("xb") as handle:
                created.append(path)
                handle.write(data)
            require(read_regular(path) == data, "Output readback differs")
        unchanged()
        with manifest.open("x") as handle:
            created.append(manifest)
            json.dump(report, handle, indent=2)
            handle.write("\n")
        unchanged()
    except BaseException:
        for path in reversed(created):
            path.unlink()
        out.rmdir()
        raise
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--checkpoint", action="append", choices=CHECKPOINT_IDS, default=[], help="Explicit source prerequisite flag ID; repeat for each verified activation")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.seed, args.out, args.checkpoint), indent=2))
    except (ValueError, OSError, KeyError, IndexError, struct.error, RecursionError) as error:
        print(f"Refused: {error}", file=sys.stderr)
        sys.exit(2)
