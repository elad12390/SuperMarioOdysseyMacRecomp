"""Independent test readers only; never imported into the browser product."""
import json
import os
import sys

from ds_store import DSStore
from mac_alias import Alias

root = sys.argv[1]
with DSStore.open(os.path.join(root, '.DS_Store'), 'r') as store:
    records = [f'{entry.filename}:{entry.code.decode()}' for entry in store]
    window = store['.']['bwsp']
    icons = dict(store['.']['icvp'])
    alias_bytes = icons.pop('backgroundImageAlias')
    alias = Alias.from_bytes(alias_bytes)
    with open(os.path.join(root, 'background.alias'), 'rb') as file:
        expected_alias = file.read()
    print(json.dumps({
        'records': records,
        'window': window,
        'icons': icons,
        'view': store['.']['icvl'][1].decode(),
        'appPosition': store['Super Mario Odyssey.app']['Iloc'],
        'applicationsPosition': store['Applications']['Iloc'],
        'alias': {
            'version': alias.version,
            'volume': alias.volume.name,
            'fsType': alias.volume.fs_type.decode(),
            'createdUnix': int(alias.volume.creation_date.timestamp()),
            'path': alias.target.posix_path,
            'filename': alias.target.filename,
            'cnid': alias.target.cnid,
            'parentCnid': alias.target.folder_cnid,
        },
        'aliasMatches': alias_bytes == expected_alias,
    }))
