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

function tweetId(t) {
  if (t.id) return String(t.id);
  const m = String(t.url || '').match(/status\/(\d+)/);
  return m ? m[1] : null;
}

function cmpId(a, b) {
  try { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  catch { return a < b ? -1 : a > b ? 1 : 0; }
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
  store.tweets = pruneTweets(ctx, [...byId.values()].sort((a, b) => cmpId(tweetId(b), tweetId(a))));
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
    if (maxId === null || cmpId(String(it.id), maxId) > 0) maxId = String(it.id);
  }
  writeJSON(file, store);
  const s = loadState(ctx);
  const prev = s.handles[handle] || {};
  s.handles[handle] = { last_id: maxId && (!prev.last_id || cmpId(maxId, prev.last_id) > 0) ? maxId : (prev.last_id || maxId),
    last_processed_time: new Date().toISOString() };
  saveState(ctx, s);
  return { advanced: s.handles[handle].last_id };
}

const dayOf = (time) => new Date(time).toLocaleDateString('en-CA'); // YYYY-MM-DD local

function pendingDaily(ctx) {
  const today = new Date().toLocaleDateString('en-CA');
  const s = loadState(ctx);
  const byDate = {}; // date -> handle -> {target, tweets}
  for (const target of (ctx.config.targets || [])) {
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

function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((dt - ys) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`;
}

function pendingWeekly(ctx) {
  const s = loadState(ctx);
  const curWeek = isoWeek(new Date());
  const prevLongTerm = fs.existsSync(ctx.dp.coreInsights) ? fs.readFileSync(ctx.dp.coreInsights, 'utf8') : '';
  const byWeek = {}; // week -> [{date, content}]
  if (fs.existsSync(ctx.dp.dailyDir)) {
    for (const f of fs.readdirSync(ctx.dp.dailyDir).filter(f => f.endsWith('.md'))) {
      const date = f.replace(/\.md$/, '');
      const wk = isoWeek(new Date(date));
      if (wk === curWeek) continue; // exclude current in-progress week
      (byWeek[wk] ||= []).push({ date, content: fs.readFileSync(path.join(ctx.dp.dailyDir, f), 'utf8') });
    }
  }
  const pendingWeeks = Object.keys(byWeek)
    .filter(w => !s.last_weekly_date || w > s.last_weekly_date)
    .sort();
  if (pendingWeeks.length === 0) return { ready: false, week: null, dailyReports: [], prevLongTerm, pendingWeeks: [] };
  const week = pendingWeeks[0];
  const dailyReports = byWeek[week].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return { ready: true, week, dailyReports, prevLongTerm, pendingWeeks };
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

module.exports = { makeCtx, init, cursors, migrate, loadState, saveState, readJSON, writeJSON,
  tweetId, dataFile, addTweets, saveInsights,
  pendingDaily, saveDaily,
  isoWeek, pendingWeekly, saveWeekly,
  _internal: { defaultConfig, DEFAULT_TARGETS } };
