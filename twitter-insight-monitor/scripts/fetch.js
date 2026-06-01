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
