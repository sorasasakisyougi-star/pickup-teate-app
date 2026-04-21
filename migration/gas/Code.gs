/**
 * Phase 1 — GAS サーバーサイド (修理8: 名前+PIN ログイン方式へ切替)。
 *
 * 責務:
 *   - doGet: index.html を返す (LIFF_ID を埋め込む、入口用)
 *   - loadPickupLoginNames: ログイン画面の表示名 select を埋める (新本線)
 *   - loginAndLoadMasters: 表示名+PIN で認証してマスタを返す (新本線)
 *   - saveReport: loginName+PIN 再検証 → test sheet へ追記
 *   - checkAllowedByPin_: 送迎PINマスタ で名前+PIN を判定
 *
 * 原則:
 *   - Phase 0 引継: test sheet 先行 / google.script.run のみ / 会社管理アカウント所有
 *   - doPost は実装しない
 *   - Secrets (Channel secret 等) には触らない
 *   - 運転者名は 送迎PINマスタ.運転者名 が正本 (クライアント値は使わない)
 *   - reportedAt も server-side で確定 (クライアント値は使わない)
 *   - vehicle / from / arrivals は server-side でマスタ存在チェック
 *   - PIN は 送迎記録_test / 投稿ログ に残さない (シートの 送迎PINマスタ にのみ存在)
 *
 * Legacy:
 *   - 旧 loadMasters(userId) / checkAllowed_ は 許可マスタ ベース。いきなり削除せず
 *     legacy 扱いで残す (新本線は必ず loginAndLoadMasters + 送迎PINマスタ を使う)。
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

// --- PIN-based login (新本線) --------------------------------------------

/**
 * ログイン画面の 表示名 select を埋めるために active=TRUE && 送迎利用可=TRUE の
 * 行の表示名だけを返す (PIN は返さない)。認証前呼び出しなので PIN/userId は受け取らない。
 */
function loadPickupLoginNames() {
  return readMaster_('送迎PINマスタ',
      ['表示名', 'PIN', 'active', '送迎利用可', '運転者名'])
    .filter(function(r) {
      var active = r.active === true || r.active === 'TRUE';
      var pickupOk = r['送迎利用可'] === true || r['送迎利用可'] === 'TRUE';
      return active && pickupOk;
    })
    .map(function(r) { return String(r['表示名'] || '').trim(); })
    .filter(function(name) { return name.length > 0; });
}

/**
 * 表示名+PIN を検証してフォーム初期化用のマスタを返す (新本線)。
 * 運転者名は 送迎PINマスタ.運転者名 が正本なので UI へは driverName/displayName
 * だけを返す (運転者リストは UI の select 対象にしない)。
 */
function loginAndLoadMasters(displayName, pin) {
  var allow = checkAllowedByPin_(displayName, pin);
  if (!allow.ok) {
    throw new Error(allow.reason);
  }
  return {
    vehicles:  loadVehicleNames_(),
    locations: loadLocationNames_(),
    displayName: allow.displayName,
    driverName:  allow.driverName,
  };
}

// --- loadMasters (LEGACY: LINE userId 方式、未使用化) --------------------

/**
 * @deprecated 修理8 で PIN ログイン方式へ切替。新本線は loginAndLoadMasters 参照。
 * 既存 許可マスタ 行の緊急フォールバック用に残す (いきなり削除しない)。
 */
function loadMasters(userId) {
  var allow = checkAllowed_(userId);
  if (!allow.ok) {
    throw new Error(allow.reason);
  }
  return {
    vehicles:  loadVehicleNames_(),
    locations: loadLocationNames_(),
    displayName: allow.displayName,
    driverName:  allow.driverName,
  };
}

// --- saveReport (google.script.run から呼ばれる) -------------------------

/**
 * 受け付けるペイロード (クライアント、修理8):
 *   {
 *     loginName: 'アジ',
 *     pin:       '1234',
 *     vehicle:   'ハイエース',
 *     mode:      '通常ルート',    // '通常ルート' | 'バス'
 *     from:      '会社',
 *     arrivals:  ['A病院', 'B老人ホーム'],  // 1..8
 *     odoStart:  215159,
 *     odoEnd:    215185,
 *     note:      '雨'
 *   }
 *
 * 受け付けないフィールド (server 側で上書きまたは無視):
 *   - driver      (送迎PINマスタ.運転者名 を正本にする)
 *   - reportedAt  (new Date() を正本にする)
 *   - userId      (LINE userId 方式は廃止)
 *
 * PIN は 送迎記録_test にも 投稿ログ にも残さない。
 * 投稿ログ の subject は loginName (表示名) のみ。
 */
function saveReport(payload) {
  var reportedAtServer = new Date();
  var loginName = payload && payload.loginName ? String(payload.loginName) : '';
  var pin       = payload && payload.pin       ? String(payload.pin)       : '';
  try {
    var allow = checkAllowedByPin_(loginName, pin);
    if (!allow.ok) {
      logPost_(reportedAtServer, loginName, 'saveReport', 'unauthorized', allow.reason);
      throw new Error('unauthorized:' + allow.reason);
    }

    var v = validatePayload_(payload);
    if (!v.ok) {
      logPost_(reportedAtServer, loginName, 'saveReport', 'invalid', v.error);
      throw new Error('invalid:' + v.error);
    }

    // 送迎PINマスタ.運転者名 が 運転者マスタ に存在するか
    var activeDrivers = loadActiveDriverNames_();
    if (activeDrivers.indexOf(allow.driverName) === -1) {
      logPost_(reportedAtServer, loginName, 'saveReport', 'error', 'driver_not_in_master:' + allow.driverName);
      throw new Error('driver_not_in_master');
    }

    // vehicle は 車両マスタに存在するか
    var vehicles = loadVehicleNames_();
    if (vehicles.indexOf(payload.vehicle) === -1) {
      logPost_(reportedAtServer, loginName, 'saveReport', 'error', 'vehicle_not_registered:' + payload.vehicle);
      throw new Error('vehicle_not_registered');
    }

    // from + arrivals の全要素は 地点マスタに存在するか (通常ルートのみ)。
    // バスは既存本線と同じく from / arrivals を空で保存するので地点マスタ照合しない。
    if (payload.mode === '通常ルート') {
      var locations = loadLocationNames_();
      if (locations.indexOf(payload.from) === -1) {
        logPost_(reportedAtServer, loginName, 'saveReport', 'error', 'location_not_registered:' + payload.from);
        throw new Error('location_not_registered');
      }
      for (var i = 0; i < payload.arrivals.length; i++) {
        var a = payload.arrivals[i];
        if (!a) continue;
        if (locations.indexOf(a) === -1) {
          logPost_(reportedAtServer, loginName, 'saveReport', 'error', 'location_not_registered:' + a);
          throw new Error('location_not_registered');
        }
      }
    }

    var fareYen = resolveFare_(payload);
    if (fareYen == null) {
      logPost_(reportedAtServer, loginName, 'saveReport', 'error', 'fare_not_registered');
      throw new Error('fare_not_registered');
    }

    // 総走行距離は resolveTotalKm_ が ODO delta で常に数値を返す (旧本線と揃える)。
    // 距離マスタ未登録で保存失敗させない (修理6 案2)。
    var totalKm = resolveTotalKm_(payload);

    var sh = getTargetReportSheet_();
    var row = buildRow_(payload, fareYen, totalKm, allow.driverName, reportedAtServer);
    sh.appendRow(row);

    logPost_(reportedAtServer, loginName, 'saveReport', 'ok', '');
    return {
      ok: true,
      savedAt: Utilities.formatDate(reportedAtServer, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    };
  } catch (e) {
    var msg = String(e.message || '');
    // 既知の invalid/unauthorized/fare/distance/vehicle/location/driver は上で log 済。
    if (msg.indexOf('unauthorized:') !== 0 &&
        msg.indexOf('invalid:') !== 0 &&
        msg !== 'fare_not_registered' &&
        msg !== 'vehicle_not_registered' &&
        msg !== 'location_not_registered' &&
        msg !== 'driver_not_in_master') {
      logPost_(reportedAtServer, loginName, 'saveReport', 'error', msg || String(e));
    }
    throw e;
  }
}

// --- Allowlist: PIN 方式 (新本線) -----------------------------------------

/**
 * 送迎PINマスタ で 表示名 + PIN を検証する。
 * 返り値: { ok, reason?, displayName, driverName }
 * reason codes:
 *   - missing_login_name / missing_pin
 *   - user_not_registered   (表示名が送迎PINマスタに無い)
 *   - pin_mismatch          (PIN 不一致)
 *   - inactive_user         (active=FALSE)
 *   - pickup_not_permitted  (送迎利用可=FALSE)
 *   - missing_driver_name   (運転者名 欄が空)
 */
function checkAllowedByPin_(loginName, pin) {
  if (!loginName) return { ok: false, reason: 'missing_login_name' };
  if (!pin)       return { ok: false, reason: 'missing_pin' };
  var rows = readMaster_('送迎PINマスタ',
    ['表示名', 'PIN', 'active', '送迎利用可', '運転者名']);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r['表示名'] || '').trim() !== String(loginName).trim()) continue;
    // PIN は数値/文字列どちらで入っていても比較は string で行う (Sheet 側の自動型変換対策)
    if (String(r['PIN']) !== String(pin)) {
      return { ok: false, reason: 'pin_mismatch' };
    }
    var active = r.active === true || r.active === 'TRUE';
    if (!active) return { ok: false, reason: 'inactive_user' };
    var pickupOk = r['送迎利用可'] === true || r['送迎利用可'] === 'TRUE';
    if (!pickupOk) return { ok: false, reason: 'pickup_not_permitted' };
    var driverName = String(r['運転者名'] || '').trim();
    if (!driverName) return { ok: false, reason: 'missing_driver_name' };
    return { ok: true, displayName: String(r['表示名']).trim(), driverName: driverName };
  }
  return { ok: false, reason: 'user_not_registered' };
}

// --- Allowlist: LINE userId 方式 (LEGACY、修理8 で未使用化) --------------

/**
 * @deprecated 修理8 で PIN ログイン方式へ切替。checkAllowedByPin_ を使うこと。
 */
function checkAllowed_(userId) {
  if (!userId) return { ok: false, reason: 'missing_user_id' };
  var rows = readMaster_('許可マスタ', ['line_user_id', 'display_name', 'role', 'active', 'driver_name']);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].line_user_id !== userId) continue;
    var active = rows[i].active === true || rows[i].active === 'TRUE';
    if (!active) return { ok: false, reason: 'inactive_user' };
    var role = String(rows[i].role || '');
    if (role !== '送迎報告' && role !== '両方') {
      return { ok: false, reason: 'role_not_permitted' };
    }
    var driverName = String(rows[i].driver_name || '').trim();
    if (!driverName) return { ok: false, reason: 'missing_driver_name' };
    return { ok: true, displayName: rows[i].display_name, driverName: driverName };
  }
  return { ok: false, reason: 'user_not_registered' };
}

// --- Master loaders (server-side 正本) -----------------------------------

function loadVehicleNames_() {
  return readMaster_('車両マスタ', ['vehicle_name', 'active'])
    .filter(function(r) { return r.active === true || r.active === 'TRUE'; })
    .map(function(r) { return r.vehicle_name; });
}

function loadLocationNames_() {
  return readMaster_('地点マスタ', ['location_name', 'category'])
    .map(function(r) { return r.location_name; });
}

function loadActiveDriverNames_() {
  return readMaster_('運転者マスタ', ['driver_name', 'active', 'default_vehicle'])
    .filter(function(r) { return r.active === true || r.active === 'TRUE'; })
    .map(function(r) { return r.driver_name; });
}

// --- Validation (形式のみ、存在チェックは saveReport 内) -----------------

function validatePayload_(p) {
  if (!p) return { ok: false, error: 'empty_payload' };
  if (!p.vehicle) return { ok: false, error: 'missing_vehicle' };
  if (p.mode !== '通常ルート' && p.mode !== 'バス') {
    return { ok: false, error: 'invalid_mode' };
  }
  // バスは from / arrivals を問わない (既存本線 pages/api/powerautomate.ts:1023-1024 と揃える)。
  // 通常ルートのみ from 必須 + arrivals 1..8。
  if (p.mode === '通常ルート') {
    if (!p.from) return { ok: false, error: 'missing_from' };
    var arrivals = Array.isArray(p.arrivals)
      ? p.arrivals.filter(function(a) { return a && String(a).trim(); })
      : [];
    if (arrivals.length === 0) return { ok: false, error: 'missing_arrivals' };
    if (arrivals.length > 8) return { ok: false, error: 'too_many_arrivals' };
  }
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

/**
 * 総走行距離 = ODO終 - ODO始 (driver 実測)。
 * 旧送迎システム (pickup-teate-app @ a55bf56) の距離ロジックに揃える:
 *   - 距離マスタは save 必須ではない (optional reference table)
 *   - route_distances 未登録でも保存は成功する
 *   - 想定距離 / 超過距離 / 距離警告 / 区間警告詳細 は保存失敗条件にしない
 * validatePayload_ が既に odoStart/odoEnd を数値検査 + e >= s を確認済。
 */
function resolveTotalKm_(payload) {
  return Math.round((Number(payload.odoEnd) - Number(payload.odoStart)) * 10) / 10;
}

// --- Row assembly (実シート 送迎記録_test 35 列レイアウトと一致) ---------

/**
 * 送迎記録_test (実シート) の正本 35 列レイアウトと一致させる。
 * 旧送迎システムの OneDrive Excel (送迎N月自動反映.xlsx) と同じ列配置:
 *
 *   A=日付 B=運転者 C=車両 D=出発地 E..L=到着1..8
 *   M=バス (モード文字列 '通常ルート' | 'バス')
 *   N=金額（円） O=距離（始） P=距離（終）
 *   Q..X=距離（始〜到着1, 到着1〜到着2, …, 到着7〜到着8）
 *   Y=総走行距離（km） Z=備考
 *   AA=出発写真URL AB..AI=到着写真URL到着1..8
 *
 * 区間距離 (Q..X) の契約 (実シート既存行 217 件検証済):
 *   - 到着 1 件の通常ルート: Q = Y (= ODO 差分)、R..X は空欄 (67/67 行 R..X 空)
 *   - 到着 2 件以上の通常ルート: 各区間に個別実測距離が入っている (sum(Q..X)==Y)。
 *     Phase 1 LIFF フォームには区間距離入力欄が無いため再現不能。
 *     勝手に合計を Q に集約せず Q..X 全空で保存し、実シート既存契約と衝突させない
 *     (「Phase 1 では未対応」= 区間内訳なし)。
 *   - バス: Q..X 空欄 (既存挙動継続)。
 * 写真URL (AA..AI): Phase 1 は LIFF 直接入力のみ、写真アップロード未実装で空欄。
 * Y (総走行距離) は resolveTotalKm_ (ODO 差分) で常に数値。
 *
 * userId / displayName は **実シートに列が無い**。監査は 投稿ログ タブで完結
 * (allowlist 経由で display_name を逆引きできるので二重記録はしない)。
 */
function buildRow_(p, fareYen, totalKm, driverName, reportedAtServer) {
  // バスモードでは既存本線 (pages/api/powerautomate.ts:1023-1024) と揃えて
  // 出発地 (D) と 到着1..8 (E..L) を空欄で書き込む。通常ルートのみ値を入れる。
  var isBus = (p.mode === 'バス');
  var effectiveFrom = isBus ? '' : (p.from || '');
  var effectiveArrivals = isBus
    ? []
    : (p.arrivals || []).filter(function(a) { return a && String(a).trim(); });
  var padded = effectiveArrivals.slice(0, 8);
  while (padded.length < 8) padded.push('');

  // 区間距離 Q (距離（始）〜到着１) は 到着 1 件の通常ルートに限り totalKm と一致させる
  // (実シート既存運用の契約)。到着 2 件以上 / バス / 通常ルート以外は Q..X 全空。
  var qSegment = (!isBus && effectiveArrivals.length === 1) ? totalKm : '';

  return [
    reportedAtServer,    // A: 日付 (Date オブジェクト → Sheets が datetime として保存)
    driverName,          // B: 運転者 (allowlist.driver_name 正本)
    p.vehicle,           // C: 車両
    effectiveFrom,       // D: 出発地 (バス時は '')
    padded[0],           // E: 到着1
    padded[1],           // F: 到着2
    padded[2],           // G: 到着3
    padded[3],           // H: 到着4
    padded[4],           // I: 到着5
    padded[5],           // J: 到着6
    padded[6],           // K: 到着7
    padded[7],           // L: 到着8
    p.mode,              // M: バス (モード文字列)
    fareYen,             // N: 金額（円）
    Number(p.odoStart),  // O: 距離（始）
    Number(p.odoEnd),    // P: 距離（終）
    qSegment,            // Q: 距離（始）〜到着１ (到着1件の通常ルートは totalKm、他は '')
    '',                  // R: 距離（到着１〜到着２）
    '',                  // S: 距離（到着２〜到着３）
    '',                  // T: 距離（到着３〜到着４）
    '',                  // U: 距離（到着４〜到着５）
    '',                  // V: 距離（到着５〜到着６）
    '',                  // W: 距離（到着６〜到着７）
    '',                  // X: 距離（到着７〜到着８）
    totalKm,             // Y: 総走行距離（km）
    p.note || '',        // Z: 備考
    '',                  // AA: 出発写真URL (Phase 1 未収集)
    '',                  // AB: 到着写真URL到着１
    '',                  // AC: 到着写真URL到着２
    '',                  // AD: 到着写真URL到着３
    '',                  // AE: 到着写真URL到着４
    '',                  // AF: 到着写真URL到着５
    '',                  // AG: 到着写真URL到着６
    '',                  // AH: 到着写真URL到着７
    '',                  // AI: 到着写真URL到着８
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
