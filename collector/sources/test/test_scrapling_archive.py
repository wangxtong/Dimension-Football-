import importlib.util
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent.parent / 'scrapling_archive.py'
spec = importlib.util.spec_from_file_location('scrapling_archive', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NOW = '2026-11-02T04:00:00Z'


def fixture(*, valid=True, finished=True):
    item = {
        'matchID': 42, 'leagueShortcut': 'bl1', 'leagueSeason': 2025,
        'matchDateTimeUTC': '2025-10-15T16:30:00Z',
        'team1': {'teamId': 10, 'teamName': 'Team A'},
        'team2': {'teamId': 20, 'teamName': 'Team B'},
        'matchIsFinished': finished,
        'matchResults': [{'resultTypeKind': 'After90Minutes', 'pointsTeam1': 2, 'pointsTeam2': 1}],
    }
    if not valid:
        item['team2']['teamId'] = 10
    return item


def xml():
    return (b'<rss version="2.0"><channel><title>Sport</title><item>'
            b'<title>Football headline</title>'
            b'<link>https://www.bbc.co.uk/sport/football/articles/abc123</link>'
            b'<pubDate>Mon, 02 Nov 2026 03:55:00 GMT</pubDate>'
            b'</item></channel></rss>')


class ScraplingArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_source_is_fixed_allowlist_not_generic_arbitrary_url(self):
        self.assertEqual(module.target_url('openligadb-bl1-history', 2025),
                         'https://api.openligadb.de/getmatchdata/bl1/2025')
        with self.assertRaises(module.ArchiveError):
            module.target_url('https://localhost/admin', None)
        with self.assertRaises(module.ArchiveError):
            module.target_url('openligadb-bl1-history', '../../secrets')
        with self.assertRaises(module.ArchiveError):
            module.target_url('bbc-football-rss', 2025)

    def test_live_scrapling_fetch_uses_no_stealth_redirects_and_checks_real_server_time(self):
        class Response:
            status = 200
            url = 'https://feeds.bbci.co.uk/sport/football/rss.xml'
            body = xml()
            headers = {'date': 'Mon, 02 Nov 2026 04:00:00 GMT'}
        requests = []
        def fake(url, **kwargs):
            requests.append((url, kwargs))
            return Response()
        raw, fetched, server = module.fetch_live('bbc-football-rss', None,
            now=datetime(2026, 11, 2, 4, tzinfo=timezone.utc), fetcher=fake)
        self.assertEqual(raw, xml())
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0][1], {'follow_redirects': False, 'retries': 0,
                                          'timeout': 8, 'stealthy_headers': False})
        self.assertTrue(fetched.startswith('2026-11-02T04:00:00'))
        self.assertTrue(server.startswith('2026-11-02T04:00:00'))
        Response.status = 403
        with self.assertRaisesRegex(module.ArchiveError, 'SOURCE_ACCESS_BLOCKED'):
            module.fetch_live('bbc-football-rss', None,
                now=datetime(2026, 11, 2, 4, tzinfo=timezone.utc), fetcher=fake)

    def test_bundesliga_ft_and_missing_are_distinguished_no_pregame_claim(self):
        raw = json.dumps([fixture(), {**fixture(), 'matchID': 43, 'matchIsFinished': False},
                          {**fixture(valid=False), 'matchID': 44}]).encode()
        parsed = module.normalize(raw, 'openligadb-bl1-history', 2025, NOW)
        self.assertEqual(parsed['received'], 3)
        self.assertEqual(parsed['validIdentities'], 2)
        self.assertEqual(parsed['finishedWithVerifiedFT'], 1)
        self.assertEqual(parsed['missingOrUnverifiedFT'], 1)
        self.assertEqual(parsed['rejectedIdentity'], 1)
        self.assertFalse(parsed['historicalPregameObserved'])
        self.assertFalse(parsed['modelReady'])
        self.assertEqual(parsed['records'][0]['ft'], [2, 1])
        self.assertIsNone(parsed['records'][1]['ft'])

    def test_live_raw_can_be_saved_immutably_and_verified_in_fresh_process(self):
        raw = json.dumps([fixture()]).encode()
        stored = module.store(raw, source='openligadb-bl1-history', season=2025,
            fetched_at=NOW, out_root=self.tmp.name, mode='OFFLINE_VERIFIED_INPUT')
        self.assertEqual(stored['receipt']['rawSha256'], module.h(raw))
        self.assertEqual(stored['receipt']['recordCount'], 1)
        self.assertFalse(stored['receipt']['containsVerifiedOdds'])
        self.assertFalse(stored['receipt']['modelReady'])
        path = Path(stored['directory'])
        self.assertEqual((path / 'raw.bin').read_bytes(), raw)
        run = subprocess.run([sys.executable, str(SCRIPT), '--verify', str(path)],
                             capture_output=True, text=True, check=False)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertTrue(json.loads(run.stdout)['verified'])
        with self.assertRaisesRegex(module.ArchiveError, 'ARCHIVE_DUPLICATE_RUN'):
            module.store(raw, source='openligadb-bl1-history', season=2025,
                fetched_at=NOW, out_root=self.tmp.name, mode='OFFLINE_VERIFIED_INPUT')

    def test_corrupted_raw_fails_readback_not_recovered_from_last_good(self):
        r = module.store(json.dumps([fixture()]).encode(), source='openligadb-bl1-history',
            season=2025, fetched_at=NOW, out_root=self.tmp.name, mode='OFFLINE_VERIFIED_INPUT')
        path = Path(r['directory'])
        (path / 'raw.bin').write_bytes(b'{"evil": true}')
        with self.assertRaisesRegex(module.ArchiveError, 'RAW_HASH_MISMATCH'):
            module.verify(path)

    def test_bbc_headlines_are_metadata_only_without_merchant_odds_or_model_signal(self):
        r = module.normalize(xml(), 'bbc-football-rss', None, NOW)
        self.assertEqual(r['kind'], 'football-headlines-only')
        self.assertEqual(r['retained'], 1)
        self.assertFalse(r['containsOdds'])
        self.assertFalse(r['containsInjuriesOrLineupsVerified'])
        self.assertFalse(r['modelReady'])
        self.assertTrue(r['records'][0]['publishedAtUTC'].startswith('2026-11-02T03:55:00'))

    def test_xml_entity_and_duplicates_rejected_or_deduplicated(self):
        with self.assertRaisesRegex(module.ArchiveError, 'XML_ENTITY_FORBIDDEN'):
            module.normalize(b'<!DOCTYPE rss [<!ENTITY x "bad">]><rss/>', 'bbc-football-rss', None, NOW)
        item = (b'<item><title>A</title><link>https://www.bbc.com/sport/football/articles/1</link>'
                b'<pubDate>Mon, 02 Nov 2026 03:00:00 GMT</pubDate></item>')
        rss = b'<rss><channel>' + item * 2 + b'</channel></rss>'
        r = module.normalize(rss, 'bbc-football-rss', None, NOW)
        self.assertEqual(r['received'], 2)
        self.assertEqual(r['retained'], 1)

    def test_duplicate_provider_fixture_id_refuses_entire_invalid_source_document(self):
        with self.assertRaisesRegex(module.ArchiveError, 'DUPLICATE_FIXTURE_ID'):
            module.normalize(json.dumps([fixture(), fixture()]).encode(),
                             'openligadb-bl1-history', 2025, NOW)


if __name__ == '__main__':
    unittest.main()