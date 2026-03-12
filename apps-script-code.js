// ============================================================
// KRIBB Meal Bot — Google Apps Script
//
// Telegram bot that serves KRIBB cafeteria menu.
// Receives meal data from WSL crawler via doPost.
// Responds to user commands via webhook + polling backup.
// Auto-sends lunch at 11:00, dinner at 17:30.
// Clears data at 19:00.
// ============================================================

var BOT_TOKEN = 'YOUR_BOT_TOKEN';
var TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;
var PROPS = PropertiesService.getScriptProperties();

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

// --- Storage ---

function getUsers() {
  var raw = PROPS.getProperty('users');
  return raw ? JSON.parse(raw) : [];
}

function addUser(chatId) {
  var users = getUsers();
  if (users.indexOf(chatId) === -1) {
    users.push(chatId);
    PROPS.setProperty('users', JSON.stringify(users));
  }
}

function saveMeal(data) { PROPS.setProperty('meal', JSON.stringify(data)); }
function getMeal() { var r = PROPS.getProperty('meal'); return r ? JSON.parse(r) : null; }
function clearMeal() { PROPS.deleteProperty('meal'); }

// --- Time helpers ---

function todayStr() {
  var t = new Date();
  return t.getFullYear() + '/' + String(t.getMonth() + 1).padStart(2, '0') + '/' + String(t.getDate()).padStart(2, '0');
}

function now() { var t = new Date(); return { h: t.getHours(), m: t.getMinutes(), day: t.getDay() }; }

function isUpdated(data) {
  return data && data.date === todayStr() && (data.lunchA || data.dinner);
}

// --- Message formatting ---

function msgNotReady() {
  var h = now().h;
  if (h < 8) return 'KRIBB meal (' + todayStr() + ')\n\nNot yet updated.\nAuto-send: lunch 11:00 / dinner 17:30';
  return 'KRIBB meal (' + todayStr() + ')\n\nNot yet updated.';
}

function msgClosed() {
  return 'KRIBB meal (' + todayStr() + ')\n\nDone for today.\nNext update tomorrow at 11:00.';
}

function msgLunch(data) {
  if (!isUpdated(data) || !data.lunchA) return msgNotReady();
  return '<b>Lunch</b> (11:30-13:00)\n\n' + escHtml(data.lunchA);
}

function msgDinner(data) {
  if (!isUpdated(data) || !data.dinner) return msgNotReady();
  return '<b>Dinner</b> (18:00-19:00)\n\n' + escHtml(data.dinner);
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
  return '<b>KRIBB Meal Bot</b>\n\nAuto schedule:\n11:00 - Lunch\n17:30 - Dinner\n\n/lunch - Lunch menu\n/dinner - Dinner menu\n/meal - All\n/test - Preview';
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Command handler (shared by webhook + polling) ---

function handleCommand(chatId, text) {
  var data = getMeal();
  addUser(chatId);

  if (text === '/start' || text === '/help') tgSend(chatId, msgHelp());
  else if (text === '/lunch') tgSend(chatId, msgLunch(data));
  else if (text === '/dinner') tgSend(chatId, msgDinner(data));
  else if (text === '/meal') tgSend(chatId, msgAll(data));
  else if (text === '/test') tgSend(chatId, msgTest(data));
}

// --- Broadcast ---

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

// --- Scheduled tasks (called every minute) ---

function scheduledTasks() {
  var t = now();
  var today = todayStr();

  // Weekday only
  if (t.day === 0 || t.day === 6) return;

  // 11:00 lunch broadcast
  if (t.h === 11 && t.m === 0 && PROPS.getProperty('lunchSent') !== today) {
    PROPS.setProperty('lunchSent', today);
    broadcast(msgLunch);
  }

  // 17:30 dinner broadcast
  if (t.h === 17 && t.m === 30 && PROPS.getProperty('dinnerSent') !== today) {
    PROPS.setProperty('dinnerSent', today);
    broadcast(msgDinner);
  }

  // 19:00 clear
  if (t.h >= 19 && PROPS.getProperty('cleared') !== today) {
    PROPS.setProperty('cleared', today);
    clearMeal();
    Logger.log('Meal data cleared');
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
  var body = JSON.parse(e.postData.contents);

  // Check if meal data exists for today
  if (body.action === 'check_meal') {
    var data = getMeal();
    return ContentService.createTextOutput(JSON.stringify({ ok: true, updated: isUpdated(data) }));
  }

  // WSL meal data upload
  if (body.action === 'update_meal') {
    saveMeal(body.data);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, users: getUsers().length }));
  }

  // Telegram webhook (instant response)
  if (body.message && body.message.text) {
    handleCommand(body.message.chat.id, body.message.text.split('@')[0].trim());
    return ContentService.createTextOutput('ok');
  }

  return ContentService.createTextOutput('ok');
}

// 1-min trigger: scheduled sends + cleanup + polling backup
function tick() {
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
