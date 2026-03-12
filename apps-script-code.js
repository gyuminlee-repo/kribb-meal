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
  return 'KRIBB meal (' + todayStr() + ')\n\nNot yet updated.';
}

function formatAll(data) {
  if (!isUpdated(data)) return notUpdatedMsg();
  var msg = '*KRIBB meal* (' + data.date + ')\n';
  if (data.breakfast) msg += '\n*Breakfast* (7:30-9:00)\n' + data.breakfast + '\n';
  if (data.lunchA) msg += '\n*Lunch* (11:30-13:00)\n' + data.lunchA + '\n';
  if (data.dinner) msg += '\n*Dinner* (18:00-19:00)\n' + data.dinner + '\n';
  return msg;
}

function formatSingle(title, time, data, field) {
  if (!isUpdated(data)) return notUpdatedMsg();
  if (!data[field]) return 'No ' + title + ' info today.';
  return '*' + title + '* (' + time + ')\n\n' + data[field];
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

    if (text === '/start') {
      sendMessage(chatId, '*KRIBB Meal Bot*\n\nAuto-send weekdays 08:30\n\n/breakfast\n/lunch\n/dinner\n/meal - all');
    } else if (text === '/breakfast') {
      sendMessage(chatId, formatSingle('Breakfast', '7:30-9:00', data, 'breakfast'));
    } else if (text === '/lunch') {
      sendMessage(chatId, formatSingle('Lunch', '11:30-13:00', data, 'lunchA'));
    } else if (text === '/dinner') {
      sendMessage(chatId, formatSingle('Dinner', '18:00-19:00', data, 'dinner'));
    } else if (text === '/meal') {
      sendMessage(chatId, formatAll(data));
    }
  }
}

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

function setup() {
  UrlFetchApp.fetch(TG_API + '/deleteWebhook');

  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }

  ScriptApp.newTrigger('pollMessages')
    .timeBased()
    .everyMinutes(1)
    .create();

  Logger.log('Setup complete');
}
