# skill-scheduler

配置驱动的本机调度器：按计划用无头 `kiro-cli` 自动运行指定 AI skill 工作流，让群纪要、bug 收集等"周边性、重复性"工作全天候无人值守完成（含夜间），把精力留给核心问题。

- 纯 Python 标准库，无第三方依赖，无常驻进程。
- 一条 cron 心跳唤醒；"几点跑哪个任务"全在 `jobs.json`——**加任务只改配置，不碰代码、不碰系统**。
- 失败自动飞书 bot 告警；成功不打扰（摘要由 skill 自身私信发出）。
- 设计与实现细节见 `docs/superpowers/specs/2026-06-01-skill-scheduler-design.md`、`docs/superpowers/plans/2026-06-01-skill-scheduler.md`。

## 工作原理

```
cron 每 N 分钟 → dispatcher.py tick → 预检 lark-cli 认证
  → 选出"到点"的 job → 逐个(串行) kiro-cli chat --no-interactive --trust-all-tools "<prompt>"
  → 解析输出末尾哨兵 KIRO_JOB_RESULT 判定成败 → 写 state.json + per-run 日志 → 失败 bot 告警
```

被调度的工作流本身（如 lark-workflow-group-digest）是**增量 + 幂等 + 可补跑**（靠各自 `~/.config/lark-*/state.json` 的游标），所以调度层不需要精确 exactly-once：关机错过会自动补跑，重复跑也不会重复写。

`dispatcher` 会给每个 job 的 `prompt` 自动追加一段标准 footer（要求"无人值守、别问确认、最后一行输出哨兵"），所以配置里只写任务本身即可。

## 安装

```bash
mkdir -p ~/.config/skill-scheduler
cp skill-scheduler/jobs.example.json ~/.config/skill-scheduler/jobs.json
# 编辑 jobs.json：填真实群名、报告人 open_id(report_to，可留空)、时间表
```

挂一条 cron 心跳（每 10 分钟唤醒一次，真正几点跑哪个任务由 jobs.json 决定）：

```cron
*/10 * * * * /usr/bin/python3 /home/ycs/skills/skill-scheduler/dispatcher.py tick >> /home/ycs/.config/skill-scheduler/logs/cron.log 2>&1 # skill-scheduler
```

## 前置条件

- 目标群必须已 **bootstrap**：首次建文档/Base/锚点请先**手动交互式**跑一次对应 skill（含写操作确认）。定时只做增量。
- `lark-cli` 的 user 与 bot 身份已 `auth login`（`lark-cli auth status` 可查）。
- 被调度的 skill 已安装在 `~/.kiro/skills/`。

## 配置（jobs.json）

所有任务集中在 `~/.config/skill-scheduler/jobs.json`（含真实群名，不进 git）：

```json
{
  "defaults": { "timeout_minutes": 20, "report_to": "" },
  "jobs": [
    {
      "name": "group-digest-示例群",
      "enabled": true,
      "schedule": { "daily_at": "02:30" },
      "prompt": "使用 lark-workflow-group-digest skill，对飞书群「示例群名」做增量群重点整理：……该群已 bootstrap，直接增量执行。"
    }
  ]
}
```

字段：

| 字段 | 说明 |
|------|------|
| `defaults.timeout_minutes` | 单 job 默认超时（分钟），可被 job 级同名字段覆盖。默认 20。|
| `defaults.report_to` | 失败告警接收人 open_id。建议显式填；留空则首次成功解析到的 userOpenId 会缓存进 `state.json`，告警时优先用缓存（不依赖告警时刻的实时 auth）。|
| `name` | 唯一，用作日志目录名与 state 键。|
| `enabled` | 开关，停用不删（`false` 跳过）。|
| `schedule` | 见下，二选一。|
| `prompt` | 只写任务本身（footer 由 dispatcher 自动拼接，勿重复）。|
| `prompt_file` | 可选，指向一个 `.md`（相对 `skill-scheduler/` 或绝对路径），作为长 prompt 的可读替代；与 `prompt` 二选一。|

`schedule` 两种形态（不支持完整 cron 表达式）：

- `{ "daily_at": "02:30" }`，可加 `"weekdays": [1,2,3,4,5]`（ISO，周一=1）限定工作日。
- `{ "interval_minutes": 120 }`：每 N 分钟跑一次（高频任务）。

## 用法

```bash
dispatcher.py run <name> --dry-run   # 只打印拼好的 prompt + 命令，零 token，核对用
dispatcher.py run <name>             # 手动强制跑一个 job（忽略时间表）
dispatcher.py tick                   # cron 心跳调用：跑所有"到点"的 job
dispatcher.py status                 # 复盘：每个 job 上次运行时间/结果/退出码/credit
```

运行时根目录默认 `~/.config/skill-scheduler/`，可用环境变量 `SKILL_SCHEDULER_HOME` 覆盖（便于隔离测试）。

## 可观测性与告警

- **日志**：`~/.config/skill-scheduler/logs/<job名>/<时间戳>.log`（每次运行全量 stdout+stderr，每 job 保留最近 20 份）+ `logs/dispatcher.log`（每次 tick 一行）。
- **状态**：`state.json` 记每个 job 的 `last_run_at / last_result(OK|FAIL|TIMEOUT) / last_exit_code / last_reason / last_credits / last_log`，外加缓存的 `report_to_cached`。
- **告警**：失败时 bot 私信 `❌ <job> | 原因 | 日志 | 时间`；接收人优先级 `report_to` → 缓存 → 实时 auth；同一 job 当天同一 FAIL 状态只告警一次；连 bot 都发不出则写 `ALERT.log` 兜底。成功不打扰。
- **认证**：预检 `lark-cli auth status`；`needs_refresh` 视为可用（access token 过期会自动用 refresh token 续期），仅真失效才跳过本轮并告警。

## 分级验证（测试 → 检查 → 迭代闭环）

- Stage 0：`run <name> --dry-run` 核对 prompt。
- Stage 1：`run <name>` 真跑一次，核对飞书产物 + bot 摘要私信 + state/日志。
- Stage 2：用一个坏配置（如 `prompt_file` 指向不存在文件）跑 `tick`，确认 FAIL state + 收到 bot ❌ 告警。
- Stage 3：把某 job 的 schedule 设成几分钟后，等 cron 自动触发一次，确认无人值守路径。
- Stage 4：`status` + 翻 `logs/` 复盘。

单元测试（纯函数）：`cd skill-scheduler && python3 -m unittest test_dispatcher -v`。

## 已知局限

- 超时只 kill 直接子进程，`kiro-cli` 派生的孙进程可能短暂残留（超时罕见，默认 20 分钟远大于实测约 1–3 分钟/次）。
- 单一全局文件锁：某 job 跑很久会让同一 tick 的其它 job 推迟到下个 tick（幂等可接受）。
- 预检只查 `lark-cli` 认证；`kiro-cli` 自身登录态失效会表现为 job FAIL 告警。
