# twitter-insight-monitor Skill — 设计方案

- 日期：2026-06-01
- 状态：设计已批准，待写实现计划
- 来源：把现有 `~/twitter-monitor`（自研 MiniMax + cron 的 Node 应用）改造成可在任意 AI CLI 工具（kiro / Claude Code / codex）上使用的可移植 skill。

## 1. 目标与范围

把"监控 AI 大佬 Twitter/X → 逐条提炼洞察 → 日报 → 周度蒸馏 → 三层记忆"这套已验证可用的工作流，重构为一个**可移植 skill**：

- **专注 Twitter/X**，不做通用采集器抽象（YAGNI）。
- **用宿主 AI 工具的内置模型**做全部智能工作，不再依赖外部 LLM API（MiniMax）与 API key。
- **纯 agent 唤起 / 按需触发**：人在对话里主动唤起，单次唤起端到端跑完整条流水线。
- **复利来自增量游标 + 持续累积的记忆文档**，而非无人值守的 cron。
- **跨工具共享同一份记忆**：从哪个工具唤起都在同一份记忆上叠加。

### 锁定的关键决定

| # | 决定 |
|---|------|
| 1 | 范围：Twitter/X 专用的可移植版，内置模型驱动；不做通用框架。 |
| 2 | 自动化：纯 agent 唤起 / 按需。"复利" = 增量游标 + 累积记忆文档。 |
| 3 | 抓取：沿用现有 Chrome CDP + proxy；把 `monitor.js` 抓取段剥成独立机械脚本（无 LLM）。 |
| 4 | 通知：保留飞书推送为**可选**（复用 `notify.js`，lark-cli + webhook），默认可关。 |
| 5 | 数据家目录：可配置 `data_home`，默认 `~/.twitter-insight/`；`state.json` 固定在 `~/.config/twitter-insight/`；首次运行检测老 `~/twitter-monitor/` 提示迁移。 |
| 架构 | 方案 1：agent 经 SKILL.md 编排；3 个极薄机械脚本做确定性 I/O；agent 用内置模型做全部智能；3 个 prompt 从 `insights.js` 原样移植到 `references/`。 |

## 2. 整体架构与目录布局

**三面切分**

- **机械面（脚本，确定性、可单测）**：抓取、文件存取、通知。
- **智能面（agent + 内置模型）**：逐条洞察、日报、周度蒸馏。
- **控制面 vs 内容面分离**：`~/.config/` 放控制信息（配置 + 游标），`data_home` 放可累积、用户会读/改的记忆产物。

**Skill 目录**（建议名 `twitter-insight-monitor`，置于 `/home/ycs/skills/` 下）：

```
twitter-insight-monitor/
├── SKILL.md                    # 总指挥：触发描述 + 工作流
├── scripts/
│   ├── fetch.js                # 从 monitor.js 剥出的抓取段（Chrome CDP，无 LLM）
│   ├── store.js                # 三层记忆 + state/config I/O、迁移、归档
│   └── notify.js               # 可选飞书推送（复用现有）
├── references/
│   ├── insight-prompts.md      # 移植的 3 个 prompt + 单条推文 schema
│   └── memory-layout.md        # 记忆目录规范 + 生命周期说明
└── README.md                   # 安装、前置条件、跨工具说明
```

**控制面** `~/.config/twitter-insight/`（重装 skill 不丢）：

```
├── config.json    # 用户编辑：targets(handles) / feishu(可选) / data_home / notify 开关
└── state.json     # 脚本管理：每个 handle 游标 + last_daily_date / last_weekly_date / migrated
```

**内容面** `data_home`（默认 `~/.twitter-insight/`，可在 config 改）：

```
├── data/{handle}.json              # 短期：原始推文 + agent 洞察（7 天滚动）
├── reports/daily/YYYY-MM-DD.md     # 中期：日报
├── reports/weekly/YYYY-Www.md      # 周度不可变快照
└── memory/
    ├── long-term/core-insights.md  # 长期：活文档（蒸馏时重写）
    └── archive/core-insights-*.md  # 长期记忆历史归档
```

**跨工具复利的关键**：各工具把 skill 目录拷进自己的 skills 目录（自包含副本），但都指向**同一份** `~/.config/twitter-insight/` + `data_home`。

## 3. 机械脚本接口

设计原则：脚本只做确定性 I/O，**JSON 走 stdin/stdout**，无任何 LLM；`store.js` 是 state/config 与所有文件的**唯一写入者**；`fetch.js` 无状态；`notify.js` 仅在开关打开时被调用。

### `fetch.js`（无状态抓取）

```
node fetch.js --handle <h> --since-id <id>
```

- 走 Chrome CDP proxy 抓取；平凡预过滤：清洗 URL，清洗后 <15 字符的标 `prefilter_skip:true`。
- 输出 `{handle, tweets:[{id,text,time,url,engagement,prefilter_skip}], fetched_at}` 到 stdout。
- **不写盘、不读 state**（游标由 agent 从 store 取后传入）。

### `store.js`（state/config + 三层记忆唯一管家）

| 子命令 | 作用 |
|--------|------|
| `init` | 建目录；检测老 `~/twitter-monitor/` 提示迁移（拷 data/reports/memory）；缺失则生成默认 config.json。幂等。 |
| `config` | 打印解析后的配置（targets / data_home / feishu / notify 开关）。 |
| `cursors` | 打印每个 handle 的 since-id + last_daily_date + last_weekly_date。 |
| `add-tweets --handle <h>` | stdin 收原始推文 → 追加进 `data/{h}.json`，按 id 去重、剪掉 >7 天；**返回需要洞察的新推 id 列表**（排除 prefilter_skip）。 |
| `save-insights --handle <h>` | stdin 收 `[{id, insight{...}}]` → 挂到对应推文；把该 handle 游标推进到已处理的最大 id。 |
| `pending-daily` | 按 state 判断是否有就绪日期；返回当日全量推文（按人物分组 + 已附洞察）。 |
| `pending-weekly` | 按 state 判断是否跨周；返回近 7 份日报 + 当前 core-insights。 |
| `save-daily --date <d>` | stdin 收 markdown → 写 `reports/daily/<d>.md`，置 last_daily_date。 |
| `save-weekly --week <w>` | stdin 收 markdown → 写周度快照 + **重写** `core-insights.md`（旧版归档到 `archive/`），置 last_weekly_date。 |

### `notify.js`（复用现有，可选）

```
echo "<摘要 markdown>" | node notify.js     # 仅当 config.notify 开启时被调用
```

复用现有 lark-cli + webhook 双通道；推送失败降级、不阻塞主流程。

> 旧系统长期记忆是"整篇重写 + 归档"，日报是独立日期文件——因此**不需要** group-digest 那种锚点插入，`store.js` 更简单。

## 4. Agent 智能层（3 能力 + schema）

3 个 system prompt 从 `insights.js` **原样移植**到 `references/insight-prompts.md`，agent 读取后用内置模型执行。原 `llm.js` 的重试/降级/mock/`<think>` 剥离，以及 `insights.js` 的 `fallbackInsight`/`fallbackDailyReport`/dry-run mock **全部删除**（不再有外部 API 失败面需要兜底）。

### 能力 1 · 逐条洞察

- 输入：`add-tweets` 返回的"待洞察新推列表"（作者、关注领域、互动量、时间、正文）。
- 输出 schema（**保持不变**）：

```json
{"one_liner":"≤40字 核心论点(不复述原文)",
 "why_matters":"≤80字 为何值得关注 | 无信号则'无明确行业信号'",
 "tags":["#x"],
 "type":"announcement|insight|opinion|research|personal|other",
 "novelty":0-10,
 "skip":false,
 "skip_reason":"≤20字"}
```

- **改进**：agent 即模型本身，可**一次推理批量处理**当批所有新推，输出 JSON 数组，一把 pipe 给 `save-insights`（比旧系统逐条调 API 更省往返）。
- "清洗后 <15 字符自动 skip" 已前移到 `fetch.js`（`prefilter_skip`）。

### 能力 2 · 日报聚合

- 输入：`pending-daily` 返回的当日全量推文（按人物分组 + 已附洞察）。
- 输出：五段式中文 Markdown — 🎯 今日核心信号 / 📈 主题热度 / ⚖️ 立场分歧·共识 / 👁 持续追踪信号 / 👥 各人物动态；800–1500 字 → `save-daily`。

### 能力 3 · 周度蒸馏

- 输入：`pending-weekly` 返回的近 7 份日报 + 当前 `core-insights.md`。
- 输出：整篇重写的 `core-insights.md` — ⭐ 本周新观点 / 🔼 被强化 / 🔽 **被削弱·被反驳**（防回音室，关键节）/ 📊 长期趋势线 / 👀 持续追踪 / 👥 关键人物画像；1500–3000 字 → `save-weekly`（旧版归档 + 周快照）。
- "蒸馏不是累加"：不保留过期/被反驳的旧观点；用户手工加的 `>` 批注作为输入保留。

所有输出**全中文、第三人称客观**，与原系统一致。

## 5. 数据流 · 游标 · 触发 · 记忆生命周期

### 状态结构

- `config.json`（用户编辑）：`{ targets:[{name,handle,keywords}], data_home, notify:bool, feishu:{chat_id|webhook} }`
- `state.json`（脚本管理）：

```json
{ "handles": { "karpathy": {"last_id":"178...", "last_processed_time":"2026-06-01T01:24+08:00"} },
  "last_daily_date": "2026-05-31",
  "last_weekly_date": "2026-W22",
  "migrated": true }
```

### 单次唤起的端到端数据流

```
1. store.js init        建目录 / 首次迁移老数据 / 载入 config
2. store.js cursors     取每 handle 的 since-id + last_daily_date + last_weekly_date
3. 逐 handle: fetch.js --since-id N → 原始推文 | store.js add-tweets → 返回"待洞察 id 列表"
4. agent 批量逐条洞察 → save-insights（挂洞察 + 推进该 handle 游标）
5. store.js pending-daily   → 有就绪日期则 agent 写日报 → save-daily
6. store.js pending-weekly  → 有就绪周则 agent 蒸馏 → save-weekly（重写+归档+周快照）
7. config.notify 开 → 拼摘要(高novelty推文/日报Top5/周报新观点) | notify.js
8. 在对话里呈现本次结果
```

### 跨天 / 跨周触发规则（按需模式的核心）

- **日报**：`pending-daily` 返回"有推文但尚未出日报"的日期（含今天）。今天的日报可重复刷新覆盖；`last_daily_date` 只在某天彻底过去后推进。
- **周报**：`pending-weekly` 在"最近一个已完结 ISO 周 > last_weekly_date 且该周有日报"时触发，蒸馏过去 7 天日报 + 当前 core。
- **断档自愈**：离开几天后再唤起，自动补齐所有未出日报、补蒸馏漏掉的周——无 cron 也能复利的关键。

### 记忆生命周期

- 短期 `data/{handle}.json`：原始推文 + 洞察，`add-tweets` 每次剪掉 >7 天。
- 中期 `reports/daily/*.md`：永久。
- 长期 `core-insights.md`：周度整篇重写；旧版 → `archive/core-insights-<date>.md`；不可变快照 → `reports/weekly/YYYY-Www.md`。

## 6. SKILL.md · 错误处理 · 测试 · 安装

### SKILL.md frontmatter

```yaml
name: twitter-insight-monitor
version: 0.1.0
description: "..."  # 触发词：跑一下twitter监控 / 看看最近AI大佬说了啥 / 出个日报 /
                    # 周度蒸馏更新长期记忆 / 盯着这些人帮我提炼洞察 ...
metadata:
  requires:
    bins: ["node"]  # lark-cli 仅 notify 开启时需要
```

正文 = 第 5 节那 8 步的 agent 指令版 + "开始前必读 references/"（两份）+ 前置检查（Chrome 9222、CDP proxy 3456）。

### 错误处理 / 边界

- **Chrome / CDP proxy 没起**：`fetch.js` 失败 → 明确提示"请先启动 Chrome 远程调试 + `start-cdp-proxy.sh`"，**绝不编造数据**。
- **单个 handle 抓不到**（登录墙/限流）：记下并继续其他人，不整体中断。
- **无新推文**：跳过洞察，仍检查日/周报，回报"无新增"。
- **首次迁移**：检测到老 `~/twitter-monitor/` → 拷贝前先向用户确认（写操作）。
- **notify 失败**：降级不阻塞（结果已在对话里）。
- **中断 / 重跑**：游标只在 `save-insights` 后推进 + `add-tweets` 按 id 去重 → 重跑安全幂等。

### 测试与验证

- `store.js` 纯文件逻辑可单测：临时 data_home 跑 `init → add-tweets(去重/剪枝) → save-insights → pending-daily → save-weekly(归档)`，断言产物。
- `fetch.js` 可独立跑打印 JSON，对已知 handle 实测一次。
- 冒烟脚本：喂样例推文 JSON 走完整链路，校验三层文件生成。
- 在 Node 22 下验证脚本可跑。

### 跨工具安装

- 把 skill 目录分别拷进 `~/.kiro/skills/`、`~/.claude/skills/`、codex 的 skills 目录；三者都指向同一 `~/.config/twitter-insight/` + `data_home` → 记忆跨工具共享。

### 已知风险

- ⚠️ **codex 是否原生支持同样的 SKILL.md skill 机制尚未验证**。若机制不同，可能需要一层薄适配（或在 codex 里直接把 SKILL.md 当指令喂入）。建议在实现阶段优先验证，避免假设。

## 7. 不做（YAGNI）

- 不做通用采集器框架 / 多源插件（只 Twitter/X）。
- 不做 cron / headless CLI 无人值守调度。
- 不保留 MiniMax 客户端、API key、重试/降级/mock/dry-run、`<think>` 剥离。
- 不做 group-digest 式锚点插入（日报是独立日期文件，长期记忆整篇重写）。
