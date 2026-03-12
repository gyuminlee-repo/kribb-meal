/**
 * KRIBB 식단 크롤러 → Google Apps Script 웹훅 전송
 *
 * 기능:
 *   - 매일 08:30 (평일) 식단 크롤링 → Apps Script로 전송 → 텔레그램 자동 브로드캐스트
 *   - CLI: node kribb-meal-bot.mjs [send|test]
 *     send: 크롤링 + 브로드캐스트 (모든 구독자에게 전송)
 *     test: 크롤링 + 데이터 업데이트만 (브로드캐스트 없음)
 *
 * 사용법:
 *   1. .env에 KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL 설정
 *   2. LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

// --- 환경변수 ---
function loadEnv() {
  try {
    const lines = readFileSync('.env', 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (match) process.env[match[1]] = match[2];
    }
  } catch {}
}
loadEnv();

const { KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL } = process.env;

if (!KRIBB_ID || !KRIBB_PW) {
  console.error('Error: .env에 KRIBB_ID, KRIBB_PW 필요');
  process.exit(1);
}
if (!APPS_SCRIPT_URL) {
  console.error('Error: .env에 APPS_SCRIPT_URL 필요');
  process.exit(1);
}

// --- Apps Script 웹훅 전송 ---
async function sendToAppsScript(data, broadcast) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update_meal', data, broadcast }),
  });
  const text = await res.text();
  console.log('Apps Script 응답:', text);
}

// --- 식단 크롤링 ---
function todayStr() {
  const t = new Date();
  return `${t.getFullYear()}/${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}`;
}

async function getMeal() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://int.kribb.re.kr/BizRunner/TodayMealPage.bzr', {
      waitUntil: 'networkidle',
      timeout: 15000,
    });

    await page.fill('#KribbLoginPage_loginMain_tbxID', KRIBB_ID);
    await page.fill('#KribbLoginPage_loginMain_tbxPwd', KRIBB_PW);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {}),
      page.click('a.btn-login'),
    ]);
    await page.waitForTimeout(3000);

    if (page.url().includes('LoginPage')) {
      throw new Error('로그인 실패: ID/PW 확인 필요');
    }

    const data = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tr');
      const result = { date: '', breakfast: '', lunchA: '', dinner: '' };
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 4) {
          const firstCell = cells[0]?.textContent?.trim();
          if (firstCell && /^\d{4}\/\d{2}\/\d{2}$/.test(firstCell)) {
            result.date = firstCell;
            result.breakfast = cells[1]?.innerText?.trim() || '';
            result.lunchA = cells[2]?.innerText?.trim() || '';
            result.dinner = cells[3]?.innerText?.trim() || '';
            break;
          }
        }
      }
      return result;
    });

    console.log(`[${new Date().toISOString()}] 크롤링 완료: ${data.date}`);
    return data;
  } finally {
    await browser.close();
  }
}

// --- CLI 모드 ---
const arg = process.argv[2];

if (arg) {
  try {
    const data = await getMeal();
    const broadcast = arg === 'send';
    console.log(`모드: ${broadcast ? '브로드캐스트' : '데이터 업데이트만'}`);
    await sendToAppsScript(data, broadcast);
  } catch (err) {
    console.error('에러:', err.message);
    process.exit(1);
  }
  process.exit(0);
}

// --- 스케줄러 모드 ---
console.log(`[${new Date().toISOString()}] KRIBB 식단 봇 시작 (스케줄러 모드)`);
console.log('자동 전송: 평일 08:30');
console.log('수동: node kribb-meal-bot.mjs [send|test]');

let lastAutoSent = '';

while (true) {
  const now = new Date();
  const day = now.getDay();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateKey = todayStr();

  if (day >= 1 && day <= 5 && hhmm === '08:30' && lastAutoSent !== dateKey) {
    lastAutoSent = dateKey;
    console.log(`[${now.toISOString()}] 08:30 자동 전송`);
    try {
      const data = await getMeal();
      await sendToAppsScript(data, true);
    } catch (err) {
      console.error('자동 전송 에러:', err.message);
    }
  }

  // 30초마다 체크
  await new Promise(r => setTimeout(r, 30000));
}
