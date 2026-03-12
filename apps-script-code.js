var BOT_TOKEN = 'YOUR_BOT_TOKEN';
var TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;
var SCRIPT_PROPS = PropertiesService.getScriptProperties();

function sendMessage(chatId, text) {
  if (!text || text.length === 0) {
    Logger.log('SKIP: empty message for chat ' + chatId);
    return;
  }
  Logger.log('SEND to ' + chatId + ': ' + text.substring(0, 50));
  UrlFetchApp.fetch(TG_API + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' })
  });
}

function getUpdates() {
  var offset = SCRIPT_PROPS.getProperty('offset') || '0';
  var res = UrlFetchApp.fetch(TG_API + '/getUpdates?offset=' + offset + '&timeout=0');
  var data = JSON.parse(res.getContentText());
  return data.result || [];
}

function getUsers() {
  var raw = SCRIPT_PROPS.getProperty('users');
  return raw ? JSON.parse(raw) : [];
}

function addUser(chatId) {
  var users = getUsers();
  if (users.indexOf(chatId) === -1) {
    users.push(chatId);
    SCRIPT_PROPS.setProperty('users', JSON.stringify(users));
  }
}

function saveMeal(data) {
  SCRIPT_PROPS.setProperty('meal', JSON.stringify(data));
}

function getMeal() {
  var raw = SCRIPT_PROPS.getProperty('meal');
  return raw ? JSON.parse(raw) : null;
}

function clearMeal() {
  SCRIPT_PROPS.deleteProperty('meal');
  Logger.log('Meal data cleared');
}

function todayStr() {
  var t = new Date();
  var y = t.getFullYear();
  var m = String(t.getMonth() + 1).padStart(2, '0');
  var d = String(t.getDate()).padStart(2, '0');
  return y + '/' + m + '/' + d;
}

function currentHour() {
  return new Date().getHours();
}

function currentMinute() {
  return new Date().getMinutes();
}

function isUpdated(data) {
  return data && data.date === todayStr() && (data.breakfast || data.lunchA || data.dinner);
}

function notUpdatedMsg() {
  if (currentHour() < 8) {
    return 'KRIBB meal (' + todayStr() + ')\n\nNot yet updated. Auto-send at 11:00.';
  }
  return 'KRIBB meal (' + todayStr() + ')\n\nNot yet updated.';
}

function closedMsg() {
  return 'KRIBB meal (' + todayStr() + ')\n\nToday\'s meals have ended.\nNew menu tomorrow at 11:00.';
}

function formatLunch(data) {
  if (!isUpdated(data)) return notUpdatedMsg();
  if (!data.lunchA) return 'No lunch info today.';
  return '*Lunch* (11:30-13:00)\n\n' + data.lunchA;
}

function formatDinner(data) {
  if (!isUpdated(data)) return notUpdatedMsg();
  if (!data.dinner) return 'No dinner info today.';
  return '*Dinner* (18:00-19:00)\n\n' + data.dinner;
}

function formatAll(data) {
  if (currentHour() >= 19) return closedMsg();
  if (!isUpdated(data)) return notUpdatedMsg();
  var msg = '*KRIBB meal* (' + data.date + ')\n';
  if (data.lunchA) msg += '\n*Lunch* (11:30-13:00)\n' + data.lunchA + '\n';
  if (data.dinner) msg += '\n*Dinner* (18:00-19:00)\n' + data.dinner + '\n';
  return msg;
}

function formatSingle(title, time, data, field) {
  if (currentHour() >= 19) return closedMsg();
  if (!isUpdated(data)) return notUpdatedMsg();
  if (!data[field]) return 'No ' + title + ' info today.';
  return '*' + title + '* (' + time + ')\n\n' + data[field];
}

// /test: 현재 저장된 식단을 바로 확인 (브로드캐스트 미리보기)
function formatTest(data) {
  if (!isUpdated(data)) return notUpdatedMsg();
  var msg = '[TEST] *KRIBB meal* (' + data.date + ')\n';
  if (data.lunchA) msg += '\n*Lunch* (11:30-13:00)\n' + data.lunchA + '\n';
  if (data.dinner) msg += '\n*Dinner* (18:00-19:00)\n' + data.dinner + '\n';
  msg += '\n-- This is what users will receive --';
  return msg;
}

function pollMessages() {
  var updates = getUpdates();
  Logger.log('Updates: ' + updates.length);

  for (var i = 0; i < updates.length; i++) {
    var update = updates[i];
    SCRIPT_PROPS.setProperty('offset', String(update.update_id + 1));

    var msg = update.message;
    if (!msg || !msg.text) continue;

    var chatId = msg.chat.id;
    var text = msg.text.split('@')[0].trim();
    Logger.log('CMD: ' + text + ' from ' + chatId);

    var data = getMeal();
    addUser(chatId);

    handleCommand(chatId, text);
  }
}

// 자동 전송 스케줄: 11:00 점심, 17:30 저녁
function checkScheduledSend() {
  var hour = currentHour();
  var minute = currentMinute();
  var today = todayStr();
  var data = getMeal();

  if (!isUpdated(data)) return;

  // 11:00 점심 자동 전송
  var lunchSent = SCRIPT_PROPS.getProperty('lunchSentDate') || '';
  if (hour === 11 && minute === 0 && lunchSent !== today) {
    SCRIPT_PROPS.setProperty('lunchSentDate', today);
    var users = getUsers();
    var msg = formatLunch(data);
    for (var i = 0; i < users.length; i++) {
      try { sendMessage(users[i], msg); } catch (err) {}
    }
    Logger.log('Lunch broadcast sent to ' + users.length + ' users');
  }

  // 17:30 저녁 자동 전송
  var dinnerSent = SCRIPT_PROPS.getProperty('dinnerSentDate') || '';
  if (hour === 17 && minute === 30 && dinnerSent !== today) {
    SCRIPT_PROPS.setProperty('dinnerSentDate', today);
    var users = getUsers();
    var msg = formatDinner(data);
    for (var i = 0; i < users.length; i++) {
      try { sendMessage(users[i], msg); } catch (err) {}
    }
    Logger.log('Dinner broadcast sent to ' + users.length + ' users');
  }
}

// 19:00 데이터 삭제
function checkAndClear() {
  var hour = currentHour();
  var cleared = SCRIPT_PROPS.getProperty('clearedDate') || '';
  var today = todayStr();

  if (hour >= 19 && cleared !== today) {
    clearMeal();
    SCRIPT_PROPS.setProperty('clearedDate', today);
  }
}

// 명령어 처리 (폴링 + 웹훅 공용)
function handleCommand(chatId, text) {
  var data = getMeal();
  addUser(chatId);

  if (text === '/start') {
    sendMessage(chatId, '*KRIBB Meal Bot*\n\nAuto schedule:\n11:00 - Lunch menu\n17:30 - Dinner menu\n\nCommands:\n/lunch - Lunch\n/dinner - Dinner\n/meal - All\n/test - Preview');
  } else if (text === '/lunch') {
    sendMessage(chatId, formatSingle('Lunch', '11:30-13:00', data, 'lunchA'));
  } else if (text === '/dinner') {
    sendMessage(chatId, formatSingle('Dinner', '18:00-19:00', data, 'dinner'));
  } else if (text === '/meal') {
    sendMessage(chatId, formatAll(data));
  } else if (text === '/test') {
    sendMessage(chatId, formatTest(data));
  }
}

function doPost(e) {
  var body = JSON.parse(e.postData.contents);

  // WSL 데이터 업로드
  if (body.action === 'update_meal') {
    saveMeal(body.data);
    return ContentService.createTextOutput(JSON.stringify({ ok: true, users: getUsers().length }));
  }

  // 텔레그램 웹훅 (즉시 응답)
  if (body.message && body.message.text) {
    var chatId = body.message.chat.id;
    var text = body.message.text.split('@')[0].trim();
    handleCommand(chatId, text);
    return ContentService.createTextOutput('ok');
  }

  return ContentService.createTextOutput('ok');
}

function setup() {
  // 기존 트리거 삭제
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }

  // 1분 트리거: 스케줄 전송 + 데이터 삭제 + 폴링 백업
  ScriptApp.newTrigger('pollAndClean')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('Setup complete');
  Logger.log('Now set webhook in browser:');
  Logger.log('https://api.telegram.org/bot[TOKEN]/setWebhook?url=[APPS_SCRIPT_URL]');
}

function pollAndClean() {
  checkAndClear();
  checkScheduledSend();
  pollMessages();
}
