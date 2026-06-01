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
