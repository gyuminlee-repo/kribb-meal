/**
 * KRIBB 식단 크롤러
 *
 * KRIBB 인트라넷에서 오늘의 식단을 크롤링하여 Google Apps Script로 전송.
 * Apps Script가 텔레그램 봇 응답 및 스케줄 전송을 담당.
 *
 * 사용법:
 *   LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal/kribb-meal-bot.mjs
 *
 * cron (평일 08:00):
 *   0 8 * * 1-5 cd /mnt/d/_workspace/prototype && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal/kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
 *
 * 환경변수 (.env):
 *   KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

// --- Config ---

function loadEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnv();

const { KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL } = process.env;
if (!KRIBB_ID || !KRIBB_PW || !APPS_SCRIPT_URL) {
  console.error('Error: .env에 KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL 필요');
  process.exit(1);
}

// --- Crawl ---

async function crawlMeal() {
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
      throw new Error('Login failed');
    }

    return await page.evaluate(() => {
      const result = { date: '', breakfast: '', lunchA: '', dinner: '' };
      for (const row of document.querySelectorAll('table tr')) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 4) continue;
        const first = cells[0]?.textContent?.trim();
        if (first && /^\d{4}\/\d{2}\/\d{2}$/.test(first)) {
          result.date = first;
          result.breakfast = cells[1]?.innerText?.trim() || '';
          result.lunchA = cells[2]?.innerText?.trim() || '';
          result.dinner = cells[3]?.innerText?.trim() || '';
          break;
        }
      }
      return result;
    });
  } finally {
    await browser.close();
  }
}

// --- Upload ---

async function uploadToAppsScript(data) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'update_meal', data }),
  });
  return await res.text();
}

// --- Main ---

try {
  const data = await crawlMeal();
  console.log(`[${new Date().toISOString()}] ${data.date} crawled`);
  const res = await uploadToAppsScript(data);
  console.log('Apps Script:', res);
} catch (err) {
  console.error(`[${new Date().toISOString()}] Error:`, err.message);
  process.exit(1);
}
