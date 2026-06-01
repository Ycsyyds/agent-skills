# Skill Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个配置驱动的本机调度器，按计划用无头 `kiro-cli` 自动运行指定 AI skill 工作流（首批：两个 lark 群工作流），失败时飞书告警，全程本地留痕。

**Architecture:** 单个纯标准库 Python 程序 `dispatcher.py`，被一条 cron 心跳周期唤醒（`tick`）；读 `jobs.json` → 预检 `lark-cli` 认证 → 选出"到点"的 job → 串行用 `kiro-cli chat --no-interactive --trust-all-tools` 跑 → 解析 stdout 末尾哨兵判定成败 → 写 `state.json` + per-run 日志 → 失败用 `lark-cli` bot 私信告警。任务的时间表/补跑/去重判定是纯函数，单元测试覆盖。

**Tech Stack:** Python 3.8 标准库（`json/subprocess/datetime/argparse/fcntl/pathlib/re/unittest`），`kiro-cli`（运行 skill），`lark-cli`（认证预检 + bot 告警），用户 crontab。

**Spec:** `docs/superpowers/specs/2026-06-01-skill-scheduler-design.md`（端到端可行性已实测通过：无头 kiro-cli 能完整跑完多步 lark skill，哨兵落 stdout，约 1 分钟/2.86 credit）。

---

## File Structure

- `skill-scheduler/dispatcher.py` — 全部逻辑（纯函数 + IO + CLI），~180 行，进 git。
- `skill-scheduler/test_dispatcher.py` — 纯函数单元测试（`unittest`），进 git。
- `skill-scheduler/jobs.example.json` — 脱敏配置样例，进 git。
- `skill-scheduler/README.md` — 安装/使用/分级验证说明，进 git。
- `~/.config/skill-scheduler/jobs.json` — 真实任务配置（含群名），**不进 git**，由用户从 example 拷贝改写。
- `~/.config/skill-scheduler/{state.json,ALERT.log,logs/,scratch/,dispatcher.lock}` — 运行时产物，**不进 git**。

约定：所有运行时根目录由环境变量 `SKILL_SCHEDULER_HOME` 覆盖（默认 `~/.config/skill-scheduler`），便于测试时指向临时目录。

---

## Task 1: Scaffold（目录 + 可导入的 dispatcher 骨架 + 样例配置 + README）

**Files:**
- Create: `skill-scheduler/dispatcher.py`
- Create: `skill-scheduler/jobs.example.json`
- Create: `skill-scheduler/README.md`

- [ ] **Step 1: 创建 dispatcher.py 骨架（仅 import + 常量 + 受保护 main，便于后续任务里 import 纯函数而无副作用）**

```python
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


def main():
    raise SystemExit("not implemented yet")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 创建脱敏样例配置 jobs.example.json**

```json
{
  "defaults": { "timeout_minutes": 20, "report_to": "" },
  "jobs": [
    {
      "name": "group-digest-示例群",
      "enabled": true,
      "schedule": { "daily_at": "02:30" },
      "prompt": "使用 lark-workflow-group-digest skill，对飞书群「示例群名」做增量群重点整理：从该群上次游标到现在拉新消息，识别5类重点，追加到该群纪要文档顶部，bot 私信摘要给我。该群已 bootstrap，直接增量执行。"
    },
    {
      "name": "bug-feedback-示例群",
      "enabled": false,
      "schedule": { "daily_at": "02:45", "weekdays": [1, 2, 3, 4, 5] },
      "prompt": "使用 lark-workflow-bug-feedback skill，对飞书群「示例群名」做增量 bug 收集：拉新消息，识别 bug/意见，查重合并写该群 Base，追加当天日报到顶部，bot 私信日报给我。该群已 bootstrap，直接增量执行。"
    }
  ]
}
```

- [ ] **Step 3: 创建 README.md**

````markdown
# skill-scheduler

配置驱动的本机调度器：按计划用无头 `kiro-cli` 运行指定 AI skill 工作流。

## 安装

```bash
mkdir -p ~/.config/skill-scheduler
cp skill-scheduler/jobs.example.json ~/.config/skill-scheduler/jobs.json
# 编辑 jobs.json：填真实群名、报告人 open_id(report_to)、时间表
```

挂上一条 cron 心跳（每 10 分钟唤醒一次，真正几点跑哪个任务由 jobs.json 决定）：

```cron
*/10 * * * * /usr/bin/python3 /home/ycs/skills/skill-scheduler/dispatcher.py tick >> ~/.config/skill-scheduler/logs/cron.log 2>&1
```

## 前置条件

- 目标群必须已 **bootstrap**（首次建文档/Base/锚点请先手动交互式跑一次对应 skill）。定时只做增量。
- `lark-cli` 的 user 与 bot 身份已 `auth login`。
- 目标 skill 已安装在 `~/.kiro/skills/`。

## 用法

```bash
dispatcher.py run <name> --dry-run   # 只打印拼好的 prompt+命令，零 token
dispatcher.py run <name>             # 手动强制跑一个 job（忽略时间表）
dispatcher.py tick                   # cron 心跳调用：跑所有到点的 job
dispatcher.py status                 # 复盘：每个 job 上次运行/结果/credit
```

## 分级验证（测试→检查→迭代闭环）

- Stage 0：`run <name> --dry-run` 核对 prompt。
- Stage 1：`run <name>` 真跑一次，核对飞书产物 + bot 摘要私信 + state/日志。
- Stage 2：临时改错群名跑一次，确认收到 bot ❌ 告警。
- Stage 3：把 schedule 设成几分钟后，等 cron 自动触发一次，确认无人值守路径。
- Stage 4：`status` + `logs/` 复盘。
````

- [ ] **Step 4: Commit**

```bash
git add skill-scheduler/dispatcher.py skill-scheduler/jobs.example.json skill-scheduler/README.md
git commit -m "feat(skill-scheduler): scaffold dispatcher, example config, README"
```

---

## Task 2: 纯函数 strip_ansi + parse_sentinel（TDD）

**Files:**
- Modify: `skill-scheduler/dispatcher.py`
- Test: `skill-scheduler/test_dispatcher.py`

- [ ] **Step 1: 写失败测试**

```python
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: FAIL — `ImportError: cannot import name 'strip_ansi'`

- [ ] **Step 3: 实现（加到 dispatcher.py 常量之后、main 之前）**

```python
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add skill-scheduler/dispatcher.py skill-scheduler/test_dispatcher.py
git commit -m "feat(skill-scheduler): ANSI strip + sentinel parsing"
```

---

## Task 3: 纯函数 parse_credits（TDD）

**Files:**
- Modify: `skill-scheduler/dispatcher.py`
- Test: `skill-scheduler/test_dispatcher.py`

- [ ] **Step 1: 写失败测试（追加到 test_dispatcher.py）**

```python
from dispatcher import parse_credits


class TestCredits(unittest.TestCase):
    def test_extract_last(self):
        err = "noise\n ▸ Credits: 0.23 • Time: 6s\nmore\n ▸ Credits: 2.86 • Time: 1m\n"
        self.assertEqual(parse_credits(err), 2.86)

    def test_none_when_absent(self):
        self.assertIsNone(parse_credits("no credits here"))
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: FAIL — `ImportError: cannot import name 'parse_credits'`

- [ ] **Step 3: 实现**

```python
def parse_credits(stderr):
    matches = CREDITS_RE.findall(strip_ansi(stderr))
    return float(matches[-1]) if matches else None
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill-scheduler/dispatcher.py skill-scheduler/test_dispatcher.py
git commit -m "feat(skill-scheduler): parse credits from stderr"
```

---

## Task 4: 纯函数 build_prompt（TDD，含 prompt_file）

**Files:**
- Modify: `skill-scheduler/dispatcher.py`
- Test: `skill-scheduler/test_dispatcher.py`

- [ ] **Step 1: 写失败测试**

```python
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: FAIL — `ImportError: cannot import name 'build_prompt'`

- [ ] **Step 3: 实现**

```python
def build_prompt(job):
    if job.get("prompt_file"):
        p = Path(job["prompt_file"])
        if not p.is_absolute():
            p = Path(__file__).resolve().parent / p
        base = p.read_text(encoding="utf-8").strip()
    else:
        base = job["prompt"].strip()
    return base + FOOTER
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill-scheduler/dispatcher.py skill-scheduler/test_dispatcher.py
git commit -m "feat(skill-scheduler): build_prompt with footer + prompt_file support"
```

---

## Task 5: 纯函数 is_due（到点判定：补跑/去重/weekday/interval）（TDD）

**Files:**
- Modify: `skill-scheduler/dispatcher.py`
- Test: `skill-scheduler/test_dispatcher.py`

- [ ] **Step 1: 写失败测试**

```python
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: FAIL — `ImportError: cannot import name 'is_due'`

- [ ] **Step 3: 实现**

```python
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: PASS（8 个 is_due 用例 + 之前全部）

- [ ] **Step 5: Commit**

```bash
git add skill-scheduler/dispatcher.py skill-scheduler/test_dispatcher.py
git commit -m "feat(skill-scheduler): is_due schedule logic (daily/interval, catch-up, dedup)"
```

---

## Task 6: 配置/状态 IO + 校验（TDD 校验函数）

**Files:**
- Modify: `skill-scheduler/dispatcher.py`
- Test: `skill-scheduler/test_dispatcher.py`

- [ ] **Step 1: 写失败测试（校验逻辑是纯函数，可测）**

```python
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: FAIL — `ImportError: cannot import name 'validate_job'`

- [ ] **Step 3: 实现（IO 辅助 + 校验）**

```python
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill-scheduler/dispatcher.py skill-scheduler/test_dispatcher.py
git commit -m "feat(skill-scheduler): config/state IO + job validation"
```

---

## Task 7: kiro 运行器 + 结果判定 + 日志 + 保留

**Files:**
- Modify: `skill-scheduler/dispatcher.py`
- Test: `skill-scheduler/test_dispatcher.py`

注：`run_kiro` 调子进程，难纯测；`judge` 是纯函数，TDD 它。`run_kiro` 用 Stage 1 手动验证。

- [ ] **Step 1: 写失败测试（judge 纯函数）**

```python
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: FAIL — `ImportError: cannot import name 'judge'`

- [ ] **Step 3: 实现（judge + run_kiro + prune_logs）**

```python
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill-scheduler/dispatcher.py skill-scheduler/test_dispatcher.py
git commit -m "feat(skill-scheduler): kiro runner, result judge, log retention"
```

---

## Task 8: 认证预检 + 告警（含缓存接收人 + ALERT 兜底）

**Files:**
- Modify: `skill-scheduler/dispatcher.py`
- Test: `skill-scheduler/test_dispatcher.py`

注：`resolve_recipient` 纯函数，TDD 它；`preflight_auth`/`send_alert` 调子进程，Stage 1/2 手动验证。

- [ ] **Step 1: 写失败测试**

```python
from dispatcher import resolve_recipient


class TestRecipient(unittest.TestCase):
    def test_explicit_wins(self):
        cfg = {"defaults": {"report_to": "ou_explicit"}}
        self.assertEqual(resolve_recipient(cfg, {"report_to_cached": "ou_cached"}), "ou_explicit")

    def test_cached_fallback(self):
        self.assertEqual(resolve_recipient({"defaults": {}}, {"report_to_cached": "ou_cached"}), "ou_cached")

    def test_none(self):
        self.assertIsNone(resolve_recipient({"defaults": {}}, {}))
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: FAIL — `ImportError: cannot import name 'resolve_recipient'`

- [ ] **Step 3: 实现**

```python
def resolve_recipient(cfg, state):
    return cfg.get("defaults", {}).get("report_to") or state.get("report_to_cached") or None


def preflight_auth():
    """跑 lark-cli auth status，返回 (ok, user_open_id|None)。"""
    try:
        out = subprocess.run(
            ["lark-cli", "auth", "status"], capture_output=True, text=True, timeout=60
        )
        data = json.loads(out.stdout)
    except Exception:
        return False, None
    user = data.get("identities", {}).get("user", {})
    ok = bool(user.get("available")) and user.get("tokenStatus") == "valid"
    return ok, user.get("openId")


def send_alert(recipient, text):
    """优先 bot 私信；失败/无接收人则写 ALERT.log。返回是否经飞书送达。"""
    if recipient:
        try:
            r = subprocess.run(
                ["lark-cli", "im", "+messages-send", "--user-id", recipient,
                 "--markdown", text, "--as", "bot"],
                capture_output=True, text=True, timeout=60,
            )
            if r.returncode == 0:
                return True
        except Exception:
            pass
    ALERT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(ALERT_FILE, "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat(timespec='seconds')} {text}\n")
    return False
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skill-scheduler/dispatcher.py skill-scheduler/test_dispatcher.py
git commit -m "feat(skill-scheduler): auth preflight, bot alert with cache + ALERT fallback"
```

---

## Task 9: 编排 + CLI（execute_job / tick / run / status / lock / main）

**Files:**
- Modify: `skill-scheduler/dispatcher.py`

注：编排层主要是 IO 串联，用 Task 10 的分级验证覆盖；本任务后 `--dry-run` 必须可用。

- [ ] **Step 1: 实现编排与 CLI（加到 main 之前；替换占位 main）**

```python
def log_dispatcher(msg):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_DIR / "dispatcher.log", "a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")


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
    timeout_minutes = job.get("timeout_minutes", cfg.get("defaults", {}).get("timeout_minutes", 20))
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
    if result != "OK":
        prev_failed_today = (
            prev.get("last_result") not in (None, "OK", "DRYRUN")
            and (prev.get("last_run_at") or "")[:10] == rec["last_run_at"][:10]
        )
        if not prev_failed_today:
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
        validate_job(job)
        last = state.get("jobs", {}).get(job["name"], {}).get("last_run_at")
        last_dt = datetime.fromisoformat(last) if last else None
        if is_due(job["schedule"], last_dt, now):
            res = execute_job(job, cfg, state, dry_run=False)
            save_json(STATE_FILE, state)
            ran.append(f"{job['name']}={res}")
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
```

- [ ] **Step 2: 跑全部单测确认未回归**

Run: `cd skill-scheduler && python3 -m unittest test_dispatcher -v`
Expected: PASS（全部）

- [ ] **Step 3: dry-run 冒烟（用样例配置指向临时 HOME，零 token、零副作用）**

Run:
```bash
cd skill-scheduler
mkdir -p /tmp/ss-smoke && cp jobs.example.json /tmp/ss-smoke/jobs.json
SKILL_SCHEDULER_HOME=/tmp/ss-smoke python3 dispatcher.py run group-digest-示例群 --dry-run
```
Expected: 打印 `=== job: group-digest-示例群 ===`、命令行、`cwd`、以及"任务正文 + 自动拼接的 footer"（footer 末尾含 `KIRO_JOB_RESULT`）。

- [ ] **Step 4: 清理冒烟临时目录**

Run: `rm -rf /tmp/ss-smoke`

- [ ] **Step 5: Commit**

```bash
git add skill-scheduler/dispatcher.py
git commit -m "feat(skill-scheduler): orchestration + CLI (tick/run/status, lock)"
```

---

## Task 10: 分级端到端验证 + 挂 cron（人工执行，对照 spec §10）

**Files:**
- Modify: `~/.config/skill-scheduler/jobs.json`（真实配置，不进 git）
- Modify: 用户 crontab

前提：目标群已 bootstrap；`lark-cli` user+bot 已登录（`lark-cli auth status` 显示 `tokenStatus: valid`）。

- [ ] **Step 1: 落真实配置**

```bash
mkdir -p ~/.config/skill-scheduler
cp ~/skills/skill-scheduler/jobs.example.json ~/.config/skill-scheduler/jobs.json
# 编辑 jobs.json：把群名改成「LS软件开发与规划」，name 改成 group-digest-LS，
# 填 defaults.report_to 为你的 open_id（可留空，预检会自动缓存）。
```

- [ ] **Step 2: Stage 0 — dry-run 核对真实 prompt**

Run: `python3 ~/skills/skill-scheduler/dispatcher.py run group-digest-LS --dry-run`
Expected: 打印的 prompt 群名正确、含增量语义、末尾有 footer 哨兵约定。

- [ ] **Step 3: Stage 1 — 手动真跑一次（有真实写副作用）**

Run: `python3 ~/skills/skill-scheduler/dispatcher.py run group-digest-LS`
Expected: 终端打印 `group-digest-LS -> OK`；飞书纪要文档顶部出现当天小节；收到 bot 摘要私信；`~/.config/skill-scheduler/logs/group-digest-LS/<ts>.log` 存在。

- [ ] **Step 4: 检查 status**

Run: `python3 ~/skills/skill-scheduler/dispatcher.py status`
Expected: 一行 `group-digest-LS: OK @ ... (exit=0, credits=<n>) ` + log 路径。

- [ ] **Step 5: Stage 2 — 故障注入验告警**

把 jobs.json 里该 job 群名临时改成一个不存在的群（如「不存在的群XYZ」），再跑：
Run: `python3 ~/skills/skill-scheduler/dispatcher.py run group-digest-LS`
Expected: 结果 `FAIL`/`TIMEOUT`；收到 bot ❌ 告警私信（或 `~/.config/skill-scheduler/ALERT.log` 有记录）。验证后把群名改回。

- [ ] **Step 6: Stage 3 — 挂 cron 心跳并验证自动触发**

先把该 job 的 `schedule` 临时改成几分钟后的 `daily_at`（如当前时间 +3 分钟），加 cron：
```bash
( crontab -l 2>/dev/null; echo '*/2 * * * * /usr/bin/python3 /home/ycs/skills/skill-scheduler/dispatcher.py tick >> /home/ycs/.config/skill-scheduler/logs/cron.log 2>&1' ) | crontab -
```
Expected：到点后 `logs/dispatcher.log` 出现 `tick ran: group-digest-LS=OK`，`status` 显示新一次运行。验证后把 `schedule` 改回 `02:30`，并把 cron 频率按需调整（如 `*/10`）。

- [ ] **Step 7: Stage 4 — 复盘**

Run: `python3 ~/skills/skill-scheduler/dispatcher.py status` + 翻 `logs/`。
确认结果稳定、credit 消耗符合预期。据此迭代 prompt 或时间表。无需提交（运行时产物不进 git）。

---

## Self-Review

**Spec coverage：**
- §4 组件（dispatcher/cron/配置/运行时）→ Task 1、9、10。
- §5 文件布局 → Task 1（含 `SKILL_SCHEDULER_HOME` 覆盖）。
- §6 配置（schedule 两型 / footer 拼接 / prompt_file / report_to）→ Task 1、4、6、8。
- §7 运行流程（模式 / tick / 串行 / scratch cwd / 到点判定 / 哨兵剥 ANSI 取最后匹配 / credit）→ Task 2、3、5、7、9。
- §8 日志/state/告警（per-run 日志 + 保留 N / state 字段含 credits + report_to_cached / 告警优先级 + ALERT 兜底 + 当天去重）→ Task 7、8、9。
- §9 前置条件 → README（Task 1）+ Task 10 前提。
- §10/§11 验收阶梯 + 单元测试 → Task 2–8（单测）+ Task 10（Stage 0–4）。
- §12 技术栈 → 全程纯 stdlib，外部仅 kiro-cli/lark-cli。
- §13 地基先行 → Task 10 Stage 1 即 spec 要求的端到端 spike（可行性此前已实测过）。

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整代码；每个测试步骤含真实断言。

**Type/名称一致性：** `is_due/parse_sentinel/parse_credits/build_prompt/judge/validate_job/resolve_recipient/run_kiro/execute_job/cmd_tick/cmd_run/cmd_status/with_lock/load_json/save_json/load_config/prune_logs/log_dispatcher/preflight_auth/send_alert` 跨任务签名一致；常量 `HOME/JOBS_FILE/STATE_FILE/LOG_DIR/SCRATCH_DIR/ALERT_FILE/LOCK_FILE/KEEP_LOGS/FOOTER/ANSI_RE/SENTINEL_RE/CREDITS_RE` 在 Task 1 一次定义、后续引用一致。

**已知局限（接受）：** `run_kiro` 超时只杀直接子进程，kiro-cli 派生的孙进程可能残留（超时罕见，timeout 默认 20min 远大于实测 ~1min）；单一全局 flock 下某 job 跑久会让同 tick 其它 job 推迟到下个 tick（幂等可接受）。
