# Phase 1 — GAS + Google Sheets + LINE LIFF Design

**作成日**: 2026-04-19
**branch**: `free-migration/gas-liff-phase0`
**前提**: Phase 0 Azure freeze 完了、LINE 側 4 点控え完了、許可マスタは現状空
**目的**: 新無料系の送迎報告システムを、既存本線に一切触れずに単独で動く状態まで組み上げる

---

## 1. ゴール (Phase 1 完了条件)

- [x] 新無料系が **単独で動く** — test sheet に 1 件保存できる状態
- [ ] 本番 sheet には書き込まない (Phase 3 以降に切替)
- [ ] 公式LINE 本番リッチメニューにはまだ載せない (Phase 4)
- [ ] 既存 LIFF / 公式LINE / Azure に影響ゼロ

## 2. 系統図

```
[LINE アプリ]
    │
    │  (公式LINE → 新テスト LIFF リンク — まだリッチメニューには載せない)
    ▼
[LIFF (LINE Login channel 上の新テスト用 LIFF app)]
    │
    │  liff.init() + liff.getProfile() で userId 取得
    ▼
[GAS HTML Service (webapp)]
    │                      │
    │ google.script.run    │ google.script.run
    │ loadMasters()        │ saveReport(payload)
    ▼                      ▼
[GAS Code.gs]          [GAS Code.gs]
    │                      │
    ▼                      ▼
[Google スプレッドシート (会社管理アカウント所有)]
    └── 運転者マスタ
    └── 車両マスタ
    └── 地点マスタ
    └── 料金マスタ
    └── 距離マスタ
    └── 許可マスタ
    └── 送迎記録_test       ← Phase 1 の書き込み先
    └── 送迎記録            ← Phase 3 以降、本番に昇格
    └── 投稿ログ
```

## 3. 原則 (Phase 0 引継ぎ)

| # | 原則 | 実装への反映 |
|---|---|---|
| 1 | test sheet 先行 | `Code.gs` の `getTargetSheetName()` が Script Property `TEST_MODE=1` のとき `送迎記録_test` を返す |
| 2 | `google.script.run` 優先 | `doPost` を実装しない、HTML 側は `google.script.run.withSuccessHandler(...).saveReport(payload)` のみ |
| 3 | 会社管理 Google アカウント | Spreadsheet + GAS プロジェクト両方を会社アカウントで作成、所有権を個人に残さない |
| 4 | 写真なし | Phase 1 では画像 UI / 保存を実装しない |
| 5 | task24 branch と交差しない | `migration/gas/` 配下に閉じる。既存 `app/`/`pages/`/`lib/` と import 関係なし |
| 6 | allowlist = LINE User ID | `許可マスタ` シートで userId ごとに権限行を定義。未登録は `unauthorized` |

## 4. ファイル構成 (`migration/gas/`)

| ファイル | 役割 |
|---|---|
| `README.md` | Deploy 手順 (Google アカウントで実施する SOP) |
| `appsscript.json` | GAS manifest (timezone Asia/Tokyo, webapp 設定) |
| `Code.gs` | サーバーサイド: `doGet`, `loadMasters`, `saveReport`, `checkAllowed` |
| `index.html` | UI: LIFF init + フォーム + google.script.run 呼び出し |
| `sheet-schema.md` | 送迎記録_test + 各マスタの列定義とサンプル |

## 5. シート構成 (9 タブ)

### マスタ系 (5 タブ)
- `運転者マスタ` — 運転者名、アクティブ、既定車両
- `車両マスタ` — 車両名、アクティブ
- `地点マスタ` — 地点名、カテゴリ
- `料金マスタ` — from / to / 金額
- `距離マスタ` — from / to / 距離km

### 権限 (1 タブ)
- `許可マスタ` — **LINE User ID 正本**。userId ごとに `送迎報告/有給申請/両方`、アクティブフラグ
- Phase 0 時点は空。Phase 2 テスト開始時にあなた 1 人分を追加、Phase 5 切替時に全運転者分に拡張

### 記録系 (2 タブ)
- `送迎記録_test` — **Phase 1 の書き込み先**
- `送迎記録` — 本番。Phase 3 以降、スクリプトから書き込み対象を切替

### 監査 (1 タブ)
- `投稿ログ` — 成功・失敗問わず 1 件 1 行。userId / timestamp / action / result / error message

`sheet-schema.md` に列定義を記載。

## 6. Script Properties (GAS 側で設定)

**設定順**: LIFF app 作成前 (Step 3) に下 3 つ、LIFF app 作成後 (Step 6) に `LIFF_ID` を追加。
LIFF endpoint URL は Step 4 で deploy した webapp URL を指すため、`LIFF_ID` は LIFF app 作成後にしか確定しない。

| Key | 設定タイミング | 値 | 用途 |
|---|---|---|---|
| `SHEET_ID` | Step 3 | 会社管理アカウント所有の Google Sheet の ID | `SpreadsheetApp.openById(...)` |
| `TEST_MODE` | Step 3 | `"1"` (Phase 1-3) / 空 (Phase 4+) | `送迎記録_test` vs `送迎記録` 切替 |
| `TIMEZONE` | Step 3 | `Asia/Tokyo` (manifest と重複だが明示) | 日付書式統一 |
| `LIFF_ID` | **Step 6 (LIFF app 作成後)** | 新テスト LIFF の ID (LINE Developers Console から取得) | `index.html` から `doGet` 経由で読み出し、`liff.init()` に渡す |

**禁止**: LIFF Channel ID、Channel secret、OAuth token 等を Script Properties に入れない (Phase 0 原則 #2)。

## 7. 保存フロー (google.script.run)

```
[HTML] submit click
    │
    │ validate client-side (required fields, ODO numeric)
    ▼
[HTML] google.script.run
         .withSuccessHandler(onSaveOk)
         .withFailureHandler(onSaveFail)
         .saveReport({
           userId, displayName, reportedAt (ISO),
           vehicle, mode (通常|バス), from, arrivals[],
           odoStart, odoEnd, note
         })
    ▼
[Code.gs.saveReport(payload)]
    1. checkAllowed(payload.userId) — 許可マスタ照合
    2. validate payload (arrivals 1..8, ODO numeric, mode ∈ {通常,バス})
    3. resolveFare(from, arrivals, mode) — 料金マスタ pairwise合計 or バス一律2000
    4. resolveDistances(from, arrivals) — 距離マスタ pairwise
    5. getTargetSheet() — TEST_MODE に応じて 送迎記録_test or 送迎記録
    6. appendRow([...]) — 1 行追記
    7. log to 投稿ログ
    8. return { ok: true, savedAt }
    ▼
[HTML] onSaveOk → 完了画面 + LIFF close
```

## 8. 認証モデル

**allowlist based**:
- `liff.getProfile()` で userId を取得 (LIFF が LINE アプリ内で動作していれば信頼できる値)
- `saveReport` の先頭で `checkAllowed(userId)` を呼び、許可マスタに行が無ければ `unauthorized` エラー
- エラー時 HTML 側で「運転者登録が必要です。管理者にご連絡ください。」と表示

**今 Phase では実施しない** (将来強化候補):
- `liff.getIDToken()` のサーバー側検証 (`https://api.line.me/oauth2/v2.1/verify`) — spoof 耐性向上
- 時刻ベースのリプレイ対策 (nonce)

理由: Phase 1 は「単独で動く」が目標。セキュリティ強化は Phase 3 並走検証で課題が見えてから判断。

## 9. エラー設計

| ケース | UI 表示 | sheet 側 |
|---|---|---|
| userId 未許可 | 「運転者登録が必要です」 | 投稿ログに記録 (記録シートには書かない) |
| 必須欄未入力 (client-side validate) | UI で赤枠 + メッセージ | 送信しない |
| 到着数 > 8 | 「到着地は最大8件です」 | 投稿ログに記録 |
| 料金マスタ未登録 (pairwise 欠) | 「料金マスタが未登録です。管理者に連絡してください。」 | 投稿ログに記録 |
| 保存中の例外 | 「一時的なエラーです。もう一度お試しください。」 | 投稿ログに stack 付きで記録 |

## 10. Phase 2 以降の布石

- **Phase 2 テスト URL**: 新 LIFF app を LINE Login channel 上に追加して、そのエンドポイントに GAS webapp URL を設定。リッチメニューには載せない。
- **Phase 3 並走**: `許可マスタ` に active driver 全員を追加し、既存本線と新無料系の両方に同じ内容を入れて比較観察。
- **Phase 4**: `TEST_MODE` を空にして本番シートへ書込変更、`送迎記録` タブの schema を `送迎記録_test` と完全一致させる、リッチメニュー切替手順を確定。
- **Phase 5**: 公式LINE リッチメニュー送迎ボタンを新 LIFF URL に差替、1 件疎通確認、運用広報。
- **Phase 6-7**: 14 日保険 → Azure 停止判断 (別タスク)。

## 11. Phase 1 で作るもの vs 作らないもの

### 作る
- 上記 6 ファイル (`migration/gas/` 配下)
- シート列定義
- Deploy runbook

### 作らない
- 本番シートの schema 決定 (Phase 4 で old Excel と整合を取る)
- 写真アップロード UI / 保存
- 有給申請フォーム (これは将来別 LIFF で追加)
- 管理者用マスタ編集 UI (Phase 2 で判断)
- `doPost` エントリーポイント
- 自動デプロイ (clasp 等) — 手動で Apps Script エディタに貼り付け想定

---

**次**: `migration/gas/README.md` の deploy 手順を見ながら、会社管理 Google アカウントで GAS プロジェクトとスプレッドシートを作成 → script properties 設定 → Web app deploy → LIFF エンドポイント更新 の順で進める。
