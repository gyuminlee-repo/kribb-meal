/**
 * KRIBB 식단 이메일 봇
 *
 * 기능:
 *   - 매일 08:30 (평일) 식단 이메일 자동 전송
 *   - CLI 명령어: node kribb-meal-bot.mjs [아침|점심|저녁|식단|test]
 *
 * 사용법:
 *   1. .env에 KRIBB_ID, KRIBB_PW, KRIBB_EMAIL 설정
 *   2. LD_LIBRARY_PATH="/home/gml/miniforge3/lib:$LD_LIBRARY_PATH" node kribb-meal-bot.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { createTransport } from 'nodemailer';

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

const { KRIBB_ID, KRIBB_PW, KRIBB_EMAIL } = process.env;
const EMAIL_TO = KRIBB_EMAIL || 'sysbiogyumin@kribb.re.kr';

if (!KRIBB_ID || !KRIBB_PW) {
  console.error('Error: .env에 KRIBB_ID, KRIBB_PW 필요');
  process.exit(1);
}

// --- 이메일 전송 ---
const transporter = createTransport({
  host: 'sguard.kisti.re.kr',
  port: 25,
  secure: false,
  tls: { rejectUnauthorized: false },
});

async function sendEmail(subject, html) {
  await transporter.sendMail({
    from: `"KRIBB 식단봇" <meal-bot@kribb.re.kr>`,
    to: EMAIL_TO,
    subject,
    html,
  });
  console.log(`이메일 전송 완료 → ${EMAIL_TO}`);
}

// --- 식단 크롤링 (캐시) ---
let cachedData = null;
let cacheDate = '';

function todayStr() {
  const t = new Date();
  return `${t.getFullYear()}/${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}`;
}

async function getMeal() {
  const today = todayStr();
  if (cachedData && cacheDate === today) return cachedData;

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

    cachedData = data;
    cacheDate = today;
    console.log(`[${new Date().toISOString()}] 크롤링 완료: ${data.date}`);
    return data;
  } finally {
    await browser.close();
  }
}

// --- HTML 포맷 ---
function nl2br(text) {
  return text.replace(/\n/g, '<br>');
}

function isUpdated(data) {
  return data.date && data.date === todayStr() && (data.breakfast || data.lunchA || data.dinner);
}

function notUpdatedHtml() {
  return `
    <div style="font-family:'Malgun Gothic',sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1e40af">🍽 KRIBB 오늘의 식단 (${todayStr()})</h2>
      <p style="color:#dc2626;font-size:16px">⚠️ 아직 식단이 업데이트되지 않았습니다.<br>인트라넷에서 직접 확인해주세요.</p>
    </div>`;
}

function mealSection(emoji, title, time, content) {
  if (!content) return '';
  return `
    <tr>
      <td style="padding:12px 16px;background:#f0f9ff;font-weight:bold;color:#1e40af;width:100px;vertical-align:top">
        ${emoji} ${title}<br><span style="font-weight:normal;font-size:12px;color:#64748b">${time}</span>
      </td>
      <td style="padding:12px 16px;line-height:1.8">${nl2br(content)}</td>
    </tr>`;
}

function formatAllHtml(data) {
  if (!isUpdated(data)) return notUpdatedHtml();
  return `
    <div style="font-family:'Malgun Gothic',sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1e40af">🍽 KRIBB 오늘의 식단 (${data.date})</h2>
      <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0">
        ${mealSection('🌅', '조식', '7:30~9:00', data.breakfast)}
        ${mealSection('🌞', '중식', '11:30~13:00', data.lunchA)}
        ${mealSection('🌙', '석식', '18:00~19:00', data.dinner)}
      </table>
      <p style="font-size:11px;color:#94a3b8;margin-top:12px">자동 발송 | KRIBB 식단봇</p>
    </div>`;
}

function formatSingleHtml(emoji, title, time, data, field) {
  if (!isUpdated(data)) return notUpdatedHtml();
  const content = data[field];
  if (!content) return `<p>${emoji} 오늘 ${title} 정보가 없습니다.</p>`;
  return `
    <div style="font-family:'Malgun Gothic',sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1e40af">${emoji} ${title} (${time})</h2>
      <div style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;line-height:1.8">
        ${nl2br(content)}
      </div>
      <p style="font-size:11px;color:#94a3b8;margin-top:12px">${data.date} | KRIBB 식단봇</p>
    </div>`;
}

// --- CLI 모드 ---
const arg = process.argv[2];

if (arg) {
  try {
    const data = await getMeal();
    let subject, html;

    switch (arg) {
      case '아침': case '조식':
        subject = `🌅 KRIBB 조식 — ${todayStr()}`;
        html = formatSingleHtml('🌅', '조식', '7:30~9:00', data, 'breakfast');
        break;
      case '점심': case '중식':
        subject = `🌞 KRIBB 중식 — ${todayStr()}`;
        html = formatSingleHtml('🌞', '중식', '11:30~13:00', data, 'lunchA');
        break;
      case '저녁': case '석식':
        subject = `🌙 KRIBB 석식 — ${todayStr()}`;
        html = formatSingleHtml('🌙', '석식', '18:00~19:00', data, 'dinner');
        break;
      case 'test': case '식단': default:
        subject = `🍽 KRIBB 오늘의 식단 — ${todayStr()}`;
        html = formatAllHtml(data);
        break;
    }

    await sendEmail(subject, html);
  } catch (err) {
    console.error('에러:', err.message);
    process.exit(1);
  }
  process.exit(0);
}

// --- 스케줄러 모드 (인자 없이 실행 시) ---
console.log(`[${new Date().toISOString()}] KRIBB 식단 봇 시작 (스케줄러 모드)`);
console.log(`수신: ${EMAIL_TO}`);
console.log('자동 전송: 평일 08:30');
console.log('수동: node kribb-meal-bot.mjs [아침|점심|저녁|식단]');

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
      const subject = `🍽 KRIBB 오늘의 식단 — ${dateKey}`;
      const html = formatAllHtml(data);
      await sendEmail(subject, html);
    } catch (err) {
      console.error('자동 전송 에러:', err.message);
    }
  }

  // 30초마다 체크
  await new Promise(r => setTimeout(r, 30000));
}
