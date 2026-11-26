"""The archive guard must reject paths that can escape the restored volume."""
import io
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/validate-backup-tar.py"


def archive(entries):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode="w") as output:
        for name, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == "link":
                info.type = tarfile.SYMTYPE
                info.linkname = "/run/woowtechbot/options.json"
                output.addfile(info)
            elif kind.startswith("hardlink:"):
                info.type = tarfile.LNKTYPE
                info.linkname = kind.partition(":")[2]
                output.addfile(info)
            else:
                payload = b"synthetic data"
                info.size = len(payload)
                output.addfile(info, io.BytesIO(payload))
    return data.getvalue()


class ArchiveGuardTest(unittest.TestCase):
    def check(self, entries, expected):
        data = archive(entries)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "data.tar"
            path.write_bytes(data)
            for source in (str(path), "-"):
                result = subprocess.run(
                    ["python3", "-I", str(SCRIPT), source],
                    input=data if source == "-" else None,
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(result.returncode == 0, expected, result.stderr.decode())

    def test_valid_volume_with_absolute_symlink_target(self):
        self.check([("./data/file.txt", "file"), ("./options.json", "link")], True)

    def test_parent_and_absolute_paths_are_refused(self):
        for name in ("../escape", "data/../../escape", "/etc/passwd"):
            with self.subTest(name=name):
                self.check([(name, "file")], False)

    def test_file_nested_beneath_earlier_symlink_is_refused(self):
        self.check([("link", "link"), ("link/escape", "file")], False)

    def test_later_symlink_cannot_replace_an_earlier_directory(self):
        self.check([("link/first", "file"), ("link", "link")], False)

    def test_duplicate_and_file_parent_paths_are_refused(self):
        self.check([("file", "file"), ("./file", "file")], False)
        self.check([("file", "file"), ("file/child", "file")], False)

    def test_hardlinks_must_point_to_an_earlier_regular_file(self):
        self.check([("file", "file"), ("copy", "hardlink:file")], True)
        self.check([("link", "link"), ("copy", "hardlink:link")], False)
        self.check([("copy", "hardlink:../escape")], False)

    def test_empty_archive_is_refused(self):
        self.check([], False)


if __name__ == "__main__":
    unittest.main()
