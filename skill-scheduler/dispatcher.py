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


def is_due(schedule, last_run, now):
    """schedule: dict; last_run: datetime|None; now: datetime -> bool。"""
    if "interval_minutes" in schedule:
        if last_run is None:
            return True
        return (now - last_run) >= timedelta(minutes=schedule["interval_minutes"])
    if "daily_at" in schedule:
        weekdays = schedule.get("weekdays")
        if weekdays and now.isoweekday() not in weekdays:
            return False
        hh, mm = (int(x) for x in schedule["daily_at"].split(":"))
        scheduled = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if now < scheduled:
            return False
        if last_run is not None and last_run.date() >= now.date():
            return False
        return True
    raise ValueError("schedule 必须含 'daily_at' 或 'interval_minutes'")


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def load_config():
    cfg = load_json(JOBS_FILE, None)
    if cfg is None:
        raise SystemExit(f"找不到配置：{JOBS_FILE}（从 jobs.example.json 拷贝一份）")
    return cfg


def validate_job(job):
    if not job.get("name"):
        raise ValueError("job 缺少 name")
    sched = job.get("schedule", {})
    picked = {"daily_at", "interval_minutes"} & set(sched)
    if len(picked) != 1:
        raise ValueError(f"job {job.get('name')}: schedule 必须且只能含 daily_at / interval_minutes 之一")
    if not (job.get("prompt") or job.get("prompt_file")):
        raise ValueError(f"job {job.get('name')}: 需要 prompt 或 prompt_file")


def judge(stdout, exit_code, timed_out):
    if timed_out:
        return "TIMEOUT", "运行超时"
    result, reason = parse_sentinel(stdout)
    if result == "OK":
        return "OK", ""
    if result == "FAIL":
        return "FAIL", reason or "skill 报告失败"
    if exit_code != 0:
        return "FAIL", f"退出码 {exit_code}，无哨兵"
    return "FAIL", "无 KIRO_JOB_RESULT 哨兵"


def run_kiro(prompt, timeout_minutes, log_path):
    """跑无头 kiro-cli，全量落 log_path；返回 (stdout, stderr, exit_code, timed_out)。"""
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, KIRO_LOG_NO_COLOR="1")
    timed_out = False
    try:
        proc = subprocess.run(
            ["kiro-cli", "chat", "--no-interactive", "--trust-all-tools", prompt],
            cwd=str(SCRATCH_DIR), env=env, capture_output=True, text=True,
            timeout=timeout_minutes * 60,
        )
        stdout, stderr, exit_code = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired as e:
        stdout = e.stdout or ""
        stderr = e.stderr or ""
        exit_code, timed_out = -1, True
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(
        "$ kiro-cli chat --no-interactive --trust-all-tools <prompt>\n\n"
        f"=== STDOUT ===\n{stdout}\n\n=== STDERR ===\n{stderr}\n",
        encoding="utf-8",
    )
    return stdout, stderr, exit_code, timed_out


def prune_logs(job_name):
    d = LOG_DIR / job_name
    if not d.exists():
        return
    for old in sorted(d.glob("*.log"))[:-KEEP_LOGS]:
        old.unlink()


def main():
    raise SystemExit("not implemented yet")


if __name__ == "__main__":
    main()
