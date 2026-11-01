#!/usr/bin/env python3
"""Isolated Linux research capture. No serving, publishing, bets, or model claims.

All persisted evidence is immutable. Mutable pointers only identify the current
provider fixture revision; they never supply commands to the root reconciler.
"""
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import math
import os
import re
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

try:
    import fcntl
except ImportError:
    fcntl = None

HOST = "v3.football.api-sports.io"
GROUP = "api-football"
LEAGUES = (39, 140, 135, 78, 61)
HEX = re.compile(r"^[a-f0-9]{64}$")
SAFE = re.compile(r"^[A-Za-z0-9_.-]{1,160}$")
DEFAULTS = {"data_dir": "/var/lib/dimension-research", "max_daily_requests": 500,
            "max_slot_requests": 5, "quota_reserve": 500,
            "max_data_bytes": 536870912, "min_free_bytes": 1073741824,
            "request_timeout_seconds": 10, "max_response_bytes": 2097152}
UTC = dt.timezone.utc


class SafetyError(RuntimeError):
    pass


class BusyError(RuntimeError):
    pass


def utcnow():
    return dt.datetime.now(UTC)


def iso(value):
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z", value):
        raise SafetyError("invalid UTC timestamp")
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def slot_time(now):
    return int(now.timestamp()) // 600 * 600


def metadata(now):
    try:
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as stream:
            boot = stream.read(80).strip()
    except OSError:
        boot = "unavailable"
    return {"host": socket.gethostname(), "boot_id": boot, "pid": os.getpid(),
            "observed_at": iso(now), "monotonic_ns": time.monotonic_ns()}


def configuration(path=None, supplied=None):
    values = dict(DEFAULTS)
    if path:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise SafetyError("config must be a regular file")
            raw = os.read(fd, 32769)
            if len(raw) > 32768:
                raise SafetyError("config too large")
            supplied = json.loads(raw)
        finally:
            os.close(fd)
    if supplied:
        if not isinstance(supplied, dict) or set(supplied) - set(DEFAULTS):
            raise SafetyError("unknown configuration fields")
        values.update(supplied)
    for key in set(DEFAULTS) - {"data_dir"}:
        if type(values[key]) is not int or values[key] < 1:
            raise SafetyError("invalid numeric configuration")
    if values["max_daily_requests"] > 500 or values["max_slot_requests"] > 5 or values["quota_reserve"] < 500:
        raise SafetyError("research request limits exceed fixed safety bounds")
    if values["request_timeout_seconds"] > 15 or values["max_response_bytes"] > 4194304:
        raise SafetyError("request limits exceed safety bounds")
    return values


def segments(path):
    parts = path.split("/") if isinstance(path, str) else list(path)
    if not parts or any(not isinstance(p, str) or not SAFE.fullmatch(p) or p in (".", "..") for p in parts):
        raise SafetyError("unsafe relative path")
    return parts


class State:
    """No path traversal: every directory and file is opened relative to an FD."""

    def __init__(self, root, config=None, create=True):
        if os.name != "posix" or fcntl is None or not hasattr(os, "O_NOFOLLOW"):
            raise SafetyError("Linux FD safety primitives required")
        if not isinstance(root, str) or not root.startswith("/") or root == "/":
            raise SafetyError("data_dir must be an absolute dedicated directory")
        self.config = config or DEFAULTS
        self.root = root
        parts = root.split("/")[1:]
        if any(not p or p in (".", "..") for p in parts):
            raise SafetyError("invalid absolute data directory")
        self.fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            for part in parts:
                if create:
                    try:
                        os.mkdir(part, 0o700, dir_fd=self.fd)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fd)
                os.close(self.fd)
                self.fd = child
        except Exception:
            os.close(self.fd)
            raise

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    @contextlib.contextmanager
    def directory(self, path=(), create=False):
        parts = segments(path) if path else []
        fd = os.dup(self.fd)
        try:
            for part in parts:
                if create:
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                        os.fsync(fd)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            yield fd
        finally:
            os.close(fd)

    def read(self, path, maximum=8388608):
        parts = segments(path)
        with self.directory(parts[:-1]) as parent:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
                    raise SafetyError("unsafe evidence object")
                data = bytearray()
                while len(data) <= maximum:
                    chunk = os.read(fd, min(65536, maximum + 1 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                if len(data) > maximum:
                    raise SafetyError("evidence object exceeds limit")
                return bytes(data)
            finally:
                os.close(fd)

    def json(self, path, default=None):
        try:
            return json.loads(self.read(path))
        except FileNotFoundError:
            return default

    def names(self, path):
        try:
            with self.directory(path) as fd:
                result = sorted(os.listdir(fd))
                for name in result:
                    segments([name])
                return result
        except FileNotFoundError:
            return []

    def used_bytes(self):
        def walk(fd):
            size = 0
            for name in os.listdir(fd):
                segments([name])
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        size += walk(child)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                    size += info.st_size
                else:
                    raise SafetyError("unsafe filesystem entry")
            return size
        return walk(self.fd)

    def capacity(self, additional):
        free = os.fstatvfs(self.fd)
        if self.used_bytes() + additional > self.config["max_data_bytes"]:
            raise SafetyError("research data size limit reached")
        if free.f_bavail * free.f_frsize < self.config["min_free_bytes"] + additional:
            raise SafetyError("reserved free disk space reached")

    def immutable(self, path, data):
        with self.lock("allocation.lock", blocking=True):
            return self._immutable(path, data)

    def _immutable(self, path, data):
        parts = segments(path)
        self.capacity(len(data))
        with self.directory(parts[:-1], create=True) as parent:
            fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
            try:
                view = memoryview(data)
                while view:
                    size = os.write(fd, view)
                    view = view[size:]
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(parent)

    def pointer(self, path, payload):
        parts = segments(path)
        temporary = parts[:-1] + ["tmp-" + uuid.uuid4().hex]
        self.immutable(temporary, encoded(payload))
        with self.directory(parts[:-1]) as parent:
            # Replacement changes an internal pointer, never an evidence object.
            os.replace(temporary[-1], parts[-1], src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)

    @contextlib.contextmanager
    def lock(self, name="writer.lock", blocking=False):
        segments([name])
        fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.fd)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink != 1:
                raise SafetyError("unsafe lock file")
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            except BlockingIOError:
                raise BusyError("research writer is busy") from None
            yield
        finally:
            os.close(fd)

    def raw(self, data):
        sha = digest(data)
        path = "raw/" + sha + ".bin"
        try:
            self.immutable(path, data)
        except FileExistsError:
            if digest(self.read(path)) != sha:
                raise SafetyError("existing raw content hash mismatch")
        command = [sys.executable, "-I", "-B", os.path.abspath(__file__), "_verify",
                   "--data-dir", self.root, "--path", path, "--sha256", sha]
        completed = subprocess.run(command, close_fds=True, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15,
                                   env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, check=False)
        if completed.returncode or completed.stdout.strip() != sha.encode("ascii"):
            raise SafetyError("fresh-process raw verification failed")
        return {"path": path, "sha256": sha, "bytes": len(data), "verified_in_fresh_process": True}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@contextlib.contextmanager
def deadline(seconds):
    def expired(signum, frame):
        raise TimeoutError("official API deadline exceeded")
    old = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def official_http(path, key, timeout, maximum):
    if not path.startswith("/") or "#" in path or "\r" in path or "\n" in path:
        raise SafetyError("unsafe official source path")
    request = urllib.request.Request("https://" + HOST + path,
                                    headers={"x-apisports-key": key, "Accept": "application/json",
                                             "User-Agent": "DimensionResearch/1.0"})
    opener = urllib.request.build_opener(NoRedirect())
    with deadline(timeout):
        try:
            response = opener.open(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read(maximum + 1)
            if len(body) > maximum:
                raise SafetyError("official response exceeds raw object limit")
            return response.status, dict(response.headers.items()), body


def revision(fixture_id, kickoff, status):
    return digest(encoded({"fixture_id": fixture_id, "kickoff": kickoff, "status": status}))


def make_plan(fixture_id, kickoff, status, now):
    generation = revision(fixture_id, kickoff, status)
    due = iso(instant(kickoff) - dt.timedelta(minutes=50))
    event_id = digest(encoded({"fixture_id": fixture_id, "generation": generation, "due": due, "source_group": GROUP}))
    return {"schema": 1, "event_id": event_id, "fixture_id": fixture_id, "kickoff": kickoff,
            "fixture_status": status, "generation": generation, "due": due, "source_group": GROUP,
            "source_host": HOST, "path": "/odds?fixture=" + str(fixture_id), "created_at": iso(now)}


def parsed_fixture(item):
    try:
        fixture = item["fixture"]
        provider_id, kickoff = fixture["id"], fixture["date"]
        status = fixture["status"]["short"]
        if (type(provider_id) is not int or not 0 < provider_id < 10000000000
                or not isinstance(status, str) or not re.fullmatch(r"[A-Z]{1,4}", status)
                or item["league"]["id"] not in LEAGUES):
            return None
        value = dt.datetime.fromisoformat(kickoff.replace("Z", "+00:00"))
        if value.tzinfo is None:
            return None
        return provider_id, iso(value), status, value
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


def has_target_odds(payload, fixture_id):
    rows = payload.get("response", []) if isinstance(payload, dict) else []
    if not rows:
        return False
    found = False
    for row in rows:
        if not isinstance(row, dict) or row.get("fixture", {}).get("id") != fixture_id:
            return False
        for bookmaker in row.get("bookmakers", []):
            if not isinstance(bookmaker, dict) or type(bookmaker.get("id")) is not int or not bookmaker.get("name"):
                continue
            for bet in bookmaker.get("bets", []):
                if not isinstance(bet, dict) or type(bet.get("id")) is not int or not bet.get("name"):
                    continue
                for value in bet.get("values", []):
                    if not isinstance(value, dict) or not isinstance(value.get("value"), str) or not value["value"]:
                        continue
                    try:
                        price = float(value.get("odd"))
                    except (TypeError, ValueError):
                        continue
                    if math.isfinite(price) and 1 < price <= 10000:
                        found = True
    return found


def validate_plan(plan):
    keys = {"schema", "event_id", "fixture_id", "kickoff", "fixture_status", "generation", "due",
            "source_group", "source_host", "path", "created_at"}
    if not isinstance(plan, dict) or set(plan) != keys or plan["schema"] != 1:
        raise SafetyError("invalid event plan schema")
    if type(plan["fixture_id"]) is not int or not 0 < plan["fixture_id"] < 10000000000 or plan["fixture_status"] != "NS":
        raise SafetyError("invalid official fixture identity")
    instant(plan["created_at"])
    expected = make_plan(plan["fixture_id"], plan["kickoff"], plan["fixture_status"], instant(plan["created_at"]))
    if plan != expected or not HEX.fullmatch(plan["event_id"]) or not HEX.fullmatch(plan["generation"]):
        raise SafetyError("event identity or fixed source mismatch")
    return plan


class Runner:
    def __init__(self, config, now_fn=utcnow, http_fn=None):
        self.config = configuration(supplied=config)
        self.now_fn = now_fn
        self.http_fn = http_fn or official_http
        self.state = State(self.config["data_dir"], self.config)

    def close(self):
        self.state.close()

    def receipt(self, name, payload):
        payload = {"schema": 1, **payload}
        self.state.immutable("receipts/" + name + ".json", encoded(payload))
        return payload

    def initialize(self, now):
        try:
            self.state.immutable("epoch.json", encoded({"started_at": iso(now)}))
        except FileExistsError:
            pass

    def request(self, path, now, odds_fixture=None):
        key = os.environ.get("API_FOOTBALL_KEY", "").strip()
        if not key:
            return {"status": "FAIL_CLOSED", "reason": "API_FOOTBALL_KEY_missing", "path": path}, None
        day = now.strftime("%Y-%m-%d")
        quota = self.state.json("state/quota.json", {})
        if quota.get("day") == day and (quota.get("remaining") is None or quota["remaining"] < self.config["quota_reserve"]):
            return {"status": "BUDGET_BLOCKED", "reason": "upstream_quota_reserve", "path": path}, None
        names = self.state.names("budget/" + day)
        slot = slot_time(now)
        slot_count = sum(1 for name in names if self.state.json("budget/" + day + "/" + name, {}).get("slot") == slot)
        if len(names) >= self.config["max_daily_requests"] or slot_count >= self.config["max_slot_requests"]:
            return {"status": "BUDGET_BLOCKED", "reason": "local_request_budget", "path": path}, None
        self.state.capacity(self.config["max_response_bytes"] + 32768)
        request_id = uuid.uuid4().hex
        self.state.immutable("budget/" + day + "/" + request_id + ".json", encoded({"slot": slot, "path": path, "reserved_at": iso(now)}))
        record = {"kind": "HTTP", "request_id": request_id, "source_host": HOST, "path": path,
                  "started_at": iso(now), "metadata": metadata(now), "http_status": None, "raw": None}
        payload = None
        try:
            status, headers, body = self.http_fn(path, key, self.config["request_timeout_seconds"], self.config["max_response_bytes"])
            if not isinstance(body, bytes) or len(body) > self.config["max_response_bytes"]:
                raise SafetyError("invalid raw response")
            record["http_status"] = status
            record["raw"] = self.state.raw(body)
            remaining = None
            for header, value in headers.items():
                if header.lower() == "x-ratelimit-requests-remaining" and str(value).isdigit():
                    remaining = int(value)
            self.state.pointer("state/quota.json", {"day": day, "remaining": remaining, "observed_at": iso(self.now_fn())})
            record["quota_remaining"] = remaining
            if status != 200:
                record.update(status="HTTP_FAILED", reason="official_non_200")
            else:
                payload = json.loads(body)
                if not isinstance(payload, dict) or payload.get("errors") or not isinstance(payload.get("response"), list):
                    raise SafetyError("official API error or invalid schema")
                if odds_fixture is not None and not has_target_odds(payload, odds_fixture):
                    record.update(status="NO_ODDS", reason="empty_invalid_or_wrong_fixture_odds")
                else:
                    record["status"] = "CAPTURED"
        except Exception as error:
            record.update(status="FAILED", reason=type(error).__name__)
            payload = None
        record["finished_at"] = iso(self.now_fn())
        self.receipt("http-" + request_id, record)
        return record, payload

    def register(self, payload, now):
        registered = []
        rows = payload.get("response", [])
        if len(rows) > 128:
            raise SafetyError("fixture response row limit exceeded")
        identities = [item.get("fixture", {}).get("id") for item in rows if isinstance(item, dict)]
        if len(identities) != len(set(identities)):
            raise SafetyError("duplicate provider fixture identifiers")
        for item in rows:
            parsed = parsed_fixture(item)
            if parsed is None:
                continue
            provider_id, kickoff, status, value = parsed
            gen = revision(provider_id, kickoff, status)
            prior = self.state.json("current/" + str(provider_id) + ".json", {})
            pointer = {"fixture_id": provider_id, "kickoff": kickoff, "fixture_status": status,
                       "generation": gen, "verified_at": iso(now), "event_id": None}
            if status == "NS" and now < value <= now + dt.timedelta(days=2):
                plan = make_plan(provider_id, kickoff, status, now)
                pointer["event_id"] = plan["event_id"]
                try:
                    self.state.immutable("plans/" + plan["event_id"] + ".json", encoded(plan))
                except FileExistsError:
                    existing = validate_plan(self.state.json("plans/" + plan["event_id"] + ".json"))
                    if existing["generation"] != gen:
                        raise SafetyError("event immutable plan conflict")
                registered.append(pointer)
            if prior and prior.get("generation") != gen:
                old_identity = prior.get("event_id") or prior.get("generation")
                if not isinstance(old_identity, str) or not HEX.fullmatch(old_identity):
                    raise SafetyError("invalid prior fixture pointer")
                tombstone = {"schema": 1, "kind": "GENERATION_CANCELLED", "fixture_id": provider_id,
                             "old_event_id": prior.get("event_id"), "old_generation": prior.get("generation"),
                             "new_event_id": pointer["event_id"], "new_generation": gen,
                             "reason": "kickoff_or_status_changed", "observed_at": iso(now), "metadata": metadata(now)}
                try:
                    self.state.immutable("tombstones/" + old_identity + "-" + gen + ".json", encoded(tombstone))
                except FileExistsError:
                    pass
            self.state.pointer("current/" + str(provider_id) + ".json", pointer)
        return registered

    def collect(self, now=None):
        now = now or self.now_fn()
        with self.state.lock():
            self.initialize(now)
            slot = slot_time(now)
            claim = "claims/collect-" + str(slot) + ".json"
            try:
                self.state.immutable(claim, encoded({"started_at": iso(now), "metadata": metadata(now)}))
            except FileExistsError:
                return {"status": "DUPLICATE", "slot": slot}
            league = LEAGUES[(slot // 600) % len(LEAGUES)]
            season = now.year if now.month >= 7 else now.year - 1
            query = urllib.parse.urlencode({"league": league, "season": season,
                                            "from": now.strftime("%Y-%m-%d"),
                                            "to": (now + dt.timedelta(days=2)).strftime("%Y-%m-%d"), "timezone": "UTC"})
            first, payload = self.request("/fixtures?" + query, now)
            calls, plans = [first], []
            if payload is not None:
                plans = self.register(payload, self.now_fn())
                if plans:
                    chosen = plans[(slot // 600) % len(plans)]
                    record, unused = self.request("/odds?fixture=" + str(chosen["fixture_id"]), self.now_fn(), odds_fixture=chosen["fixture_id"])
                    calls.append(record)
            final = "CAPTURED" if all(c.get("status") == "CAPTURED" for c in calls) else "INCOMPLETE"
            late_seconds = max(0, now.timestamp() - slot)
            if late_seconds > 60:
                final = "LATE"
            return self.receipt("collect-" + str(slot), {"kind": "COLLECT", "status": final,
                "slot": slot, "due_at": iso(dt.datetime.fromtimestamp(slot, UTC)), "started_at": iso(now),
                "finished_at": iso(self.now_fn()), "late_seconds": late_seconds, "league": league,
                "coverage": "one rotating league, at most one odds fixture; not full T50 coverage",
                "plan_count": len(plans), "calls": calls, "metadata": metadata(now)})

    def current_matches(self, plan):
        current = self.state.json("current/" + str(plan["fixture_id"]) + ".json", {})
        return current.get("generation") == plan["generation"] and current.get("event_id") == plan["event_id"]

    def capture(self, event_id, now=None):
        if not HEX.fullmatch(event_id):
            raise SafetyError("invalid event identifier")
        now = now or self.now_fn()
        with self.state.lock():
            existing = self.state.json("receipts/event-" + event_id + ".json")
            if existing is not None:
                return {"status": "DUPLICATE", "event_id": event_id}
            plan = validate_plan(self.state.json("plans/" + event_id + ".json"))
            if plan["event_id"] != event_id:
                raise SafetyError("event filename mismatch")
            due = instant(plan["due"])
            late_seconds = (now - due).total_seconds()
            calls = []
            status = "CANCELLED_GENERATION" if not self.current_matches(plan) else "EARLY" if late_seconds < -1 else None
            if status is None:
                first, payload = self.request("/fixtures?id=" + str(plan["fixture_id"]), now)
                calls.append(first)
                if payload is not None:
                    rows = payload.get("response", [])
                    if (len(rows) != 1 or not isinstance(rows[0], dict)
                            or rows[0].get("fixture", {}).get("id") != plan["fixture_id"]
                            or parsed_fixture(rows[0]) is None):
                        payload = None
                if payload is not None:
                    self.register(payload, self.now_fn())
                if payload is None:
                    status = "INCOMPLETE"
                elif not self.current_matches(plan):
                    status = "CANCELLED_GENERATION"
                else:
                    record, unused = self.request(plan["path"], self.now_fn(), odds_fixture=plan["fixture_id"])
                    calls.append(record)
                    status = "CAPTURED" if record.get("status") == "CAPTURED" else "INCOMPLETE"
                    if not self.current_matches(plan):
                        status = "CANCELLED_GENERATION"
            if status == "CAPTURED" and late_seconds > 60:
                status = "LATE"
            return self.receipt("event-" + event_id, {"kind": "T50", "event_id": event_id,
                "generation": plan["generation"], "due_at": plan["due"], "status": status,
                "started_at": iso(now), "finished_at": iso(self.now_fn()), "late_seconds": late_seconds,
                "calls": calls, "metadata": metadata(now)})

    def heartbeat(self, now=None):
        now = now or self.now_fn()
        # Separate from network collection; allocations alone share a short
        # filesystem lock so heartbeat never waits behind an upstream request.
        with self.state.lock("heartbeat.lock"):
            self.initialize(now)
            epoch = instant(self.state.json("epoch.json")["started_at"])
            first = (int(epoch.timestamp()) + 599) // 600 * 600
            cursor = self.state.json("state/heartbeat.json", {"last_slot": first - 600})["last_slot"]
            latest = int((now - dt.timedelta(seconds=300)).timestamp()) // 600 * 600
            alerts = []
            for slot in range(max(first, cursor + 600), min(latest, cursor + 600000) + 1, 600):
                record = self.state.json("receipts/collect-" + str(slot) + ".json")
                if record is None or record.get("status") != "CAPTURED":
                    alert = {"kind": "LOCAL_ALERT", "status": "NOT_RUN" if record is None else record.get("status"),
                             "slot": slot, "checked_at": iso(now), "metadata": metadata(now)}
                    try:
                        self.state.immutable("alerts/slot-" + str(slot) + ".json", encoded(alert))
                        alerts.append(alert)
                    except FileExistsError:
                        pass
                cursor = slot
            for name in self.state.names("plans"):
                if not re.fullmatch(r"[a-f0-9]{64}\.json", name):
                    raise SafetyError("invalid plan filename")
                plan = validate_plan(self.state.json("plans/" + name))
                if self.current_matches(plan) and (now - instant(plan["due"])).total_seconds() >= 300:
                    record = self.state.json("receipts/event-" + plan["event_id"] + ".json")
                    if record is None:
                        record = self.receipt("event-" + plan["event_id"], {"kind": "T50", "event_id": plan["event_id"],
                            "generation": plan["generation"], "due_at": plan["due"], "status": "NOT_RUN",
                            "checked_at": iso(now), "reason": "one-shot timer missed or capture never committed",
                            "metadata": metadata(now)})
                    if record.get("status") != "CAPTURED":
                        alert = {"kind": "LOCAL_ALERT", "event_id": plan["event_id"], "status": record.get("status"),
                                 "checked_at": iso(now), "metadata": metadata(now)}
                        try:
                            self.state.immutable("alerts/event-" + plan["event_id"] + ".json", encoded(alert))
                            alerts.append(alert)
                        except FileExistsError:
                            pass
            self.state.pointer("state/heartbeat.json", {"last_slot": cursor, "checked_at": iso(now)})
            return {"status": "HEARTBEAT", "checked_at": iso(now), "new_alerts": len(alerts), "alerts": alerts}


def event_units(plan):
    plan = validate_plan(plan)
    event_id = plan["event_id"]
    service = """[Unit]
Description=Dimension research T50 capture
[Service]
Type=oneshot
User=dimension-research
Group=dimension-research
Slice=dimension-research.slice
EnvironmentFile=/etc/dimension-research/api.env
ExecStart=/usr/bin/python3 -I -B /opt/dimension-research/runner.py --config /etc/dimension-research/config.json capture --event %s
MemoryMax=192M
MemorySwapMax=0
TasksMax=20
CPUWeight=10
Nice=10
UMask=0077
TimeoutStartSec=90s
TimeoutStopSec=10s
KillMode=control-group
LimitNOFILE=128
LimitFSIZE=16M
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
LockPersonality=yes
SystemCallArchitectures=native
ReadWritePaths=/var/lib/dimension-research
InaccessiblePaths=-/etc/vantis -/opt/vantis -/var/lib/vantis
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
SocketBindDeny=any
""" % event_id
    due = instant(plan["due"]).strftime("%Y-%m-%d %H:%M:%S")
    timer = """[Unit]
Description=Dimension research absolute UTC T50
[Timer]
OnCalendar=%s UTC
Unit=dr-t50-%s.service
AccuracySec=1s
RandomizedDelaySec=0
Persistent=false
[Install]
WantedBy=timers.target
""" % (due, event_id)
    return service.encode("ascii"), timer.encode("ascii")


def reconcile(config, now=None):
    """Root reads only strict plans; unit text and executable paths are fixed."""
    if os.geteuid() != 0:
        raise SafetyError("reconcile requires root")
    if config["data_dir"] != DEFAULTS["data_dir"]:
        raise SafetyError("root reconciler requires the fixed research data directory")
    now = now or utcnow()
    state = State(config["data_dir"], config, create=False)
    units = State("/etc/systemd/system", config, create=False)
    wanted = {}
    try:
        for name in state.names("plans"):
            if not re.fullmatch(r"[a-f0-9]{64}\.json", name):
                raise SafetyError("invalid plan filename")
            plan = validate_plan(state.json("plans/" + name))
            current = state.json("current/" + str(plan["fixture_id"]) + ".json", {})
            if plan["event_id"] + ".json" != name:
                raise SafetyError("plan filename mismatch")
            if current.get("event_id") != plan["event_id"] or current.get("generation") != plan["generation"]:
                continue
            if not now < instant(plan["due"]) <= now + dt.timedelta(days=2):
                continue
            if state.json("receipts/event-" + plan["event_id"] + ".json") is not None:
                continue
            wanted[plan["event_id"]] = plan
            if len(wanted) > 64:
                raise SafetyError("active T50 unit limit exceeded (64)")
        existing = [name for name in os.listdir(units.fd) if re.fullmatch(r"dr-t50-[a-f0-9]{64}\.(?:service|timer)", name)]
        changed = False
        for name in existing:
            event_id = name[7:71]
            if event_id not in wanted:
                if name.endswith(".timer"):
                    subprocess.run(["/usr/bin/systemctl", "stop", name], check=False, timeout=20,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                # Only names created within this namespace can be removed.
                os.unlink(name, dir_fd=units.fd)
                changed = True
        for event_id, plan in wanted.items():
            for extension, content in zip(("service", "timer"), event_units(plan)):
                name = "dr-t50-" + event_id + "." + extension
                try:
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=units.fd)
                except FileExistsError:
                    if units.read(name) != content:
                        raise SafetyError("existing generated systemd unit differs")
                    continue
                try:
                    os.write(fd, content)
                    os.fsync(fd)
                finally:
                    os.close(fd)
                changed = True
        os.fsync(units.fd)
        if changed:
            subprocess.run(["/usr/bin/systemctl", "daemon-reload"], check=True, timeout=30)
        for event_id in wanted:
            subprocess.run(["/usr/bin/systemctl", "start", "dr-t50-" + event_id + ".timer"], check=True, timeout=20)
        return {"status": "RECONCILED", "active_plans": len(wanted), "checked_at": iso(now)}
    finally:
        units.close()
        state.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/dimension-research/config.json")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("collect", "heartbeat", "reconcile", "check"):
        commands.add_parser(command)
    capture = commands.add_parser("capture")
    capture.add_argument("--event", required=True)
    verify = commands.add_parser("_verify")
    verify.add_argument("--data-dir", required=True)
    verify.add_argument("--path", required=True)
    verify.add_argument("--sha256", required=True)
    args = parser.parse_args(argv)
    if args.command == "_verify":
        if not HEX.fullmatch(args.sha256) or args.path != "raw/" + args.sha256 + ".bin":
            raise SafetyError("invalid raw verifier request")
        state = State(args.data_dir, create=False)
        try:
            if digest(state.read(args.path)) != args.sha256:
                raise SafetyError("raw verifier mismatch")
            print(args.sha256)
            return 0
        finally:
            state.close()
    config = configuration(args.config)
    if args.command == "check":
        print(json.dumps({"status": "CONFIG_VALID", "network_used": False}))
        return 0
    if args.command == "reconcile":
        result = reconcile(config)
    else:
        runner = Runner(config)
        try:
            result = runner.capture(args.event) if args.command == "capture" else getattr(runner, args.command)()
        finally:
            runner.close()
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BusyError:
        # The independent heartbeat will turn an absent due receipt into a local
        # NOT_RUN alert. Never wait on a lock then label delayed capture on-time.
        print('{"status":"LOCK_BUSY","receipt_committed":false}', file=sys.stderr)
        sys.exit(75)
    except Exception as error:
        # Do not print exception text: upstream errors can contain credentials.
        print(json.dumps({"status": "FAILED", "error_type": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
