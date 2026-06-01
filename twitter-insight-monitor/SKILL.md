---
name: twitter-insight-monitor
version: 0.1.0
description: "监控 AI 大佬的 Twitter/X 动态，用你（agent）的内置模型逐条提炼结构化洞察、生成每日日报、每周蒸馏长期记忆，维护一份随时间累积的三层记忆（短期推文 / 中期日报 / 长期核心观点库）。当用户说『跑一下 twitter 监控』『看看最近 AI 大佬说了啥』『出个 AI 日报』『周度蒸馏/更新长期记忆』『盯着这些人帮我提炼洞察』，或任何需要抓取关注对象推文、提炼信号并沉淀到可持续维护的记忆文档的场景时使用。抓取走本地 Chrome CDP proxy；飞书推送可选。"
metadata:
  requires:
    bins: ["node"]
---

# Twitter Insight Monitor

你（agent）是这个流程的大脑：逐条洞察、写日报、做周度蒸馏都由你用**内置模型**完成。机械活（抓推文、读写记忆、推飞书）交给 `scripts/` 下的三个脚本。"复利"来自增量游标 + 持续累积的记忆文档——每次唤起都在上次基础上叠加。

**开始前必读**（用 Read 工具）：
1. [`references/insight-prompts.md`](references/insight-prompts.md) — 3 个核心 prompt + 单条推文 schema（Step 4/5/6 必读）
2. [`references/memory-layout.md`](references/memory-layout.md) — 记忆布局与生命周期

**前置条件**：Node 22；Chrome 远程调试已登录 x.com + CDP proxy 在 3456 端口（沿用 `~/twitter-monitor/scripts/start-cdp-proxy.sh`）；飞书推送可选（需 `lark-cli` 且 `config.notify=true`）。

`SCRIPTS=` 本 skill 的 `scripts/` 绝对路径（安装后固定）。

## 工作流

### Step 0 · 初始化（每次先跑，幂等）
```bash
node $SCRIPTS/store.js init
```
若返回 `migrationAvailable:true`，**先向用户确认**再迁移老数据：
```bash
node $SCRIPTS/store.js migrate --from <oldRepo>
```

### Step 1 · 取游标
```bash
node $SCRIPTS/store.js cursors      # 每 handle 的 last_id + last_daily_date + last_weekly_date
node $SCRIPTS/store.js config       # 取 targets 列表
```

### Step 2 · 逐 handle 抓取 + 入短期记忆
对每个 target：
```bash
node $SCRIPTS/fetch.js --handle <h> --since-id <last_id>    # 抓新推（JSON）
# 把上面的 tweets 数组通过 stdin 喂给 add-tweets：
echo '<tweets json>' | node $SCRIPTS/store.js add-tweets --handle <h>   # 返回 {pending:[ids]}
```
- 单个 handle 抓取失败（如未登录/限流）：记录并继续其他人，不中断。
- Chrome/proxy 没起导致全部失败：明确提示用户先启动 Chrome + `start-cdp-proxy.sh`，**不要编造数据**。

### Step 3 · 批量逐条洞察（你来做）
读取 `pending` 对应的推文（从抓取结果里取），按 `references/insight-prompts.md` 第 1 节，一次推理输出洞察 JSON 数组（每项含 `id`），写回：
```bash
echo '[{"id":"...","insight":{...}}]' | node $SCRIPTS/store.js save-insights --handle <h>
```

### Step 4 · 日报（按需/跨天）
```bash
node $SCRIPTS/store.js pending-daily     # {dates:[{date,groups:[{target,tweets}]}]}
```
对每个就绪日期，按 prompt 第 2 节写日报：
```bash
node $SCRIPTS/store.js save-daily --date <YYYY-MM-DD> < /tmp/daily.md
```

### Step 5 · 周度蒸馏（按需/跨周）
```bash
node $SCRIPTS/store.js pending-weekly     # {ready,week,dailyReports,prevLongTerm}
```
若 `ready`，按 prompt 第 3 节重写 core-insights：
```bash
node $SCRIPTS/store.js save-weekly --week <YYYY-Www> < /tmp/core.md
```

### Step 6 · 可选通知 + 对话内呈现
若 `config.notify=true`，拼摘要（高 novelty 推文 / 日报核心信号 / 周报新观点）推飞书：
```bash
echo '<摘要 markdown>' | node $SCRIPTS/notify.js
```
无论是否推送，都在对话里向用户呈现本次结果（新推文洞察 Top 项 + 是否生成了日/周报）。

## 容错
- 无新推文：跳过洞察，仍检查日/周报，回报"无新增"。
- 重跑安全：游标只在 `save-insights` 后推进，`add-tweets` 按 id 去重。
- 通知失败：降级不阻塞（结果已在对话里）。
