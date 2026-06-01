# agent-skills

个人 AI Agent Skill 仓库，持续积累与维护自研 skill，形成沉淀与复利。

每个 skill 是一个目录，包含一份 `SKILL.md`（YAML frontmatter 定义触发描述 + 正文工作流）和可选的 `references/`。

## 当前 skills

| Skill | 说明 |
|-------|------|
| [lark-workflow-bug-feedback](lark-workflow-bug-feedback/) | 从指定飞书群收集 bug/产品反馈，去重维护到多维表格 + 累积日报，私信汇总 |
| [lark-workflow-group-digest](lark-workflow-group-digest/) | 从指定飞书群提取 5 类重点（决策/待办/通知/关键信息/资源），按天追加到累积「群重点纪要」文档，私信摘要 |

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
