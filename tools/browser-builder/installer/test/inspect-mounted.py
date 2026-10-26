"""Read the actual mounted installer through independent system/Python readers."""
import hashlib
import json
import os
import plistlib
import sys

from ds_store import DSStore
from mac_alias import Alias

mount, output = sys.argv[1:3]
os.makedirs(output, exist_ok=True)
app = os.path.join(mount, 'Super Mario Odyssey.app')
relative = 'Super Mario Odyssey.app/Contents/Resources/game/installer/background.tiff'
background = os.path.join(mount, relative)
with DSStore.open(os.path.join(mount, '.DS_Store'), 'r') as store:
    assert store['Super Mario Odyssey.app']['Iloc'] == (190, 250)
    assert store['Applications']['Iloc'] == (570, 250)
    assert store['.']['bwsp']['WindowBounds'] == '{{160, 120}, {777, 604}}'
    assert store['.']['icvp']['iconSize'] == 104
    assert store['.']['icvp']['backgroundType'] == 2
    alias_bytes = store['.']['icvp']['backgroundImageAlias']
alias = Alias.from_bytes(alias_bytes)
assert alias.target.posix_path == '/' + relative
assert alias.target.cnid == os.stat(background).st_ino
assert alias.target.folder_cnid == os.stat(os.path.dirname(background)).st_ino
assert int(alias.volume.creation_date.timestamp()) == int(os.stat(mount).st_birthtime)
assert os.readlink(os.path.join(mount, 'Applications')) == '/Applications'
assert '.background' not in os.listdir(mount)
with open(os.path.join(app, 'Contents/Info.plist'), 'rb') as file:
    info = plistlib.load(file)
assert info['CFBundleIconFile'] == 'Game.icns'
with open(os.path.join(app, 'Contents/Resources/Game.icns'), 'rb') as file:
    icon = file.read()
with open(os.path.join(mount, '.VolumeIcon.icns'), 'rb') as file:
    assert file.read() == icon
with open(os.path.join(app, 'Contents/_CodeSignature/CodeResources'), 'rb') as file:
    seal = plistlib.load(file)
with open(background, 'rb') as file:
    pixels = file.read()
resource = 'Resources/game/installer/background.tiff'
assert seal['files'][resource] == hashlib.sha1(pixels).digest()
assert seal['files2'][resource]['hash2'] == hashlib.sha256(pixels).digest()
alias_path = os.path.join(output, 'background.alias')
with open(alias_path, 'wb') as file:
    file.write(alias_bytes)
result = {
    'passed': True, 'mount': mount, 'rootEntries': sorted(os.listdir(mount)),
    'background': background, 'alias': alias_path, 'backgroundId': alias.target.cnid,
    'parentId': alias.target.folder_cnid, 'volume': alias.volume.name,
    'createdUnix': int(alias.volume.creation_date.timestamp()),
    'backgroundBytes': len(pixels), 'iconBytes': len(icon),
    'iconSha256': hashlib.sha256(icon).hexdigest(), 'backgroundSealed': True,
}
with open(os.path.join(output, 'mounted-layout.json'), 'w') as file:
    json.dump(result, file, indent=2)
print(json.dumps(result))
