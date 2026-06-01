#!/usr/bin/env python3
"""skill-scheduler dispatcher: 按计划用无头 kiro-cli 运行 AI skill 工作流。"""
import argparse
import fcntl
import json
import os
import re
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

HOME = Path(os.environ.get("SKILL_SCHEDULER_HOME", Path.home() / ".config" / "skill-scheduler"))
JOBS_FILE = HOME / "jobs.json"
STATE_FILE = HOME / "state.json"
LOG_DIR = HOME / "logs"
SCRATCH_DIR = HOME / "scratch"
ALERT_FILE = HOME / "ALERT.log"
LOCK_FILE = HOME / "dispatcher.lock"
KEEP_LOGS = 20

FOOTER = (
    "\n\n[无人值守自动调度] 没人能回答你的问题。务必：1) 不要问任何确认，"
    "按上述参数直接执行（含写操作）；2) 全部完成后，最后一行仅输出机器可读结果："
    "成功=「KIRO_JOB_RESULT: OK」，失败/未完成=「KIRO_JOB_RESULT: FAIL <一句话原因>」。"
)

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
SENTINEL_RE = re.compile(r"^KIRO_JOB_RESULT:\s*(OK|FAIL)\b[ \t]*(.*)$")
CREDITS_RE = re.compile(r"Credits:\s*([0-9.]+)")


def strip_ansi(text):
    return ANSI_RE.sub("", text)


def parse_sentinel(stdout):
    """剥 ANSI 后取最后一个匹配行；返回 (result, reason)，result ∈ {'OK','FAIL',None}。"""
    result, reason = None, ""
    for line in strip_ansi(stdout).splitlines():
        m = SENTINEL_RE.match(line.strip())
        if m:
            result, reason = m.group(1), m.group(2).strip()
    return result, reason


def parse_credits(stderr):
    matches = CREDITS_RE.findall(strip_ansi(stderr))
    return float(matches[-1]) if matches else None


def build_prompt(job):
    if job.get("prompt_file"):
        p = Path(job["prompt_file"])
        if not p.is_absolute():
            p = Path(__file__).resolve().parent / p
        base = p.read_text(encoding="utf-8").strip()
    else:
        base = job["prompt"].strip()
    return base + FOOTER


def main():
    raise SystemExit("not implemented yet")


if __name__ == "__main__":
    main()
