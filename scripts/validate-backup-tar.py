#!/usr/bin/env python3
"""Read a Podman volume tar without extracting it; reject paths that could escape the volume."""
import posixpath
import sys
import tarfile


def valid_name(name: str) -> str:
    if name.startswith("/") or "\x00" in name:
        raise ValueError("absolute or invalid member path")
    parts = name.split("/")
    if ".." in parts:
        raise ValueError("member path crosses a parent directory")
    clean = posixpath.normpath(name)
    if clean in ("", "."):
        return "."
    if clean.startswith("../"):
        raise ValueError("member path escapes the volume")
    return clean


def main() -> None:
    source = sys.stdin.buffer if sys.argv[1] == "-" else open(sys.argv[1], "rb")
    seen: dict[str, str] = {}
    count = 0
    with source, tarfile.open(fileobj=source, mode="r|*") as archive:
        for member in archive:
            path = valid_name(member.name)
            if path == ".":
                if not member.isdir():
                    raise ValueError("only a directory may name the volume root")
                continue
            if path in seen:
                raise ValueError("archive repeats a member path")
            parts = path.split("/")
            for i in range(1, len(parts)):
                parent = "/".join(parts[:i])
                if parent in seen and seen[parent] != "dir":
                    raise ValueError("member is nested inside a file or symlink")
            if member.issym():
                kind = "symlink"
            elif member.islnk():
                target = valid_name(member.linkname)
                if seen.get(target) != "file":
                    raise ValueError("hardlink target is not an earlier regular file")
                kind = "file"
            elif member.isfile():
                kind = "file"
            elif member.isdir():
                kind = "dir"
            else:
                raise ValueError("archive contains a special file")
            if kind != "dir" and any(name.startswith(path + "/") for name in seen):
                raise ValueError("file or symlink replaces a directory with earlier members")
            seen[path] = kind
            count += 1
    if count == 0:
        raise ValueError("volume archive contains no data")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as error:
        print(f"invalid volume archive: {error}", file=sys.stderr)
        raise SystemExit(1)
