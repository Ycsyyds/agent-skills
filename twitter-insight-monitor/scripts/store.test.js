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
