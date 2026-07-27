/**
 * KRIBB 식단 크롤러
 *
 * KRIBB 인트라넷에서 오늘의 식단을 크롤링하여 Google Apps Script로 전송.
 * Apps Script가 텔레그램 봇 응답 및 스케줄 전송을 담당.
 *
 * 사용법:
 *   LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs
 *   LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs --force
 *
 * 휴가 스킵: HOLIDAY_RANGES(KST 기준)에 오늘이 포함되면 크롤링 없이 즉시 종료한다.
 * IGNORE_HOLIDAY=1 을 주면 스킵을 무시한다 (--force 로는 무시되지 않음).
 *
 * cron (평일 08:25 + 랜덤 0~600초 딜레이 + 재부팅):
 *   25 8 * * 1-5 sleep $((RANDOM % 600)) && cd /mnt/d/_workspace/030.repos/kribb-meal && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
 *   @reboot sleep 15 && cd /mnt/d/_workspace/030.repos/kribb-meal && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
 *
 * 환경변수 (.env):
 *   KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL
 *   SHARED_SECRET
 *   WORKER_INGEST_URL  (optional) Cloudflare Worker /ingest URL. If unset, Worker push is skipped.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { chromium } from "playwright";

// --- Config ---

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const m = trimmed.match(/^([\w]+)\s*=\s*(.*)$/);
  if (!m) return null;

  let value = m[2].trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [m[1], value];
}

function loadEnv() {
  try {
    const envPath = new URL(".env", import.meta.url);
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (process.env[key] == null) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
loadEnv();

const { KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL, SHARED_SECRET } = process.env;
if (!KRIBB_ID || !KRIBB_PW || !APPS_SCRIPT_URL) {
  console.error('Error: .env에 KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL 필요');
  process.exit(1);
}
if (!SHARED_SECRET) {
  console.error('Error: .env에 SHARED_SECRET 필요');
  process.exit(1);
}

// --- Holiday (식당 미운영 기간, KST 기준, 'YYYY-MM-DD', 양끝 포함) ---

const HOLIDAY_RANGES = [{ start: "2026-07-27", end: "2026-07-31", label: "집중휴가기간" }];

// 서버 타임존이 UTC일 수 있으므로 +9h 오프셋으로 KST 날짜를 구한다.
function kstTodayISO() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function findHoliday() {
  const today = kstTodayISO();
  return HOLIDAY_RANGES.find((r) => today >= r.start && today <= r.end) || null;
}

function normalizeMealText(value) {
  if (!value) return "";
  return value
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function validateMealData(data) {
  if (!data || typeof data !== "object") {
    throw new Error("Meal crawl returned no data");
  }

  const normalized = {
    date: typeof data.date === "string" ? data.date.trim() : "",
    breakfast: normalizeMealText(data.breakfast),
    lunchA: normalizeMealText(data.lunchA),
    dinner: normalizeMealText(data.dinner),
  };

  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(normalized.date)) {
    throw new Error("Meal date not found");
  }
  if (!normalized.breakfast && !normalized.lunchA && !normalized.dinner) {
    throw new Error("Meal content is empty");
  }

  return normalized;
}

// --- Crawl ---

async function crawlMeal() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-setuid-sandbox", "--no-sandbox"],
  });
  const page = await browser.newPage();

  try {
    await page.goto("https://int.kribb.re.kr/BizRunner/TodayMealPage.bzr", {
      waitUntil: "networkidle",
      timeout: 15000,
    });

    await page.fill("#KribbLoginPage_loginMain_tbxID", KRIBB_ID);
    await page.fill("#KribbLoginPage_loginMain_tbxPwd", KRIBB_PW);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle", timeout: 20000 }).catch(() => {}),
      page.click("a.btn-login"),
    ]);
    await page.waitForTimeout(3000);

    if (page.url().includes("LoginPage")) {
      throw new Error("Login failed");
    }

    const meal = await page.evaluate(() => {
      const result = { date: "", breakfast: "", lunchA: "", dinner: "", noData: false };
      if (document.body.innerText.includes("오늘의 식단이 없거나")) {
        result.noData = true;
        return result;
      }
      for (const row of document.querySelectorAll("table tr")) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) continue;
        const first = cells[0]?.textContent?.trim();
        if (first && /^\d{4}\/\d{2}\/\d{2}$/.test(first)) {
          result.date = first;
          result.breakfast = cells[1]?.innerText?.trim() || "";
          result.lunchA = cells[2]?.innerText?.trim() || "";
          result.dinner = cells[3]?.innerText?.trim() || "";
          break;
        }
      }
      return result;
    });
    if (meal.noData) {
      const e = new Error("No meal posted on source site");
      e.noData = true;
      throw e;
    }

    return validateMealData(meal);
  } finally {
    await browser.close();
  }
}

// --- Upload ---

async function postAppsScript(payload) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, secret: SHARED_SECRET }),
  });
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Apps Script HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  return text;
}

async function uploadToAppsScript(data) {
  const text = await postAppsScript({ action: "update_meal", data });
  if (!text.trim()) {
    throw new Error("Apps Script returned empty response");
  }
  return text;
}

// --- Cloudflare Worker upload (non-fatal, optional) ---

async function uploadToWorker(data) {
  const workerUrl = process.env.WORKER_INGEST_URL;
  if (!workerUrl) return;
  try {
    const res = await fetch(workerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: SHARED_SECRET, data }),
    });
    const text = await res.text();
    console.log(`[${ts()}] Worker ingest: ${res.status} ${text.slice(0, 100)}`);
  } catch (err) {
    console.warn(`[${ts()}] Worker ingest failed (non-fatal):`, err.message);
  }
}

// --- Check if already updated ---

async function checkMeal() {
  const text = await postAppsScript({ action: "check_meal" });
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from Apps Script: ${text.slice(0, 200)}`);
  }
  if (!("updated" in json)) {
    throw new Error("Apps Script check_meal response missing updated flag");
  }
  return !!json.updated;
}

const force = process.argv.includes('--force');
const ts = () => new Date().toISOString();

// Weekend skip
const day = new Date().getDay();
if ((day === 0 || day === 6) && !force) {
  console.log(`[${ts()}] Weekend — skip`);
  process.exit(0);
}

// Holiday skip (--force 로는 무시되지 않음. IGNORE_HOLIDAY=1 만 무시)
const holiday = findHoliday();
if (holiday && process.env.IGNORE_HOLIDAY !== '1') {
  console.log(`[${ts()}] ${holiday.label} (${holiday.start}~${holiday.end}) - skip`);
  process.exit(0);
}

// Duplicate check
if (!force && process.env.SKIP_APPS_SCRIPT !== '1') {
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

// --- Save as Markdown ---

const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"];

function saveMealMarkdown(data) {
  const [y, m, d] = data.date.split("/");
  const dow = WEEKDAY_KR[new Date(+y, +m - 1, +d).getDay()];

  let md = `# ${data.date} (${dow})\n`;
  if (data.breakfast) md += `\n## 조식\n${data.breakfast}\n`;
  if (data.lunchA) md += `\n## 중식\n${data.lunchA}\n`;
  if (data.dinner) md += `\n## 석식\n${data.dinner}\n`;

  const dir = new URL("meals", import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });

  const filePath = new URL(`meals/${data.date.replace(/\//g, "-")}.md`, import.meta.url).pathname;
  writeFileSync(filePath, md, "utf8");
  console.log(`[${ts()}] Saved ${filePath}`);
  return filePath;
}

function gitPushMeals() {
  const repoDir = new URL(".", import.meta.url).pathname;
  execSync("git add meals/", { cwd: repoDir, stdio: "pipe" });

  const hasChanges = (() => {
    try {
      execSync("git diff --cached --quiet", { cwd: repoDir, stdio: "pipe" });
      return false; // exit 0 = no changes
    } catch {
      return true;  // exit 1 = changes staged
    }
  })();

  if (!hasChanges) return;

  execSync('git commit -m "meal: update"', { cwd: repoDir, stdio: "pipe" });
  execSync("git push origin main", { cwd: repoDir, stdio: "pipe" });
  console.log(`[${ts()}] Pushed to origin`);
}

try {
  const data = await crawlMeal();
  console.log(`[${ts()}] ${data.date} crawled`);

  try {
    saveMealMarkdown(data);
    gitPushMeals();
  } catch (mdErr) {
    console.warn(`[${ts()}] md save/push failed (non-fatal):`, mdErr.message);
  }

  if (process.env.SKIP_APPS_SCRIPT === '1') {
    console.log(`[${ts()}] SKIP_APPS_SCRIPT=1 — Apps Script upload skipped`);
  } else {
    const res = await uploadToAppsScript(data);
    console.log('Apps Script:', res);
  }
  await uploadToWorker(data);
} catch (err) {
  if (err.noData) {
    console.log(`[${ts()}] ${err.message} — skip`);
    process.exit(0);
  }
  console.error(`[${ts()}] Error:`, err.message);
  process.exit(1);
}
