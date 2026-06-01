---
name: lark-workflow-bug-feedback
version: 0.2.0
description: "产品 Bug 反馈收集工作流：从**指定的飞书群**抓取群消息，用大模型智能识别其中的 bug 反馈与产品意见，去重合并后维护到该群专属的多维表格（Base），在一篇累积日报文档顶部追加当天汇总，并把日报私信发给你。支持同时维护多个群（各群独立的表 / 文档 / 进度游标）。当用户说『整理今天群里的 bug』『收集 X 群的反馈』『更新 bug 反馈表 / 日报』『看看今天 X 群有哪些 bug』『汇总这几天某群的产品问题』（例如「乌班图LixelStudio体验」群），或任何需要把某飞书群里的 bug / 产品反馈沉淀到表格或文档、并持续维护的场景时，都应使用本 skill。"
metadata:
  requires:
    bins: ["lark-cli"]
---

# Bug 反馈收集工作流

把任意飞书群里零散的 bug 反馈，自动整理成该群专属的、可持续维护的多维表格 + 累积日报，并把日报私信发给你。
你（Agent）是这个流程的大脑：识别哪些是 bug、判断是不是重复、写表、写日报——这些"智能活"由你完成，机械操作交给 `lark-cli`。

**开始前必读**（用 Read 工具）：
1. [`../lark-shared/SKILL.md`](../lark-shared/SKILL.md) — 认证、权限、身份（必读）
2. 用到时再读：[`../lark-im/SKILL.md`](../lark-im/SKILL.md)（拉消息 / 发私信）、[`../lark-base/SKILL.md`](../lark-base/SKILL.md)（写表）、[`../lark-doc/SKILL.md`](../lark-doc/SKILL.md)（写日报）

## 适用场景

- "整理一下今天 X 群的 bug" / "收集乌班图体验群的反馈" / "更新 bug 表"
- "看看这两天某群反馈了哪些问题" / "把 5 月 20 到 25 号 X 群的反馈补一下"
- 任何"从某飞书群沉淀 bug / 产品意见到表格 + 日报，并定期回顾"的需求

## 前置条件

- **拉消息 / 写 Base / 写文档用 user 身份**（`--as user`）：能正确解析发言人姓名，能访问你的 Base / 文档。
- **最后私信日报用 bot 身份**（`--as bot`）：避免 `im:message.send_as_user` 这个需后台单独开通的 scope。
- 执行前确保已授权（具体 domain/scope 以 `lark-shared` 为准，遇权限报错按其流程提权）：

```bash
lark-cli auth login --domain im,base,docs,drive
```

## 状态与持久化对象

每个群有**各自独立**的一套表 / 文档 / 进度游标，统一记在一个状态文件里。

- **状态文件**：`~/.config/lark-bug-feedback/state.json`（放 `~/.config` 而非 skill 目录，避免重装 skill 被覆盖）。结构：

```json
{
  "report_to": "",
  "groups": {
    "<chat_id>": {
      "group_name": "乌班图LixelStudio体验",
      "base_token": "xxx",
      "table_id": "tblxxx",
      "doc_token": "xxx",
      "last_processed_time": "2026-05-29 23:59:59"
    }
  }
}
```

- `report_to`：日报私信接收人 open_id。留空时运行时用 `lark-cli auth status` 里的 `userOpenId`（即你自己）。
- 每个群一份 Base（字段见 [`references/table-schema.md`](references/table-schema.md)）+ 一篇累积日报文档（模板见 [`references/report-template.md`](references/report-template.md)，每天在**顶部**追加当天小节）。

## 工作流

```
确定目标群(chat_id) ─► state.groups[chat_id] 缺? ─是─► 该群首次初始化(bootstrap)
        │                                              建表 + 建日报，写回 state
        ▼ 否
确定时间范围 ─► 拉群消息 ─► 智能识别 bug ─► 查重合并写表 ─► 追加日报 ─► 私信日报给你 ─► 回写游标
```

### Step 0 · 确定目标群

- 从用户话里取群名关键词，`lark-cli im +chat-search --query "<关键词>" --as user` 解析出 `chat_id`；多个结果让用户确认。
- 用户没点名群、且 `state.groups` 里只有一个群 → 默认用它；有多个 → 让用户选。
- 读 `~/.config/lark-bug-feedback/state.json` 中 `groups[chat_id]`。若该群条目不存在 → 先 **bootstrap**（只发生一次）：
  1. `+base-create --name "「<群名>」Bug反馈"` 建 Base。新 Base 自带默认表「数据表」（含 文本/单选/日期/附件 默认字段），**复用它，别新建表**：
     - `+table-list` 取默认表 `table_id`；
     - `+field-update` 把主字段（默认「文本」）改名为 `Bug标题`（主字段不能删，只能改）；
     - 「附件」等用不上的默认字段 `+field-delete --yes`；「单选」「日期」可复用成 `类型`/`首次反馈时间`或删掉重建；
     - 按 [`references/table-schema.md`](references/table-schema.md) 顺序 `+field-create` 补齐其余字段（串行、间隔 ~0.7s）。
  2. `docs +create --api-version v2 --doc-format markdown` 建日报文档（标题「「<群名>」Bug 反馈日报」）。
  3. 把 `group_name / base_token / table_id / doc_token` 写回 `state.groups[chat_id]`（`last_processed_time` 暂空）。

### Step 1 · 确定时间范围

- **默认（增量）**：从该群的 `last_processed_time` 到现在；为空（首次）则取最近 24 小时。
- **手动指定**：用户说了"今天 / 最近 3 天 / 5月20到25日"等就按其指定。
- 日期换算调用系统 `date`，不要心算。

### Step 2 · 拉取群消息

读 [`references/lark-im-chat-messages-list.md`](../lark-im/references/lark-im-chat-messages-list.md) 确认参数，按时间范围分页拉全（`page-size` 最大 50）：

```bash
lark-cli im +chat-messages-list --chat-id <chat_id> --start <起> --end <止> --sort asc --page-size 50 --as user --format json
```

`has_more` 为真时用 `page-token` 续拉。收集每条：发言人、时间、正文、`message_id`、`reply_to`、`mentions`。

### Step 3 · 智能识别 bug / 意见

按 [`references/report-template.md`](references/report-template.md) 的判定标准挑出 bug 与产品意见，抽取结构化字段。核心：抓"产品没按预期工作"的信号，过滤闲聊 / 纯排查对话 / 内部沟通；用 `reply_to`、`mentions` 串联"+1 / 我也遇到"等确认。把握不准宁可纳入并标注待确认。

### Step 4 · 查重合并写表（核心）

"持续维护"的关键——**不要无脑追加**。

1. `+field-list` 拿真实字段，`+record-search`/`+record-list` 读出该群表里**未关闭**的已有 bug。
2. 每条新 bug 判断是否与已有某条是**同一个问题**（看现象、模块是否实质相同）：
   - **同一个**：`+record-batch-update` 更新那行——`反馈次数 +1`、追加反馈人与消息链接、刷新`最近反馈时间`；**不改`状态`/`备注`**（人工维护区）。
   - **新问题**：`+record-upsert` 新增一行，`状态`默认`待处理`，`首次/最近反馈时间`填当前。
3. 遵循 `lark-base`：先读结构再写、只写存储字段、单批 ≤200、串行写入。

### Step 5 · 追加日报

按 [`references/report-template.md`](references/report-template.md) 生成"当天小节"，用 `docs +update` 插到该群日报**顶部**（标题之后、历史小节之前），最新日期在最上。插入指令（`block_insert_after` 等）见 `lark-doc`。

### Step 6 · 私信日报 + 回写游标

1. **私信日报给你**：取接收人 open_id（`state.report_to`，为空则 `lark-cli auth status` 的 `userOpenId`），把当天小节摘要 + 日报文档链接 + Base 链接发出去。**用 `--as bot`（机器人私信你）**，因为 `--as user` 发消息需要单独的 `im:message.send_as_user` scope（要去开发者后台开通，较慢）；bot 私信只需应用自带发消息能力，最省事：

```bash
lark-cli im +messages-send --user-id <open_id> --markdown "<当天日报摘要 + 链接>" --as bot
```

（若 bot 与你无会话关系导致发送失败，再退回 `--as user` 并按 `lark-shared` 提权 `im:message.send_as_user`。）

2. **回写游标**：`last_processed_time` 更新为本次处理消息的最大时间（或"止"时间），写回 `state.groups[chat_id]`。

## 容错与边界

- **无新消息 / 无 bug**：不写表；私信里告知"今日无新增 bug 反馈"，日报可跳过或留一行。
- **断档/补跑**：靠 `last_processed_time` 自动续上，隔几天再跑也不漏。
- **重复运行同一区间**：靠 Step 4 查重合并保证幂等。
- **权限报错**：按 `lark-shared` 流程提权或降级，不要静默吞错。
- **多群**：各群状态、表、文档完全独立，互不影响。

## 实操坑点（实测）

- **`--json @file` / `--content @file` 只认当前目录下的相对路径**：长内容用文件传参时，把文件写到当前工作目录并用 `@./xxx.json`（绝对路径如 `@/tmp/x.json` 会被拒）。
- **`base` 命令默认就输出 JSON**，别加 `--format json`（会报 positional 错）；`im` 命令才用 `--format json`。
- **`+record-list` 返回 markdown 表格**（末尾 `Meta: count=N`），核对条数看 `count`，别 grep `record_id`。
- **`+record-search` 用 `--json`**（`{"keyword":"...","search_fields":["Bug标题","问题描述"]}`），不是 `--query`；查重检索时用它定位已有 bug。
- **发言人姓名**：用 `--as user` 拉消息才会解析出姓名；bot 身份常只给 open_id。

## 参考

- [lark-shared](../lark-shared/SKILL.md) — 认证、权限（必读）
- [lark-im](../lark-im/SKILL.md) — `+chat-search`、`+chat-messages-list`、`+messages-send`
- [lark-base](../lark-base/SKILL.md) — `+base-create`、`+field-*`、`+record-*`
- [lark-doc](../lark-doc/SKILL.md) — `+create`、`+update`
- [references/table-schema.md](references/table-schema.md) — Base 字段定义
- [references/report-template.md](references/report-template.md) — 日报模板 + bug 判定标准
