# twitter-insight-monitor Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repackage the existing `~/twitter-monitor` Node app into a portable, agent-invoked skill where the host AI tool's built-in model does all insight work, backed by 3 thin mechanical scripts and a shared 3-layer memory home.

**Architecture:** SKILL.md drives the flow; `fetch.js` (stateless Chrome-CDP fetch), `store.js` (sole owner of config/state + 3-layer memory I/O), `notify.js` (optional Feishu). The agent reads `references/insight-prompts.md` and produces per-tweet insights / daily reports / weekly distillation using its built-in model — no external LLM API.

**Tech Stack:** Node.js 22 (built-in `node:test`, no deps), Chrome remote debug + CDP proxy (port 3456) reused from twitter-monitor, optional `lark-cli` for Feishu.

**Spec:** `docs/superpowers/specs/2026-06-01-twitter-insight-monitor-skill-design.md`

---

## File Structure

All paths under `/home/ycs/skills/twitter-insight-monitor/`:

- `scripts/paths.js` — resolves config/state/data_home paths; single source of truth for locations.
- `scripts/store.js` — CLI: `init|config|cursors|add-tweets|save-insights|pending-daily|pending-weekly|save-daily|save-weekly`. Sole writer of `config.json`, `state.json`, and all `data_home` files.
- `scripts/fetch.js` — CLI: `--handle <h> --since-id <id>`; stateless Chrome-CDP fetch + prefilter; prints JSON.
- `scripts/notify.js` — optional Feishu push (ported from twitter-monitor `notify.js`, reads resolved config from `paths.js`).
- `scripts/store.test.js` — `node:test` unit tests for store.js pure logic.
- `references/insight-prompts.md` — 3 verbatim-ported prompts + per-tweet schema.
- `references/memory-layout.md` — memory dir spec + lifecycle.
- `SKILL.md` — frontmatter + workflow.
- `README.md` — install, prerequisites, cross-tool notes.

**Path contract (used by all scripts):**
- Control plane: `~/.config/twitter-insight/config.json` + `~/.config/twitter-insight/state.json`
- Content plane: `data_home` (from config, default `~/.twitter-insight/`) containing `data/`, `reports/daily/`, `reports/weekly/`, `memory/long-term/`, `memory/archive/`

---

## Task 1: Path resolver + project scaffold

**Files:**
- Create: `/home/ycs/skills/twitter-insight-monitor/scripts/paths.js`
- Create: `/home/ycs/skills/twitter-insight-monitor/scripts/store.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/store.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const paths = require('./paths');

test('resolves control-plane paths under a custom HOME/XDG', () => {
  const p = paths.resolve({ home: '/tmp/h', xdgConfig: '/tmp/h/.config' });
  assert.strictEqual(p.configDir, '/tmp/h/.config/twitter-insight');
  assert.strictEqual(p.configFile, '/tmp/h/.config/twitter-insight/config.json');
  assert.strictEqual(p.stateFile, '/tmp/h/.config/twitter-insight/state.json');
});

test('default data_home is ~/.twitter-insight, overridable', () => {
  const p = paths.resolve({ home: '/tmp/h' });
  assert.strictEqual(p.defaultDataHome, '/tmp/h/.twitter-insight');
  const sub = paths.dataPaths('/tmp/dh');
  assert.strictEqual(sub.dailyDir, path.join('/tmp/dh', 'reports', 'daily'));
  assert.strictEqual(sub.coreInsights, path.join('/tmp/dh', 'memory', 'long-term', 'core-insights.md'));
  assert.strictEqual(sub.archiveDir, path.join('/tmp/dh', 'memory', 'archive'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: FAIL — `Cannot find module './paths'`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/paths.js`:

```js
const os = require('node:os');
const path = require('node:path');

function resolve(opts = {}) {
  const home = opts.home || os.homedir();
  const xdgConfig = opts.xdgConfig || process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const configDir = path.join(xdgConfig, 'twitter-insight');
  return {
    home,
    configDir,
    configFile: path.join(configDir, 'config.json'),
    stateFile: path.join(configDir, 'state.json'),
    defaultDataHome: path.join(home, '.twitter-insight'),
  };
}

function dataPaths(dataHome) {
  return {
    dataHome,
    dataDir: path.join(dataHome, 'data'),
    dailyDir: path.join(dataHome, 'reports', 'daily'),
    weeklyDir: path.join(dataHome, 'reports', 'weekly'),
    longTermDir: path.join(dataHome, 'memory', 'long-term'),
    coreInsights: path.join(dataHome, 'memory', 'long-term', 'core-insights.md'),
    archiveDir: path.join(dataHome, 'memory', 'archive'),
  };
}

module.exports = { resolve, dataPaths };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/scripts/paths.js twitter-insight-monitor/scripts/store.test.js && git commit -m "feat(twitter-insight): path resolver + test scaffold"
```

---

## Task 2: store-lib core — init / config / cursors / migrate

**Files:**
- Create: `/home/ycs/skills/twitter-insight-monitor/scripts/store-lib.js`
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store.test.js`

- [ ] **Step 1: Write the failing tests** — append to `scripts/store.test.js`:

```js
const fs = require('node:fs');
const lib = require('./store-lib');

function tmpCtx() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-'));
  const p = paths.resolve({ home: root });
  return { root, ctx: lib.makeCtx({ home: root }) , p};
}

test('init creates config + dirs and reports no migration when old repo absent', () => {
  const { ctx } = tmpCtx();
  const r = lib.init(ctx);
  assert.ok(fs.existsSync(ctx.p.configFile));
  assert.ok(fs.existsSync(ctx.dp.dailyDir));
  assert.ok(fs.existsSync(ctx.dp.archiveDir));
  assert.strictEqual(r.migrationAvailable, false);
  assert.ok(Array.isArray(ctx.config.targets) && ctx.config.targets.length >= 1);
  assert.strictEqual(ctx.config.notify, false);
});

test('cursors returns empty handle map + null dates on fresh state', () => {
  const { ctx } = tmpCtx();
  lib.init(ctx);
  const c = lib.cursors(ctx);
  assert.deepStrictEqual(c.handles, {});
  assert.strictEqual(c.last_daily_date, null);
  assert.strictEqual(c.last_weekly_date, null);
});

test('migrate copies data/reports/memory from old repo', () => {
  const { ctx, root } = tmpCtx();
  lib.init(ctx);
  const old = path.join(root, 'twitter-monitor');
  fs.mkdirSync(path.join(old, 'data'), { recursive: true });
  fs.writeFileSync(path.join(old, 'data', 'karpathy.json'), '{"tweets":[]}');
  const n = lib.migrate(ctx, old);
  assert.ok(n.copied >= 1);
  assert.ok(fs.existsSync(path.join(ctx.dp.dataDir, 'karpathy.json')));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: FAIL — `Cannot find module './store-lib'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/store-lib.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');

const DEFAULT_TARGETS = [
  { handle: 'karpathy', name: 'Andrej Karpathy', url: 'https://x.com/karpathy', keywords: ['AI','LLM','neural'] },
  { handle: 'ylecun', name: 'Yann LeCun', url: 'https://x.com/ylecun', keywords: ['AI','deep learning','Meta AI'] },
  { handle: 'AndrewYNg', name: 'Andrew Ng', url: 'https://x.com/AndrewYNg', keywords: ['AI','machine learning'] },
  { handle: 'goodfellow_ian', name: 'Ian Goodfellow', url: 'https://x.com/goodfellow_ian', keywords: ['GAN','generative'] },
  { handle: 'hardmaru', name: 'David Ha', url: 'https://x.com/hardmaru', keywords: ['AI','generative','art'] },
  { handle: 'DrJimFan', name: 'Jim Fan', url: 'https://x.com/DrJimFan', keywords: ['AI','robotics','NVIDIA'] },
  { handle: 'demishassabis', name: 'Demis Hassabis', url: 'https://x.com/demishassabis', keywords: ['AI','DeepMind','AGI'] },
  { handle: 'sama', name: 'Sam Altman', url: 'https://x.com/sama', keywords: ['AI','OpenAI','AGI'] },
  { handle: 'ilyasut', name: 'Ilya Sutskever', url: 'https://x.com/ilyasut', keywords: ['AI','superintelligence','safety'] },
];

const readJSON = (f, d) => fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d;
const writeJSON = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };

function defaultConfig(dataHome) {
  return { targets: DEFAULT_TARGETS, data_home: dataHome, notify: false,
    feishu: { enabled: false, chat_id: '', webhook_url: '', use_lark_cli: true, as: 'bot' },
    storage: { tweet_history_days: 7 } };
}

function makeCtx(opts = {}) {
  const p = paths.resolve(opts);
  let config = readJSON(p.configFile, null) || defaultConfig(p.defaultDataHome);
  const dataHome = config.data_home || p.defaultDataHome;
  return { p, config, dp: paths.dataPaths(dataHome) };
}

function loadState(ctx) {
  return readJSON(ctx.p.stateFile, { handles: {}, last_daily_date: null, last_weekly_date: null, migrated: false });
}
function saveState(ctx, s) { writeJSON(ctx.p.stateFile, s); }

function ensureDirs(ctx) {
  for (const d of [ctx.dp.dataDir, ctx.dp.dailyDir, ctx.dp.weeklyDir, ctx.dp.longTermDir, ctx.dp.archiveDir])
    fs.mkdirSync(d, { recursive: true });
}

function init(ctx) {
  if (!fs.existsSync(ctx.p.configFile)) writeJSON(ctx.p.configFile, ctx.config);
  ensureDirs(ctx);
  const oldRepo = path.join(ctx.p.home, 'twitter-monitor');
  const st = loadState(ctx);
  const migrationAvailable = !st.migrated && fs.existsSync(path.join(oldRepo, 'data'));
  return { migrationAvailable, oldRepo: migrationAvailable ? oldRepo : null };
}

function cursors(ctx) {
  const s = loadState(ctx);
  return { handles: s.handles, last_daily_date: s.last_daily_date, last_weekly_date: s.last_weekly_date };
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

function migrate(ctx, oldRepo) {
  let copied = 0;
  copied += copyDir(path.join(oldRepo, 'data'), ctx.dp.dataDir);
  copied += copyDir(path.join(oldRepo, 'reports', 'daily'), ctx.dp.dailyDir);
  copied += copyDir(path.join(oldRepo, 'reports', 'weekly'), ctx.dp.weeklyDir);
  copied += copyDir(path.join(oldRepo, 'memory', 'long-term'), ctx.dp.longTermDir);
  copied += copyDir(path.join(oldRepo, 'memory', 'archive'), ctx.dp.archiveDir);
  const s = loadState(ctx); s.migrated = true; saveState(ctx, s);
  return { copied };
}

module.exports = { makeCtx, init, cursors, migrate, loadState, saveState, readJSON, writeJSON,
  _internal: { defaultConfig, DEFAULT_TARGETS } };
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: PASS (all tests incl. Task 1).

- [ ] **Step 5: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/scripts/store-lib.js twitter-insight-monitor/scripts/store.test.js && git commit -m "feat(twitter-insight): store-lib init/config/cursors/migrate"
```

---

## Task 3: store-lib — add-tweets / save-insights (short-term memory + cursor)

**Files:**
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store-lib.js`
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store.test.js`

- [ ] **Step 1: Write the failing tests** — append to `scripts/store.test.js`:

```js
test('addTweets dedups by id and returns pending ids excluding prefilter_skip', () => {
  const { ctx } = tmpCtx(); lib.init(ctx);
  const tweets = [
    { id: '100', text: 'a real insightful tweet about LLMs scaling', url: 'https://x.com/k/status/100', time: new Date().toISOString() },
    { id: '101', text: 'gm', url: 'https://x.com/k/status/101', time: new Date().toISOString(), prefilter_skip: true },
    { id: '100', text: 'dup', url: 'https://x.com/k/status/100', time: new Date().toISOString() },
  ];
  const r = lib.addTweets(ctx, 'karpathy', tweets);
  assert.deepStrictEqual(r.pending, ['100']);
  const stored = lib.readJSON(path.join(ctx.dp.dataDir, 'karpathy.json'), null);
  assert.strictEqual(stored.tweets.length, 2);
});

test('saveInsights attaches insight and advances handle cursor to max id', () => {
  const { ctx } = tmpCtx(); lib.init(ctx);
  lib.addTweets(ctx, 'karpathy', [{ id: '100', text: 'xxxxxxxxxxxxxxxxxxx', url: 'https://x.com/k/status/100', time: new Date().toISOString() }]);
  lib.saveInsights(ctx, 'karpathy', [{ id: '100', insight: { one_liner: 'oo', novelty: 7, skip: false } }]);
  const stored = lib.readJSON(path.join(ctx.dp.dataDir, 'karpathy.json'), null);
  assert.strictEqual(stored.tweets[0].llm_insight.novelty, 7);
  assert.strictEqual(lib.cursors(ctx).handles.karpathy.last_id, '100');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: FAIL — `lib.addTweets is not a function`.

- [ ] **Step 3: Write minimal implementation** — add to `scripts/store-lib.js` (before `module.exports`):

```js
function tweetId(t) {
  if (t.id) return String(t.id);
  const m = String(t.url || '').match(/status\/(\d+)/);
  return m ? m[1] : null;
}

function dataFile(ctx, handle) { return path.join(ctx.dp.dataDir, `${handle}.json`); }

function pruneTweets(ctx, tweets) {
  const days = (ctx.config.storage && ctx.config.storage.tweet_history_days) || 7;
  const cut7 = Date.now() - days * 86400000;
  const cut14 = Date.now() - 14 * 86400000;
  return tweets.filter(t => {
    if (!t.time) return true;
    const ts = new Date(t.time).getTime();
    return t.llm_insight ? ts > cut14 : ts > cut7;
  });
}

function addTweets(ctx, handle, incoming) {
  const file = dataFile(ctx, handle);
  const store = readJSON(file, { tweets: [], lastChecked: null });
  const byId = new Map(store.tweets.map(t => [tweetId(t), t]));
  const pending = [];
  for (const t of incoming) {
    const id = tweetId(t); if (!id) continue;
    if (!byId.has(id)) { t.id = id; byId.set(id, t); }
    const cur = byId.get(id);
    if (!cur.llm_insight && !cur.prefilter_skip && !pending.includes(id)) pending.push(id);
  }
  store.tweets = pruneTweets(ctx, [...byId.values()].sort((a, b) => (tweetId(b) > tweetId(a) ? 1 : -1)));
  store.lastChecked = new Date().toISOString();
  writeJSON(file, store);
  return { pending };
}

function saveInsights(ctx, handle, items) {
  const file = dataFile(ctx, handle);
  const store = readJSON(file, { tweets: [] });
  const byId = new Map(store.tweets.map(t => [tweetId(t), t]));
  let maxId = null;
  for (const it of items) {
    const t = byId.get(String(it.id)); if (!t) continue;
    t.llm_insight = it.insight;
    if (maxId === null || String(it.id) > maxId) maxId = String(it.id);
  }
  writeJSON(file, store);
  const s = loadState(ctx);
  const prev = s.handles[handle] || {};
  s.handles[handle] = { last_id: maxId && (!prev.last_id || maxId > prev.last_id) ? maxId : (prev.last_id || maxId),
    last_processed_time: new Date().toISOString() };
  saveState(ctx, s);
  return { advanced: s.handles[handle].last_id };
}
```

Add `tweetId, dataFile, addTweets, saveInsights` to `module.exports`.

- [ ] **Step 4: Run to verify pass**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/scripts/store-lib.js twitter-insight-monitor/scripts/store.test.js && git commit -m "feat(twitter-insight): add-tweets + save-insights with cursor advance"
```

---

## Task 4: store-lib — pending-daily / save-daily (mid-term memory)

**Files:**
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store-lib.js`
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store.test.js`

- [ ] **Step 1: Write the failing tests** — append to `scripts/store.test.js`:

```js
test('pendingDaily returns today as a ready date with grouped tweets', () => {
  const { ctx } = tmpCtx(); lib.init(ctx);
  const today = new Date().toLocaleDateString('en-CA');
  lib.addTweets(ctx, 'karpathy', [{ id: '200', text: 'a tweet long enough to matter', url: 'https://x.com/k/status/200', time: new Date().toISOString() }]);
  const r = lib.pendingDaily(ctx);
  const day = r.dates.find(d => d.date === today);
  assert.ok(day, 'today should be ready');
  assert.strictEqual(day.groups[0].target.handle, 'karpathy');
  assert.strictEqual(day.groups[0].tweets.length, 1);
});

test('saveDaily writes report file and advances last_daily_date only for past dates', () => {
  const { ctx } = tmpCtx(); lib.init(ctx);
  lib.saveDaily(ctx, '2026-05-30', '# report');
  assert.ok(fs.existsSync(path.join(ctx.dp.dailyDir, '2026-05-30.md')));
  assert.strictEqual(lib.cursors(ctx).last_daily_date, '2026-05-30');
  const today = new Date().toLocaleDateString('en-CA');
  lib.saveDaily(ctx, today, '# today');
  assert.strictEqual(lib.cursors(ctx).last_daily_date, '2026-05-30');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: FAIL — `lib.pendingDaily is not a function`.

- [ ] **Step 3: Write minimal implementation** — add to `scripts/store-lib.js`:

```js
const dayOf = (time) => new Date(time).toLocaleDateString('en-CA'); // YYYY-MM-DD local

function pendingDaily(ctx) {
  const today = new Date().toLocaleDateString('en-CA');
  const s = loadState(ctx);
  const byDate = {}; // date -> handle -> {target, tweets}
  for (const target of ctx.config.targets) {
    const store = readJSON(dataFile(ctx, target.handle), { tweets: [] });
    for (const t of store.tweets) {
      if (!t.time) continue;
      const d = dayOf(t.time);
      const ready = d === today || !fs.existsSync(path.join(ctx.dp.dailyDir, `${d}.md`));
      if (!ready) continue;
      if (s.last_daily_date && d < s.last_daily_date) continue;
      ((byDate[d] ||= {})[target.handle] ||= { target, tweets: [] }).tweets.push(t);
    }
  }
  const dates = Object.keys(byDate).sort().map(date => ({ date, groups: Object.values(byDate[date]) }));
  return { today, dates };
}

function saveDaily(ctx, date, markdown) {
  fs.mkdirSync(ctx.dp.dailyDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.dp.dailyDir, `${date}.md`), markdown);
  const today = new Date().toLocaleDateString('en-CA');
  if (date < today) {
    const s = loadState(ctx);
    if (!s.last_daily_date || date > s.last_daily_date) { s.last_daily_date = date; saveState(ctx, s); }
  }
  return { written: `${date}.md` };
}
```

Add `pendingDaily, saveDaily` to `module.exports`.

- [ ] **Step 4: Run to verify pass**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/scripts/store-lib.js twitter-insight-monitor/scripts/store.test.js && git commit -m "feat(twitter-insight): pending-daily + save-daily"
```

---

## Task 5: store-lib — pending-weekly / save-weekly (long-term memory + archive)

**Files:**
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store-lib.js`
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store.test.js`

- [ ] **Step 1: Write the failing tests** — append to `scripts/store.test.js`:

```js
test('pendingWeekly is ready when daily reports exist and week not yet distilled', () => {
  const { ctx } = tmpCtx(); lib.init(ctx);
  const today = new Date().toLocaleDateString('en-CA');
  lib.saveDaily(ctx, today, '# today report');
  const r = lib.pendingWeekly(ctx);
  assert.strictEqual(r.ready, true);
  assert.match(r.week, /^\d{4}-W\d{2}$/);
  assert.ok(r.dailyReports.length >= 1);
});

test('saveWeekly writes snapshot, archives old core, rewrites core, sets cursor', () => {
  const { ctx } = tmpCtx(); lib.init(ctx);
  fs.writeFileSync(ctx.dp.coreInsights, '# OLD CORE');
  lib.saveWeekly(ctx, '2026-W22', '# NEW CORE');
  assert.ok(fs.existsSync(path.join(ctx.dp.weeklyDir, '2026-W22.md')));
  assert.strictEqual(fs.readFileSync(ctx.dp.coreInsights, 'utf8'), '# NEW CORE');
  assert.ok(fs.readdirSync(ctx.dp.archiveDir).some(f => f.startsWith('core-insights-')));
  assert.strictEqual(lib.cursors(ctx).last_weekly_date, '2026-W22');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: FAIL — `lib.pendingWeekly is not a function`.

- [ ] **Step 3: Write minimal implementation** — add to `scripts/store-lib.js`:

```js
function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((dt - ys) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

function pendingWeekly(ctx) {
  const week = isoWeek(new Date());
  const s = loadState(ctx);
  const cut = Date.now() - 7 * 86400000;
  const dailyReports = [];
  if (fs.existsSync(ctx.dp.dailyDir)) {
    for (const f of fs.readdirSync(ctx.dp.dailyDir).filter(f => f.endsWith('.md')).sort()) {
      const date = f.replace(/\.md$/, '');
      if (new Date(date).getTime() >= cut) dailyReports.push({ date, content: fs.readFileSync(path.join(ctx.dp.dailyDir, f), 'utf8') });
    }
  }
  const prevLongTerm = fs.existsSync(ctx.dp.coreInsights) ? fs.readFileSync(ctx.dp.coreInsights, 'utf8') : '';
  const ready = dailyReports.length > 0 && s.last_weekly_date !== week;
  return { ready, week, dailyReports, prevLongTerm };
}

function saveWeekly(ctx, week, markdown) {
  fs.mkdirSync(ctx.dp.weeklyDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.dp.weeklyDir, `${week}.md`), markdown);
  if (fs.existsSync(ctx.dp.coreInsights)) {
    fs.mkdirSync(ctx.dp.archiveDir, { recursive: true });
    const stamp = new Date().toLocaleDateString('en-CA');
    fs.copyFileSync(ctx.dp.coreInsights, path.join(ctx.dp.archiveDir, `core-insights-${stamp}.md`));
  }
  fs.mkdirSync(ctx.dp.longTermDir, { recursive: true });
  fs.writeFileSync(ctx.dp.coreInsights, markdown);
  const s = loadState(ctx); s.last_weekly_date = week; saveState(ctx, s);
  return { snapshot: `${week}.md` };
}
```

Add `isoWeek, pendingWeekly, saveWeekly` to `module.exports`.

- [ ] **Step 4: Run to verify pass**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/scripts/store-lib.js twitter-insight-monitor/scripts/store.test.js && git commit -m "feat(twitter-insight): pending-weekly + save-weekly (archive + snapshot)"
```

---

## Task 6: store.js CLI dispatcher (stdin/stdout JSON)

**Files:**
- Create: `/home/ycs/skills/twitter-insight-monitor/scripts/store.js`
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store.test.js`

- [ ] **Step 1: Write the failing test** — append to `scripts/store.test.js`:

```js
const { execFileSync } = require('node:child_process');

test('store.js CLI: init then cursors via subprocess', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-cli-'));
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, '.config') };
  const cli = path.join(__dirname, 'store.js');
  execFileSync('node', [cli, 'init'], { env });
  const out = execFileSync('node', [cli, 'cursors'], { env }).toString();
  const c = JSON.parse(out);
  assert.deepStrictEqual(c.handles, {});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: FAIL — `Cannot find module .../store.js`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/store.js`:

```js
#!/usr/bin/env node
const fs = require('node:fs');
const lib = require('./store-lib');

function flags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) f[argv[i].slice(2)] = argv[i + 1];
  return f;
}
function stdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }
function out(o) { process.stdout.write(JSON.stringify(o, null, 2) + '\n'); }

const cmd = process.argv[2];
const f = flags(process.argv.slice(3));
const ctx = lib.makeCtx();

switch (cmd) {
  case 'init': out(lib.init(ctx)); break;
  case 'migrate': out(lib.migrate(ctx, f.from)); break;
  case 'config': out(ctx.config); break;
  case 'cursors': out(lib.cursors(ctx)); break;
  case 'add-tweets': out(lib.addTweets(ctx, f.handle, JSON.parse(stdin()))); break;
  case 'save-insights': out(lib.saveInsights(ctx, f.handle, JSON.parse(stdin()))); break;
  case 'pending-daily': out(lib.pendingDaily(ctx)); break;
  case 'pending-weekly': out(lib.pendingWeekly(ctx)); break;
  case 'save-daily': out(lib.saveDaily(ctx, f.date, stdin())); break;
  case 'save-weekly': out(lib.saveWeekly(ctx, f.week, stdin())); break;
  default:
    process.stderr.write(`unknown command: ${cmd}\n`);
    process.exit(1);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/scripts/store.js twitter-insight-monitor/scripts/store.test.js && git commit -m "feat(twitter-insight): store.js CLI dispatcher"
```

---

## Task 7: fetch.js — stateless Chrome-CDP fetch (ported from monitor.js)

**Files:**
- Create: `/home/ycs/skills/twitter-insight-monitor/scripts/fetch.js`
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store.test.js`

The DOM extraction script and CDP proxy calls are ported verbatim from `~/twitter-monitor/scripts/monitor.js`. New: derive `id` from the status URL, apply prefilter (`<15` chars after URL-strip), and `--since-id` filtering. No state writes; reads only `config.targets` for the handle's URL.

- [ ] **Step 1: Write the failing test** — append to `scripts/store.test.js` (pure helpers only; Chrome not required):

```js
const fetchmod = require('./fetch');

test('fetch helpers: idFromUrl + prefilter', () => {
  assert.strictEqual(fetchmod.idFromUrl('https://x.com/k/status/12345'), '12345');
  assert.strictEqual(fetchmod.prefilterSkip('https://t.co/abc'), true);   // empty after strip
  assert.strictEqual(fetchmod.prefilterSkip('gm'), true);                 // <15 chars
  assert.strictEqual(fetchmod.prefilterSkip('a genuinely long enough tweet body'), false);
});

test('fetch helper: filterSince keeps only newer ids', () => {
  const tw = [{ id: '100' }, { id: '101' }, { id: '99' }];
  assert.deepStrictEqual(fetchmod.filterSince(tw, '100').map(t => t.id), ['101']);
  assert.deepStrictEqual(fetchmod.filterSince(tw, null).map(t => t.id), ['100','101','99']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: FAIL — `Cannot find module './fetch'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/fetch.js`:

```js
#!/usr/bin/env node
const http = require('node:http');
const lib = require('./store-lib');

const PROXY_HOST = 'localhost', PROXY_PORT = 3456;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function proxyRequest(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request(`http://${PROXY_HOST}:${PROXY_PORT}${endpoint}`, {
      method, headers: bodyStr ? { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(bodyStr) } : {}
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const idFromUrl = (url) => { const m = String(url || '').match(/status\/(\d+)/); return m ? m[1] : null; };
const prefilterSkip = (text) => String(text || '').replace(/https?:\/\/\S+/g, '').trim().length < 15;
function filterSince(tweets, sinceId) {
  if (!sinceId) return tweets;
  return tweets.filter(t => { try { return BigInt(t.id) > BigInt(sinceId); } catch { return true; } });
}

async function extractTweets(targetId, maxTweets) {
  const script = `
    (function() {
      const tweets = [];
      const els = document.querySelectorAll('[data-testid="tweet"]');
      for (let i = 0; i < Math.min(${maxTweets}, els.length); i++) {
        const el = els[i];
        const textEl = el.querySelector('[data-testid="tweetText"]');
        const text = textEl ? textEl.innerText.trim() : '';
        const timeEl = el.querySelector('time');
        const time = timeEl ? timeEl.getAttribute('datetime') : '';
        const linkEl = el.querySelector('a[href*="/status/"]');
        const url = linkEl ? linkEl.href : '';
        const get = id => { const e = el.querySelector('[data-testid="'+id+'"]'); return e ? (e.textContent||'0') : '0'; };
        function parse(s){const m=s.match(/([\\.\\d]+)([KMB]?)/);if(!m)return 0;const n=parseFloat(m[1]),x=m[2];return Math.round(x==='K'?n*1e3:x==='M'?n*1e6:x==='B'?n*1e9:n);}
        if (text && url) tweets.push({ text: text.substring(0,500), time, url, engagement: { likes: parse(get('like')), retweets: parse(get('retweet')), replies: parse(get('reply')) }});
      }
      return JSON.stringify(tweets);
    })()
  `;
  const result = await proxyRequest(`/eval?target=${targetId}`, 'POST', script);
  const raw = JSON.parse(result.value);
  const seen = new Set();
  return raw.filter(t => { if (seen.has(t.url)) return false; seen.add(t.url); return true; });
}

async function fetchHandle(target, sinceId, maxTweets) {
  let targetId = null;
  try {
    targetId = (await proxyRequest(`/new?url=${encodeURIComponent(target.url)}`)).targetId;
    await sleep(3000);
    const login = await proxyRequest(`/eval?target=${targetId}`, 'POST',
      'document.querySelector("[data-testid=\\"SideNav_AccountSwitcher_Button\\"]") !== null ? "ok" : "no"');
    if (login.value !== 'ok' && login.value !== true) { await proxyRequest(`/close?target=${targetId}`); throw new Error('not logged in'); }
    for (let i = 0; i < 3; i++) { await proxyRequest(`/scroll?target=${targetId}&direction=bottom`); await sleep(1500); }
    let tweets = await extractTweets(targetId, maxTweets);
    await proxyRequest(`/close?target=${targetId}`);
    tweets = tweets.map(t => ({ ...t, id: idFromUrl(t.url), prefilter_skip: prefilterSkip(t.text) })).filter(t => t.id);
    return filterSince(tweets, sinceId);
  } catch (e) {
    if (targetId) try { await proxyRequest(`/close?target=${targetId}`); } catch {}
    throw e;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const f = {}; for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) f[argv[i].slice(2)] = argv[i + 1];
  const ctx = lib.makeCtx();
  const target = (ctx.config.targets || []).find(t => t.handle === f.handle);
  if (!target) { process.stderr.write(`unknown handle: ${f.handle}\n`); process.exit(1); }
  const maxTweets = (ctx.config.monitoring && ctx.config.monitoring.max_tweets_per_check) || 20;
  const tweets = await fetchHandle(target, f['since-id'] || null, maxTweets);
  process.stdout.write(JSON.stringify({ handle: target.handle, tweets, fetched_at: new Date().toISOString() }, null, 2) + '\n');
}

if (require.main === module) main().catch(e => { process.stderr.write(`fetch error: ${e.message}\n`); process.exit(2); });
else module.exports = { idFromUrl, prefilterSkip, filterSince, fetchHandle };
```

- [ ] **Step 4: Run unit tests to verify pass**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: PASS (helpers tested without Chrome).

- [ ] **Step 5: Manual smoke (requires Chrome + CDP proxy)**

Run (with `~/twitter-monitor/scripts/start-cdp-proxy.sh` running and Chrome logged into x.com):
```bash
node ~/.../twitter-insight-monitor/scripts/store.js init
node ~/.../twitter-insight-monitor/scripts/fetch.js --handle karpathy
```
Expected: JSON `{ handle:"karpathy", tweets:[...] }` printed; each tweet has `id`, `prefilter_skip`. If proxy down: exits non-zero with `fetch error:` — acceptable, documents the prerequisite.

- [ ] **Step 6: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/scripts/fetch.js twitter-insight-monitor/scripts/store.test.js && git commit -m "feat(twitter-insight): stateless Chrome-CDP fetch.js"
```

---

## Task 8: notify.js — optional Feishu push (ported from twitter-monitor)

**Files:**
- Create: `/home/ycs/skills/twitter-insight-monitor/scripts/notify.js`
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store.test.js`

Ported from `~/twitter-monitor/scripts/notify.js`. Change: config comes from `store-lib.makeCtx()` (not repo `config.json`); gated by `config.notify`. Reads the message from stdin.

- [ ] **Step 1: Write the failing test** — append to `scripts/store.test.js`:

```js
const notify = require('./notify');

test('notify.send returns false when notify disabled (no send attempted)', async () => {
  const ctx = { config: { notify: false, feishu: { enabled: false } } };
  const ok = await notify.send('hello', 'title', ctx);
  assert.strictEqual(ok, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: FAIL — `Cannot find module './notify'`.

- [ ] **Step 3: Write minimal implementation** — create `scripts/notify.js`:

```js
#!/usr/bin/env node
const { execSync } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const lib = require('./store-lib');

function sendViaLarkCli(chatId, text, identity) {
  const escaped = text.replace(/'/g, "'\\''");
  execSync(`lark-cli im +messages-send --chat-id ${chatId} --as ${identity} --markdown $'${escaped.replace(/\n/g, '\\n')}'`, { timeout: 30000, stdio: 'pipe' });
}

function sendViaWebhook(webhookUrl, title, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ msg_type: 'post', content: { post: { zh_cn: { title, content: [[{ tag: 'text', text }]] } } } });
    const url = new URL(webhookUrl);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function send(text, title = 'Twitter AI 监控', ctx = lib.makeCtx()) {
  const feishu = ctx.config.feishu;
  if (!ctx.config.notify || !feishu || !feishu.enabled) { console.log('[notify] 未启用'); return false; }
  if (feishu.use_lark_cli && feishu.chat_id) {
    try { sendViaLarkCli(feishu.chat_id, text, feishu.as || 'bot'); return true; } catch (e) { console.error('[notify] lark-cli 失败:', e.message); }
  }
  if (feishu.webhook_url) {
    try { await sendViaWebhook(feishu.webhook_url, title, text); return true; } catch (e) { console.error('[notify] webhook 失败:', e.message); }
  }
  return false;
}

module.exports = { send };

if (require.main === module) {
  const text = fs.readFileSync(0, 'utf8');
  send(text).then(ok => process.exit(ok ? 0 : 1));
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/scripts/notify.js twitter-insight-monitor/scripts/store.test.js && git commit -m "feat(twitter-insight): optional Feishu notify.js"
```

---

## Task 9: references — insight-prompts.md + memory-layout.md

**Files:**
- Create: `/home/ycs/skills/twitter-insight-monitor/references/insight-prompts.md`
- Create: `/home/ycs/skills/twitter-insight-monitor/references/memory-layout.md`

No tests (docs). Prompts are ported verbatim from `~/twitter-monitor/scripts/insights.js` (`TWEET_INSIGHT_SYSTEM`, `DAILY_AGGREGATE_SYSTEM`, `WEEKLY_DISTILL_SYSTEM`).

- [ ] **Step 1: Create `references/insight-prompts.md`** with this content:

````markdown
# Insight Prompts（agent 用内置模型执行）

这些是 agent 的工作指令。逐条洞察可一次批处理整批新推，输出 JSON 数组。

## 1. 单条推文洞察 → JSON

> 你是一位资深的 AI 行业分析师，擅长从大佬的 X/Twitter 推文中快速提炼信号。把一条原始推文转成结构化洞察 JSON。
>
> - one_liner：一句话说清这条推文在说什么（≤40 字，中文，不复述原文，要"提炼"核心论点）
> - why_matters：为什么值得 AI 从业者关注？信号意味着什么？（≤80 字）；若只是空话/感慨/吃瓜/广告/纯个人生活，写 "无明确行业信号"
> - tags：1-4 个主题标签，#xxx 格式
> - type：announcement(发布/公告/新论文) | insight(新观点/深度分析) | opinion(表态/评论/争论) | research(研究进展/技术细节) | personal(个人动态/玩梗/无关) | other
> - novelty：0-10，相对此人长期立场与行业共识的"新"程度（0-2 老生常谈/转发；3-5 略有变化；6-8 明显新观点/发布/立场转变；9-10 重大信号）
> - skip：bool，true=不值得展示（纯个人/广告/吃瓜/纯转发无评论）
> - skip_reason：skip=true 时简述原因（≤20 字）

**输出 schema（每条一个对象，附 `id`）：**
```json
{"id":"<tweet id>","one_liner":"...","why_matters":"...","tags":["#x"],"type":"insight","novelty":7,"skip":false,"skip_reason":""}
```
（`fetch.js` 已对清洗后 <15 字符的推文标 `prefilter_skip`，这些不会进入待洞察列表。）

## 2. 日报聚合 → Markdown

> 你是一位资深 AI 行业分析师，为订阅者撰写「AI 大佬动态日报」。输入是当天大佬们的推文及每条已抽取的洞察。输出高信息密度、可读性强的中文 Markdown 日报。必须包含五个二级标题（缺数据则跳过对应章节）：
>
> ## 🎯 今日核心信号
> 跨人物提炼 3-5 条最值得关注的信号，每条 1-2 句并标 (来源: @handle)。重点是"这意味着什么"，两人观点互补/冲突/共振必须点出。
> ## 📈 主题热度
> 当天讨论度最高的 3-5 个主题，每个列关键人物及立场（一行）。
> ## ⚖️ 立场分歧 / 共识
> 多人就同一议题表态时单独列出；无则整段省略。
> ## 👁 持续追踪信号
> 当下不确定但值得后续观察的信号、悬念、模糊表态。
> ## 👥 各人物动态
> 按人物分组，每人 1-3 条最重要推文：`- **<one_liner>** — <why_matters 摘要> [novelty:N] [→](原文链接)`
>
> 要求：全中文、第三人称客观、不标题党、不客套、800-1500 字，只输出 Markdown。

## 3. 周度蒸馏 → 重写 core-insights.md

> 你是一位资深 AI 行业分析师，维护一份「AI 行业核心观点库」(core-insights.md)，即用户的"长期记忆/第二大脑"。输入：① 过去 7 天日报；② 上一版 core-insights.md（可能为空）。输出：完整重写后的 core-insights.md，结构（缺数据则跳过）：
>
> # AI 行业核心观点库
> *最后更新：YYYY-MM-DD*
> ## ⭐ 本周新出现的观点 — 本周首次出现且有深度的观点，标 (谁, 何时)。
> ## 🔼 被强化的观点 — 本周有新证据的旧观点，说明"如何被强化"。
> ## 🔽 被削弱 / 被反驳的观点 — 本周挑战之前判断的信号，说明"如何被挑战"。⚠️ 这一节非常重要，避免回音室。
> ## 📊 长期趋势线 — 跨周/跨月累积趋势（延续上一版）。
> ## 👀 持续追踪信号 — 还无定论的信号、悬念。
> ## 👥 关键人物画像 — 每个有显著动态的大佬一段简短画像。
>
> 要求：全中文、第三人称客观、信息密度高、引用标 @handle、1500-3000 字；**不保留过期或已被反驳的旧观点（这是"蒸馏"不是"累加"）**；用户在文档里用 `>` 引用块写的批注作为输入保留。只输出 Markdown。
````

- [ ] **Step 2: Create `references/memory-layout.md`** with this content:

````markdown
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
````

- [ ] **Step 3: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/references && git commit -m "docs(twitter-insight): port insight prompts + memory layout references"
```

---

## Task 10: SKILL.md + README.md

**Files:**
- Create: `/home/ycs/skills/twitter-insight-monitor/SKILL.md`
- Create: `/home/ycs/skills/twitter-insight-monitor/README.md`

- [ ] **Step 1: Create `SKILL.md`** with this content:

````markdown
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
````

- [ ] **Step 2: Create `README.md`** with this content:

````markdown
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
````

- [ ] **Step 3: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/SKILL.md twitter-insight-monitor/README.md && git commit -m "docs(twitter-insight): SKILL.md workflow + README"
```

---

## Task 11: end-to-end pipeline smoke test (no Chrome, no agent)

**Files:**
- Modify: `/home/ycs/skills/twitter-insight-monitor/scripts/store.test.js`

- [ ] **Step 1: Write the test** — append to `scripts/store.test.js`:

```js
test('end-to-end: init → add-tweets → save-insights → daily → weekly', () => {
  const { ctx } = tmpCtx(); lib.init(ctx);
  const now = new Date().toISOString();
  const r1 = lib.addTweets(ctx, 'karpathy', [{ id: '300', text: 'a substantive tweet about model scaling laws', url: 'https://x.com/k/status/300', time: now }]);
  assert.deepStrictEqual(r1.pending, ['300']);
  lib.saveInsights(ctx, 'karpathy', [{ id: '300', insight: { one_liner: 'scaling', novelty: 8, skip: false } }]);

  const pd = lib.pendingDaily(ctx);
  const today = new Date().toLocaleDateString('en-CA');
  assert.ok(pd.dates.some(d => d.date === today));
  lib.saveDaily(ctx, today, '# daily\n核心信号');
  assert.ok(fs.existsSync(path.join(ctx.dp.dailyDir, `${today}.md`)));

  const pw = lib.pendingWeekly(ctx);
  assert.strictEqual(pw.ready, true);
  lib.saveWeekly(ctx, pw.week, '# core insights v1');
  assert.strictEqual(fs.readFileSync(ctx.dp.coreInsights, 'utf8'), '# core insights v1');
  assert.strictEqual(lib.cursors(ctx).last_weekly_date, pw.week);
});
```

- [ ] **Step 2: Run the full suite**

Run: `cd /home/ycs/skills/twitter-insight-monitor && node --test`
Expected: PASS — all tests across Tasks 1-11.

- [ ] **Step 3: Commit**

```bash
cd /home/ycs/skills && git add twitter-insight-monitor/scripts/store.test.js && git commit -m "test(twitter-insight): end-to-end store pipeline smoke"
```

---

## Plan Self-Review

- **Spec coverage:**
  - §2 dir layout → Tasks 1, 2 (paths.js, init/dirs). ✓
  - §3 fetch.js → Task 7; store.js subcommands → Tasks 2-6; notify.js → Task 8. ✓
  - §4 agent prompts + schema → Task 9 references; workflow wiring → Task 10 SKILL.md. ✓
  - §5 state/cursors/triggers/lifecycle → Tasks 3 (cursor), 4 (daily trigger), 5 (weekly trigger + archive). ✓
  - §6 SKILL.md/errors/testing/install → Tasks 10 (SKILL/README), 11 (e2e), per-task tests. ✓
  - §5 migration → Task 2 (`migrate`) + Task 10 Step 0 confirm gate. ✓
- **Placeholder scan:** no TBD/TODO; every code step shows full code. ✓
- **Type consistency:** `tweetId`/`idFromUrl` both parse `status/(\d+)`; `llm_insight` field consistent across add/save/daily; `last_id`/`last_daily_date`/`last_weekly_date` consistent across store-lib, store.js, SKILL.md; `makeCtx`/`dataPaths` names match across tasks. ✓
- **Note:** `fetch.js` live fetch (Task 7 Step 5) and the agent intelligence steps (SKILL.md Steps 3-5) are not unit-tested (require Chrome / a live model); covered by manual smoke + the no-Chrome e2e pipeline test (Task 11). This is expected for this skill's boundaries.
