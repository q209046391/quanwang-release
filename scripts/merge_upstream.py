"""Prepare a reviewable source tree from three release ZIPs."""

import argparse
import json
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import subprocess
import tempfile
from zipfile import ZipFile

PROJECT_FIELDS = {
    'package.json': {
        ('version',), ('build', 'buildVersion'), ('build', 'artifactName'),
        ('build', 'portable', 'artifactName'), ('build', 'nsis', 'artifactName'),
    },
    'package-lock.json': {('version',), ('packages', '', 'version')},
}


def load_project(data, name):
    result = json.loads(data)
    for fields in PROJECT_FIELDS[name]:
        node = result
        for key in fields[:-1]:
            node = node[key]
        node.pop(fields[-1], None)
    return result


def merge_object(incoming, base, branded, parent=()):
    if incoming == base or incoming == branded:
        return branded
    if branded == base:
        return incoming
    if all(isinstance(value, dict) for value in (incoming, base, branded)):
        missing = object()
        result = {}
        for key in incoming.keys() | base.keys() | branded.keys():
            value = merge_object(incoming.get(key, missing), base.get(key, missing),
                                 branded.get(key, missing), parent + (key,))
            if value is not missing:
                result[key] = value
        return result
    raise ValueError('overlapping JSON changes in ' + '.'.join(parent))


def merge_project(name, incoming, base, branded, version):
    merged = merge_object(*(load_project(value, name) for value in (incoming, base, branded)))
    merged['version'] = version
    if name == 'package.json':
        build = merged['build']
        build['buildVersion'] = version
        build['artifactName'] = 'quanwang-${version}-${os}-${arch}.${ext}'
        build['portable']['artifactName'] = '${productName}-${version}.${ext}'
        build['nsis']['artifactName'] = 'quanwang-${version}-setup.${ext}'
        build['nsis']['shortcutName'] = build['productName']
    else:
        merged['packages']['']['version'] = version
    return (json.dumps(merged, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode()


def split_upstream_header(data):
    # The introductory source-version comment can move when the brand adds an import.
    lines = data.replace(b'\r\n', b'\n').splitlines(keepends=True)
    candidates = [i for i, line in enumerate(lines[:3])
                  if re.match(rb'// Hongguo Drama [0-9]+\.[0-9]+:', line)]
    if len(candidates) != 1:
        raise ValueError('upstream runtime header moved or changed')
    line = lines.pop(candidates[0])
    return line, b''.join(lines)


def read_sources(path):
    with ZipFile(path) as archive:
        sources = {}
        for member in archive.infolist():
            name = member.filename
            posix = PurePosixPath(name)
            windows = PureWindowsPath(name)
            if windows.root or posix.is_absolute() or "\\" in name or ":" in name or ".." in posix.parts:
                raise ValueError(f"Invalid archive path: {name}")
            if not member.is_dir():
                normalized = str(posix)
                if normalized in sources:
                    raise ValueError(f"Duplicate archive path: {name}")
                sources[normalized] = archive.read(member)
        if "package.json" not in sources:
            prefixes = {name.split("/")[0] for name in sources}
            if len(prefixes) == 1 and all("/" in name for name in sources):
                sources = {name.split("/", 1)[1]: data for name, data in sources.items()}
        if "package.json" not in sources:
            raise ValueError(f"No root package.json in {path}")
        return sources


def merge_file(incoming, base, branded, scratch):
    if incoming == base or incoming == branded:
        return branded
    if branded == base:
        return incoming
    if None in (incoming, base, branded):
        raise ValueError("concurrent addition or deletion")
    filenames = [scratch / label for label in ("upstream", "base", "quanwang")]
    for filename, contents in zip(filenames, (incoming, base, branded)):
        contents.decode("utf-8")
        filename.write_bytes(contents.replace(b"\r\n", b"\n"))
    merge = subprocess.run(
        ["git", "merge-file", "--stdout", *map(str, filenames)], capture_output=True, check=False
    )
    if merge.returncode:
        raise ValueError("overlapping changes")
    return merge.stdout


def merge_sources(base, branded, incoming, version=None):
    result = {}
    conflicts = []
    with tempfile.TemporaryDirectory() as directory:
        for name in sorted(base.keys() | branded.keys() | incoming.keys()):
            try:
                before, original, custom = (tree.get(name) for tree in (incoming, base, branded))
                if version and name in PROJECT_FIELDS:
                    data = merge_project(name, before, original, custom, version)
                elif version and name == 'main.js':
                    header, before = split_upstream_header(before)
                    _, original = split_upstream_header(original)
                    _, custom = split_upstream_header(custom)
                    data = header + merge_file(before, original, custom, Path(directory))
                else:
                    data = merge_file(before, original, custom, Path(directory))
            except (ValueError, KeyError, TypeError, UnicodeError) as error:
                conflicts.append(f"{name}: {error}")
                continue
            if data is not None:
                result[name] = data
    if conflicts:
        raise ValueError("Merge requires review:\n" + "\n".join(conflicts))
    return result


def write_sources(result, output):
    output.mkdir(parents=True)
    for name, data in result.items():
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base", "branded", "upstream", "output"):
        parser.add_argument(name, type=Path)
    parser.add_argument('--version')
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output path already exists")
    if args.version and not re.fullmatch(r'\d+\.\d+\.\d+', args.version):
        parser.error("version must have three numeric parts")
    try:
        result = merge_sources(*map(read_sources, (args.base, args.branded, args.upstream)), args.version)
    except ValueError as error:
        parser.exit(1, str(error) + '\n')
    write_sources(result, args.output)
    print(f"Prepared {len(result)} files in {args.output}")


if __name__ == "__main__":
    main()
