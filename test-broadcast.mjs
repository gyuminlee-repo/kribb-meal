import { readFileSync } from 'fs';

const env = readFileSync(new URL('.env', import.meta.url), 'utf8');
const url = env.match(/APPS_SCRIPT_URL=(.+)/)?.[1]?.replace(/^["']|["']$/g, '').trim();
const secret = env.match(/SHARED_SECRET=(.+)/)?.[1]?.replace(/^["']|["']$/g, '').trim();

if (!url || !secret) {
  console.error('env missing: APPS_SCRIPT_URL or SHARED_SECRET');
  process.exit(1);
}

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    action: 'force_broadcast',
    secret,
    prefix: '[TEST] cron 검증 메시지 — 이 메시지는 테스트입니다',
  }),
});
console.log('Status:', res.status);
console.log('Response:', await res.text());
