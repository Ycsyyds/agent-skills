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
