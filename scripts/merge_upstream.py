"""Prepare a reviewable source tree from three release ZIPs."""

import argparse
from pathlib import Path, PurePosixPath, PureWindowsPath
import subprocess
import tempfile
from zipfile import ZipFile


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("base", "branded", "upstream", "output"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output path already exists")
    base, branded, incoming = map(read_sources, (args.base, args.branded, args.upstream))
    result = {}
    conflicts = []
    with tempfile.TemporaryDirectory() as directory:
        for name in sorted(base.keys() | branded.keys() | incoming.keys()):
            try:
                data = merge_file(incoming.get(name), base.get(name), branded.get(name), Path(directory))
            except ValueError as error:
                conflicts.append(f"{name}: {error}")
                continue
            if data is not None:
                result[name] = data
    if conflicts:
        parser.exit(1, "Merge requires review:\n" + "\n".join(conflicts) + "\n")
    args.output.mkdir(parents=True)
    for name, data in result.items():
        destination = args.output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
    print(f"Prepared {len(result)} files in {args.output}")


if __name__ == "__main__":
    main()

