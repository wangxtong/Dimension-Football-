import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('bundle',Path(__file__).with_name('bundle.py'))
bundle=importlib.util.module_from_spec(spec);spec.loader.exec_module(bundle)

class BundleTests(unittest.TestCase):
    def test_roundtrip_corruption_and_wrong_expected_digest(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'release.tar'
            info=bundle.write_archive(path,{'collector/a.mjs':b'export default 1'}, {'kind':'release','sourceCommit':'a'*40})
            m,files=bundle.inspect_archive(path,info['sha256']);self.assertEqual(files['collector/a.mjs'],b'export default 1')
            with self.assertRaisesRegex(ValueError,'DIGEST_MISMATCH'):bundle.inspect_archive(path,'b'*64)
            raw=path.read_bytes().replace(b'export default 1',b'export default 2');path.write_bytes(raw)
            with self.assertRaisesRegex(ValueError,'FILE_DIGEST_MISMATCH'):bundle.inspect_archive(path)

    def test_traversal_symlink_duplicate_and_secret_members_rejected(self):
        for name,kind in [('../escape','file'),('/absolute','file'),('collector/link','symlink'),('collector/.env','file')]:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as d:
                path=Path(d)/'bad.tar'
                with tarfile.open(path,'w') as tar:
                    m=tarfile.TarInfo(name)
                    if kind=='symlink':m.type=tarfile.SYMTYPE;m.linkname='/etc/passwd';tar.addfile(m)
                    else:m.size=1;tar.addfile(m,io.BytesIO(b'x'))
                with self.assertRaises((ValueError,KeyError)):bundle.inspect_archive(path)

    def test_backup_contains_state_outbox_ledger_but_excludes_secret_and_locks(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'state';root.mkdir()
            for name in ['state.json','state.json.crawl.json','reports/.delivery/outbox.json','reports/forecast-ledger/rows.json','operations/tasks.json']:
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('{}')
            (root/'collector.env').write_text('DO_NOT_PACKAGE')
            (root/'state.json.lock').write_text('LOCK')
            archive=Path(d)/'backup.tar';info=bundle.backup(root,archive)
            m,files=bundle.inspect_archive(archive,info['sha256'],'backup')
            self.assertEqual(len(files),5);self.assertNotIn('collector.env',files)
            restored=Path(d)/'restored';bundle.extract(archive,restored,info['sha256'],'backup')
            self.assertTrue((restored/'reports/.delivery/outbox.json').exists())
            with self.assertRaisesRegex(ValueError,'DESTINATION_NOT_EMPTY'):bundle.extract(archive,restored,info['sha256'],'backup')

    def test_backup_symlinks_and_invalid_json_fail_without_touching_production(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'state';root.mkdir();(root/'reports').mkdir();(root/'reports/leak.json').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(ValueError,'SYMLINK'):bundle.backup(root,Path(d)/'backup.tar')

    def test_build_uses_committed_bytes_not_uncommitted_files(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'repo';root.mkdir()
            for name,value in {'collector/operations.mjs':'// committed','deploy/release-contract.json':'{"supportedStateSchemas":[1]}','package.json':'{}'}.items():
                p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value)
            def git(*args):return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.DEVNULL).decode().strip()
            git('init');git('-c','user.name=test','-c','user.email=test@example.invalid','add','.')
            git('-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','fixture')
            sha=git('rev-parse','HEAD');(root/'collector/operations.mjs').write_text('// uncommitted')
            result=bundle.build(root,sha,Path(d)/'release.tar');_,files=bundle.inspect_archive(Path(d)/'release.tar',result['sha256'])
            self.assertEqual(files['collector/operations.mjs'],b'// committed')

if __name__=='__main__':unittest.main()
