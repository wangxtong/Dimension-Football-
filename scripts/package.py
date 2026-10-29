"""Build a source-only deployment archive; no database, reports or credentials."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
files = [root / name for name in ("package.json", "README.md", ".gitignore", ".gitattributes", ".env.example")]
for name in (".github", "collector", "config", "deploy", "docs", "examples", "scripts"):
    files.extend(path for path in (root / name).rglob("*") if path.is_file() and "__pycache__" not in path.parts)

for path in files:
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise SystemExit("Refusing a source outside the project")
    if path.name in {".env", ".env.local", "runtime-secrets.local.json"} or path.suffix in {".sqlite", ".db", ".lock", ".pyc"}:
        raise SystemExit("Refusing a runtime or credential file")

output = root / "artifacts" / "Dimension-Football-collection.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for path in sorted(set(files)):
        archive.write(path, path.relative_to(root).as_posix())
with ZipFile(output) as archive:
    if archive.testzip() is not None:
        raise SystemExit("Archive verification failed")
print(f"Created {output} ({len(set(files))} source files)")
