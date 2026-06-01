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

const notify = require('./notify');

test('notify.send returns false when notify disabled (no send attempted)', async () => {
  const ctx = { config: { notify: false, feishu: { enabled: false } } };
  const ok = await notify.send('hello', 'title', ctx);
  assert.strictEqual(ok, false);
});

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
