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
DEFAULT_TIMEOUT_MINUTES = 20
SUBPROCESS_TIMEOUT_SECONDS = 60

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
    try:
        cfg = load_json(JOBS_FILE, None)
    except json.JSONDecodeError as e:
        raise SystemExit(f"jobs.json 解析失败: {e}")
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


def resolve_recipient(cfg, state):
    return cfg.get("defaults", {}).get("report_to") or state.get("report_to_cached") or None


# needs_refresh 视为可用：access token 过期但 lark-cli 会用 refresh token 自动续期。
# 只有 user 不可用或 token 状态不在此集合（如需重新登录）才判失败。
USABLE_TOKEN_STATUSES = {"valid", "needs_refresh"}


def auth_usable(status_data):
    """从 lark-cli auth status 的 JSON 判断 user 身份是否可用，返回 (ok, user_open_id|None)。"""
    user = status_data.get("identities", {}).get("user", {})
    ok = bool(user.get("available")) and user.get("tokenStatus") in USABLE_TOKEN_STATUSES
    return ok, user.get("openId")


def preflight_auth():
    """跑 lark-cli auth status，返回 (ok, user_open_id|None)。"""
    try:
        out = subprocess.run(
            ["lark-cli", "auth", "status"], capture_output=True, text=True,
            timeout=SUBPROCESS_TIMEOUT_SECONDS
        )
        data = json.loads(out.stdout)
    except Exception:
        return False, None
    return auth_usable(data)


def send_alert(recipient, text):
    """优先 bot 私信；失败/无接收人则写 ALERT.log。返回是否经飞书送达。"""
    if recipient:
        try:
            r = subprocess.run(
                ["lark-cli", "im", "+messages-send", "--user-id", recipient,
                 "--markdown", text, "--as", "bot"],
                capture_output=True, text=True, timeout=SUBPROCESS_TIMEOUT_SECONDS,
            )
            if r.returncode == 0:
                return True
        except Exception:
            pass
    ALERT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(ALERT_FILE, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat(timespec='seconds')} {text}\n")
    return False


def log_dispatcher(msg):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_DIR / "dispatcher.log", "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")


def should_alert(prev, rec):
    """仅当本次非 OK 且非'同一天已经是失败态'时返回 True。"""
    if rec.get("last_result") == "OK":
        return False
    prev_failed_today = (
        prev.get("last_result") not in (None, "OK", "DRYRUN")
        and (prev.get("last_run_at") or "")[:10] == rec["last_run_at"][:10]
    )
    return not prev_failed_today


def execute_job(job, cfg, state, dry_run=False):
    name = job["name"]
    prompt = build_prompt(job)
    if dry_run:
        print(f"=== job: {name} ===")
        print("cmd: kiro-cli chat --no-interactive --trust-all-tools <prompt>")
        print(f"cwd: {SCRATCH_DIR}")
        print("--- prompt ---")
        print(prompt)
        return "DRYRUN"
    timeout_minutes = job.get("timeout_minutes", cfg.get("defaults", {}).get("timeout_minutes", DEFAULT_TIMEOUT_MINUTES))
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    log_path = LOG_DIR / name / f"{ts}.log"
    stdout, stderr, exit_code, timed_out = run_kiro(prompt, timeout_minutes, log_path)
    result, reason = judge(stdout, exit_code, timed_out)
    jobs_state = state.setdefault("jobs", {})
    prev = jobs_state.get(name, {})
    rec = {
        "last_run_at": datetime.now().isoformat(timespec="seconds"),
        "last_result": result,
        "last_exit_code": exit_code,
        "last_reason": reason,
        "last_credits": parse_credits(stderr),
        "last_log": str(log_path),
    }
    jobs_state[name] = rec
    prune_logs(name)
    if should_alert(prev, rec):
        send_alert(resolve_recipient(cfg, state),
                   f"❌ {name} {result} | {reason} | {log_path} | {rec['last_run_at']}")
    return result


def cmd_tick():
    cfg = load_config()
    state = load_json(STATE_FILE, {})
    ok, open_id = preflight_auth()
    if open_id and not state.get("report_to_cached"):
        state["report_to_cached"] = open_id
        save_json(STATE_FILE, state)
    if not ok:
        send_alert(resolve_recipient(cfg, state),
                   f"❌ skill-scheduler 预检失败：lark-cli 认证无效，请重新登录 | "
                   f"{datetime.now().isoformat(timespec='seconds')}")
        log_dispatcher("preflight FAILED, tick skipped")
        return
    now = datetime.now()
    ran = []
    for job in cfg.get("jobs", []):
        if not job.get("enabled", True):
            continue
        try:
            validate_job(job)
            last = state.get("jobs", {}).get(job["name"], {}).get("last_run_at")
            last_dt = datetime.fromisoformat(last) if last else None
            if is_due(job["schedule"], last_dt, now):
                res = execute_job(job, cfg, state, dry_run=False)
                save_json(STATE_FILE, state)
                ran.append(f"{job['name']}={res}")
        except Exception as e:
            job_name = job.get("name", "<unknown>")
            now_iso = datetime.now().isoformat(timespec="seconds")
            log_dispatcher(f"job {job_name} 调度异常: {e}")
            jobs_state = state.setdefault("jobs", {})
            prev = jobs_state.get(job_name, {})
            rec = {"last_run_at": now_iso, "last_result": "FAIL",
                   "last_exit_code": None, "last_reason": f"调度异常: {e}",
                   "last_credits": None, "last_log": None}
            jobs_state[job_name] = rec
            save_json(STATE_FILE, state)
            if should_alert(prev, rec):
                send_alert(resolve_recipient(cfg, state),
                           f"❌ {job_name} 调度异常 | {e} | {now_iso}")
            continue
    log_dispatcher("tick ran: " + (", ".join(ran) if ran else "(none due)"))


def cmd_run(name, dry_run):
    cfg = load_config()
    state = load_json(STATE_FILE, {})
    job = next((j for j in cfg.get("jobs", []) if j["name"] == name), None)
    if not job:
        raise SystemExit(f"找不到 job: {name}")
    validate_job(job)
    if dry_run:
        execute_job(job, cfg, state, dry_run=True)
        return
    ok, open_id = preflight_auth()
    if open_id and not state.get("report_to_cached"):
        state["report_to_cached"] = open_id
        save_json(STATE_FILE, state)
    if not ok:
        raise SystemExit("预检失败：lark-cli 认证无效，请重新登录")
    res = execute_job(job, cfg, state, dry_run=False)
    save_json(STATE_FILE, state)
    print(f"{name} -> {res}")


def cmd_status():
    state = load_json(STATE_FILE, {})
    jobs = state.get("jobs", {})
    if not jobs:
        print("尚无运行记录")
        return
    for name, rec in jobs.items():
        print(f"{name}: {rec.get('last_result')} @ {rec.get('last_run_at')} "
              f"(exit={rec.get('last_exit_code')}, credits={rec.get('last_credits')}) "
              f"{rec.get('last_reason') or ''}")
        print(f"    log: {rec.get('last_log')}")


def with_lock(fn):
    HOME.mkdir(parents=True, exist_ok=True)
    f = open(LOCK_FILE, "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("已有一个 dispatcher 在运行，退出")
        return
    try:
        fn()
    finally:
        fcntl.flock(f, fcntl.LOCK_UN)
        f.close()


def main():
    ap = argparse.ArgumentParser(prog="dispatcher.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("tick")
    pr = sub.add_parser("run")
    pr.add_argument("name")
    pr.add_argument("--dry-run", action="store_true")
    sub.add_parser("status")
    args = ap.parse_args()
    if args.cmd == "tick":
        with_lock(cmd_tick)
    elif args.cmd == "run":
        cmd_run(args.name, args.dry_run)
    elif args.cmd == "status":
        cmd_status()


if __name__ == "__main__":
    main()
