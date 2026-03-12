var BOT_TOKEN = 'YOUR_BOT_TOKEN';
var TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;
var SCRIPT_PROPS = PropertiesService.getScriptProperties();

// === Telegram API ===
function sendMessage(chatId, text) {
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

// === User Management ===
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

// === Meal Data ===
function saveMeal(data) {
  SCRIPT_PROPS.setProperty('meal', JSON.stringify(data));
}

function getMeal() {
  var raw = SCRIPT_PROPS.getProperty('meal');
  return raw ? JSON.parse(raw) : null;
}

// === Format ===
function todayStr() {
  var t = new Date();
  var y = t.getFullYear();
  var m = String(t.getMonth() + 1).padStart(2, '0');
  var d = String(t.getDate()).padStart(2, '0');
  return y + '/' + m + '/' + d;
}

function isUpdated(data) {
  return data && data.date === todayStr() && (data.breakfast || data.lunchA || data.dinner);
}

function notUpdatedMsg() {
  return '*KRIBB \uC624\uB298\uC758 \uC2DD\uB2E8* (' + todayStr() + ')\n\n\u26A0\uFE0F \uC544\uC9C1 \uC2DD\uB2E8\uC774 \uC5C5\uB370\uC774\uD2B8\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.';
}

function formatAll(data) {
  if (!isUpdated(data)) return notUpdatedMsg();
  var msg = '*KRIBB \uC624\uB298\uC758 \uC2DD\uB2E8* (' + data.date + ')\n';
  if (data.breakfast) msg += '\n\uD83C\uDF05 *\uC870\uC2DD* (7:30~9:00)\n' + data.breakfast + '\n';
  if (data.lunchA) msg += '\n\uD83C\uDF1E *\uC911\uC2DD* (11:30~13:00)\n' + data.lunchA + '\n';
  if (data.dinner) msg += '\n\uD83C\uDF19 *\uC11D\uC2DD* (18:00~19:00)\n' + data.dinner + '\n';
  return msg;
}

function formatSingle(emoji, title, time, data, field) {
  if (!isUpdated(data)) return notUpdatedMsg();
  if (!data[field]) return emoji + ' \uC624\uB298 ' + title + ' \uC815\uBCF4\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.';
  return emoji + ' *' + title + '* (' + time + ')\n\n' + data[field];
}

// === Poll: 1\uBD84\uB9C8\uB2E4 \uC2E4\uD589 (\uC2DC\uAC04 \uD2B8\uB9AC\uAC70) ===
function pollMessages() {
  var updates = getUpdates();
  for (var i = 0; i < updates.length; i++) {
    var update = updates[i];
    SCRIPT_PROPS.setProperty('offset', String(update.update_id + 1));

    var msg = update.message;
    if (!msg || !msg.text) continue;

    var chatId = msg.chat.id;
    var text = msg.text.split('@')[0].trim();
    var data = getMeal();

    addUser(chatId);

    if (text === '/start') {
      sendMessage(chatId, '\uD83C\uDF7D *KRIBB \uC2DD\uB2E8\uBD07*\n\n\uB9E4\uC77C 08:30 \uC790\uB3D9 \uC804\uC1A1\n\n/\uC544\uCE68 - \uC870\uC2DD\n/\uC810\uC2EC - \uC911\uC2DD\n/\uC800\uB141 - \uC11D\uC2DD\n/\uC2DD\uB2E8 - \uC804\uCCB4');
    } else if (text === '/\uC544\uCE68' || text === '/\uC870\uC2DD') {
      sendMessage(chatId, formatSingle('\uD83C\uDF05', '\uC870\uC2DD', '7:30~9:00', data, 'breakfast'));
    } else if (text === '/\uC810\uC2EC' || text === '/\uC911\uC2DD') {
      sendMessage(chatId, formatSingle('\uD83C\uDF1E', '\uC911\uC2DD', '11:30~13:00', data, 'lunchA'));
    } else if (text === '/\uC800\uB141' || text === '/\uC11D\uC2DD') {
      sendMessage(chatId, formatSingle('\uD83C\uDF19', '\uC11D\uC2DD', '18:00~19:00', data, 'dinner'));
    } else if (text === '/\uC2DD\uB2E8') {
      sendMessage(chatId, formatAll(data));
    }
  }
}

// === WSL \uC6F9\uD6C5 \uC218\uC2E0 ===
function doPost(e) {
  var body = JSON.parse(e.postData.contents);

  if (body.action === 'update_meal') {
    saveMeal(body.data);

    if (body.broadcast) {
      var users = getUsers();
      var msg = formatAll(body.data);
      for (var i = 0; i < users.length; i++) {
        try { sendMessage(users[i], msg); } catch (err) {}
      }
    }

    return ContentService.createTextOutput(JSON.stringify({ ok: true, users: users ? users.length : 0 }));
  }

  return ContentService.createTextOutput('ok');
}

// === \uCD08\uAE30 \uC124\uC815: \uC6F9\uD6C5 \uC81C\uAC70 + \uD3F4\uB9C1 \uD2B8\uB9AC\uAC70 \uC124\uC815 ===
function setup() {
  // \uAE30\uC874 \uC6F9\uD6C5 \uC81C\uAC70
  UrlFetchApp.fetch(TG_API + '/deleteWebhook');

  // \uAE30\uC874 \uD2B8\uB9AC\uAC70 \uC0AD\uC81C
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }

  // 1\uBD84 \uAC04\uACA9 \uD3F4\uB9C1 \uD2B8\uB9AC\uAC70 \uC0DD\uC131
  ScriptApp.newTrigger('pollMessages')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('Setup complete: webhook deleted, polling trigger created');
}
