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
