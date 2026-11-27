"""Stage or archive a Quanwang Windows candidate from pinned local inputs."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
from zipfile import ZIP_DEFLATED, ZipFile

from merge_upstream import merge_sources, read_sources, write_sources

INDEX = 'quanwang-overlay.json'
PROTECTED = (
    'build/icon.ico', 'build/icon.png',
    'src/assets/membership/month.jpg', 'src/assets/membership/year.jpg',
    'src/native/membership-public.pem', 'src/native/membership-v2-public.pem',
)
EXCLUDED = {'.git', 'node_modules', 'data', 'dist', 'dist-react', '.cache', '客服私用'}
PRIVATE = re.compile(rb'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|QW2\.[\w-]{16,}\.[\w-]{32,}')


def identifier(data):
    return sha256(data).hexdigest()


def tree_digest(files):
    hashed = [(name, identifier(data)) for name, data in sorted(files.items())]
    return identifier(json.dumps(hashed, ensure_ascii=False, separators=(',', ':')).encode())


def check_client_asset(name, data):
    if (EXCLUDED.intersection(name.split('/')) or Path(name).name in {'membership.json', '.env'}
            or re.search(r'private[-_.]?key|secret[-_.]?key|activation[-_.]?codes', name, re.I)
            or PRIVATE.search(data)):
        raise ValueError(f'Private file or credential material in source input: {name}')


def create_overlay(base, brand, out):
    original, branded = map(read_sources, (base, brand))
    differences = {name: data for name, data in branded.items() if original.get(name) != data}
    for name, data in differences.items():
        check_client_asset(name, data)
    package = json.loads(branded['package.json'])
    assert package['build']['productName'] == '全网短剧'
    record = dict(base=tree_digest(original), version=package['version'],
                  removed=sorted(original.keys() - branded.keys()),
                  changes={name: identifier(data) for name, data in differences.items()},
                  protected={name: identifier(branded[name]) for name in PROTECTED})
    with ZipFile(out, 'x', compression=ZIP_DEFLATED) as archive:
        for name, data in sorted(differences.items()):
            archive.writestr(name, data)
        archive.writestr(INDEX, json.dumps(record, ensure_ascii=False, indent=2))
    print(f'Prepared overlay with {len(differences)} changed client files')


def apply_overlay(base, path):
    # The overlay has a package.json because branded builds always change version and title.
    overlay = read_sources(path)
    manifest = json.loads(overlay.pop(INDEX))
    if manifest['base'] != tree_digest(base):
        raise ValueError('The app overlay does not match the verified upstream baseline')
    if manifest['changes'] != {name: identifier(data) for name, data in overlay.items()}:
        raise ValueError('The app overlay contents do not match its index')
    for name, data in overlay.items():
        check_client_asset(name, data)
    branded = {name: data for name, data in base.items() if name not in manifest['removed']}
    branded.update(overlay)
    return branded, manifest


def build_version(tag, baseline):
    upstream = re.fullmatch(r'v([0-9]+\.[0-9]+)(?:\.[0-9]+)?', tag)
    received = re.fullmatch(r'[0-9]+\.[0-9]+\.([0-9]+)', baseline)
    if not upstream or not received:
        raise ValueError('The upstream tag or current Quanwang version has an unsupported format')
    return f'{upstream[1]}.{int(received[1]) + 1}'


def stage(args):
    base = read_sources(args.base)
    branded, overlay = apply_overlay(base, args.overlay)
    upstream = read_sources(args.upstream)
    version = build_version(args.tag, overlay['version'])
    incoming = json.loads(upstream['package.json'])
    if incoming['version'].split('.')[:2] != version.split('.')[:2]:
        raise ValueError('The upstream source version does not match the release tag')
    result = merge_sources(base, branded, upstream, version)
    for name in PROTECTED:
        if identifier(result[name]) != overlay['protected'][name]:
            raise ValueError(f'Protected brand or membership asset differs: {name}')
    if json.loads(result['package.json'])['build']['productName'] != '全网短剧':
        raise ValueError('The package does not use the approved brand')
    if b"ipcMain.handle('get-membership-status'" not in result['main.js']:
        raise ValueError('The membership IPC entry is missing')
    write_sources(result, args.out)
    print(version)


def archive_source(root, out):
    # Build output and local data are outside this explicitly staged source tree.
    files = []
    for file in sorted(root.rglob('*')):
        if not file.is_file():
            continue
        name = file.relative_to(root).as_posix()
        if set(name.split('/')) & EXCLUDED or name.startswith('build/ffmpeg/') and file.suffix == '.exe':
            continue
        if file.suffix == '.exe':
            continue
        data = file.read_bytes()
        check_client_asset(name, data)
        files.append((name, data))
    with ZipFile(out, 'x', compression=ZIP_DEFLATED) as archive:
        for name, data in files:
            archive.writestr(name, data)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest='command', required=True)
    overlay = commands.add_parser('overlay')
    for name in ('base', 'brand', 'out'):
        overlay.add_argument(name, type=Path)
    prepare = commands.add_parser('stage')
    for name in ('base', 'overlay', 'upstream'):
        prepare.add_argument(name, type=Path)
    prepare.add_argument('tag')
    prepare.add_argument('out', type=Path)
    source = commands.add_parser('archive')
    for name in ('root', 'out'):
        source.add_argument(name, type=Path)
    args = cli.parse_args()
    if args.command == 'overlay':
        create_overlay(args.base, args.brand, args.out)
    elif args.command == 'stage':
        stage(args)
    else:
        archive_source(args.root, args.out)


if __name__ == '__main__':
    main()
