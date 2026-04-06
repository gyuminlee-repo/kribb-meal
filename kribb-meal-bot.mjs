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
 * cron (평일 08:25 + 랜덤 0~600초 딜레이 + 재부팅):
 *   25 8 * * 1-5 sleep $((RANDOM % 600)) && cd /mnt/d/_workspace/030.repos/kribb-meal && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
 *   @reboot sleep 15 && cd /mnt/d/_workspace/030.repos/kribb-meal && LD_LIBRARY_PATH="/home/gml/miniforge3/lib" node kribb-meal-bot.mjs >> /tmp/kribb-meal-bot.log 2>&1
 *
 * 환경변수 (.env):
 *   KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL
 */
import { readFileSync } from "fs";
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

const { KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL } = process.env;
if (!KRIBB_ID || !KRIBB_PW || !APPS_SCRIPT_URL) {
  console.error('Error: .env에 KRIBB_ID, KRIBB_PW, APPS_SCRIPT_URL 필요');
  process.exit(1);
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
      const result = { date: "", breakfast: "", lunchA: "", dinner: "" };
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
    body: JSON.stringify(payload),
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

  const res = await uploadToAppsScript(data);
  console.log('Apps Script:', res);
} catch (err) {
  console.error(`[${ts()}] Error:`, err.message);
  process.exit(1);
}
