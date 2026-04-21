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

    // 修理11: Google Sheet 書込成功後に OneDrive Excel 側へブリッジ転送する。
    // 既存 Power Automate Flow (旧 pickup.vege-office.com /api/powerautomate が使ってきたもの) を
    // GAS から直接叩くだけ。失敗は saveReport 本線を壊さない (ok を返し、投稿ログ に sync 状態を残す)。
    // ExcelPath は row[0] の日付から動的導出 (excelPathForDate_) するので Script Property 固定値不要。
    var syncMsg = '';
    try {
      var paPayload = toPowerAutomatePayload_(row, reportedAtServer);
      var sync = postRowToPowerAutomate_(paPayload);
      if (sync.skipped) syncMsg = 'excel_sync_skipped:' + sync.reason;
      else if (!sync.ok) syncMsg = 'excel_sync_failed:status=' + (sync.status || 0) +
        (sync.reason ? ' reason=' + sync.reason : '');
    } catch (paErr) {
      syncMsg = 'excel_sync_exception:' + String(paErr && paErr.message || paErr);
      Logger.log('saveReport PA bridge swallow: ' + paErr);
    }

    logPost_(reportedAtServer, loginName, 'saveReport', 'ok', syncMsg);
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

/**
 * 投稿ログ へ 1 行追記する。
 * 契約: PIN を引数に取らない・書き込まない。第 2 引数は subject (新本線 = loginName、
 *       legacy フォールバック時 = userId) で、呼出側が 1 つだけ渡す。
 */
function logPost_(whenDate, subject, action, result, message) {
  try {
    var sh = getSheetByName_('投稿ログ');
    sh.appendRow([
      Utilities.formatDate(whenDate || new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"),
      subject || '',
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

// --- Power Automate bridge (修理10/11: Google Sheet → OneDrive Excel) ---

/**
 * dateValue から対象月の OneDrive ExcelPath を組み立てる (修理11 + 修理12)。
 *
 *   /Shared Documents/General/雇用/送迎/{YYYY}年送迎記録表/送迎{M}月自動反映.xlsx
 *
 * 既存 OneDrive 実ファイル名の月は 全角 (U+FF13..FF19) が既定 (ls 検証済)。
 * 拡張子は .xlsx で固定 (directive の .xlsm より実ファイル名一致を優先)。
 * Script Property `MONTH_DIGIT_WIDTH`:
 *   'zenkaku' (既定): ４月, ５月, １０月 等
 *   'hankaku':        4月, 5月, 10月 等 (SharePoint 側が半角で登録されているとき)
 * タイムゾーンは Asia/Tokyo で固定し月跨ぎの UTC ずれを防ぐ。
 */
function excelPathForDate_(dateValue) {
  var d = (dateValue instanceof Date) ? dateValue : new Date(dateValue);
  if (isNaN(d.getTime())) {
    throw new Error('excelPathForDate_ got invalid date: ' + dateValue);
  }
  var y = Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy');
  var mNum = Number(Utilities.formatDate(d, 'Asia/Tokyo', 'M'));
  var width = (getProp_('MONTH_DIGIT_WIDTH') || 'zenkaku').toLowerCase();
  var mStr = (width === 'hankaku') ? String(mNum) : toZenkakuDigits_(String(mNum));
  return '/Shared Documents/General/雇用/送迎/' + y + '年送迎記録表/送迎' + mStr + '月自動反映.xlsx';
}

function toZenkakuDigits_(s) {
  return String(s).replace(/[0-9]/g, function(c) {
    return String.fromCharCode(c.charCodeAt(0) - 0x30 + 0xFF10);
  });
}

/**
 * 送迎記録_test に append した 35 列行 (buildRow_ の出力) から Power Automate Flow の
 * Parse JSON 契約 (pages/api/powerautomate.ts:175-215 の PowerAutomatePayload 型) に
 * 一致する 40 キー object を作る。ExcelPath は dateValue (既定: savedRow[0]) から動的導出。
 *
 * 契約:
 *   - ExcelPath は excelPathForDate_ から動的導出 (Script Property 固定値依存しない)
 *   - 数値項目は Number() に通す。空欄 / 無効値は '' (Parse JSON 契約の permissive 型)
 *   - 想定距離 / 超過距離 / 距離警告 / 区間警告詳細 は旧本線と同じく常に ''
 *   - 写真URL (出発 + 到着1..8) は Phase 1 未収集のため 8 + 1 列全て ''
 *   - PIN / loginName は含めない (savedRow 35 列に PIN カラムが無いため物理的に混入不可)
 */
function toPowerAutomatePayload_(savedRow, dateValue) {
  if (!savedRow || savedRow.length < 35) {
    throw new Error('toPowerAutomatePayload_ expected 35-col row, got ' + (savedRow && savedRow.length));
  }
  var d = (dateValue instanceof Date) ? dateValue :
          (savedRow[0] instanceof Date) ? savedRow[0] :
          new Date(savedRow[0]);
  var iso = Utilities.formatDate(d, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX");
  var str = function(v) { return v === null || v === undefined ? '' : String(v); };
  var numOrEmpty = function(v) {
    if (v === '' || v === null || v === undefined) return '';
    var n = Number(v);
    return isFinite(n) ? n : '';
  };
  return {
    ExcelPath: excelPathForDate_(d),
    '日付': iso,
    '運転者': str(savedRow[1]),
    '車両': str(savedRow[2]),
    '出発地': str(savedRow[3]),
    '到着１': str(savedRow[4]),
    '到着２': str(savedRow[5]),
    '到着３': str(savedRow[6]),
    '到着４': str(savedRow[7]),
    '到着５': str(savedRow[8]),
    '到着６': str(savedRow[9]),
    '到着７': str(savedRow[10]),
    '到着８': str(savedRow[11]),
    'バス': str(savedRow[12]),
    '金額（円）': numOrEmpty(savedRow[13]),
    '距離（始）': numOrEmpty(savedRow[14]),
    '距離（終）': numOrEmpty(savedRow[15]),
    '距離（始）〜到着１': numOrEmpty(savedRow[16]),
    '距離（到着１〜到着２）': numOrEmpty(savedRow[17]),
    '距離（到着２〜到着３）': numOrEmpty(savedRow[18]),
    '距離（到着３〜到着４）': numOrEmpty(savedRow[19]),
    '距離（到着４〜到着５）': numOrEmpty(savedRow[20]),
    '距離（到着５〜到着６）': numOrEmpty(savedRow[21]),
    '距離（到着６〜到着７）': numOrEmpty(savedRow[22]),
    '距離（到着７〜到着８）': numOrEmpty(savedRow[23]),
    '総走行距離（km）': numOrEmpty(savedRow[24]),
    '想定距離（km）': '',
    '超過距離（km）': '',
    '距離警告': '',
    '区間警告詳細': '',
    '備考': str(savedRow[25]),
    '出発写真URL': str(savedRow[26]),
    '到着写真URL到着１': str(savedRow[27]),
    '到着写真URL到着２': str(savedRow[28]),
    '到着写真URL到着３': str(savedRow[29]),
    '到着写真URL到着４': str(savedRow[30]),
    '到着写真URL到着５': str(savedRow[31]),
    '到着写真URL到着６': str(savedRow[32]),
    '到着写真URL到着７': str(savedRow[33]),
    '到着写真URL到着８': str(savedRow[34]),
  };
}

/**
 * payload を Power Automate Webhook へ POST する (修理11)。
 * Script Properties: POWER_AUTOMATE_WEBHOOK_URL (必須、未設定なら skipped)
 * 返り値: { ok, skipped?, status, text?, reason? } — throw しない。
 * Logger.log で ExcelPath + status + body prefix を残す (Apps Script 実行ログ追跡用)。
 */
function postRowToPowerAutomate_(payload) {
  var url = getProp_('POWER_AUTOMATE_WEBHOOK_URL');
  if (!url) return { ok: false, skipped: true, reason: 'webhook_url_unset' };
  var opts = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: true,
  };
  try {
    var res = UrlFetchApp.fetch(url, opts);
    var status = res.getResponseCode();
    var text = String(res.getContentText() || '').slice(0, 500);
    Logger.log('postRowToPowerAutomate_ ExcelPath=' + payload.ExcelPath +
      ' status=' + status + ' body=' + text);
    return {
      ok: (status >= 200 && status < 300),
      skipped: false,
      status: status,
      text: text,
    };
  } catch (e) {
    Logger.log('postRowToPowerAutomate_ fetch_exception: ' + e);
    return { ok: false, skipped: false, status: 0, reason: 'fetch_exception:' + e };
  }
}

// --- Manual replay tool (修理10: 既存 N 行を OneDrive Excel に遡及反映) -------

/**
 * 送迎記録_test の末尾 N 行を Power Automate Webhook 経由で OneDrive Excel に再送する。
 * GAS Editor → 関数選択 `replaySheetRowsToExcel` → 実行。引数 N 指定不可のため、
 * デフォルトは 2 (修理10 受入の 2 行)。異なる N が必要なら一時的に引数値を書き換えて再実行。
 *
 * 重複防止の立て付け:
 *   - 通常フロー (saveReport) は 1 行保存 = 1 回 webhook で自然に重複しない
 *   - 本 replay 関数は「手動で明示実行する one-shot」であり menu/onEdit からは呼ばない
 *   - 呼出側が実行前に OneDrive Excel の Sheet1 最新行を確認すること (受入ランブック参照)
 *
 * Google Sheet 側は読取のみ (appendRow / updateRange 等は行わない)。
 * PIN には触れない (sheet に PIN 列は無い + 関数内でも PIN を参照しない)。
 */
function replaySheetRowsToExcel() {
  var n = 2;
  var sh = getTargetReportSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 'no_rows';
  var from = Math.max(2, last - n + 1);
  var rows = sh.getRange(from, 1, last - from + 1, 35).getValues();
  var results = [];
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var dateVal = r[0] instanceof Date ? r[0] : new Date(r[0]);
    var sync;
    try {
      var paPayload = toPowerAutomatePayload_(r, dateVal);
      sync = postRowToPowerAutomate_(paPayload);
    } catch (e) {
      sync = { ok: false, skipped: false, status: 0, reason: 'payload_build_failed:' + e };
    }
    results.push({ row: from + i, sync: sync });
    logPost_(new Date(), '(replay)', 'replayToExcel', sync.ok ? 'ok' : 'error',
      'row=' + (from + i) + ' status=' + (sync.status || 0) +
      (sync.reason ? ' reason=' + sync.reason : ''));
  }
  return results;
}
