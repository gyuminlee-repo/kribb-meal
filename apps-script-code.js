// ============================================================
// KRIBB Meal Bot — Google Apps Script
//
// Telegram bot that serves KRIBB cafeteria menu.
// Receives meal data from WSL crawler via doPost.
// Responds to user commands via webhook + polling backup.
// Per-user notification times (default: lunch 11:00, dinner 17:30).
// Clears data at 19:00.
// ============================================================

var BOT_TOKEN = 'YOUR_BOT_TOKEN';
var TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;
var PROPS = PropertiesService.getScriptProperties();

var DEFAULT_LUNCH = '09:30';
var DEFAULT_DINNER = '';     // 저녁 알림 미사용 — 09:30 단일 알림으로 통합

var LUNCH_START_H = 11, LUNCH_START_M = 30;   // 11:30 (catch-up 상한선)
var DINNER_START_H = 18, DINNER_START_M = 0;   // 18:00

// 식당 미운영 기간 (KST 기준, 'YYYY/MM/DD', 양끝 포함)
var HOLIDAY_RANGES = [
  { start: '2026/07/27', end: '2026/07/29', label: '집중휴가기간', display: '7/27~7/29', resume: '7/30(목)' }
];

// 식단 미갱신 감시: 평일 이 시각(KST) 이후에도 오늘 식단이 없으면 운영자에게 메일 1통 (빈 주소면 스크립트 소유자)
var WATCHDOG_H = 9, WATCHDOG_M = 15;
var WATCHDOG_EMAIL = PROPS.getProperty('WATCHDOG_EMAIL') || '';   // 스크립트 속성에서 읽음 (공개 저장소에 주소를 두지 않기 위함)

// --- Telegram API ---

function tgSend(chatId, text) {
  if (!text) return;
  UrlFetchApp.fetch(TG_API + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
  });
}

function tgGetUpdates() {
  var offset = PROPS.getProperty('tg_offset') || '0';
  var res = UrlFetchApp.fetch(TG_API + '/getUpdates?offset=' + offset + '&timeout=0');
  return JSON.parse(res.getContentText()).result || [];
}

// --- Storage: users (legacy array, kept for compatibility) ---

function getUsers() {
  var raw = PROPS.getProperty('users');
  return raw ? JSON.parse(raw) : [];
}

function addUser(chatId) {
  // Legacy users array
  var users = getUsers();
  if (users.indexOf(chatId) === -1) {
    users.push(chatId);
    PROPS.setProperty('users', JSON.stringify(users));
  }
  // User preferences (ensure entry exists)
  var prefs = getUserPrefs();
  if (!prefs[chatId]) {
    prefs[chatId] = { lunch: DEFAULT_LUNCH, dinner: DEFAULT_DINNER, muted: false };
    PROPS.setProperty('userPrefs', JSON.stringify(prefs));
  }
}

// --- Storage: user preferences ---

function getUserPrefs() {
  var raw = PROPS.getProperty('userPrefs');
  return raw ? JSON.parse(raw) : {};
}

function setUserPref(chatId, key, val) {
  var prefs = getUserPrefs();
  if (!prefs[chatId]) prefs[chatId] = { lunch: DEFAULT_LUNCH, dinner: DEFAULT_DINNER, muted: false };
  prefs[chatId][key] = val;
  PROPS.setProperty('userPrefs', JSON.stringify(prefs));
}

// --- Storage: sent log (per-user daily tracking) ---

function getSentLog() {
  var raw = PROPS.getProperty('sentLog');
  var log = raw ? JSON.parse(raw) : {};
  if (log.date !== todayStr()) return { date: todayStr(), lunch: [], dinner: [] };
  return log;
}

function saveSentLog(log) {
  PROPS.setProperty('sentLog', JSON.stringify(log));
}

// --- Storage: meal ---

function saveMeal(data) { PROPS.setProperty('meal', JSON.stringify(data)); }
function getMeal() { var r = PROPS.getProperty('meal'); return r ? JSON.parse(r) : null; }
function clearMeal() { PROPS.deleteProperty('meal'); }

// --- Migration: users array → userPrefs ---

function migrateIfNeeded() {
  var version = PROPS.getProperty('migrated');

  // v1: users 배열 → userPrefs 객체
  if (version !== 'v1' && version !== 'v2') {
    var prefs = getUserPrefs();
    var users = getUsers();
    var changed = false;
    for (var i = 0; i < users.length; i++) {
      if (!prefs[users[i]]) {
        prefs[users[i]] = { lunch: DEFAULT_LUNCH, dinner: DEFAULT_DINNER, muted: false };
        changed = true;
      }
    }
    if (changed) PROPS.setProperty('userPrefs', JSON.stringify(prefs));
    version = 'v1';
  }

  // v2: 09:30 단일 알림으로 통합 — 기존 lunch→09:30, dinner→'' 업데이트
  if (version !== 'v2') {
    var prefs2 = getUserPrefs();
    var changed2 = false;
    for (var chatId in prefs2) {
      if (prefs2[chatId].lunch !== DEFAULT_LUNCH) {
        prefs2[chatId].lunch = DEFAULT_LUNCH;
        changed2 = true;
      }
      if (prefs2[chatId].dinner !== DEFAULT_DINNER) {
        prefs2[chatId].dinner = DEFAULT_DINNER;
        changed2 = true;
      }
    }
    if (changed2) PROPS.setProperty('userPrefs', JSON.stringify(prefs2));
    PROPS.setProperty('migrated', 'v2');
  }
}

// --- Time helpers ---

function pad(n) { return String(n).padStart(2, '0'); }

// UTC+9 고정 오프셋으로 KST 시각 반환 (GAS 프로젝트 타임존 설정 독립)
function kstDate() {
  return new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
}

function todayStr() {
  var t = kstDate();
  return t.getUTCFullYear() + '/' + pad(t.getUTCMonth() + 1) + '/' + pad(t.getUTCDate());
}

function now() {
  var t = kstDate();
  return { h: t.getUTCHours(), m: t.getUTCMinutes(), day: t.getUTCDay() };
}

// KST 'YYYY/MM/DD HH:MM'
function kstStamp() {
  var t = kstDate();
  return todayStr() + ' ' + pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes());
}

// 'YYYY/MM/DD' 다음 날부터 오늘까지(오늘 포함) 평일 수. 형식 오류면 -1.
function weekdaysSince(dateStr) {
  var m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(dateStr || '');
  if (!m) return -1;
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  var today = todayStr();
  var n = 0;
  for (var i = 0; i < 366; i++) {   // 안전 상한 1년
    d.setUTCDate(d.getUTCDate() + 1);
    var s = d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate());
    if (s > today) break;
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) n++;
  }
  return n;
}

// 오늘이 미운영 기간이면 해당 range 객체, 아니면 null.
// 'YYYY/MM/DD' 고정폭 문자열이라 사전순 비교가 날짜 비교와 일치한다.
function findHoliday() {
  var today = todayStr();
  for (var i = 0; i < HOLIDAY_RANGES.length; i++) {
    var r = HOLIDAY_RANGES[i];
    if (today >= r.start && today <= r.end) return r;
  }
  return null;
}

// --- 법정 공휴일 (Google 공개 대한민국 휴일 캘린더) ---

var KR_HOLIDAY_ICS = 'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';

// ICS 본문에서 DESCRIPTION이 '공휴일'로 시작하는 종일 일정의 날짜만 'YYYY/MM/DD'로 반환.
// '기념일'(국군의날, 어버이날 등)은 제외. 대체공휴일('쉬는 날 ...')은 DESCRIPTION이 '공휴일'이라 포함.
function parseHolidayIcs(text) {
  var lines = text.replace(/\r\n[ \t]/g, '').split(/\r?\n/);  // 줄 접힘 해제
  var out = [];
  var date = null, desc = '';
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === 'BEGIN:VEVENT') { date = null; desc = ''; }
    else if (line.indexOf('DTSTART;VALUE=DATE:') === 0) {
      var d = line.substring(19);
      date = d.substring(0, 4) + '/' + d.substring(4, 6) + '/' + d.substring(6, 8);
    }
    else if (line.indexOf('DESCRIPTION:') === 0) desc = line.substring(12);
    else if (line === 'END:VEVENT' && date && desc.indexOf('공휴일') === 0) out.push(date);
  }
  return out;
}

// 오늘이 법정 공휴일이면 true. 목록은 6시간 캐시. fetch 실패 시 false(메일 발송 쪽으로 fail-open).
function isPublicHoliday() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('krHolidays');
  var list;
  if (cached) {
    list = JSON.parse(cached);
  } else {
    try {
      var res = UrlFetchApp.fetch(KR_HOLIDAY_ICS, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        Logger.log('Holiday ICS fetch failed: HTTP ' + res.getResponseCode());
        return false;
      }
      list = parseHolidayIcs(res.getContentText('UTF-8'));
      cache.put('krHolidays', JSON.stringify(list), 21600);
    } catch (err) {
      Logger.log('Holiday ICS fetch failed: ' + err);
      return false;
    }
  }
  return list.indexOf(todayStr()) !== -1;
}

// --- 날짜 목록 스크립트 속성 (SKIP_DATES, 재배포 불필요) ---
// 형식: 쉼표 구분, 각 항목은 'YYYY-MM-DD' 또는 'YYYY-MM-DD~YYYY-MM-DD'(양끝 포함), 공백 허용.
// 예: '2026-10-30, 2026-12-28~2027-01-02'

// 'YYYY-MM-DD' → UTC 자정 Date. 형식 오류나 달력에 없는 날짜면 null.
function parseYmd(str) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return null;
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return d;
}

// 스크립트 속성 name 의 날짜 목록에 오늘(KST)이 들어 있으면 true. 잘못된 항목은 로그만 남기고 무시.
// 'YYYY-MM-DD' 고정폭 문자열이라 사전순 비교가 날짜 비교와 일치한다.
function dateListHasToday(name) {
  var items = (PROPS.getProperty(name) || '').split(',');
  var today = todayStr().replace(/\//g, '-');
  var hit = false;
  for (var i = 0; i < items.length; i++) {
    var item = items[i].trim();
    if (!item) continue;
    var ends = item.split('~');
    var from = ends[0].trim();
    var to = ends.length === 2 ? ends[1].trim() : from;
    if (ends.length > 2 || !parseYmd(from) || !parseYmd(to) || to < from) {
      Logger.log(name + ': 잘못된 항목 무시: ' + item);
      continue;
    }
    if (today >= from && today <= to) hit = true;
  }
  return hit;
}

// 임시 휴무일: HOLIDAY_RANGES 에 없는 갑작스러운 휴무 (watchdog 메일만 건너뜀)
function isSkipDate() { return dateListHasToday('SKIP_DATES'); }

function isUpdated(data) {
  return data && data.date === todayStr() && (data.lunchA || data.dinner);
}

function parseTime(str) {
  if (!str) return null;
  var m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return { h: h, m: min };
}

// --- Message formatting ---

var CONTACT_FOOTER = '\n\n문의: 이규민 | sysbiogyumin@kribb.re.kr';

function msgNotReady() {
  var h = now().h;
  if (h < 8) return 'KRIBB meal (' + todayStr() + ')\n\nNot yet updated.\nAuto-send: lunch 11:00 / dinner 17:30';
  return 'KRIBB meal (' + todayStr() + ')\n\nNot yet updated.';
}

function msgClosed() {
  return 'KRIBB meal (' + todayStr() + ')\n\nDone for today.\nNext update tomorrow.';
}

function msgHoliday(r) {
  return '<b>KRIBB meal</b> (' + todayStr() + ')\n\n'
    + r.label + '(' + r.display + ')으로 구내식당 식단 운영이 없습니다.\n'
    + r.resume + '부터 평소대로 안내합니다.'
    + CONTACT_FOOTER;
}

function msgLunch(data) {
  var hol = findHoliday(); if (hol) return msgHoliday(hol);
  if (now().h >= 19) return msgClosed();
  if (!isUpdated(data) || !data.lunchA) return msgNotReady();
  var msg = '<b>Lunch</b> (11:30-13:00)\n\n' + escHtml(data.lunchA);
  if (data.insight) msg += '\n\n✨ <b>AI Insight</b>\n' + escHtml(data.insight);
  return msg + CONTACT_FOOTER;
}

function msgDinner(data) {
  var hol = findHoliday(); if (hol) return msgHoliday(hol);
  if (now().h >= 19) return msgClosed();
  if (!isUpdated(data) || !data.dinner) return msgNotReady();
  var msg = '<b>Dinner</b> (18:00-19:00)\n\n' + escHtml(data.dinner);
  if (data.insight) msg += '\n\n✨ <b>AI Insight</b>\n' + escHtml(data.insight);
  return msg + CONTACT_FOOTER;
}

function msgAll(data) {
  var hol = findHoliday(); if (hol) return msgHoliday(hol);
  if (now().h >= 19) return msgClosed();
  if (!isUpdated(data)) return msgNotReady();
  var msg = '<b>KRIBB meal</b> (' + data.date + ')\n';
  if (data.lunchA) msg += '\n<b>Lunch</b> (11:30-13:00)\n' + escHtml(data.lunchA) + '\n';
  if (data.dinner) msg += '\n<b>Dinner</b> (18:00-19:00)\n' + escHtml(data.dinner) + '\n';
  return msg + CONTACT_FOOTER;
}

function msgTest(data) {
  var hol = findHoliday(); if (hol) return msgHoliday(hol);
  if (!isUpdated(data)) return msgNotReady();
  return '[PREVIEW]\n' + msgAll(data);
}

function msgHelp() {
  return '<b>KRIBB Meal Bot</b>\n\n'
    + '응답은 최대 1분 정도 소요될 수 있습니다.\n\n'
    + '<b>Menu</b>\n'
    + '/lunch - Lunch menu\n'
    + '/dinner - Dinner menu\n'
    + '/meal - All\n'
    + '/test - Preview\n\n'
    + '<b>Settings</b>\n'
    + '/setlunch HH:MM - Lunch alert time\n'
    + '/setdinner HH:MM - Dinner alert time\n'
    + '/mute - Disable auto alerts\n'
    + '/unmute - Enable auto alerts\n'
    + '/settings - View current settings';
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Command handlers ---

function handleSetTime(chatId, type, text) {
  var parts = text.trim().split(/\s+/);
  var arg = parts[1] || '';

  // Reset to default
  if (arg === 'reset') {
    var def = type === 'lunch' ? DEFAULT_LUNCH : DEFAULT_DINNER;
    setUserPref(chatId, type, def);
    tgSend(chatId, (type === 'lunch' ? 'Lunch' : 'Dinner') + ' alert reset to ' + def);
    return;
  }

  var parsed = parseTime(arg);
  if (!parsed) {
    tgSend(chatId, 'Format: /set' + type + ' HH:MM (e.g. /set' + type + ' 11:30)\nOr /set' + type + ' reset');
    return;
  }

  // Range validation
  if (type === 'lunch' && (parsed.h < 8 || parsed.h > 14)) {
    tgSend(chatId, 'Lunch alert must be between 08:00 and 14:59.');
    return;
  }
  if (type === 'dinner' && (parsed.h < 15 || parsed.h > 19)) {
    tgSend(chatId, 'Dinner alert must be between 15:00 and 19:00.');
    return;
  }

  var timeStr = pad(parsed.h) + ':' + pad(parsed.m);
  setUserPref(chatId, type, timeStr);
  tgSend(chatId, (type === 'lunch' ? 'Lunch' : 'Dinner') + ' alert set to ' + timeStr);
}

function handleMute(chatId, muted) {
  setUserPref(chatId, 'muted', muted);
  tgSend(chatId, 'Auto alerts ' + (muted ? 'OFF' : 'ON'));
}

function handleSettings(chatId) {
  var prefs = getUserPrefs();
  var p = prefs[chatId] || { lunch: DEFAULT_LUNCH, dinner: DEFAULT_DINNER, muted: false };
  var msg = '<b>Settings</b>\n\n'
    + 'Lunch alert: ' + p.lunch + '\n'
    + 'Dinner alert: ' + p.dinner + '\n'
    + 'Auto alerts: ' + (p.muted ? 'OFF' : 'ON') + '\n\n'
    + '/setlunch HH:MM\n'
    + '/setdinner HH:MM\n'
    + '/mute | /unmute';
  tgSend(chatId, msg);
}

// --- Command router (shared by webhook + polling) ---

function handleCommand(chatId, text) {
  var data = getMeal();
  addUser(chatId);

  if (text === '/start' || text === '/help') tgSend(chatId, msgHelp());
  else if (text === '/lunch') tgSend(chatId, msgLunch(data));
  else if (text === '/dinner') tgSend(chatId, msgDinner(data));
  else if (text === '/meal') tgSend(chatId, msgAll(data));
  else if (text === '/test') tgSend(chatId, msgTest(data));
  else if (text === '/mute') handleMute(chatId, true);
  else if (text === '/unmute') handleMute(chatId, false);
  else if (text === '/settings') handleSettings(chatId);
  else if (text.indexOf('/setlunch') === 0) handleSetTime(chatId, 'lunch', text);
  else if (text.indexOf('/setdinner') === 0) handleSetTime(chatId, 'dinner', text);
}

// --- Broadcast (kept for manual/admin use) ---

function broadcast(msgFn) {
  if (findHoliday()) return;   // 미운영 기간: 자동 발송 전면 차단
  var data = getMeal();
  if (!isUpdated(data)) return;
  var users = getUsers();
  var msg = msgFn(data);
  for (var i = 0; i < users.length; i++) {
    try { tgSend(users[i], msg); } catch (err) {}
  }
  Logger.log('Broadcast to ' + users.length + ' users');
}

// --- Catch-up: send to users whose alert time already passed (before meal starts) ---

function catchUpSend() {
  if (findHoliday()) return;   // 미운영 기간: 자동 발송 전면 차단
  var data = getMeal();
  if (!isUpdated(data)) return;

  var t = now();
  var prefs = getUserPrefs();
  var sentLog = getSentLog();
  var dirty = false;

  for (var chatId in prefs) {
    var p = prefs[chatId];
    if (p.muted) continue;

    var lunchTime = parseTime(p.lunch);
    var dinnerTime = parseTime(p.dinner);

    // Lunch: alert time passed + before 11:30 + not yet sent
    if (lunchTime && data.lunchA
        && (t.h > lunchTime.h || (t.h === lunchTime.h && t.m >= lunchTime.m))
        && (t.h < LUNCH_START_H || (t.h === LUNCH_START_H && t.m < LUNCH_START_M))
        && sentLog.lunch.indexOf(chatId) === -1) {
      try {
        tgSend(chatId, msgAll(data));
        sentLog.lunch.push(chatId);
        dirty = true;
      } catch (err) {}
    }

    // Dinner: alert time passed + before 18:00 + not yet sent
    if (dinnerTime && data.dinner
        && (t.h > dinnerTime.h || (t.h === dinnerTime.h && t.m >= dinnerTime.m))
        && (t.h < DINNER_START_H || (t.h === DINNER_START_H && t.m < DINNER_START_M))
        && sentLog.dinner.indexOf(chatId) === -1) {
      try {
        tgSend(chatId, msgDinner(data));
        sentLog.dinner.push(chatId);
        dirty = true;
      } catch (err) {}
    }
  }

  if (dirty) saveSentLog(sentLog);
}

// --- Scheduled tasks (per-user notification times) ---

function scheduledTasks() {
  // 미운영 기간: 함수 맨 앞에서 차단. 휴가 중에는 크롤러가 업로드하지 않아
  // 잔여 meal 데이터의 date가 stale이므로 isUpdated()가 이미 false이고,
  // sentLog는 날짜 불일치 시 자동 리셋된다. 19:00 삭제를 건너뛰어도 무해하다.
  if (findHoliday()) return;
  var t = now();
  var today = todayStr();

  // Weekday only
  if (t.day === 0 || t.day === 6) return;

  // 19:00 clear
  if (t.h >= 19 && PROPS.getProperty('cleared') !== today) {
    PROPS.setProperty('cleared', today);
    clearMeal();
    PROPS.deleteProperty('sentLog');
    Logger.log('Meal data cleared');
    return;
  }

  // Per-user scheduled sends
  var data = getMeal();
  if (!isUpdated(data)) return;

  var prefs = getUserPrefs();
  var sentLog = getSentLog();
  var timeStr = pad(t.h) + ':' + pad(t.m);
  var dirty = false;

  for (var chatId in prefs) {
    var p = prefs[chatId];
    if (p.muted) continue;

    // Lunch
    if (p.lunch === timeStr && data.lunchA && sentLog.lunch.indexOf(chatId) === -1) {
      try {
        tgSend(chatId, msgAll(data));
        sentLog.lunch.push(chatId);
        dirty = true;
      } catch (err) {}
    }

    // Dinner
    if (p.dinner === timeStr && data.dinner && sentLog.dinner.indexOf(chatId) === -1) {
      try {
        tgSend(chatId, msgDinner(data));
        sentLog.dinner.push(chatId);
        dirty = true;
      } catch (err) {}
    }
  }

  if (dirty) saveSentLog(sentLog);
}

// --- Watchdog: crawler/cron failure alert (email, once per day) ---

function watchdogCheck() {
  if (findHoliday()) return;
  var t = now();
  if (t.day === 0 || t.day === 6) return;
  if (isPublicHoliday()) return;
  if (isSkipDate()) return;   // 스크립트 속성 SKIP_DATES 의 임시 휴무일
  if (t.h < WATCHDOG_H || (t.h === WATCHDOG_H && t.m < WATCHDOG_M)) return;
  if (t.h >= 19) return;
  if (isUpdated(getMeal())) return;
  var today = todayStr();
  if (PROPS.getProperty('watchdogAlerted') === today) return;

  try {
    var to = WATCHDOG_EMAIL || Session.getEffectiveUser().getEmail();
    var subject = '[KRIBB meal] ' + today + ' 식단 미갱신';
    var gap = weekdaysSince(PROPS.getProperty('lastMealDate'));   // 마지막 식단 이후 평일 수
    var body = '확인 시각(KST): ' + pad(t.h) + ':' + pad(t.m) + '\n'
      + '오늘(' + today + ') 식단 데이터가 아직 수신되지 않았습니다.\n\n'
      + '가능한 원인\n'
      + '- 크롤러 실패\n'
      + '- 서버 또는 cron 중단\n'
      + '- 원 사이트에 식단 미게시\n\n'
      + '마지막 식단 수신: ' + (PROPS.getProperty('lastMealAt') || '기록 없음') + '\n'
      + (gap >= 2 ? '며칠째 미수신 상태입니다 (평일 기준 ' + gap + '일째).\n' : '')
      + '\n'
      + '조치\n'
      + '- 서버에서 수동 실행: node kribb-meal-bot.mjs\n'
      + '- 크롤러 및 cron 로그 확인\n';
    MailApp.sendEmail(to, subject, body);
    PROPS.setProperty('watchdogAlerted', today);
    Logger.log('Watchdog alert sent to ' + to);
  } catch (err) {
    Logger.log('Watchdog email failed: ' + err);
  }
}

// --- Polling (backup for webhook) ---

function pollMessages() {
  var updates = tgGetUpdates();
  for (var i = 0; i < updates.length; i++) {
    PROPS.setProperty('tg_offset', String(updates[i].update_id + 1));
    var msg = updates[i].message;
    if (!msg || !msg.text) continue;
    handleCommand(msg.chat.id, msg.text.split('@')[0].trim());
  }
}

// --- Entry points ---

// Webhook + WSL data receiver
function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
  }

  // Crawler actions require shared secret
  if (body.action === 'check_meal' || body.action === 'update_meal' || body.action === 'force_broadcast') {
    var secret = PROPS.getProperty('SHARED_SECRET');
    if (!secret || body.secret !== secret) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    }
  }

  // Check if meal data exists for today
  if (body.action === 'check_meal') {
    var data = getMeal();
    return ContentService.createTextOutput(JSON.stringify({ ok: true, updated: isUpdated(data) }));
  }

  // Force broadcast: unconditional send to all users (test/admin)
  if (body.action === 'force_broadcast') {
    var data = getMeal();
    if (!isUpdated(data)) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'No meal data' }));
    }
    var users = getUsers();
    var prefix = body.prefix ? body.prefix + '\n\n' : '';
    var sent = 0;
    for (var i = 0; i < users.length; i++) {
      try { tgSend(users[i], prefix + msgAll(data)); sent++; } catch (err) {}
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, sent: sent, total: users.length }));
  }

  // WSL meal data upload
  if (body.action === 'update_meal') {
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(5000);
      saveMeal(body.data);
      // 마지막 수신 기록 (19:00 정리 대상 아님, watchdog 메일에 표기)
      if (body.data && body.data.date) PROPS.setProperty('lastMealDate', String(body.data.date));
      PROPS.setProperty('lastMealAt', kstStamp());
      catchUpSend();
    } finally {
      lock.releaseLock();
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, users: getUsers().length }));
  }

  // Telegram webhook (instant response)
  if (body.message && body.message.text) {
    handleCommand(body.message.chat.id, body.message.text.split('@')[0].trim());
    return ContentService.createTextOutput('ok');
  }

  return ContentService.createTextOutput('ok');
}

// 1-min trigger: migration + scheduled sends + cleanup + polling backup
function tick() {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    migrateIfNeeded();
    scheduledTasks();
    watchdogCheck();
    catchUpSend();
    pollMessages();
  } catch (err) {
    Logger.log('tick lock timeout: ' + err);
  } finally {
    lock.releaseLock();
  }
}

// Run once after deploy: registers trigger + removes old webhook
function setup() {
  UrlFetchApp.fetch(TG_API + '/deleteWebhook');
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) ScriptApp.deleteTrigger(triggers[i]);
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
  Logger.log('Setup complete. Now set webhook in browser:');
  Logger.log('https://api.telegram.org/bot[TOKEN]/setWebhook?url=[DEPLOY_URL]');
}
