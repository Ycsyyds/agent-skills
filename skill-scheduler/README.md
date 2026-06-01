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
