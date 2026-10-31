import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import unittest
import tarfile
import hashlib
import io
import subprocess
import sys

def module(name,file):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
nginx=module('nginx_namespace','nginx-namespace.py')
secrets=module('report_secrets','ensure-report-secrets.py')
persistent=module('persistent_config','persistent-config.py')
restore=module('restore_verify','restore-verify.py')
bundle=module('bundle','bundle.py')
ORIGINAL='''# Existing production app and bridge. Braces in comments: { }
server {
    listen 80;
    server_name football.fotpredict.xyz;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name football.fotpredict.xyz;
    ssl_certificate /etc/letsencrypt/live/football.fotpredict.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/football.fotpredict.xyz/privkey.pem;
    location / { proxy_pass http://127.0.0.1:8000; }
    location /weidu-bridge/ { proxy_pass http://127.0.0.1:8091/; }
    location = /literal { return 200 "{"; }
    add_header X-Test ${hostname};
}
'''

class NginxTests(unittest.TestCase):
    def test_preserves_apps_and_inserts_only_in_tls_server_idempotently(self):
        changed=nginx.plan(ORIGINAL)
        self.assertEqual(changed.replace(nginx.SNIPPET,''),ORIGINAL)
        self.assertEqual(nginx.plan(changed),changed)
        self.assertIn('proxy_pass http://127.0.0.1:8000;',changed)
        self.assertIn('proxy_pass http://127.0.0.1:8091/;',changed)
        self.assertEqual(changed.count('proxy_pass http://127.0.0.1:8787/;'),1)
        self.assertGreater(changed.index(nginx.BEGIN),changed.index('listen 443 ssl'))

    def test_absent_ambiguous_unmanaged_and_malformed_configs_fail_closed(self):
        fixtures=[ORIGINAL.replace('listen 443 ssl','listen 8443 ssl').replace('listen [::]:443 ssl','listen [::]:8443 ssl'),
                  ORIGINAL+'server {listen 443 ssl;server_name football.fotpredict.xyz;}',
                  ORIGINAL.replace('location / {','location /dimension-football/ {'),ORIGINAL[:-2],
                  ORIGINAL+nginx.BEGIN]
        for source in fixtures:
            with self.subTest(source=source[:50]),self.assertRaises(ValueError):nginx.plan(source)

    def test_validated_change_is_backed_up_and_second_run_does_not_reload(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'football-prediction';p.write_text(ORIGINAL);p.chmod(0o640);calls=[]
            result=nginx.apply(p,lambda args:calls.append(args) or True)
            self.assertEqual(Path(result['backup']).read_text(),ORIGINAL)
            self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o640)
            self.assertEqual(calls,[['nginx','-t'],['systemctl','reload','nginx']])
            calls.clear();result=nginx.apply(p,lambda args:calls.append(args) or True)
            self.assertFalse(result['changed']);self.assertEqual(calls,[['nginx','-t']])

    def test_validation_failure_restores_exact_original_without_reload(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'football-prediction';p.write_text(ORIGINAL);answers=iter([False,True]);calls=[]
            def runner(args):calls.append(args);return next(answers)
            with self.assertRaisesRegex(ValueError,'VALIDATION_FAILED_RESTORED'):nginx.apply(p,runner)
            self.assertEqual(p.read_text(),ORIGINAL);self.assertEqual(calls,[['nginx','-t'],['nginx','-t']])

    def test_reload_failure_restores_and_reloads_original(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'football-prediction';p.write_text(ORIGINAL);answers=iter([True,False,True,True])
            with self.assertRaisesRegex(ValueError,'RELOAD_FAILED_RESTORED'):nginx.apply(p,lambda args:next(answers))
            self.assertEqual(p.read_text(),ORIGINAL)

    def test_symlink_and_concurrent_edits_never_get_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            target=Path(d)/'target';target.write_text(ORIGINAL);p=Path(d)/'link';p.symlink_to(target)
            with self.assertRaisesRegex(ValueError,'NOT_REGULAR'):nginx.apply(p,lambda args:True)
            def concurrent(args):target.write_text('# admin edit\n'+ORIGINAL);return False
            with self.assertRaisesRegex(ValueError,'RESTORE_SKIPPED'):nginx.apply(target,concurrent)
            self.assertEqual(target.read_text(),'# admin edit\n'+ORIGINAL)

class SecretTests(unittest.TestCase):
    def test_missing_tokens_are_independent_valid_private_and_never_in_result(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);(root/'report.env').write_text('REPORTS_PORT=8787\n');(root/'collector.env').write_text('EXISTING_CONFIG=keep\n')
            result=secrets.ensure(root,uid=os.getuid(),gid=os.getgid())
            read=(root/'report.env').read_text();probe=(root/'collector.env').read_text()
            a=re.search(r'REPORTS_READ_TOKEN=([a-f0-9]{64})',read).group(1);b=re.search(r'REPORTS_PROBE_TOKEN=([a-f0-9]{64})',probe).group(1)
            self.assertNotEqual(a,b);self.assertNotIn(a,json.dumps(result));self.assertNotIn(b,json.dumps(result))
            self.assertIn('EXISTING_CONFIG=keep\n',probe);self.assertEqual(stat.S_IMODE((root/'report.env').stat().st_mode),0o640)
            again=secrets.ensure(root,uid=os.getuid(),gid=os.getgid());self.assertEqual(again['createdKeys'],[])
            self.assertEqual((root/'report.env').read_text(),read);self.assertEqual((root/'collector.env').read_text(),probe)

    def test_empty_values_filled_but_quoted_existing_value_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);old='REPORTS_READ_TOKEN="'+'a'*64+'" # preserve comment\n';(root/'report.env').write_text(old)
            (root/'collector.env').write_text("REPORTS_PROBE_TOKEN=''\n")
            result=secrets.ensure(root,uid=os.getuid(),gid=os.getgid())
            self.assertEqual(result['createdKeys'],['REPORTS_PROBE_TOKEN']);self.assertEqual((root/'report.env').read_text(),old)

    def test_invalid_or_duplicate_old_values_fail_before_either_file_changes(self):
        for bad in ['REPORTS_PROBE_TOKEN=bad\n','REPORTS_PROBE_TOKEN=\nREPORTS_PROBE_TOKEN=\n']:
            with tempfile.TemporaryDirectory() as d:
                root=Path(d);(root/'report.env').write_text('REPORTS_PORT=8787\n');(root/'collector.env').write_text(bad)
                with self.assertRaises(ValueError):secrets.ensure(root,uid=os.getuid(),gid=os.getgid())
                self.assertEqual((root/'report.env').read_text(),'REPORTS_PORT=8787\n');self.assertEqual((root/'collector.env').read_text(),bad)

    def test_symlink_secret_target_is_never_read_or_replaced(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);target=root/'unrelated';target.write_text('unchanged');(root/'report.env').symlink_to(target)
            with self.assertRaises(OSError):secrets.ensure(root,uid=os.getuid(),gid=os.getgid())
            self.assertEqual(target.read_text(),'unchanged');self.assertTrue((root/'report.env').is_symlink())

class NodeArchiveTests(unittest.TestCase):
    def program(self):
        script=Path(__file__).with_name('install-node.sh').read_text()
        return script.split("<<'PYNODE'\n",1)[1].split('\nPYNODE',1)[0]

    def fixture(self,root,link=False):
        name='node-v24.19.0-linux-x64.tar.xz';archive=root/name
        with tarfile.open(archive,'w:xz') as tar:
            for path,data in [('node-v24.19.0-linux-x64/bin/node',b'synthetic runtime'),('node-v24.19.0-linux-x64/LICENSE',b'fixture license')]:
                member=tarfile.TarInfo(path)
                if link and path.endswith('/node'):member.type=tarfile.SYMTYPE;member.linkname='/outside';tar.addfile(member)
                else:member.size=len(data);tar.addfile(member,io.BytesIO(data))
        (root/'SHASUMS256.txt').write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+name+'\n')
        return name

    def test_pinned_runtime_extracts_only_regular_binary_and_license(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);name=self.fixture(root)
            r=subprocess.run([sys.executable,'-c',self.program(),str(root),name,'v24.19.0','x64'],capture_output=True,text=True)
            self.assertEqual(r.returncode,0);self.assertEqual((root/'runtime/bin/node').read_bytes(),b'synthetic runtime')
            self.assertEqual(stat.S_IMODE((root/'runtime/bin/node').stat().st_mode),0o755)

    def test_bad_checksum_or_archive_symlink_never_install_a_runtime(self):
        for link in [False,True]:
            with tempfile.TemporaryDirectory() as d:
                root=Path(d);name=self.fixture(root,link=link)
                if not link:(root/'SHASUMS256.txt').write_text('0'*64+'  '+name+'\n')
                r=subprocess.run([sys.executable,'-c',self.program(),str(root),name,'v24.19.0','x64'],capture_output=True,text=True)
                self.assertNotEqual(r.returncode,0);self.assertFalse((root/'runtime/bin/node').exists())

class PersistentPathTests(unittest.TestCase):
    def test_new_install_uses_nested_state_and_known_base_without_claiming_acceptance(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=root/'operations.json';p.write_text('{"publicReportOrigin":null}')
            result=persistent.configure(p,root,True)
            self.assertEqual(result['stateRelativePath'],'state/state.json');self.assertEqual(result['liveAcceptance'],'not_verified')
            self.assertEqual(json.loads(p.read_text())['publicReportOrigin'],'https://football.fotpredict.xyz/dimension-football/')

    def test_existing_legacy_state_is_selected_without_copy_or_move(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=root/'operations.json';p.write_text('{"publicReportOrigin":null}');(root/'state.json').write_text('{"version":1}')
            result=persistent.configure(p,root)
            self.assertEqual(result['stateRelativePath'],'state.json');self.assertFalse((root/'state/state.json').exists())
            self.assertEqual(persistent.state_relative({}),'state.json')

    def test_ambiguous_paths_require_selection_and_explicit_custom_origin_is_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);p=root/'operations.json';p.write_text('{}');(root/'state.json').write_text('{}');(root/'state').mkdir();(root/'state/state.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'MULTIPLE_STATE_PATHS'):persistent.configure(p,root)
            self.assertEqual(p.read_text(),'{}')
            p.write_text('{"stateRelativePath":"state/state.json","publicReportOrigin":"https://existing.example/feed/"}')
            persistent.configure(p,root)
            self.assertEqual(json.loads(p.read_text())['publicReportOrigin'],'https://existing.example/feed/')

    def test_rollback_rejects_old_code_that_only_understands_legacy_state_path(self):
        old={'supportedStateSchemas':[1]};new={**old,'supportedStatePaths':['state.json','state/state.json']}
        with self.assertRaisesRegex(ValueError,'STATE_PATH_INCOMPATIBLE'):persistent.check_contract({'stateRelativePath':'state/state.json'},old,{'version':1})
        self.assertEqual(persistent.check_contract({'stateRelativePath':'state/state.json'},new,{'version':1})['status'],'state_compatible')
        with self.assertRaisesRegex(ValueError,'STATE_SCHEMA_INCOMPATIBLE'):persistent.check_contract({'stateRelativePath':'state/state.json'},new,{'version':2})
        self.assertEqual(persistent.check_contract({},old,{'version':1})['stateRelativePath'],'state.json')


class RestoreEvidenceTests(unittest.TestCase):
    def fixture(self, root):
        folder = root/'reports'
        folder.mkdir()
        report_id = 'a'*64
        report = {'publication': {'reportId': report_id}, 'simulated': False}
        data = json.dumps(report).encode()
        (folder/'predictions.json').write_bytes(data)
        receipt = {'version': 1, 'reportId': report_id,
                   'channels': {'files': {'status': 'published'}},
                   'files': [{'name': 'predictions.json', 'sha256': hashlib.sha256(data).hexdigest()}]}
        (folder/'publication.json').write_text(json.dumps(receipt))
        return folder, receipt

    def test_restore_verifies_report_receipt_and_file_digest(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);self.fixture(root)
            result=restore.verify_restore(root)
            self.assertEqual(result['status'],'restore_drill_passed')
            self.assertTrue(result['publicationEvidenceVerified'])
            self.assertFalse(result['productionModified'])
            self.assertEqual(result['verifiedFiles'],1)

    def test_missing_publication_evidence_cannot_claim_restored(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            with self.assertRaisesRegex(ValueError,'RESTORED_PUBLICATION_EVIDENCE_MISSING'):
                restore.verify_restore(root)
            folder,_=self.fixture(root)
            (folder/'publication.json').unlink()
            with self.assertRaisesRegex(ValueError,'RESTORED_REPORT_RECEIPT_INCOMPLETE'):
                restore.verify_restore(root)

    def test_failed_receipt_and_empty_or_missing_index_are_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,receipt=self.fixture(root)
            for broken in [
                {**receipt, 'channels': {'files': {'status': 'failed'}}},
                {**receipt, 'files': []},
                {k:v for k,v in receipt.items() if k != 'files'}
            ]:
                (folder/'publication.json').write_text(json.dumps(broken))
                with self.assertRaisesRegex(ValueError,'RESTORED_PUBLICATION_NOT_COMPLETE|RESTORED_FILE_INDEX_INVALID'):
                    restore.verify_restore(root)

    def test_wrong_report_id_duplicate_paths_unlisted_predictions_and_corruption_block(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);folder,receipt=self.fixture(root)
            bad_cases=[
                ({**receipt,'reportId':'b'*64},'RESTORED_REPORT_RECEIPT_MISMATCH'),
                ({**receipt,'files':[receipt['files'][0]]*2},'RESTORED_RECEIPT_PATH_INVALID'),
                ({**receipt,'files':[{'name':'other.json','sha256':'0'*64}]},'RESTORED_RECEIPT_FILE_MISSING'),
                ({**receipt,'files':[{'name':'../outside','sha256':'0'*64}]},'RESTORED_RECEIPT_PATH_INVALID'),
                ({**receipt,'files':[{'name':'predictions.json','sha256':'0'*64}]},'RESTORED_RECEIPT_DIGEST_MISMATCH')
            ]
            for broken,code in bad_cases:
                (folder/'publication.json').write_text(json.dumps(broken))
                with self.subTest(code=code),self.assertRaisesRegex(ValueError,code):
                    restore.verify_restore(root)

    def test_shell_restore_drill_accepts_complete_backup_but_rejects_missing_receipt(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'state';root.mkdir()
            folder,_=self.fixture(root)
            script=Path(__file__).with_name('restore-drill.sh')
            archive=Path(d)/'complete.tar'
            complete=bundle.backup(root,archive)
            good=subprocess.run(['bash',str(script),str(archive),complete['sha256']],
                                capture_output=True,text=True,timeout=30)
            self.assertEqual(good.returncode,0,good.stdout+good.stderr)
            self.assertTrue(json.loads(good.stdout)['publicationEvidenceVerified'])
            (folder/'publication.json').unlink()
            partial=Path(d)/'partial.tar'
            damaged=bundle.backup(root,partial)
            bad=subprocess.run(['bash',str(script),str(partial),damaged['sha256']],
                               capture_output=True,text=True,timeout=30)
            self.assertNotEqual(bad.returncode,0,bad.stdout+bad.stderr)
            self.assertEqual(json.loads(bad.stdout)['code'],'RESTORED_REPORT_RECEIPT_INCOMPLETE')

    def test_cli_returns_nonzero_json_blocked_without_leaking_report(self):
        with tempfile.TemporaryDirectory() as d:
            script=Path(__file__).with_name('restore-verify.py')
            result=subprocess.run([sys.executable,str(script),d],capture_output=True,text=True)
            self.assertEqual(result.returncode,2)
            value=json.loads(result.stdout)
            self.assertEqual(value['status'],'blocked')
            self.assertFalse(value['publicationEvidenceVerified'])
            self.assertNotIn(str(d),result.stdout)

if __name__=='__main__':unittest.main()
