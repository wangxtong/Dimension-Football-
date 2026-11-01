"""Independent review checks. Linux FD tests deliberately skip on Windows.

Run on an isolated Linux checkout with: python3 -B -m unittest -v test_runner_review
All runtime writes stay inside TemporaryDirectory; there are no real HTTP calls.
"""
import configparser
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("dimension_research_review_target", HERE / "runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
NOW = dt.datetime(2026, 11, 1, 0, 0, tzinfo=dt.timezone.utc)


def parse_unit(text):
    value = configparser.ConfigParser(interpolation=None, strict=False)
    value.read_string(text)
    return value


def bytes_limit(value):
    if value.endswith("M"):
        return int(value[:-1]) * 1024 ** 2
    if value.endswith("G"):
        return int(value[:-1]) * 1024 ** 3
    return int(value)


def fixture(provider_id=41, kickoff=None, status="NS"):
    return {"fixture": {"id": provider_id, "date": runner.iso(kickoff or NOW + dt.timedelta(hours=2)),
                        "status": {"short": status}}, "league": {"id": 39}}


def response(rows):
    return 200, {"x-ratelimit-requests-remaining": "10000"}, runner.encoded({"errors": [], "response": rows})


class PurePolicyReview(unittest.TestCase):
    def test_utc_slots_do_not_drift_at_ten_minute_boundary(self):
        before = NOW + dt.timedelta(minutes=9, seconds=59, microseconds=999999)
        after = NOW + dt.timedelta(minutes=10)
        self.assertEqual(runner.slot_time(before), int(NOW.timestamp()))
        self.assertEqual(runner.slot_time(after), int(NOW.timestamp()) + 600)
        local = after.astimezone(dt.timezone(dt.timedelta(hours=8)))
        self.assertEqual(runner.slot_time(local), runner.slot_time(after))

    def test_configuration_cannot_widen_request_safety_bounds(self):
        for supplied in ({"max_daily_requests": 501}, {"max_slot_requests": 6}, {"quota_reserve": 499},
                         {"request_timeout_seconds": 16}, {"max_response_bytes": 4194305},
                         {"max_daily_requests": True}, {"unknown": 1}):
            with self.subTest(supplied=supplied), self.assertRaises(runner.SafetyError):
                runner.configuration(supplied=supplied)

    def test_plan_derivation_is_fixed_source_and_rejects_mutated_identity(self):
        plan = runner.make_plan(41, runner.iso(NOW + dt.timedelta(hours=2)), "NS", NOW)
        self.assertEqual(runner.validate_plan(plan), plan)
        self.assertEqual(runner.instant(plan["due"]), NOW + dt.timedelta(minutes=70))
        for key, value in (("path", "/admin"), ("source_host", "example.com"), ("fixture_id", True),
                           ("generation", "a" * 64), ("due", runner.iso(NOW))):
            with self.subTest(key=key), self.assertRaises(runner.SafetyError):
                runner.validate_plan({**plan, key: value})

    def test_path_segments_reject_traversal_and_untrusted_names(self):
        for path in ("../target", "/absolute", "a//b", "a/./b", "a/../../b", "bad\nname", "a\\b"):
            with self.subTest(path=path), self.assertRaises(runner.SafetyError):
                runner.segments(path)


class SystemdBoundaryReview(unittest.TestCase):
    def read_unit(self, name):
        return parse_unit((HERE / "systemd" / name).read_text(encoding="utf-8"))

    def test_aggregate_limits_bound_all_research_services(self):
        unit = self.read_unit("dimension-research.slice")["Slice"]
        self.assertLessEqual(float(unit["CPUQuota"].rstrip("%")), 20)
        self.assertLessEqual(bytes_limit(unit["MemoryMax"]), 256 * 1024 ** 2)
        self.assertEqual(unit["MemorySwapMax"], "0")
        self.assertLessEqual(int(unit["TasksMax"]), 32)

    def test_collector_and_heartbeat_use_independent_native_utc_timers(self):
        collector = self.read_unit("dimension-research-collector.timer")["Timer"]
        heartbeat = self.read_unit("dimension-research-heartbeat.timer")["Timer"]
        self.assertEqual(collector["OnCalendar"], "*-*-* *:00/10:00 UTC")
        self.assertEqual(heartbeat["OnCalendar"], "*-*-* *:*:00 UTC")
        self.assertNotEqual(collector["Unit"], heartbeat["Unit"])
        self.assertEqual(collector["RandomizedDelaySec"], "0")
        self.assertEqual(heartbeat["RandomizedDelaySec"], "0")

    def test_heartbeat_has_no_key_network_or_production_write_access(self):
        service = self.read_unit("dimension-research-heartbeat.service")["Service"]
        self.assertEqual(service["User"], "dimension-research")
        self.assertEqual(service["Slice"], "dimension-research.slice")
        self.assertEqual(service["PrivateNetwork"], "yes")
        self.assertNotIn("EnvironmentFile", service)
        self.assertIn("/etc/dimension-research/api.env", service["InaccessiblePaths"])
        self.assertEqual(service["ReadWritePaths"], "/var/lib/dimension-research")
        self.assertLessEqual(bytes_limit(service["MemoryMax"]), 32 * 1024 ** 2)
        self.assertLess(int(service["TimeoutStartSec"].rstrip("s")), 60)

    def test_generated_t50_keeps_research_slice_identity_and_hard_file_limits(self):
        plan = runner.make_plan(41, runner.iso(NOW + dt.timedelta(hours=2)), "NS", NOW)
        service_bytes, timer_bytes = runner.event_units(plan)
        service, timer = parse_unit(service_bytes.decode())["Service"], parse_unit(timer_bytes.decode())["Timer"]
        self.assertEqual(service["User"], "dimension-research")
        self.assertEqual(service["Slice"], "dimension-research.slice")
        self.assertLessEqual(bytes_limit(service["MemoryMax"]), 192 * 1024 ** 2)
        self.assertLessEqual(int(service["TasksMax"]), 20)
        self.assertLessEqual(bytes_limit(service["LimitFSIZE"]), 16 * 1024 ** 2)
        self.assertLessEqual(int(service["LimitNOFILE"]), 128)
        self.assertEqual(service["ReadWritePaths"], "/var/lib/dimension-research")
        self.assertEqual(timer["OnCalendar"], "2026-11-01 01:10:00 UTC")
        self.assertNotIn("OnUnitActiveSec", timer)


@unittest.skipUnless(sys.platform == "linux", "requires real Linux FD/flock/process semantics")
class LinuxRuntimeReview(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dimension-runner-review-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "data"
        self.config = {"data_dir": str(self.root), "min_free_bytes": 1,
                       "max_data_bytes": 16 * 1024 ** 2, "max_response_bytes": 16384,
                       "request_timeout_seconds": 1}
        self.calls = []
        self.http_result = response([])
        self.environment = mock.patch.dict(os.environ, {"API_FOOTBALL_KEY": "synthetic-test-key"}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def make_runner(self, now=NOW, http_fn=None, **config):
        def http(path, key, timeout, maximum):
            self.calls.append(path)
            return self.http_result
        result = runner.Runner({**self.config, **config}, now_fn=lambda: now, http_fn=http_fn or http)
        self.addCleanup(result.close)
        return result

    def plan(self, instance, row=None):
        with instance.state.lock():
            instance.register({"response": [row or fixture()]}, NOW)
        names = instance.state.names("plans")
        return instance.state.json("plans/" + names[-1])

    def test_raw_roundtrip_uses_a_real_fresh_process_and_exact_bytes(self):
        instance = self.make_runner()
        original_popen = subprocess.Popen
        children = []
        def popen(*args, **kwargs):
            child = original_popen(*args, **kwargs)
            children.append(child.pid)
            return child
        data = b"synthetic raw response\x00\xff\n"
        with instance.state.lock(), mock.patch.object(subprocess, "Popen", side_effect=popen):
            recorded = instance.state.raw(data)
        self.assertEqual(recorded["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(instance.state.read(recorded["path"]), data)
        self.assertTrue(recorded["verified_in_fresh_process"])
        self.assertEqual(len(children), 1)
        self.assertNotEqual(children[0], os.getpid())

    def test_preexisting_symlink_or_hardlink_is_never_read_as_raw(self):
        instance = self.make_runner()
        sentinel = Path(self.temporary.name) / "outside-sentinel"
        sentinel.write_bytes(b"outside must remain unchanged")
        (self.root / "raw").mkdir()
        for hardlink in (False, True):
            name = self.root / "raw" / ("b" * 64 + ".bin")
            if hardlink:
                os.link(sentinel, name)
            else:
                name.symlink_to(sentinel)
            try:
                with self.assertRaises((OSError, runner.SafetyError)):
                    instance.state.read("raw/" + name.name)
                self.assertEqual(sentinel.read_bytes(), b"outside must remain unchanged")
            finally:
                name.unlink()

    def test_symlink_parent_is_rejected(self):
        sentinel_directory = Path(self.temporary.name) / "outside-directory"
        sentinel_directory.mkdir()
        link = Path(self.temporary.name) / "linked-parent"
        link.symlink_to(sentinel_directory, target_is_directory=True)
        with self.assertRaises((OSError, runner.SafetyError)):
            runner.State(str(link / "data"))
        self.assertEqual(list(sentinel_directory.iterdir()), [])

    def test_verifier_rejects_raw_replaced_after_parent_wrote_it(self):
        instance = self.make_runner()
        sentinel = Path(self.temporary.name) / "outside-sentinel"
        sentinel.write_bytes(b"outside remains unchanged")
        data = b"valid original raw"
        path = self.root / "raw" / (runner.digest(data) + ".bin")
        original_popen = subprocess.Popen
        def swap_before_exec(*args, **kwargs):
            path.unlink()
            path.symlink_to(sentinel)
            return original_popen(*args, **kwargs)
        with instance.state.lock(), mock.patch.object(subprocess, "Popen", side_effect=swap_before_exec):
            with self.assertRaises(runner.SafetyError):
                instance.state.raw(data)
        self.assertEqual(sentinel.read_bytes(), b"outside remains unchanged")

    def test_fifo_raw_fails_without_hanging_before_fstat(self):
        instance = self.make_runner()
        (self.root / "raw").mkdir()
        sha = "c" * 64
        os.mkfifo(self.root / "raw" / (sha + ".bin"))
        result = subprocess.run([sys.executable, "-I", "-B", str(HERE / "runner.py"), "_verify",
                                 "--data-dir", str(self.root), "--path", "raw/" + sha + ".bin",
                                 "--sha256", sha], capture_output=True, timeout=2, check=False)
        self.assertNotEqual(result.returncode, 0)

    def test_missing_key_does_not_use_http(self):
        instance = self.make_runner()
        with mock.patch.dict(os.environ, {}, clear=True), instance.state.lock():
            result, payload = instance.request("/fixtures?id=41", NOW)
        self.assertEqual(result["status"], "FAIL_CLOSED")
        self.assertIsNone(payload)
        self.assertEqual(self.calls, [])

    def test_request_budgets_block_before_network(self):
        instance = self.make_runner(max_daily_requests=1, max_slot_requests=1)
        with instance.state.lock():
            first, _ = instance.request("/fixtures?id=41", NOW)
            same_slot, _ = instance.request("/fixtures?id=41", NOW)
            later_slot, _ = instance.request("/fixtures?id=41", NOW + dt.timedelta(minutes=10))
        self.assertEqual(first["status"], "CAPTURED")
        self.assertEqual(same_slot["status"], "BUDGET_BLOCKED")
        self.assertEqual(later_slot["status"], "BUDGET_BLOCKED")
        self.assertEqual(len(self.calls), 1)

    def test_t50_empty_or_wrong_fixture_refresh_does_not_reuse_old_identity(self):
        for rows in ([], [fixture(provider_id=99)]):
            with self.subTest(rows=rows):
                isolated = Path(self.temporary.name) / ("case-" + str(len(rows)))
                calls = []
                def http(path, key, timeout, maximum):
                    calls.append(path)
                    return response(rows)
                instance = self.make_runner(now=NOW + dt.timedelta(minutes=70), http_fn=http, data_dir=str(isolated))
                plan = self.plan(instance)
                receipt = instance.capture(plan["event_id"], NOW + dt.timedelta(minutes=70))
                self.assertNotEqual(receipt["status"], "CAPTURED")
                self.assertEqual(calls, ["/fixtures?id=41"])

    def test_cancelled_revision_makes_old_timer_a_network_free_noop(self):
        instance = self.make_runner(now=NOW + dt.timedelta(minutes=70))
        plan = self.plan(instance)
        with instance.state.lock():
            instance.register({"response": [fixture(status="PST")]}, NOW + dt.timedelta(minutes=1))
        receipt = instance.capture(plan["event_id"], NOW + dt.timedelta(minutes=70))
        self.assertEqual(receipt["status"], "CANCELLED_GENERATION")
        self.assertEqual(self.calls, [])
        self.assertEqual(instance.capture(plan["event_id"], NOW + dt.timedelta(minutes=70))["status"], "DUPLICATE")

    def test_heartbeat_still_records_a_tick_while_collection_writer_is_locked(self):
        collector = self.make_runner()
        heartbeat = self.make_runner(now=NOW + dt.timedelta(minutes=5))
        with collector.state.lock():
            result = heartbeat.heartbeat(NOW + dt.timedelta(minutes=5))
        self.assertEqual(result["status"], "HEARTBEAT")
        record = heartbeat.state.json("heartbeats/20261101T0005Z.json")
        self.assertEqual(record["kind"], "HEARTBEAT")
        self.assertEqual(record["metadata"]["pid"], os.getpid())
        self.assertTrue(record["metadata"]["boot_id"])

    def test_overdue_and_restart_gaps_raise_each_local_alert_once(self):
        instance = self.make_runner()
        with instance.state.lock():
            instance.initialize(NOW)
        self.assertEqual(instance.heartbeat(NOW + dt.timedelta(minutes=4, seconds=59))["new_alerts"], 0)
        self.assertEqual(instance.heartbeat(NOW + dt.timedelta(minutes=5))["new_alerts"], 1)
        self.assertEqual(instance.heartbeat(NOW + dt.timedelta(minutes=5))["new_alerts"], 0)
        restarted = self.make_runner(now=NOW + dt.timedelta(minutes=35))
        self.assertEqual(restarted.heartbeat(NOW + dt.timedelta(minutes=35))["new_alerts"], 3)
        self.assertEqual(restarted.heartbeat(NOW + dt.timedelta(minutes=35))["new_alerts"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
