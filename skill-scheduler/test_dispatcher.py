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


if __name__ == "__main__":
    unittest.main()
