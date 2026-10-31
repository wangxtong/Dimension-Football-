import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
import zipfile

spec=importlib.util.spec_from_file_location('bundle',Path(__file__).with_name('bundle.py'))
bundle=importlib.util.module_from_spec(spec);spec.loader.exec_module(bundle)

class BundleTests(unittest.TestCase):
    def release_metadata(self,files):
        return {'kind':'release','sourceCommit':'a'*40,'supportedStateSchemas':[1],
                'toolingDigest':bundle.digest(b''.join(n.encode()+b'\0'+files[n] for n in sorted(files) if n.startswith('deploy/')))}

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

    def test_runtime_bundle_excludes_test_helpers_but_source_zip_retains_them(self):
        excluded=['collector/test/helpers/release-gate-mock.mjs','collector/test/publication-release-gate.test.mjs',
                  'collector/sources/test/quotes.mjs','collector/browser-runtime/test/runtime.test.mjs',
                  'website/test/hosted-fixtures.mjs','collector/helpers/mock-gate.mjs','scripts/__tests__/gate.mjs',
                  'deploy/test_bundle.py','deploy/test_handoff.py']
        included={'collector/operations.mjs':'// runtime','collector/publication-release-gate.mjs':"export const RELEASE_GATE='BLOCKED'",
                  'website/report-schema.mjs':'// runtime schema','config/delivery.json':'{}','package.json':'{}',
                  'deploy/release-contract.json':'{"supportedStateSchemas":[1]}','deploy/bundle.py':'# deployed tool'}
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'repo';root.mkdir()
            for name,value in {**included,**{n:'// test-only' for n in excluded}}.items():
                path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(value)
            def git(*args):return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.DEVNULL)
            git('init');git('add','.')
            git('-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','runtime separation')
            sha=git('rev-parse','HEAD').decode().strip();archive=Path(d)/'release.tar'
            info=bundle.build(root,sha,archive);manifest,files=bundle.inspect_archive(archive,info['sha256'])
            self.assertEqual(set(files),set(included));self.assertEqual(manifest['supportedStateSchemas'],[1])
            expected=bundle.digest(b''.join(n.encode()+b'\0'+files[n] for n in sorted(files) if n.startswith('deploy/')))
            self.assertEqual(manifest['toolingDigest'],expected)
            with zipfile.ZipFile(io.BytesIO(git('archive','--format=zip',sha))) as development:
                self.assertTrue(set(excluded).issubset(set(development.namelist())))
                self.assertTrue(set(included).issubset(set(development.namelist())))

    def test_fully_hashed_archive_and_directory_cannot_smuggle_test_or_helper_code(self):
        for name in ['collector/test/helpers/gate.mjs','collector/sources/test/source.mjs','website/test/fixture.mjs',
                     'collector/helpers/gate.mjs','collector/nested/gate.test.mjs','deploy/test_injection.py']:
            with self.subTest(name=name),tempfile.TemporaryDirectory() as d:
                files={'collector/operations.mjs':b'// runtime',name:b'// injected test gate'}
                archive=Path(d)/'bad.tar';metadata=self.release_metadata(files)
                info=bundle.write_archive(archive,files,metadata)
                with self.assertRaisesRegex(ValueError,'RELEASE_PATH_INVALID'):
                    bundle.inspect_archive(archive,info['sha256'])
                root=Path(d)/'source';root.mkdir()
                for path,data in files.items():
                    target=root/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
                manifest={'version':1,**metadata,'files':{n:{'sha256':bundle.digest(b),'size':len(b)} for n,b in files.items()}}
                (root/bundle.MANIFEST).write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError,'SOURCE_PATH_INVALID'):bundle.verify_directory(root)
                with self.assertRaisesRegex(ValueError,'SOURCE_PATH_INVALID'):bundle.copy_runtime(root,Path(d)/'runtime')
                self.assertFalse((Path(d)/'runtime').exists())

    def test_runtime_copy_preserves_schema_and_release_commit_but_not_deployment_tools(self):
        files={'collector/operations.mjs':b'// runtime','collector/publication-release-gate.mjs':b"export const RELEASE_GATE='BLOCKED'",
               'website/report-schema.mjs':b'// report contract','config/delivery.json':b'{}','package.json':b'{}',
               'deploy/release.sh':b'#!/bin/sh','scripts/setup-crawler.mjs':b'// tool'}
        with tempfile.TemporaryDirectory() as d:
            archive=Path(d)/'release.tar';info=bundle.write_archive(archive,files,self.release_metadata(files))
            source=Path(d)/'source';bundle.extract(archive,source,info['sha256'])
            runtime=Path(d)/'runtime';result=bundle.copy_runtime(source,runtime)
            self.assertEqual(result['sourceCommit'],'a'*40);self.assertEqual(result['files'],5)
            self.assertEqual((runtime/'website/report-schema.mjs').read_bytes(),files['website/report-schema.mjs'])
            self.assertFalse((runtime/'deploy').exists());self.assertFalse((runtime/'scripts').exists())
            with self.assertRaisesRegex(ValueError,'DESTINATION_NOT_EMPTY'):bundle.copy_runtime(source,runtime)
            (source/'collector/operations.mjs').write_bytes(b'// changed')
            with self.assertRaisesRegex(ValueError,'FILE_DIGEST_MISMATCH'):bundle.copy_runtime(source,Path(d)/'second-runtime')

    def test_unlisted_test_file_cannot_bypass_directory_verification(self):
        with tempfile.TemporaryDirectory() as d:
            files={'collector/operations.mjs':b'// runtime'};archive=Path(d)/'release.tar'
            info=bundle.write_archive(archive,files,self.release_metadata(files));source=Path(d)/'source'
            bundle.extract(archive,source,info['sha256']);path=source/'collector/test/helpers/malicious.mjs'
            path.parent.mkdir(parents=True);path.write_text('// extra')
            with self.assertRaisesRegex(ValueError,'SOURCE_PATH_INVALID'):bundle.verify_directory(source)

if __name__=='__main__':unittest.main()
