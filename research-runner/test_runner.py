"""Meaningful offline checks. FD and subprocess guarantees run on Linux only."""
import contextlib
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("research_runner", Path(__file__).with_name("runner.py"))
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
NOW = dt.datetime(2026, 11, 1, 12, 0, tzinfo=dt.timezone.utc)
LINUX = sys.platform.startswith("linux")


def fixture(provider_id=123, kickoff=None, status="NS"):
    return {"fixture": {"id": provider_id, "date": runner.iso(kickoff or NOW + dt.timedelta(minutes=50)),
                         "status": {"short": status}}, "league": {"id": 39}}


def response(rows, remaining=10000):
    return 200, {"x-ratelimit-requests-remaining": str(remaining)}, runner.encoded({"errors": [], "response": rows})


def odds_row(provider_id=123):
    return {"fixture": {"id": provider_id}, "bookmakers": [{"id": 8, "name": "Synthetic Test Book",
            "bets": [{"id": 1, "name": "Match Winner", "values": [{"value": "Home", "odd": "1.90"}]}]}]}


class PlanTests(unittest.TestCase):
    def test_plan_identity_changes_with_revision_and_has_fixed_source(self):
        first = runner.make_plan(123, runner.iso(NOW + dt.timedelta(minutes=50)), "NS", NOW)
        self.assertEqual(runner.validate_plan(first), first)
        later = runner.make_plan(123, runner.iso(NOW + dt.timedelta(minutes=55)), "NS", NOW)
        self.assertNotEqual(first["event_id"], later["event_id"])
        for field, value in (("source_host", "evil.example"), ("path", "/bin/sh"),
                             ("event_id", "../injection"), ("fixture_id", True),
                             ("due", runner.iso(NOW + dt.timedelta(seconds=1)))):
            with self.subTest(field=field), self.assertRaises((runner.SafetyError, ValueError)):
                runner.validate_plan({**first, field: value})

    def test_generated_units_bind_fixed_identity_and_slice(self):
        plan = runner.make_plan(123, runner.iso(NOW + dt.timedelta(minutes=50)), "NS", NOW)
        service, timer = runner.event_units(plan)
        self.assertIn(b"Slice=dimension-research.slice", service)
        self.assertIn(b"User=dimension-research", service)
        self.assertIn(b"/opt/dimension-research/runner.py", service)
        self.assertIn(b"OnCalendar=2026-11-01 12:00:00 UTC", timer)
        self.assertIn(b"Persistent=false", timer)

    def test_configuration_bounds_cannot_raise_production_shared_budget(self):
        for values in ({"max_daily_requests": 501}, {"max_slot_requests": 6},
                       {"quota_reserve": 499}, {"request_timeout_seconds": 100}, {"unknown": 1}):
            with self.subTest(values=values), self.assertRaises(runner.SafetyError):
                runner.configuration(supplied=values)

    def test_odds_require_target_fixture_and_a_real_numeric_price(self):
        self.assertTrue(runner.has_target_odds({"response": [odds_row()]}, 123))
        for rows in ([], [odds_row(999)], [odds_row(), odds_row(999)], [{"fixture": {"id": 123}, "bookmakers": []}]):
            self.assertFalse(runner.has_target_odds({"response": rows}, 123))
        invalid = odds_row()
        invalid["bookmakers"][0]["bets"][0]["values"][0]["odd"] = "NaN"
        self.assertFalse(runner.has_target_odds({"response": [invalid]}, 123))


@unittest.skipUnless(LINUX, "Linux FD/O_NOFOLLOW/flock guarantees require Linux")
class LinuxRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "data")
        self.config = {"data_dir": self.path, "min_free_bytes": 1}
        self.old_key = os.environ.get("API_FOOTBALL_KEY")
        os.environ["API_FOOTBALL_KEY"] = "offline-synthetic-not-a-key"
        self.runners = []

    def tearDown(self):
        for instance in self.runners:
            instance.close()
        if self.old_key is None:
            os.environ.pop("API_FOOTBALL_KEY", None)
        else:
            os.environ["API_FOOTBALL_KEY"] = self.old_key
        self.temp.cleanup()

    def make(self, http_fn=None, config=None):
        instance = runner.Runner({**self.config, **(config or {})}, now_fn=lambda: NOW,
                                 http_fn=http_fn or (lambda *args: response([])))
        self.runners.append(instance)
        return instance

    def plan(self, instance, kickoff=None):
        instance.register({"response": [fixture(kickoff=kickoff)]}, NOW)
        return instance.state.json("current/123.json")["event_id"]

    def test_symlinked_directory_and_fifo_leaf_are_rejected_without_blocking(self):
        target = Path(self.temp.name) / "other"
        target.mkdir()
        link = Path(self.temp.name) / "link"
        link.symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            runner.State(str(link / "data"))
        instance = self.make()
        (Path(self.path) / "bad").symlink_to(target, target_is_directory=True)
        with self.assertRaises(OSError):
            instance.state.immutable("bad/escape.json", b"bad")
        (Path(self.path) / "bad").unlink()
        os.mkfifo(Path(self.path) / "pipe", 0o600)
        with self.assertRaises(runner.SafetyError):
            instance.state.read("pipe")

    def test_immutable_evidence_cannot_be_overwritten_and_raw_is_read_by_fresh_process(self):
        instance = self.make()
        instance.state.immutable("receipts/one.json", b'{"original":true}')
        with self.assertRaises(FileExistsError):
            instance.state.immutable("receipts/one.json", b"changed")
        self.assertEqual(instance.state.read("receipts/one.json"), b'{"original":true}')
        raw = instance.state.raw(b"official raw bytes")
        self.assertTrue(raw["verified_in_fresh_process"])
        self.assertEqual(instance.state.read(raw["path"]), b"official raw bytes")
        (Path(self.path) / raw["path"]).write_bytes(b"tampered")
        result = subprocess.run([sys.executable, "-I", "-B", runner.__file__, "_verify", "--data-dir", self.path,
                                 "--path", raw["path"], "--sha256", raw["sha256"]], capture_output=True, close_fds=True)
        self.assertNotEqual(result.returncode, 0)

    def test_fd_anchor_survives_path_replacement_but_fresh_verifier_rejects_changed_path(self):
        instance = self.make()
        moved = Path(self.temp.name) / "moved"
        Path(self.path).rename(moved)
        Path(self.path).symlink_to(moved, target_is_directory=True)
        instance.state.immutable("receipts/anchored.json", b"anchored")
        self.assertEqual((moved / "receipts/anchored.json").read_bytes(), b"anchored")
        with self.assertRaises(runner.SafetyError):
            instance.state.raw(b"not verified through a symlink")

    def test_network_writer_exclusion_does_not_block_independent_heartbeat(self):
        instance = self.make()
        other = self.make()
        with instance.state.lock():
            with self.assertRaises(runner.BusyError):
                with other.state.lock():
                    pass
            result = other.heartbeat(NOW)
        self.assertEqual(result["status"], "HEARTBEAT")

    def test_missing_key_fails_closed_and_same_slot_is_not_retried(self):
        os.environ.pop("API_FOOTBALL_KEY", None)
        calls = []
        instance = self.make(lambda *args: calls.append(args))
        result = instance.collect(NOW)
        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(calls, [])
        self.assertEqual(instance.collect(NOW)["status"], "DUPLICATE")

    def test_request_budget_includes_collector_and_event_queries(self):
        calls = []
        instance = self.make(lambda *args: (calls.append(args[0]) or response([fixture()])),
                             {"max_slot_requests": 1})
        result = instance.collect(NOW)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["calls"][1]["status"], "BUDGET_BLOCKED")
        event_id = instance.state.json("current/123.json")["event_id"]
        captured = instance.capture(event_id, NOW)
        self.assertEqual(captured["status"], "INCOMPLETE")
        self.assertEqual(len(calls), 1)

    def test_upstream_quota_reserve_stops_further_requests(self):
        calls = []
        instance = self.make(lambda *args: (calls.append(args[0]) or response([fixture()], 499)))
        result = instance.collect(NOW)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["calls"][1]["reason"], "upstream_quota_reserve")

    def test_empty_wrong_duplicate_and_malformed_target_responses_cannot_claim_t50_capture(self):
        for rows in ([], [fixture(999)], [fixture(), fixture()], [{"fixture": {"id": 123}, "league": {"id": 39}}]):
            with self.subTest(rows=rows):
                config = {"data_dir": str(Path(self.temp.name) / ("case-" + str(len(self.runners))))}
                calls = []
                instance = self.make(lambda *args: (calls.append(args[0]) or response(rows)), config)
                event_id = self.plan(instance)
                result = instance.capture(event_id, NOW)
                self.assertEqual(result["status"], "INCOMPLETE")
                self.assertEqual(calls, ["/fixtures?id=123"])

    def test_late_capture_is_late_and_reschedule_cancels_old_generation(self):
        calls = []
        instance = self.make(lambda *args: (calls.append(args[0]) or response([odds_row()] if args[0].startswith("/odds") else [fixture()])))
        event_id = self.plan(instance)
        result = instance.capture(event_id, NOW + dt.timedelta(seconds=61))
        self.assertEqual(result["status"], "LATE")
        self.assertEqual(len(calls), 2)
        self.assertEqual(instance.capture(event_id, NOW)["status"], "DUPLICATE")
        other = self.make(lambda *args: response([fixture(kickoff=NOW + dt.timedelta(minutes=70))]),
                          {"data_dir": str(Path(self.temp.name) / "rescheduled")})
        old = self.plan(other)
        changed = other.capture(old, NOW)
        self.assertEqual(changed["status"], "CANCELLED_GENERATION")
        self.assertEqual(len(changed["calls"]), 1)
        self.assertNotEqual(other.state.json("current/123.json")["event_id"], old)
        tombstones = other.state.names("tombstones")
        self.assertEqual(len(tombstones), 1)
        tombstone = other.state.json("tombstones/" + tombstones[0])
        self.assertEqual(tombstone["old_event_id"], old)
        self.assertEqual(tombstone["reason"], "kickoff_or_status_changed")
        self.assertIsNotNone(other.state.json("plans/" + old + ".json"))

    def test_empty_or_wrong_odds_remain_incomplete_with_raw_http_receipt(self):
        for odds in ([], [odds_row(999)], [{"fixture": {"id": 123}, "bookmakers": []}]):
            with self.subTest(odds=odds):
                instance = self.make(lambda *args: response(odds if args[0].startswith("/odds") else [fixture()]),
                                     {"data_dir": str(Path(self.temp.name) / ("odds-" + str(len(self.runners))))})
                event_id = self.plan(instance)
                result = instance.capture(event_id, NOW)
                self.assertEqual(result["status"], "INCOMPLETE")
                self.assertEqual(result["calls"][-1]["status"], "NO_ODDS")
                self.assertTrue(result["calls"][-1]["raw"]["verified_in_fresh_process"])

    def test_heartbeat_reports_missed_restart_slot_and_event_as_not_run(self):
        instance = self.make()
        instance.initialize(NOW)
        event_id = self.plan(instance)
        result = instance.heartbeat(NOW + dt.timedelta(seconds=301))
        self.assertTrue(any(a.get("status") == "NOT_RUN" and a.get("slot") == runner.slot_time(NOW) for a in result["alerts"]))
        self.assertEqual(instance.state.json("receipts/event-" + event_id + ".json")["status"], "NOT_RUN")
        self.assertEqual(instance.capture(event_id, NOW + dt.timedelta(seconds=302))["status"], "DUPLICATE")

    def test_capacity_limit_blocks_before_network_request(self):
        calls = []
        instance = self.make(lambda *args: calls.append(args), {"max_data_bytes": 1024})
        with self.assertRaises(runner.SafetyError):
            instance.collect(NOW)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
