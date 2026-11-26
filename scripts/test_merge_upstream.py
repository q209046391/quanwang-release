from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from zipfile import ZipFile


class SourceMergeTest(unittest.TestCase):
    def run_merge(self, upstream):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inputs = []
            for label, value in (
                ("base", "title=Upstream\n\n\nengine=8.3\n"),
                ("branded", "title=Quanwang\n\n\nengine=8.3\n"),
                ("upstream", upstream),
            ):
                inputs.append(root / f"{label}.zip")
                with ZipFile(inputs[-1], "w") as archive:
                    archive.writestr("package.json", "{}")
                    archive.writestr("app.txt", value)
            output = root / "output"
            script = Path(__file__).with_name("merge_upstream.py")
            run = subprocess.run(
                [sys.executable, str(script), *map(str, inputs), str(output)],
                capture_output=True,
                text=True,
            )
            return run, (output / "app.txt").read_text() if output.exists() else None

    def test_independent_changes_are_combined(self):
        run, output = self.run_merge("title=Upstream\n\n\nengine=8.4\n")
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(output, "title=Quanwang\n\n\nengine=8.4\n")

    def test_conflict_produces_no_release_tree(self):
        run, output = self.run_merge("title=New name\n\n\nengine=8.3\n")
        self.assertEqual(run.returncode, 1)
        self.assertIn("app.txt", run.stderr)
        self.assertIsNone(output)


if __name__ == "__main__":
    unittest.main()

