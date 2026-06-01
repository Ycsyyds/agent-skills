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
