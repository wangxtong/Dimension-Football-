import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile


class PackageTests(unittest.TestCase):
    def fixture(self, root):
        for name in ("package.json", "README.md", ".gitignore", ".gitattributes", ".env.example"):
            (root / name).write_text("fixture")
        (root / "scripts").mkdir()
        shutil.copyfile(Path(__file__).with_name("package.py"), root / "scripts/package.py")
        for name in ("collector/run.mjs", "collector/browser-runtime/package.json", "collector/browser-runtime/package-lock.json",
                     "collector/browser-runtime/index.mjs", "collector/browser-runtime/node_modules/example/index.js",
                     "website/report-schema.mjs", "website/telegram-presentation.mjs", "website/test/ui.test.mjs",
                     "collector/browser-runtime/.auth/session.json", "collector/browser-runtime/browsers/chrome",
                     "deploy/test/.env.production", "collector/test/private.auth.json", "collector/test/state.providers.json"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic packaging fixture")

    def test_package_excludes_dependencies_browser_sessions_and_nested_environment_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            subprocess.run([sys.executable, root / "scripts/package.py"], check=True, capture_output=True)
            with ZipFile(root / "artifacts/Dimension-Football-collection.zip") as archive:
                names = archive.namelist()
            self.assertIn("collector/browser-runtime/package-lock.json", names)
            self.assertIn("collector/browser-runtime/index.mjs", names)
            self.assertIn(".env.example", names)
            self.assertIn("website/report-schema.mjs", names)
            self.assertIn("website/telegram-presentation.mjs", names)
            self.assertIn("website/test/ui.test.mjs", names)
            self.assertNotIn("collector/test/state.providers.json", names)
            self.assertFalse(any("node_modules" in name or ".auth" in name or ".env.production" in name or "/browsers/" in name for name in names))

    def test_source_symlink_directory_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / "collector/link").symlink_to(root / "deploy", target_is_directory=True)
            result = subprocess.run([sys.executable, root / "scripts/package.py"], capture_output=True)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
