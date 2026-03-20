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

var DEFAULT_LUNCH = '11:00';
var DEFAULT_DINNER = '17:30';

var LUNCH_START_H = 11, LUNCH_START_M = 30;   // 11:30
var DINNER_START_H = 18, DINNER_START_M = 0;   // 18:00

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
}

// --- Time helpers ---

function pad(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  var t = new Date();
  return t.getFullYear() + '/' + pad(t.getMonth() + 1) + '/' + pad(t.getDate());
}

function now() { var t = new Date(); return { h: t.getHours(), m: t.getMinutes(), day: t.getDay() }; }

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

function msgNotReady() {
  var h = now().h;
  if (h < 8) return 'KRIBB meal (' + todayStr() + ')\n\nNot yet updated.\nAuto-send: lunch 11:00 / dinner 17:30';
  return 'KRIBB meal (' + todayStr() + ')\n\nNot yet updated.';
}

function msgClosed() {
  return 'KRIBB meal (' + todayStr() + ')\n\nDone for today.\nNext update tomorrow.';
}

function msgLunch(data) {
  if (now().h >= 19) return msgClosed();
  if (!isUpdated(data) || !data.lunchA) return msgNotReady();
  var msg = '<b>Lunch</b> (11:30-13:00)\n\n' + escHtml(data.lunchA);
  if (data.insight) msg += '\n\n✨ <b>AI Insight</b>\n' + escHtml(data.insight);
  return msg;
}

function msgDinner(data) {
  if (now().h >= 19) return msgClosed();
  if (!isUpdated(data) || !data.dinner) return msgNotReady();
  var msg = '<b>Dinner</b> (18:00-19:00)\n\n' + escHtml(data.dinner);
  if (data.insight) msg += '\n\n✨ <b>AI Insight</b>\n' + escHtml(data.insight);
  return msg;
}

function msgAll(data) {
  if (now().h >= 19) return msgClosed();
  if (!isUpdated(data)) return msgNotReady();
  var msg = '<b>KRIBB meal</b> (' + data.date + ')\n';
  if (data.lunchA) msg += '\n<b>Lunch</b> (11:30-13:00)\n' + escHtml(data.lunchA) + '\n';
  if (data.dinner) msg += '\n<b>Dinner</b> (18:00-19:00)\n' + escHtml(data.dinner) + '\n';
  return msg;
}

function msgTest(data) {
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
        tgSend(chatId, msgLunch(data));
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
        tgSend(chatId, msgLunch(data));
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
  var body = JSON.parse(e.postData.contents);

  // Check if meal data exists for today
  if (body.action === 'check_meal') {
    var data = getMeal();
    return ContentService.createTextOutput(JSON.stringify({ ok: true, updated: isUpdated(data) }));
  }

  // WSL meal data upload
  if (body.action === 'update_meal') {
    saveMeal(body.data);
    catchUpSend();
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
  migrateIfNeeded();
  scheduledTasks();
  pollMessages();
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
