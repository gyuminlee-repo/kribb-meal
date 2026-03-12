/**
 * KRIBB 인트라넷 오늘의 식단 크롤러
 *
 * 사용법:
 *   1. .env에 KRIBB_ID, KRIBB_PW 설정
 *   2. LD_LIBRARY_PATH="/home/gml/miniforge3/lib:$LD_LIBRARY_PATH" node kribb-meal-check.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

// .env 파싱 (dotenv 없이)
function loadEnv() {
  try {
    const lines = readFileSync('.env', 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (match) process.env[match[1]] = match[2];
    }
  } catch { /* .env 없으면 환경변수에서 직접 읽음 */ }
}

loadEnv();

const KRIBB_ID = process.env.KRIBB_ID;
const KRIBB_PW = process.env.KRIBB_PW;

if (!KRIBB_ID || !KRIBB_PW) {
  console.error('Error: .env 파일에 KRIBB_ID, KRIBB_PW를 설정하세요.');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// 1. 로그인 페이지 접속
await page.goto('https://int.kribb.re.kr/BizRunner/TodayMealPage.bzr', {
  waitUntil: 'networkidle',
  timeout: 15000,
});

// 2. 로그인 (visible Login 링크가 hidden submit을 트리거)
await page.fill('#KribbLoginPage_loginMain_tbxID', KRIBB_ID);
await page.fill('#KribbLoginPage_loginMain_tbxPwd', KRIBB_PW);

// 네비게이션 대기와 함께 클릭
await Promise.all([
  page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {}),
  page.click('a.btn-login'),
]);

// 추가 대기
await page.waitForTimeout(3000);

// 디버그: 현재 URL과 스크린샷
const url = page.url();
console.log('현재 URL:', url);
await page.screenshot({ path: '/tmp/kribb-after-login.png', fullPage: true });
console.log('로그인 후 스크린샷: /tmp/kribb-after-login.png');

if (url.includes('LoginPage')) {
  // 에러 메시지 확인
  const errMsg = await page.textContent('body').catch(() => '');
  console.error('로그인 실패. 페이지 텍스트:', errMsg?.slice(0, 500));
  await browser.close();
  process.exit(1);
}

// 4. 식단 데이터 추출
const content = await page.textContent('body');
console.log('=== 오늘의 식단 ===');
console.log(content?.trim());

// 스크린샷 저장
await page.screenshot({ path: '/tmp/kribb-meal.png', fullPage: true });
console.log('\n스크린샷: /tmp/kribb-meal.png');

await browser.close();
