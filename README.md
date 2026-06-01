# agent-skills

个人 AI Agent Skill 仓库，持续积累与维护自研 skill，形成沉淀与复利。

每个 skill 是一个目录，包含一份 `SKILL.md`（YAML frontmatter 定义触发描述 + 正文工作流）和可选的 `references/`。

## 当前 skills

### 本仓库维护

| Skill | 说明 |
|-------|------|
| [lark-workflow-bug-feedback](lark-workflow-bug-feedback/) | 从指定飞书群收集 bug/产品反馈，去重维护到多维表格 + 累积日报，私信汇总 |
| [lark-workflow-group-digest](lark-workflow-group-digest/) | 从指定飞书群提取 5 类重点（决策/待办/通知/关键信息/资源），按天追加到累积「群重点纪要」文档，私信摘要 |
| [twitter-insight-monitor](twitter-insight-monitor/) | 监控 AI 大佬的 Twitter/X 动态，逐条提炼结构化洞察、生成每日日报、每周蒸馏长期记忆，维护三层记忆（短期推文/中期日报/长期核心观点库） |

### 调度 / 自动化工具

| 工具 | 说明 |
|------|------|
| [skill-scheduler](skill-scheduler/) | 配置驱动的本机调度器：按计划用无头 `kiro-cli` 定时、无人值守地运行上面这些 skill 工作流（含夜间），失败飞书告警。加任务只改 `jobs.json`。详见其 [README](skill-scheduler/README.md) |

### 独立仓库（单独维护，按各自 URL 安装）

| Skill | 仓库 | 说明 |
|-------|------|------|
| codebase-analysis | [codebase-analysis-skill](https://github.com/Ycsyyds/codebase-analysis-skill) | 代码库分析：生成技术文档、梳理数据流、分析算法与数据结构、理解架构 |
| content-creator | [content-creator-skill](https://github.com/Ycsyyds/content-creator-skill) | 自动化内容创作：从主题产出调研报告、视频脚本、Remotion 短视频、小红书笔记、公众号文章 |

## 安装到 AI 工具

skill 通过放入对应工具的 skills 目录生效（自包含副本）：

```bash
# Kiro CLI（全局）
cp -r <skill> ~/.kiro/skills/<skill>
# Claude
cp -r <skill> ~/.claude/skills/<skill>
```

安装后重开 agent 以加载新 skill。

## 新增 / 更新 skill

在本仓库根目录下新建 skill 目录（含 `SKILL.md`），然后：

```bash
git add <skill> && git commit -m "feat: add <skill>" && git push
```

`.gitignore` 已用黑名单方式排除第三方/克隆目录与运行时产物，新增的 skill 目录会被自动纳入版本管理。
