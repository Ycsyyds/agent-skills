# 记忆布局与生命周期

控制面 `~/.config/twitter-insight/`：`config.json`（用户编辑）+ `state.json`（脚本管理）。
内容面 `data_home`（默认 `~/.twitter-insight/`）：

```
data/{handle}.json            短期：原始推文 + llm_insight（insighted 保留 14 天，否则 7 天）
reports/daily/YYYY-MM-DD.md   中期：日报，永久
reports/weekly/YYYY-Www.md    周度不可变快照
memory/long-term/core-insights.md   长期：活文档，周度整篇重写
memory/archive/core-insights-*.md   长期记忆历史归档
```

生命周期：`add-tweets` 每次按时效剪枝短期；`save-daily` 写中期；`save-weekly` 归档旧 core → 重写 core → 写周快照。游标：`state.handles[h].last_id`、`last_daily_date`、`last_weekly_date`。
