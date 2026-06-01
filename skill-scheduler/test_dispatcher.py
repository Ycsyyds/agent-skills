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


if __name__ == "__main__":
    unittest.main()
