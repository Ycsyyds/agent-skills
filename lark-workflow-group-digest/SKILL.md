---
name: lark-workflow-group-digest
version: 0.1.0
description: "飞书群重点整理工作流：从**指定的飞书群**抓取群消息，用大模型识别其中的【决策/结论、待办/行动项、重要通知、关键信息/知识、资源】5 类重点，在该群专属的累积「群重点纪要」文档**顶部**追加当天小节（时间线模式，最新在最上），并把当天重点摘要私信发给你。支持同时维护多个群（各群独立的文档 + 进度游标，默认增量续拉）。当用户说『整理今天群里的重点』『X 群最近说了啥重要的』『群消息太多了帮我抓重点』『把这几天某群的纪要补一下』『盯着这个群帮我做纪要』『看看 X 群有哪些待办/决策』，或任何需要把某飞书群里零散消息沉淀成可持续维护的重点纪要、并定期回顾的场景时，都应使用本 skill。"
metadata:
  requires:
    bins: ["lark-cli"]
---

# 群重点整理工作流

把任意飞书群里零散的消息，自动整理成该群专属的、可持续维护的「群重点纪要」累积文档，并把当天摘要私信发给你。
你（Agent）是这个流程的大脑：判断哪些是重点、归到哪一类、怎么写得简洁有用——这些"智能活"由你完成，机械操作（拉消息、写文档、发私信）交给 `lark-cli`。

**为什么需要它**：群消息太多、看着费时、容易抓不住重点、看完就忘。把每天的重点沉淀成一篇随时间增长的纪要，复利效应就出来了——以后回看一篇文档就够，不用再爬聊天记录。

**开始前必读**（用 Read 工具）：
1. [`../lark-shared/SKILL.md`](../lark-shared/SKILL.md) — 认证、权限、身份（必读）
2. 用到时再读：[`../lark-im/SKILL.md`](../lark-im/SKILL.md)（拉消息 / 发私信）、[`../lark-doc/SKILL.md`](../lark-doc/SKILL.md)（建/写纪要文档，本 skill 文档操作一律 `--api-version v2`）
3. 重点判定标准 + 当天小节模板：[`references/digest-template.md`](references/digest-template.md)（Step 3/4 必读）

## 适用场景

- "整理一下今天 X 群的重点" / "X 群最近有啥重要的" / "群消息太多帮我抓重点"
- "把 5月29 到今天 X 群的纪要补一下" / "盯着这个群，每天帮我做纪要"
- 任何"从某飞书群沉淀重点到一篇纪要、并定期回顾"的需求

## 前置条件

- **拉消息用 user 身份**（`--as user`）：能正确解析发言人姓名（bot 身份常只给 open_id）。
- **建文档 / 写文档用 user 身份**（`--as user`）：文档归属你自己，方便你打开和管理。
- **私信摘要用 bot 身份**（`--as bot`）：避免 `im:message.send_as_user`（需后台单独开通）；bot 私信只需应用自带发消息能力，最省事。
- 执行前确保已授权（domain/scope 以 `lark-shared` 为准，遇权限报错按其流程提权）：

```bash
lark-cli auth login --domain im,docs,drive
```

## 状态与持久化对象

每个群有**各自独立**的一篇纪要文档 + 进度游标，统一记在一个状态文件里。

- **状态文件**：`~/.config/lark-group-digest/state.json`（放 `~/.config` 而非 skill 目录，避免重装 skill 被覆盖）。结构：

```json
{
  "report_to": "",
  "groups": {
    "<chat_id>": {
      "group_name": "LS软件开发与规划",
      "doc_token": "doxcnxxxx",
      "anchor_block_id": "blkcnxxxx",
      "last_processed_time": "2026-05-31 23:59:59"
    }
  }
}
```

- `report_to`：私信接收人 open_id。留空时运行时用 `lark-cli auth status` 里的 `userOpenId`（即你自己）。
- `anchor_block_id`：纪要文档里那条固定"引言"块的 block_id。**每天的新小节都插入到它之后**，于是新小节永远在最上、把旧小节往下推——天然实现"时间线，最新在上"。bootstrap 时记下来，之后免去重复 fetch。

## 工作流

```
确定目标群(chat_id) ─► state.groups[chat_id] 缺? ─是─► 该群首次初始化(bootstrap)
        │                                              建纪要文档 + 记 anchor，写回 state
        ▼ 否
确定时间范围 ─► 拉群消息 ─► 智能识别 5 类重点 ─► 生成当天小节插到文档顶部 ─► 私信摘要给你 ─► 回写游标
```

### Step 0 · 确定目标群

- 从用户话里取群名关键词，`lark-cli im +chat-search --query "<关键词>" --as user --format json` 解析出 `chat_id`；多个结果让用户确认。
- 用户没点名群、且 `state.groups` 里只有一个群 → 默认用它；有多个 → 让用户选。
- 读 `~/.config/lark-group-digest/state.json` 中 `groups[chat_id]`。若该群条目不存在 → 先 **bootstrap**（只发生一次）：
  1. 建纪要文档：标题用 XML `<title>` 一步设好（v2 的 `docs +create` **没有 `--title` flag，标题必须写进 `--content`**，否则文档会是「Untitled」），body 只放一条固定引言作为锚点：

     ```bash
     lark-cli docs +create --api-version v2 --as user --doc-format xml \
       --content '<title>「<群名>」群重点纪要</title><blockquote><p>本文档由 group-digest 自动维护，按天追加，最新日期在最上方。</p></blockquote>'
     ```
     记下返回的 `document_id`（即文档 token）。
     （兜底：万一标题没设上仍是 Untitled，用 `docs +update --command str_replace --pattern "Untitled" --content "「<群名>」群重点纪要"` 改回来。）
  2. 取锚点 block_id（那条引言块）：
     ```bash
     lark-cli docs +fetch --api-version v2 --as user --doc "<doc_token>" --detail with-ids --scope outline
     ```
     取 body 里第一个块（引言）的 `id` 作为 `anchor_block_id`。
  3. 把 `group_name / doc_token / anchor_block_id` 写回 `state.groups[chat_id]`（`last_processed_time` 暂空）。

### Step 1 · 确定时间范围

- **默认（增量）**：从该群的 `last_processed_time` 到现在；为空（首次）则取最近 24 小时。
- **手动指定**：用户说了"今天 / 最近 3 天 / 5月29到今天"等就按其指定。
- 日期换算调用系统 `date`，不要心算。`im +chat-messages-list` 的 `--start/--end` 用 ISO 8601（如 `2026-05-29T00:00:00+08:00`）。

### Step 2 · 拉取群消息

按时间范围分页拉全（`--page-size` 最大 50，`--sort asc` 顺序读）：

```bash
lark-cli im +chat-messages-list --chat-id <chat_id> \
  --start <ISO起> --end <ISO止> --sort asc --page-size 50 --as user --format json
```

返回 `has_more` 为真时用 `--page-token` 续拉。收集每条：发言人、时间、正文、`message_id`、回复关系、`@提及`。

### Step 3 · 智能识别 5 类重点

按 [`references/digest-template.md`](references/digest-template.md) 的判定标准，从消息里挑出 5 类重点：🎯决策/结论、✅待办/行动项、📢重要通知、💡关键信息/知识、🔗资源。过滤闲聊/寒暄/表情接龙/与正事无关的对话。用回复关系和 `@提及` 补全上下文（"谁回应了""@谁去做"）。把握不准的，宁可纳入并标注"待确认"。

### Step 4 · 生成当天小节，插到文档顶部

按 [`references/digest-template.md`](references/digest-template.md) 的"当天小节模板"生成 markdown，插到锚点之后（即文档顶部）：

```bash
lark-cli docs +update --api-version v2 --as user --doc "<doc_token>" \
  --command block_insert_after --block-id "<anchor_block_id>" \
  --doc-format markdown --content @./section.md
```

- 多行内容用 `--content @./section.md`（写到当前工作目录，用相对路径 `@./`；绝对路径会被拒）。
- 跨度多天时：**每天一个小节**分别插入，从最旧的一天先插、最新的一天最后插——这样最后插入的（最新日）会停在最上方，时间线正确。
- 若 `anchor_block_id` 失效（插入报错/找不到块，可能文档被手动改过）：重新 fetch outline 拿 body 第一个块 id 作锚点，刷新 state。

### Step 5 · 私信摘要 + 回写游标

1. **私信摘要给你**：取接收人 open_id（`state.report_to`，为空则 `lark-cli auth status` 的 `userOpenId`），把当天摘要 + 纪要文档链接发出去。**用 `--as bot`**：

   ```bash
   lark-cli im +messages-send --user-id <open_id> --markdown "<当天摘要 + 文档链接>" --as bot
   ```
   （若 bot 与你无会话关系导致发送失败，再退回 `--as user` 并按 `lark-shared` 提权 `im:message.send_as_user`。）

2. **回写游标**：`last_processed_time` 更新为本次处理消息的最大时间（或"止"时间），写回 `state.groups[chat_id]`。

## 容错与边界

- **无新消息 / 无重点**：不写文档；私信里告知"今日无新增重点"。
- **断档/补跑**：靠 `last_processed_time` 自动续上，隔几天再跑也不漏。
- **多群**：各群状态、文档完全独立，互不影响。
- **权限报错**：按 `lark-shared` 流程提权或降级，不要静默吞错。
- **写操作前确认**：建文档 / 写文档 / 发私信均为写操作；首次对某群 bootstrap 前，向用户确认目标群无误。

## 实操坑点

- **文档命令一律带 `--api-version v2`**（本 skill 约定），用 `--command`/`--content` 而非 v1 的 `--mode`/`--markdown`。
- **`docs +create` v2 没有 `--title`，内容用 `--content`（不是 `--markdown`）**：标题写进 `--content` 的 `<title>` 标签（XML），否则文档名是「Untitled」。bootstrap 用 XML（title + 锚点）一步到位，每天的小节插入仍用 markdown。
- **`--content @file` 只认当前目录的相对路径**：长内容写到当前工作目录用 `@./section.md`（`@/tmp/x.md` 会被拒）。
- **`im` 命令才用 `--format json`**；`docs` 命令不要加。
- **发言人姓名**：用 `--as user` 拉消息才会解析出姓名。
- **时间线方向**：始终 `block_insert_after` 同一个 `anchor_block_id`；跨多天时按"旧→新"顺序逐天插入，保证最新在最上。

## 参考

- [lark-shared](../lark-shared/SKILL.md) — 认证、权限（必读）
- [lark-im](../lark-im/SKILL.md) — `+chat-search`、`+chat-messages-list`、`+messages-send`
- [lark-doc](../lark-doc/SKILL.md) — `+create`、`+fetch`、`+update`（均 `--api-version v2`）
- [references/digest-template.md](references/digest-template.md) — 重点判定标准 + 当天小节模板 + 私信模板
