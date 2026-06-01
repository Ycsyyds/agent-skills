# Skill Scheduler — 定时自动运行 AI Skill 工作流（设计规格）

- 日期：2026-06-01
- 状态：已确认（待转 writing-plans 出实现计划）
- 运行环境：常开 Linux 机器，时区 Asia/Shanghai，Python 3.8.10，用户级 systemd 在跑且 `Linger=yes`，crontab 可用（已有 `~/twitter-monitor` 的 node 定时任务在用）

## 1. 背景与目标

把已有的 AI skill 工作流挂到定时调度上，无人值守自动运行（含夜间），让"周边性、重复性"的工作全天候自动完成，从而把精力集中到核心问题上。底层意图：通过持续增加这类常驻自动任务，稳定地把 token 消耗提升 1～2 个数量级，作为"生产力饱和"的代理指标。

首批种子任务是两个已有 skill：

- `lark-workflow-group-digest`：从指定飞书群增量抓消息 → 识别 5 类重点 → 追加到该群累积纪要文档顶部 → bot 私信摘要。
- `lark-workflow-bug-feedback`：从指定飞书群增量抓消息 → 识别 bug/产品意见 → 查重合并写入该群 Base → 追加当天日报 → bot 私信日报。

两个 skill 都已是**增量 + 幂等 + 可补跑**（靠各自 `~/.config/lark-*/state.json` 里的 `last_processed_time` 游标），因此调度层不需要精确的 exactly-once：即便晚跑/补跑也不会重复或遗漏。

## 2. 范围

**在范围内**

- 一个通用、配置驱动的本机调度器：加任务只改一个配置文件，不改代码、不碰系统。
- 无头触发 `kiro-cli`，运行任意能被 prompt 触发的 skill。
- 失败检测、本地全量日志、失败时飞书 bot 告警、运行历史复盘。
- 内建支持"测试 → 检查 → 迭代"闭环的运行模式（dry-run / 手动单跑 / status）。

**不在范围内（YAGNI）**

- 不做常驻守护进程、不做分布式/多机调度。
- 不做 cron 表达式全集；只支持够用的两种时间表（见 §6）。
- 不做并发执行（任务串行，避免抢 token / 撞飞书限流）。
- 不在调度里做首次 bootstrap（建文档/Base/锚点）；那一步含写操作确认，由人工交互式跑一次完成（见 §9）。
- 不集成 Claude Code 作为运行时（运行时统一用 `kiro-cli`；未来如需可作为扩展）。

## 3. 关键决策汇总

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 承载环境 | 常开 Linux 本机，调度跑本机 |
| 2 | 形态 | 通用配置驱动调度器，两个 lark 工作流作种子 |
| 3 | 可观测性 | 本地全量日志 + 失败飞书 bot 告警；成功不重复打扰 |
| 4 | 成功判定 | 成功哨兵 `KIRO_JOB_RESULT: OK/FAIL`，退出码兜底 |
| 5 | 认证 | 跑前预检 `lark-cli auth status` 门；失效则中止本轮 + 告警 |
| 6 | 架构 | 中心 dispatcher + 单条 cron 心跳 |
| 7 | 运行时 | `kiro-cli chat --no-interactive --trust-all-tools` |

## 4. 架构与组件

技术栈：Python 3 标准库写的 dispatcher + 一条 cron 心跳 + `kiro-cli` 无头执行 + `lark-cli` bot 发告警。无第三方依赖、无常驻进程。

四个组件：

1. **jobs 配置**（`~/.config/skill-scheduler/jobs.json`）—— 所有任务的唯一真相源。加任务只改这里。含个人信息（群名），不进 git。
2. **dispatcher.py**（在仓库内，进 git）—— 被 cron 周期唤醒；读配置 → 预检认证 → 选出到点的 job → 逐个无头跑 `kiro-cli` → 判定成败 → 记日志 → 失败告警。
3. **心跳 cron**（一条 crontab 行，如 `*/10 * * * *`）—— 周期唤醒 dispatcher。真正"几点跑哪个任务"在 jobs.json 里，cron 只是心跳，因此加任务永远不碰 cron/系统。
4. **运行时产物**（`~/.config/skill-scheduler/` 下）—— 日志、每任务的 last-run 状态文件。不进 git。

心跳机制采用 cron（与现有 `~/twitter-monitor` 一致、最省事；补跑逻辑在 dispatcher 内，不依赖心跳精度）。systemd 用户 timer（`Linger=yes` 已具备，可配 `Persistent=true`）为等价备选，本设计不采用。

## 5. 文件布局

代码与已有 skill 同仓（`/home/ycs/skills`）：

```
skills/
  skill-scheduler/
    dispatcher.py          # 调度主程序（纯 stdlib）
    jobs.example.json      # 配置样例（脱敏，进 git）
    test_dispatcher.py     # 纯函数单元测试（stdlib unittest）
    README.md              # 安装/使用说明
  docs/superpowers/specs/
    2026-06-01-skill-scheduler-design.md   # 本设计文档
~/.config/skill-scheduler/ # 个人配置 + 运行时（不进 git）
    jobs.json              # 真实任务配置（含群名）
    state.json             # 每任务 last_run_at / last_result / ...
    ALERT.log              # 告警兜底（bot 告警都失败时写这里）
    logs/
      dispatcher.log
      <job名>/<时间戳>.log
```

沿用两个 skill"代码进仓库、状态放 `~/.config`"的既有约定。

## 6. jobs.json 配置结构

样例（`jobs.example.json` 即此结构的脱敏版）：

```json
{
  "defaults": { "timeout_minutes": 20, "report_to": "" },
  "jobs": [
    {
      "name": "group-digest-LS软件开发与规划",
      "enabled": true,
      "schedule": { "daily_at": "02:30" },
      "prompt": "使用 lark-workflow-group-digest skill，对飞书群「LS软件开发与规划」做增量群重点整理：从该群上次游标到现在拉新消息，识别5类重点，追加到该群纪要文档顶部，bot 私信摘要给我。该群已 bootstrap，直接增量执行。"
    },
    {
      "name": "bug-feedback-乌班图LixelStudio体验",
      "enabled": true,
      "schedule": { "daily_at": "02:45" },
      "prompt": "使用 lark-workflow-bug-feedback skill，对飞书群「乌班图LixelStudio体验」做增量 bug 收集：拉新消息，识别 bug/意见，查重合并写该群 Base，追加当天日报到顶部，bot 私信日报给我。该群已 bootstrap，直接增量执行。"
    }
  ]
}
```

字段：

- `defaults.timeout_minutes`：单 job 默认超时（分钟），可被 job 级 `timeout_minutes` 覆盖。
- `defaults.report_to`：失败告警接收人 open_id。**建议显式填写**；留空则首次成功解析到的 userOpenId 会缓存进 state.json，供后续告警使用，**不依赖告警时刻的实时 `auth status`**（见 §8 韧性）。
- `name`：唯一，用作日志目录名与 state 键。
- `enabled`：开关，停用不删。
- `schedule`：见下。
- `prompt`：只写任务本身，不写"别问我/输出哨兵"那套样板（由 dispatcher 自动拼接）。
- `prompt_file`：可选，指向一个 `.md`（相对 `skill-scheduler/` 或绝对路径），作为长 prompt 的可读替代；与 `prompt` 二选一。中文长 prompt 塞进 JSON 要转义、不能多行，量大时用 `prompt_file` 更好维护。

schedule 两种形态（够用即止，不引 cron 表达式库）：

- `{ "daily_at": "02:30" }`，可加 `"weekdays": [1,2,3,4,5]`（ISO，周一=1）做工作日限定。
- `{ "interval_minutes": 120 }`：每 N 分钟跑一次（服务"全天候高频运行"的目标）。

每个 job 的 `schedule` 必须且只能是这两种之一。

**footer 由 dispatcher 自动拼接**（写配置时不重复）。dispatcher 把每个 job 的 `prompt` 后追加标准尾巴：

```
[无人值守自动调度] 没人能回答你的问题。务必：1) 不要问任何确认，按上述参数直接执行（含写操作）；
2) 全部完成后，最后一行仅输出机器可读结果：成功=「KIRO_JOB_RESULT: OK」，失败/未完成=「KIRO_JOB_RESULT: FAIL <一句话原因>」。
```

这样"免确认 + 哨兵"对所有 skill 通用、零重复，新增任务只写纯任务描述。

## 7. dispatcher 运行流程

运行模式（CLI 子命令）：

- `dispatcher.py tick`：cron 心跳调用，跑所有"到点"的 job（生产路径）。
- `dispatcher.py run <name>`：手动强制跑某 job（忽略时间表），用于测试/补跑。
- `dispatcher.py run <name> --dry-run`：只打印拼好的完整 prompt + 将要执行的命令，**不调用 kiro-cli**（零 token），用于检查 prompt 正确性。
- `dispatcher.py status`：列出每个 job 的 last_run_at / 结果 / 退出码（复盘）。

`tick` 流程：

```
加文件锁(flock，防止上一轮没跑完又叠跑) ─► 读 jobs.json
  ─► 预检认证门: lark-cli auth status 失效? ─是─► bot 告警"认证过期" + 本轮中止
  ─► 否: 选出"到点"的 enabled job ─► 逐个(串行)执行:
        拼接 prompt+footer ─► kiro-cli chat --no-interactive --trust-all-tools (带 timeout)
        ─► 抓 stdout/stderr 落 per-run 日志 ─► 解析末尾哨兵判定 OK/FAIL
        ─► 写回 state.json (last_run_at/result/exit_code/reason/log) ─► FAIL 则 bot 告警
  ─► 释放锁
```

并发：串行执行，不并发，避免多个 `kiro-cli`/`lark-cli` 抢 token、撞飞书限流。

每次运行的工作目录：dispatcher 在一个固定 scratch 目录（如 `~/.config/skill-scheduler/scratch/`）下启动 `kiro-cli` 子进程，避免 skill 的相对路径临时文件（如 lark-doc 的 `@./section.md`）和按目录存储的会话污染仓库或互相冲突。

"到点"判定（补跑 + 去重，纯 `datetime`，不依赖心跳精度）：

- `daily_at "HH:MM"`：当「今天是允许的 weekday」且「now ≥ 今天 HH:MM」且「上次运行日期 < 今天」→ 跑。三条合起来既能准点跑，又能在机器关机错过后开机自动补跑，且一天绝不重复。
- `interval_minutes N`：当「now − 上次运行 ≥ N 分钟」→ 跑（无上次运行记录则首次立即跑）。

结果判定（**已实测**：模型最终文本与哨兵均落 stdout，但 stdout 含 ANSI 颜色码，即便 `KIRO_LOG_NO_COLOR=1` 也只影响日志文件不影响 stdout）：

- 解析时**先剥 ANSI 转义码**，再用正则取**最后一个**匹配 `^KIRO_JOB_RESULT:\s*(OK|FAIL)\b` 的行（不是死抠 stdout 末行——agent 可能在哨兵后又补话）。
- 优先级：命中 `OK` → 成功；命中 `FAIL` → 失败（带原因）；无哨兵 / 超时 / 非零退出码 → 一律判 FAIL（宁可误报，不漏报）。超时单独记为 `TIMEOUT`。
- 顺带从 stderr 解析 `Credits: <n>`（实测每次运行结束会打印），记入 state/日志，作为"token/credit 消耗"的量化指标（服务北极星目标）。

## 8. 日志 / 状态 / 告警

**日志布局**（`~/.config/skill-scheduler/logs/`）：

- 每次运行一份 `logs/<job名>/<时间戳>.log`，存该次 `kiro-cli` 的全量 stdout+stderr。每个 job 只保留最近 N 份（默认 20），自动清旧。
- dispatcher 自身 `logs/dispatcher.log`，每次 tick 一行（哪些到点、各自结果）。

**state.json**（复盘的数据源）：顶层存 `report_to_cached`（首次解析到的 userOpenId）；每个 job 记 `last_run_at` / `last_result`（`OK` | `FAIL` | `TIMEOUT`）/ `last_exit_code` / `last_reason`（FAIL 时的哨兵原因）/ `last_credits`（本次消耗，来自 stderr）/ `last_log`（日志路径）。`dispatcher.py status` 读它做汇总。

**告警**：

- 失败时 `lark-cli im +messages-send --as bot --user-id <open_id>`，正文：`❌ <job名> 失败 | 原因 | 日志路径 | 时间`。
- 接收人优先级：`defaults.report_to` → state.json 的 `report_to_cached` → 末路才尝试实时 `auth status`。**这点很关键**：最重要的"认证过期"告警恰恰发生在 `auth status` 不可靠时，靠缓存的 open_id 才能让 bot 告警照常送达（bot 用应用级凭证，与 user oauth 解耦）。
- 韧性兜底：bot 用应用级凭证，通常比 user oauth 耐久，user 过期时 bot 告警一般仍能发出。万一连 bot 告警都失败 → 写入醒目的 `ALERT.log` + dispatcher.log 记 ERROR，保证本地有痕迹，杜绝"告警自己也静默失败"。
- 降噪：同一 job 持续失败时不每个 tick 都轰炸——当天同一 FAIL 状态只告警一次（状态从 OK→FAIL 跳变才再次告警）。
- 成功不打扰：成功摘要由 skill 自身私信发出，dispatcher 成功时不重复推。

## 9. 前置条件与边界

- **目标群必须已 bootstrap**：定时 job 只做增量。首次为某群建文档/Base/锚点（含写操作确认）由人工交互式跑一次对应 skill 完成，不放进无人值守。jobs.json 里登记的群默认都视为已 bootstrap。
- **认证有效**：`lark-cli` 的 user 与 bot 身份需已 `auth login`；预检门只拦 user 失效并告警。**实测 token 周期**：access token 仅约 2 小时但带 `offline_access` 自动刷新，refresh token 约 7 天且为滑动窗口——只要每周至少跑到一次就持续续期；连续 >7 天无运行才需重新登录。每日任务天然让认证保持温热，预检门只为兜住那个 >7 天的边界。
- **kiro-cli 自身登录态**不在预检门覆盖范围（门只查 lark）；它若失效会表现为每个 job FAIL 告警，可接受。
- **skill 已安装**：两个目标 skill 已在 `~/.kiro/skills/`（真实目录），`kiro-cli` 无头可按描述触发。

## 10. 验收与"测试 → 检查 → 迭代"闭环

分级验证阶梯（从零成本/零风险逐级到无人值守，每级过了再上一级）：

- **Stage 0 · 静态校验**：`dispatcher.py run <name> --dry-run` 打印拼好的完整 prompt + 命令，肉眼核对（目标群对、增量语义对、footer 在）。零 token。
- **Stage 1 · 手动单跑**：`dispatcher.py run group-digest-...` 真跑一次。核对 ①退出码 ②末尾哨兵=OK ③飞书纪要文档确实追加了当天小节 ④收到 bot 摘要私信 ⑤state.json/日志正确。端到端打通的关键一跑。
- **Stage 2 · 故障注入验告警**：临时把群名改错或断网跑一次，确认判 FAIL + 收到 bot ❌ 告警 + ALERT 兜底生效。
- **Stage 3 · 挂 cron 跑真实周期**：先把某 job 的 schedule 设成几分钟后，让 cron 自动触发一次，确认无人值守路径（flock、预检门、到点/补跑/去重判定）端到端 OK，再改回夜间时间。
- **Stage 4 · 复盘**：跑几轮后用 `dispatcher.py status` + 日志复盘：哪些稳、哪些偶发失败、token 消耗如何 → 据此迭代 prompt（让 agent 更稳）或调频率/时间。

少量单元测试（纯 stdlib `unittest`，不连网/不烧 token）：只测两个最易错的纯函数——**到点判定**（含补跑/去重/weekday/interval 边界）与**哨兵解析**。其余靠上面的端到端阶梯验证，不另搭测试框架。

迭代闭环固化：dry-run / run / status + 全量 per-run 日志 + state 历史本身就是闭环工具——发现问题 → 看日志定位 → 改 prompt 或配置 → `run` 重测 → 通过再回归生产。

## 11. 验收标准（"做完"的定义）

1. dry-run 能正确打印两个 lark 任务的完整 prompt（含自动拼接的 footer）。
2. `dispatcher.py run` 能手动跑通 group-digest 至少一次，飞书侧产物（纪要小节）+ bot 摘要私信都正确。
3. 故障注入（错群名/断网）能触发判 FAIL 并收到 bot 告警。
4. cron 心跳能自动触发一次，且正确判定到点 / 补跑 / 去重。
5. `dispatcher.py status` 能复盘运行历史。
6. 单元测试（到点判定 + 哨兵解析）全部通过。

## 12. 技术栈与依赖

- 语言：Python 3.8（标准库：`json` / `subprocess` / `datetime` / `argparse` / `fcntl`(flock) / `pathlib` / `re`(剥 ANSI + 哨兵正则) / `unittest`），无第三方依赖。
- 外部命令：`kiro-cli`（无头运行 skill）、`lark-cli`（认证预检 + bot 告警）。
- 调度：用户 crontab 一条心跳行。
- 配置/状态/日志根目录：`~/.config/skill-scheduler/`。

## 13. 实现顺序提示（地基先行）

实现计划的**第 1 步必须是 feasibility spike**：手敲一条 `kiro-cli chat --no-interactive --trust-all-tools "使用 <skill> ..."` 对一个**已 bootstrap 的目标群**真跑一次，确认无头模式能加载并跑完整个多步 skill、产物正确、哨兵正确。**先打通这条端到端链路，再写 dispatcher**——否则可能把调度器写得很完整，地基却是空的。dispatcher 控制在数百行内，避免告警降噪/重试/保留策略滚成小框架（与"代码最少"冲突）。

## 14. 验证记录（2026-06-01 实测）

**探针 1 · `lark-cli auth status`（只读）**：user（杨仔，`ou_9bcce4dcb0a97f55cb93577559be7136`）与 bot 身份均 `ready`、`tokenStatus: valid`。access token `expiresAt` ~2 小时，`refreshExpiresAt` ~7 天滑动窗口，含 `offline_access`。→ 坐实预检门必要性；日常运行可保持认证温热（见 §9）。

**探针 2 · 无头 `kiro-cli`（核心地基，已通过）**：`kiro-cli chat --no-interactive --trust-tools= "...最后一行只输出 KIRO_JOB_RESULT: OK"`，退出码 0、耗时 11s。结论：

- ✅ 模型最终文本与哨兵**均落 stdout**（哨兵可被抓到）——stdout 解析方案成立。
- ⚠️ stdout **含 ANSI 颜色码**（`KIRO_LOG_NO_COLOR=1` 只管日志文件，不管 stdout）→ 解析器须先剥 ANSI（已写入 §7）。
- 🎁 stderr 末尾打印 `Credits: <n> • Time: <s>` → 可解析为每次运行的 credit 消耗（已写入 §7/§8）。
- ✅ scratch 工作目录可行（已写入 §7）。

**探针 3 · 端到端真跑（已通过）**：对已 bootstrap 的群「LS软件开发与规划」跑 group-digest 增量（`kiro-cli chat --no-interactive --trust-all-tools`，prompt=任务+footer，scratch 工作目录）。结果：退出码 0、耗时约 1 分钟、`Credits: 2.86`；哨兵（剥 ANSI 后取最后匹配行）=`KIRO_JOB_RESULT: OK`；真实副作用全部正确——bot 私信送达、纪要文档追加当天小节、state.json 游标从 `2026-05-29 18:40:00` 推进到运行时刻。**结论：无头 kiro-cli 能加载并完整执行多步 lark skill 工作流**，整套机制（触发→执行→写副作用→哨兵→credit）端到端打通。

实测推论：单次工作流约 1 分钟，默认 `timeout_minutes: 20` 绰绰有余；bug-feedback（写 Base）路径未单独实跑，但其工具调用机制（经 `lark-cli` 写）与 group-digest 同构，风险已基本消除。实现第 1 步 spike（§13）只需在 dispatcher 实际上下文中复跑一次确认即可。
