"""Opt-in, fail-closed public football source archive; Scrapling is the live HTTP transport.

No challenge bypass, auto-proxy switching, private routes, forecasts or production changes.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import os
from pathlib import Path
import tempfile
import shutil
import sys
import xml.etree.ElementTree as ET

SOURCES = {
    'openligadb-bl1-history': 'https://api.openligadb.de/getmatchdata/bl1/{season}',
    'bbc-football-rss': 'https://feeds.bbci.co.uk/sport/football/rss.xml',
}
MAX_RAW_BYTES = 2_000_000
MAX_RECORDS = 500
SOURCE_AGENT = 'DimensionFootball-SourceArchive/1.0'

class ArchiveError(Exception):
    pass

def fail(code):
    raise ArchiveError(code)

def utc_stamp(value):
    try:
        value = value.replace('Z', '+00:00')
        date = datetime.fromisoformat(value)
        if date.tzinfo is None:
            fail('OBSERVATION_TIME_INVALID')
        return date.astimezone(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')
    except (AttributeError, ValueError):
        fail('OBSERVATION_TIME_INVALID')

def target_url(source, season):
    if source not in SOURCES:
        fail('SOURCE_NOT_ALLOWED')
    if source == 'openligadb-bl1-history':
        if type(season) is not int or not 2010 <= season <= 2026:
            fail('SEASON_NOT_ALLOWED')
        return SOURCES[source].format(season=season)
    if season is not None:
        fail('SEASON_NOT_ALLOWED')
    return SOURCES[source]

def h(data):
    return hashlib.sha256(data).hexdigest()

def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')

def parse_bundesliga(raw, season, fetched_at):
    try:
        data = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        fail('JSON_INVALID')
    if not isinstance(data, list) or len(data) > MAX_RECORDS:
        fail('SOURCE_FORMAT_INVALID')
    records, seen = [], set()
    invalid = 0
    for row in data:
        if not isinstance(row, dict) or type(row.get('matchID')) is not int or row['matchID'] <= 0:
            invalid += 1
            continue
        match_id = row['matchID']
        if match_id in seen:
            fail('DUPLICATE_FIXTURE_ID')
        seen.add(match_id)
        if row.get('leagueShortcut') != 'bl1' or row.get('leagueSeason') != season:
            invalid += 1
            continue
        home, away = row.get('team1'), row.get('team2')
        if not isinstance(home, dict) or not isinstance(away, dict):
            invalid += 1
            continue
        if any(type(team.get('teamId')) is not int or team['teamId'] <= 0 or not isinstance(team.get('teamName'), str)
               or not team['teamName'].strip() for team in (home, away)) or home['teamId'] == away['teamId']:
            invalid += 1
            continue
        kickoff = row.get('matchDateTimeUTC')
        if not isinstance(kickoff, str) or not kickoff.endswith('Z'):
            invalid += 1
            continue
        try:
            kickoff = utc_stamp(kickoff)
        except ArchiveError:
            invalid += 1
            continue
        result = None
        if row.get('matchIsFinished') is True:
            options = [r for r in (row.get('matchResults') or [])
                       if isinstance(r, dict) and r.get('resultTypeKind') == 'After90Minutes']
            if len(options) == 1 and all(type(options[0].get(k)) is int and 0 <= options[0][k] <= 30
                                         for k in ('pointsTeam1', 'pointsTeam2')):
                result = [options[0]['pointsTeam1'], options[0]['pointsTeam2']]
        records.append({'fixtureId': match_id, 'kickoffUTC': kickoff,
                        'homeTeamId': home['teamId'], 'awayTeamId': away['teamId'],
                        'home': home['teamName'].strip()[:120], 'away': away['teamName'].strip()[:120],
                        'ft': result, 'resultObservedAtUTC': fetched_at if result else None})
    return {'kind': 'historical-match-results', 'sourceId': 'openligadb', 'league': 'BL1',
            'seasonStart': season, 'records': records,
            'received': len(data), 'validIdentities': len(records),
            'finishedWithVerifiedFT': sum(bool(x['ft']) for x in records),
            'missingOrUnverifiedFT': sum(x['ft'] is None for x in records), 'rejectedIdentity': invalid,
            'modelReady': False, 'historicalPregameObserved': False}

def parse_bbc_rss(raw, fetched_at):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        fail('XML_ENTITY_FORBIDDEN')
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        fail('XML_INVALID')
    if root.tag != 'rss' or root.find('channel') is None:
        fail('RSS_INVALID')
    items = root.findall('./channel/item')
    if len(items) > MAX_RECORDS:
        fail('RSS_TOO_MANY')
    records, seen = [], set()
    for item in items:
        title = (item.findtext('title') or '').strip()
        link = (item.findtext('link') or '').strip()
        date_str = item.findtext('pubDate') or ''
        if not title or len(title) > 200 or any(ord(c) < 32 for c in title):
            continue
        if not (link.startswith('https://www.bbc.co.uk/sport/') or link.startswith('https://www.bbc.com/sport/')) or len(link) > 900:
            continue
        try:
            when = parsedate_to_datetime(date_str)
            if when.tzinfo is None:
                continue
            published = when.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
        except (ValueError, TypeError):
            continue
        key = h((link + '\n' + published).encode('utf-8'))
        if key in seen:
            continue
        seen.add(key)
        records.append({'id': key, 'title': title, 'url': link, 'publishedAtUTC': published})
    return {'kind': 'football-headlines-only', 'sourceId': 'bbc-football-rss', 'records': records,
            'received': len(items), 'retained': len(records), 'forecastSignalReady': False,
            'containsInjuriesOrLineupsVerified': False, 'containsOdds': False, 'modelReady': False}

def normalize(raw, source, season, fetched_at):
    target_url(source, season)
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_RAW_BYTES:
        fail('RAW_SIZE_INVALID')
    fetched_at = utc_stamp(fetched_at)
    if source == 'openligadb-bl1-history':
        return parse_bundesliga(raw, season, fetched_at)
    return parse_bbc_rss(raw, fetched_at)

def fetch_live(source, season, now=None, fetcher=None):
    url = target_url(source, season)
    if now is None:
        now = datetime.now(timezone.utc)
    if fetcher is None:
        try:
            from scrapling.fetchers import Fetcher
        except ImportError:
            fail('SCRAPLING_NOT_INSTALLED')
        fetcher = Fetcher.get
    try:
        page = fetcher(url, follow_redirects=False, retries=0, timeout=8, stealthy_headers=False)
    except Exception:
        fail('SOURCE_TRANSPORT_FAILED')
    status = getattr(page, 'status', None)
    if status != 200:
        fail('SOURCE_ACCESS_BLOCKED' if status in (401, 403, 429) else 'SOURCE_HTTP_UNAVAILABLE')
    if getattr(page, 'url', url) not in (url, None):
        fail('SOURCE_REDIRECT_BLOCKED')
    raw = getattr(page, 'body', None)
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_RAW_BYTES:
        fail('RAW_SIZE_INVALID')
    headers = getattr(page, 'headers', None) or {}
    server_date = headers.get('date') or headers.get('Date')
    if not server_date:
        fail('SERVER_TIME_MISSING')
    try:
        dt = parsedate_to_datetime(server_date)
        if dt.tzinfo is None or abs((now - dt.astimezone(timezone.utc)).total_seconds()) > 300:
            fail('SERVER_TIME_UNVERIFIED')
    except (ValueError, TypeError):
        fail('SERVER_TIME_INVALID')
    return raw, utc_stamp(now.isoformat()), utc_stamp(dt.isoformat())

def _write_new(path, data):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
    except BaseException:
        raise

def store(raw, *, source, season, fetched_at, out_root, mode, response_at=None):
    if mode not in ('LIVE_SOURCE_HTTP', 'OFFLINE_VERIFIED_INPUT'):
        fail('MODE_INVALID')
    fetched_at = utc_stamp(fetched_at)
    projection = normalize(raw, source, season, fetched_at)
    root = Path(out_root)
    if not root.is_absolute() or root.exists() and (root.is_symlink() or not root.is_dir()):
        fail('ARCHIVE_ROOT_INVALID')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.resolve() != root:
        fail('ARCHIVE_ROOT_UNTRUSTED')
    sub = root / source / fetched_at[:10]
    sub.mkdir(parents=True, mode=0o700, exist_ok=True)
    if sub.is_symlink() or sub.resolve() != sub:
        fail('ARCHIVE_SUBDIR_UNTRUSTED')
    raw_hash = h(raw)
    uid = h((source + '|' + str(season) + '|' + fetched_at + '|' + raw_hash).encode('utf-8'))
    target = sub / uid
    if target.exists():
        fail('ARCHIVE_DUPLICATE_RUN')
    projection_bytes = json_bytes(projection)
    receipt = {'version': 1, 'kind': 'public-source-raw-receipt', 'sourceId': source,
               'requestedURL': target_url(source, season), 'season': season, 'fetchedAtUTC': fetched_at,
               'serverDateUTC': response_at, 'observationMode': mode, 'httpStatus': 200 if mode == 'LIVE_SOURCE_HTTP' else None,
               'rawSha256': raw_hash, 'rawBytes': len(raw), 'projectionSha256': h(projection_bytes),
               'recordCount': len(projection['records']), 'modelReady': False,
               'historicalPregameObserved': False, 'containsVerifiedOdds': False,
               'releaseGate': 'BLOCKED'}
    staging = Path(tempfile.mkdtemp(prefix='.staging-', dir=sub))
    try:
        _write_new(staging / 'raw.bin', raw)
        _write_new(staging / 'projection.json', projection_bytes)
        _write_new(staging / 'receipt.json', json_bytes(receipt))
        if target.exists():
            fail('ARCHIVE_DUPLICATE_RUN')
        os.rename(staging, target)
        fd = os.open(sub, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return {'directory': str(target), 'receipt': receipt}

def verify(directory):
    path = Path(directory)
    if path.is_symlink() or not path.is_dir():
        fail('ARCHIVE_INVALID')
    try:
        if any((path / name).is_symlink() or not (path / name).is_file()
               for name in ('raw.bin', 'receipt.json', 'projection.json')):
            fail('ARCHIVE_FILE_UNTRUSTED')
        raw = (path / 'raw.bin').read_bytes()
        receipt = json.loads((path / 'receipt.json').read_text('utf-8'))
        projection = (path / 'projection.json').read_bytes()
    except (OSError, ValueError):
        fail('ARCHIVE_UNREADABLE')
    if receipt.get('kind') != 'public-source-raw-receipt' or receipt.get('version') != 1:
        fail('RECEIPT_INVALID')
    if h(raw) != receipt.get('rawSha256') or len(raw) != receipt.get('rawBytes'):
        fail('RAW_HASH_MISMATCH')
    if h(projection) != receipt.get('projectionSha256'):
        fail('PROJECTION_HASH_MISMATCH')
    calculated = normalize(raw, receipt.get('sourceId'), receipt.get('season'), receipt.get('fetchedAtUTC'))
    if json_bytes(calculated) != projection or len(calculated['records']) != receipt.get('recordCount'):
        fail('PROJECTION_RECOMPUTE_MISMATCH')
    if receipt.get('releaseGate') != 'BLOCKED' or receipt.get('modelReady') is not False:
        fail('RECEIPT_POLICY_INVALID')
    return {'verified': True, 'directory': str(path), 'rawSha256': h(raw), 'sourceId': receipt['sourceId'],
            'records': len(calculated['records']), 'modelReady': False}

def main(argv=None):
    parser = argparse.ArgumentParser(description='Optional Scrapling public football source archivist')
    parser.add_argument('--source', choices=tuple(SOURCES))
    parser.add_argument('--season', type=int)
    parser.add_argument('--out-root')
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--offline-file')
    parser.add_argument('--observed-at')
    parser.add_argument('--verify')
    args = parser.parse_args(argv)
    try:
        if args.verify:
            if any((args.source, args.season is not None, args.out_root, args.live, args.offline_file, args.observed_at)):
                fail('ARGUMENTS_INVALID')
            result = verify(args.verify)
        else:
            if not args.source or not args.out_root or args.live == bool(args.offline_file):
                fail('ARGUMENTS_INVALID')
            if args.live:
                if args.observed_at:
                    fail('ARGUMENTS_INVALID')
                raw, observed, server_time = fetch_live(args.source, args.season)
                result = store(raw, source=args.source, season=args.season, fetched_at=observed,
                               out_root=args.out_root, mode='LIVE_SOURCE_HTTP', response_at=server_time)
            else:
                if not args.observed_at:
                    fail('ARGUMENTS_INVALID')
                data = Path(args.offline_file).read_bytes()
                result = store(data, source=args.source, season=args.season,
                               fetched_at=args.observed_at, out_root=args.out_root, mode='OFFLINE_VERIFIED_INPUT')
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (ArchiveError, OSError) as exc:
        print(json.dumps({'status': 'FAILED', 'code': str(exc) if isinstance(exc, ArchiveError)
                          else 'FILESYSTEM_UNAVAILABLE'}), file=sys.stderr)
        return 1

if __name__ == '__main__':
    sys.exit(main())