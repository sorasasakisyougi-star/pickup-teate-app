/**
 * Phase 1 — GAS サーバーサイド。
 *
 * 責務:
 *   - doGet: index.html を返す (LIFF_ID を埋め込む)
 *   - loadMasters: 各マスタを読んでフォーム初期化用に返す
 *   - saveReport: 送信されたペイロードを検証して test sheet へ追記
 *   - checkAllowed: 許可マスタで LINE userId を判定
 *
 * 原則:
 *   - Phase 0 引継: test sheet 先行 / google.script.run のみ / 会社管理アカウント所有
 *   - doPost は実装しない
 *   - Secrets (Channel secret 等) には触らない
 */

// --- Script Properties accessors ------------------------------------------

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function getLiffId_()  { return getProp_('LIFF_ID'); }
function getSheetId_() { return getProp_('SHEET_ID'); }
function isTestMode_() { return getProp_('TEST_MODE') === '1'; }

function getSpreadsheet_() {
  var id = getSheetId_();
  if (!id) throw new Error('SHEET_ID が未設定です');
  return SpreadsheetApp.openById(id);
}

function getSheetByName_(name) {
  var sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('シート "' + name + '" が見つかりません');
  return sh;
}

function getTargetReportSheet_() {
  return getSheetByName_(isTestMode_() ? '送迎記録_test' : '送迎記録');
}

// --- doGet ----------------------------------------------------------------

function doGet() {
  var t = HtmlService.createTemplateFromFile('index');
  t.liffId = getLiffId_();
  t.testMode = isTestMode_();
  return t.evaluate()
    .setTitle('送迎報告')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// --- loadMasters (google.script.run から呼ばれる) ------------------------

/**
 * フォーム初期化用にマスタを返す。呼出前に userId を allowlist で判定する。
 */
function loadMasters(userId) {
  var allow = checkAllowed_(userId);
  if (!allow.ok) {
    throw new Error(allow.reason);
  }
  return {
    drivers:   readMaster_('運転者マスタ', ['driver_name', 'active', 'default_vehicle'])
                 .filter(function(r) { return r.active === true || r.active === 'TRUE'; })
                 .map(function(r) { return r.driver_name; }),
    vehicles:  readMaster_('車両マスタ',  ['vehicle_name', 'active'])
                 .filter(function(r) { return r.active === true || r.active === 'TRUE'; })
                 .map(function(r) { return r.vehicle_name; }),
    locations: readMaster_('地点マスタ',  ['location_name', 'category'])
                 .map(function(r) { return r.location_name; }),
    displayName: allow.displayName,
  };
}

// --- saveReport (google.script.run から呼ばれる) -------------------------

/**
 * ペイロード例:
 *   {
 *     userId: 'Uxxx...',
 *     reportedAt: '2026-04-19T10:15:00+09:00',
 *     driver: '山田太郎',
 *     vehicle: 'ハイエース',
 *     mode: '通常ルート',    // '通常ルート' | 'バス'
 *     from: '会社',
 *     arrivals: ['A病院', 'B老人ホーム'],  // 1..8
 *     odoStart: 215159,
 *     odoEnd: 215185,
 *     note: '雨'
 *   }
 */
function saveReport(payload) {
  var startedAt = new Date();
  var userId = payload && payload.userId ? String(payload.userId) : '';
  try {
    var allow = checkAllowed_(userId);
    if (!allow.ok) {
      logPost_(startedAt, userId, 'saveReport', 'unauthorized', allow.reason);
      throw new Error('unauthorized:' + allow.reason);
    }

    var v = validatePayload_(payload);
    if (!v.ok) {
      logPost_(startedAt, userId, 'saveReport', 'invalid', v.error);
      throw new Error('invalid:' + v.error);
    }

    var fareYen = resolveFare_(payload);
    if (fareYen == null) {
      logPost_(startedAt, userId, 'saveReport', 'error', 'fare_not_registered');
      throw new Error('fare_not_registered');
    }

    var totalKm = resolveTotalKm_(payload);
    if (totalKm == null) {
      logPost_(startedAt, userId, 'saveReport', 'error', 'distance_not_registered');
      throw new Error('distance_not_registered');
    }

    var sh = getTargetReportSheet_();
    var row = buildRow_(payload, fareYen, totalKm, allow.displayName);
    sh.appendRow(row);

    logPost_(startedAt, userId, 'saveReport', 'ok', '');
    return {
      ok: true,
      savedAt: Utilities.formatDate(startedAt, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    };
  } catch (e) {
    var msg = String(e.message || '');
    // 既知の invalid/unauthorized/fare/distance は上で log 済。ここは想定外例外。
    if (msg.indexOf('unauthorized:') !== 0 &&
        msg.indexOf('invalid:') !== 0 &&
        msg !== 'fare_not_registered' &&
        msg !== 'distance_not_registered') {
      logPost_(startedAt, userId, 'saveReport', 'error', msg || String(e));
    }
    throw e;
  }
}

// --- Allowlist ------------------------------------------------------------

function checkAllowed_(userId) {
  if (!userId) return { ok: false, reason: 'missing_user_id' };
  var rows = readMaster_('許可マスタ', ['line_user_id', 'display_name', 'role', 'active']);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].line_user_id !== userId) continue;
    var active = rows[i].active === true || rows[i].active === 'TRUE';
    if (!active) return { ok: false, reason: 'inactive_user' };
    var role = String(rows[i].role || '');
    if (role !== '送迎報告' && role !== '両方') {
      return { ok: false, reason: 'role_not_permitted' };
    }
    return { ok: true, displayName: rows[i].display_name };
  }
  return { ok: false, reason: 'user_not_registered' };
}

// --- Validation -----------------------------------------------------------

function validatePayload_(p) {
  if (!p) return { ok: false, error: 'empty_payload' };
  if (!p.driver)  return { ok: false, error: 'missing_driver' };
  if (!p.vehicle) return { ok: false, error: 'missing_vehicle' };
  if (p.mode !== '通常ルート' && p.mode !== 'バス') {
    return { ok: false, error: 'invalid_mode' };
  }
  if (!p.from) return { ok: false, error: 'missing_from' };
  var arrivals = Array.isArray(p.arrivals)
    ? p.arrivals.filter(function(a) { return a && String(a).trim(); })
    : [];
  if (arrivals.length === 0) return { ok: false, error: 'missing_arrivals' };
  if (arrivals.length > 8) return { ok: false, error: 'too_many_arrivals' };
  var s = Number(p.odoStart), e = Number(p.odoEnd);
  if (!isFinite(s) || !isFinite(e)) return { ok: false, error: 'missing_odo' };
  if (e < s) return { ok: false, error: 'odo_end_before_start' };
  return { ok: true };
}

// --- Fare / distance lookup ----------------------------------------------

function resolveFare_(payload) {
  if (payload.mode === 'バス') return 2000;
  var fares = readMaster_('料金マスタ', ['from', 'to', 'amount_yen']);
  var chain = [payload.from].concat(
    (payload.arrivals || []).filter(function(a) { return a && String(a).trim(); })
  );
  var sum = 0;
  for (var i = 0; i < chain.length - 1; i++) {
    var from = chain[i], to = chain[i + 1];
    var row = fares.filter(function(r) { return r.from === from && r.to === to; })[0];
    if (!row) return null;
    var yen = Number(row.amount_yen);
    if (!isFinite(yen)) return null;
    sum += yen;
  }
  return sum;
}

function resolveTotalKm_(payload) {
  if (payload.mode === 'バス') return 0;
  var rows = readMaster_('距離マスタ', ['from', 'to', 'distance_km']);
  var chain = [payload.from].concat(
    (payload.arrivals || []).filter(function(a) { return a && String(a).trim(); })
  );
  var sum = 0;
  for (var i = 0; i < chain.length - 1; i++) {
    var from = chain[i], to = chain[i + 1];
    var row = rows.filter(function(r) { return r.from === from && r.to === to; })[0];
    if (!row) return null;
    var km = Number(row.distance_km);
    if (!isFinite(km)) return null;
    sum += km;
  }
  return Math.round(sum * 10) / 10;
}

// --- Row assembly (sheet-schema.md の列順と一致) -------------------------

function buildRow_(p, fareYen, totalKm, displayName) {
  var arrivals = (p.arrivals || []).filter(function(a) { return a && String(a).trim(); });
  var padded = arrivals.slice(0, 8);
  while (padded.length < 8) padded.push('');
  var reportedDate = p.reportedAt ? new Date(p.reportedAt) : new Date();
  var dateDisplay = Utilities.formatDate(reportedDate, 'Asia/Tokyo', 'yyyy/M/d');
  var reportedIso = Utilities.formatDate(reportedDate, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");

  return [
    reportedIso,        // A: 報告時刻
    dateDisplay,        // B: 日付
    p.driver,           // C: 運転者
    p.vehicle,          // D: 車両
    p.mode,             // E: 区分
    p.from,             // F: 出発地
    padded[0],          // G: 到着1
    padded[1],          // H: 到着2
    padded[2],          // I: 到着3
    padded[3],          // J: 到着4
    padded[4],          // K: 到着5
    padded[5],          // L: 到着6
    padded[6],          // M: 到着7
    padded[7],          // N: 到着8
    Number(p.odoStart), // O: ODO始
    Number(p.odoEnd),   // P: ODO終
    fareYen,            // Q: 金額
    totalKm,            // R: 総走行距離
    p.note || '',       // S: 備考
    p.userId,           // T: 投稿userId
    displayName,        // U: 投稿者表示名
  ];
}

// --- Logging --------------------------------------------------------------

function logPost_(whenDate, userId, action, result, message) {
  try {
    var sh = getSheetByName_('投稿ログ');
    sh.appendRow([
      Utilities.formatDate(whenDate || new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"),
      userId || '',
      action || '',
      result || '',
      message || '',
    ]);
  } catch (e) {
    // 投稿ログ書込失敗で saveReport 本線を壊さない (副作用扱い)
    Logger.log('logPost_ failed: ' + e);
  }
}

// --- Generic master reader -----------------------------------------------

/**
 * ヘッダー行をキーにして {key: value, ...} の配列を返す。
 * `expectedColumns` は列順の検証用。ミスマッチ時は例外。
 */
function readMaster_(sheetName, expectedColumns) {
  var sh = getSheetByName_(sheetName);
  var range = sh.getDataRange().getValues();
  if (range.length < 1) return [];
  var header = range[0].map(function(h) { return String(h || '').trim(); });
  for (var i = 0; i < expectedColumns.length; i++) {
    if (header[i] !== expectedColumns[i]) {
      throw new Error('シート "' + sheetName + '" の列 ' + (i + 1) +
        ' が想定と違います: 期待="' + expectedColumns[i] + '" 実測="' + header[i] + '"');
    }
  }
  var out = [];
  for (var r = 1; r < range.length; r++) {
    var row = range[r];
    if (row.every(function(v) { return v === '' || v == null; })) continue;
    var obj = {};
    for (var c = 0; c < expectedColumns.length; c++) {
      obj[expectedColumns[c]] = row[c];
    }
    out.push(obj);
  }
  return out;
}
