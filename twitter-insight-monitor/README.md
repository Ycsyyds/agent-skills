# twitter-insight-monitor

把"监控 AI 大佬 Twitter/X → 逐条洞察 → 日报 → 周度蒸馏 → 三层记忆"做成可移植 skill。智能由宿主 AI 工具的内置模型完成，无需外部 LLM API。

## 安装

```bash
cp -r twitter-insight-monitor ~/.kiro/skills/      # Kiro CLI
cp -r twitter-insight-monitor ~/.claude/skills/    # Claude Code
```
重开 agent 加载。各工具共享同一 `~/.config/twitter-insight/` + `data_home`（默认 `~/.twitter-insight/`），记忆跨工具累积。

## 前置条件
- Node 22
- Chrome 远程调试登录 x.com + CDP proxy（端口 3456，用 `~/twitter-monitor/scripts/start-cdp-proxy.sh`）
- 飞书推送可选：`lark-cli` + `config.notify=true`

## 配置
`~/.config/twitter-insight/config.json`：`targets`（监控对象）、`data_home`、`notify`、`feishu`。首次运行 `store.js init` 自动生成默认 9 位 AI 大佬。

## 测试
```bash
cd scripts && node --test
```

## 已知风险
codex 是否支持同样的 SKILL.md 机制未验证；如不支持可把 SKILL.md 当指令喂入或加薄适配。
