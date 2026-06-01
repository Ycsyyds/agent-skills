import unittest
from dispatcher import strip_ansi, parse_sentinel


class TestSentinel(unittest.TestCase):
    def test_strip_ansi(self):
        self.assertEqual(strip_ansi("\x1b[38;5;141m> \x1b[0mhi\x1b[0m"), "> hi")

    def test_ok(self):
        self.assertEqual(parse_sentinel("blah\nKIRO_JOB_RESULT: OK"), ("OK", ""))

    def test_fail_with_reason(self):
        self.assertEqual(
            parse_sentinel("x\nKIRO_JOB_RESULT: FAIL 认证过期"), ("FAIL", "认证过期")
        )

    def test_last_match_wins(self):
        text = "KIRO_JOB_RESULT: FAIL early\n后续又补了一句\nKIRO_JOB_RESULT: OK"
        self.assertEqual(parse_sentinel(text), ("OK", ""))

    def test_ansi_wrapped_line(self):
        self.assertEqual(parse_sentinel("\x1b[0mKIRO_JOB_RESULT: OK\x1b[0m"), ("OK", ""))

    def test_none_when_absent(self):
        self.assertEqual(parse_sentinel("just output, no sentinel"), (None, ""))


from dispatcher import parse_credits


class TestCredits(unittest.TestCase):
    def test_extract_last(self):
        err = "noise\n ▸ Credits: 0.23 • Time: 6s\nmore\n ▸ Credits: 2.86 • Time: 1m\n"
        self.assertEqual(parse_credits(err), 2.86)

    def test_none_when_absent(self):
        self.assertIsNone(parse_credits("no credits here"))


import tempfile
from pathlib import Path
from dispatcher import build_prompt, FOOTER


class TestBuildPrompt(unittest.TestCase):
    def test_inline_prompt_appends_footer(self):
        out = build_prompt({"prompt": "做任务X"})
        self.assertTrue(out.startswith("做任务X"))
        self.assertTrue(out.endswith(FOOTER))

    def test_prompt_file_absolute(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "p.md"
            p.write_text("文件里的任务", encoding="utf-8")
            out = build_prompt({"prompt_file": str(p)})
            self.assertTrue(out.startswith("文件里的任务"))
            self.assertTrue(out.endswith(FOOTER))


from datetime import datetime
from dispatcher import is_due


class TestIsDue(unittest.TestCase):
    def test_interval_first_run(self):
        self.assertTrue(is_due({"interval_minutes": 120}, None, datetime(2026, 6, 1, 9, 0)))

    def test_interval_not_elapsed(self):
        last = datetime(2026, 6, 1, 8, 30)
        self.assertFalse(is_due({"interval_minutes": 120}, last, datetime(2026, 6, 1, 9, 0)))

    def test_interval_elapsed(self):
        last = datetime(2026, 6, 1, 6, 0)
        self.assertTrue(is_due({"interval_minutes": 120}, last, datetime(2026, 6, 1, 9, 0)))

    def test_daily_before_time(self):
        self.assertFalse(is_due({"daily_at": "02:30"}, None, datetime(2026, 6, 1, 1, 0)))

    def test_daily_after_time_not_run_today(self):
        last = datetime(2026, 5, 31, 2, 30)
        self.assertTrue(is_due({"daily_at": "02:30"}, last, datetime(2026, 6, 1, 3, 0)))

    def test_daily_already_ran_today(self):
        last = datetime(2026, 6, 1, 2, 30)
        self.assertFalse(is_due({"daily_at": "02:30"}, last, datetime(2026, 6, 1, 9, 0)))

    def test_daily_catchup_after_downtime(self):
        # 机器昨天关机错过 02:30，今天 09:00 开机 -> 应补跑
        last = datetime(2026, 5, 30, 2, 30)
        self.assertTrue(is_due({"daily_at": "02:30"}, last, datetime(2026, 6, 1, 9, 0)))

    def test_daily_weekday_excluded(self):
        # 2026-06-06 是周六(isoweekday=6)，限定工作日 -> 不跑
        sched = {"daily_at": "02:30", "weekdays": [1, 2, 3, 4, 5]}
        self.assertFalse(is_due(sched, None, datetime(2026, 6, 6, 3, 0)))


from dispatcher import validate_job


class TestValidateJob(unittest.TestCase):
    def test_ok(self):
        validate_job({"name": "a", "schedule": {"daily_at": "02:30"}, "prompt": "x"})

    def test_missing_name(self):
        with self.assertRaises(ValueError):
            validate_job({"schedule": {"daily_at": "02:30"}, "prompt": "x"})

    def test_both_schedule_types(self):
        with self.assertRaises(ValueError):
            validate_job({"name": "a", "schedule": {"daily_at": "1:1", "interval_minutes": 5}, "prompt": "x"})

    def test_no_schedule_type(self):
        with self.assertRaises(ValueError):
            validate_job({"name": "a", "schedule": {}, "prompt": "x"})

    def test_missing_prompt(self):
        with self.assertRaises(ValueError):
            validate_job({"name": "a", "schedule": {"daily_at": "02:30"}})


from dispatcher import judge


class TestJudge(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(judge("KIRO_JOB_RESULT: OK", 0, False), ("OK", ""))

    def test_fail_sentinel(self):
        self.assertEqual(judge("KIRO_JOB_RESULT: FAIL 没权限", 0, False), ("FAIL", "没权限"))

    def test_timeout(self):
        self.assertEqual(judge("partial", 0, True)[0], "TIMEOUT")

    def test_nonzero_no_sentinel(self):
        self.assertEqual(judge("garbage", 1, False)[0], "FAIL")

    def test_zero_no_sentinel_is_fail(self):
        self.assertEqual(judge("no sentinel but exit 0", 0, False)[0], "FAIL")


from dispatcher import resolve_recipient


class TestRecipient(unittest.TestCase):
    def test_explicit_wins(self):
        cfg = {"defaults": {"report_to": "ou_explicit"}}
        self.assertEqual(resolve_recipient(cfg, {"report_to_cached": "ou_cached"}), "ou_explicit")

    def test_cached_fallback(self):
        self.assertEqual(resolve_recipient({"defaults": {}}, {"report_to_cached": "ou_cached"}), "ou_cached")

    def test_none(self):
        self.assertIsNone(resolve_recipient({"defaults": {}}, {}))


from dispatcher import should_alert


class TestShouldAlert(unittest.TestCase):
    def test_second_failure_same_day_suppressed(self):
        prev = {"last_result": "FAIL", "last_run_at": "2026-06-01T08:00:00"}
        rec = {"last_result": "FAIL", "last_run_at": "2026-06-01T09:00:00"}
        self.assertFalse(should_alert(prev, rec))

    def test_failure_new_day_not_suppressed(self):
        prev = {"last_result": "FAIL", "last_run_at": "2026-05-31T08:00:00"}
        rec = {"last_result": "FAIL", "last_run_at": "2026-06-01T09:00:00"}
        self.assertTrue(should_alert(prev, rec))

    def test_failure_after_prev_ok_not_suppressed(self):
        prev = {"last_result": "OK", "last_run_at": "2026-06-01T08:00:00"}
        rec = {"last_result": "FAIL", "last_run_at": "2026-06-01T09:00:00"}
        self.assertTrue(should_alert(prev, rec))


if __name__ == "__main__":
    unittest.main()
