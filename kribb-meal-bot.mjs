/**
 * KRIBB 식단 크롤러
 *
 * KRIBB 인트라넷에서 오늘의 식단을 크롤링하여 Google Apps Script로 전송.
 * Apps Script가 텔레그램 봇 응답 및 스케줄 전송을 담당.
 *
 * 사용법:
 *   LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal/kribb-meal-bot.mjs
 *   LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal/kribb-meal-bot.mjs --force
 *
 * cron (평일 08:25 + 랜덤 0~600초 딜레이 + 재부팅):
 *   25 8 * * 1-5 sleep $((RANDOM % 600)) && cd /mnt/d/_workspace/kribb-meal && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
 *   @reboot sleep 15 && cd /mnt/d/_workspace/kribb-meal && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
 *
 * 환경변수 (.env):
 *   KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

// --- Config ---

function loadEnv() {
  try {
    const envPath = '/mnt/d/_workspace/kribb-meal/.env';
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnv();

const { KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL, GEMINI_API_KEY } = process.env;
if (!KRIBB_ID || !KRIBB_PW || !APPS_SCRIPT_URL) {
  console.error('Error: .env에 KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL 필요');
  process.exit(1);
}

// --- Gemini AI Insight ---

async function getAiInsight(data) {
  if (!GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY is missing in .env');
    return "";
  }
  try {
    const prompt = `너는 한국생명공학연구원(KRIBB)의 위트 있는 인공지능 영양사야. 
오늘의 점심 메뉴는 [${data.lunchA}]이고, 저녁 메뉴는 [${data.dinner}]이야.
연구원들이 힘내서 실험할 수 있도록, 메뉴와 관련된 과학 유머나 비유(DNA, PCR, 단백질, 세포 등)를 섞어서 짧고 강렬한 한 문장의 응원 멘트를 한국어로 작성해줘. 
너무 길지 않게 딱 한 문장만!`;

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    const json = await res.json();
    if (json.error) {
      console.error('Gemini API Error Response:', JSON.stringify(json.error));
      return "";
    }
    
    const insight = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
    return insight;
  } catch (err) {
    console.error('Gemini Fetch Error:', err.message);
    return "";
  }
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

// --- Check if already updated ---

async function checkMeal() {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'check_meal' }),
  });
  const json = JSON.parse(await res.text());
  return json.updated === true;
}

// --- Main ---

const force = process.argv.includes('--force');
const ts = () => new Date().toISOString();

// Weekend skip
const day = new Date().getDay();
if ((day === 0 || day === 6) && !force) {
  console.log(`[${ts()}] Weekend — skip`);
  process.exit(0);
}

// Duplicate check
if (!force) {
  try {
    const updated = await checkMeal();
    if (updated) {
      // 이미 업데이트됨: 로그 없이 조용히 종료
      process.exit(0);
    }
    console.log(`[${ts()}] Data missing or cleared. Recovering...`);
  } catch (err) {
    console.warn(`[${ts()}] check_meal failed, proceeding:`, err.message);
  }
}

try {
  const data = await crawlMeal();
  console.log(`[${ts()}] ${data.date} crawled`);
  
  // Gemini AI 인사이트 생성
  const insight = await getAiInsight(data);
  if (insight) {
    data.insight = insight;
    console.log(`[${ts()}] AI Insight: ${insight}`);
  }

  const res = await uploadToAppsScript(data);
  console.log('Apps Script:', res);
} catch (err) {
  console.error(`[${ts()}] Error:`, err.message);
  process.exit(1);
}
