# Phase 1 Live 受入 — 名前+PIN ログイン最終確認

**対象**: `free-migration/gas-liff-phase0` ブランチ commit `36e7ce4` 以降 (本ドキュメントは 修理8 = 名前+PIN ログイン + 実シート 35 列 + Q列契約 + 距離マスタ optional がすべて入った状態を前提)。

**実施者**: 会社管理 Google アカウントを持つオペレーター。Script Editor での deploy が必須のため、ローカルマシンの自動実行では完結しない。

---

## 0. 前提確認 (受入前チェック)

1. `送迎PINマスタ` タブがあり、少なくとも 1 行入っている
2. `運転者マスタ` / `車両マスタ` / `地点マスタ` / `料金マスタ` に旧送迎システム (Supabase) と同じ実データが入っている
3. `距離マスタ` は空でも OK (optional、修理6)
4. `許可マスタ` は残っているが参照されない (legacy、修理8)
5. `送迎記録_test` タブのヘッダは旧 OneDrive Excel と同じ 35 列
6. 最新 `Code.gs` / `index.html` / `appsscript.json` が GAS Editor に貼り付け済、Web App として再デプロイ済

---

## 1. 送迎PINマスタ の最小セットアップ

`送迎PINマスタ` タブに受入用 2 行:

| 表示名 | PIN | active | 送迎利用可 | 運転者名 |
|---|---|---|---|---|
| アジ | 1234 | TRUE | TRUE | アジ |
| 退職者 | 9999 | FALSE | TRUE | 退職者 |

(`表示名` = 有給報告のログイン名、`PIN` = 有給報告で配布済みの値、`運転者名` = 運転者マスタと完全一致)

---

## 2. Live 受入 2 ケース

### ケース A: 通常ルート 到着1件 (蘭越 → 会社)

操作:
1. LIFF URL を開く → ログイン画面表示
2. 表示名: `アジ` を選択、PIN: `1234` → ログインボタン
3. 車両: 旧システムで存在する車両 (例 `１０号車`)、区分: 通常ルート
4. 出発地: `蘭越`、到着 1: `会社`
5. ODO(出発): `100`、ODO(到着): `121`、備考: `acceptance A`
6. 保存

期待 `送迎記録_test` 最新行 (35 列):

| 列 | 値 |
|---|---|
| A 日付 | 保存時刻 (Date) |
| B 運転者 | `アジ` |
| C 車両 | `１０号車` |
| D 出発地 | `蘭越` |
| E 到着１ | `会社` |
| F..L | (空) |
| M バス | `通常ルート` |
| N 金額（円） | 料金マスタ `蘭越 → 会社` の値 (旧実運用と一致) |
| O 距離（始） | `100` |
| P 距離（終） | `121` |
| Q 距離（始）〜到着１ | `21` (= totalKm、修理7契約) |
| R..X | (空) |
| Y 総走行距離（km） | `21` (= P - O、修理6) |
| Z 備考 | `acceptance A` |
| AA..AI | (空) |

期待 `投稿ログ` 最新行: `timestamp | アジ | saveReport | ok | (空)`

### ケース B: バス

操作:
1. 引き続き `アジ` でログイン中
2. 車両: `ハイエース`、区分: バス (出発地/到着は自動 disabled)
3. ODO(出発): `215159`、ODO(到着): `215185`、備考: `acceptance B`
4. 保存

期待 `送迎記録_test` 最新行:

| 列 | 値 |
|---|---|
| A | 保存時刻 |
| B | `アジ` |
| C | `ハイエース` |
| D | (空) ← バスは 出発地 空欄 |
| E..L | (空) |
| M | `バス` |
| N | `2000` (バス一律) |
| O | `215159` |
| P | `215185` |
| Q..X | (空) ← バスは区間距離なし |
| Y | `26` (= P - O) |
| Z | `acceptance B` |
| AA..AI | (空) |

期待 `投稿ログ` 最新行: `timestamp | アジ | saveReport | ok | (空)`

---

## 3. 失敗系スモーク (最低 3 件)

| # | 入力 | 期待 UI メッセージ | 期待 投稿ログ |
|---|---|---|---|
| F1 | `アジ` + PIN=`9999` | `PIN が違います` | ログイン時 throw のため 投稿ログ には残らない可能性あり (UI 判定) |
| F2 | `退職者` + `9999` | `利用者が無効化されています` | 同上 (UI 判定) |
| F3 | 送迎利用可=FALSE のユーザー | `送迎利用が許可されていません` | 同上 (UI 判定) |

`saveReport` 到達後の失敗 (`driver_not_in_master` / `vehicle_not_registered` / `location_not_registered` / `fare_not_registered`) は 投稿ログ に `result=error` で明記される。

---

## 4. PIN 非記録の根拠

`Code.gs` の静的監査 (本ドキュメント作成時点):

- `payload.pin` は `saveReport` 内で `checkAllowedByPin_` に渡すのみで、`sh.appendRow` / `logPost_` / `buildRow_` のいずれにも流れない
- `logPost_(whenDate, subject, action, result, message)` は第 2 引数に `subject` (= `loginName`) のみ取り、PIN を引数に取らない
- `buildRow_` は 35 列のうちどの位置にも `payload.pin` を書かない
- `index.html` は `state.pin` を送信時のみ参照、`localStorage` / `sessionStorage` / `document.cookie` へ書かない

確認コマンド (受入後に再実行可):

```bash
# appendRow / logPost_ / Logger.log の近傍に pin が混入していないこと
grep -nE 'appendRow|logPost_|Logger\.log' migration/gas/Code.gs | grep -i 'pin'
# → 0 件
```

---

## 5. 受入判定

合格条件 (全て満たしたら本番 `送迎記録` への切替可):

- [ ] ケース A: `送迎記録_test` に 35 列の行が増え、B=アジ / D=蘭越 / E=会社 / Q=Y=21
- [ ] ケース B: `送迎記録_test` に 35 列の行が増え、D=空 / E..L=空 / Q..X=空 / Y=26
- [ ] 投稿ログ に `result=ok` で 2 行増え、B列 (loginName) に `アジ` 明記
- [ ] 投稿ログ のどの行にも PIN 文字列 (`1234` / `9999` 等) が混入していない
- [ ] 送迎記録_test のどの列にも PIN 文字列が混入していない
- [ ] 失敗系 F1〜F3 で人間向けメッセージが正しく出る
- [ ] 旧送迎システムの業務マスタ (運転者/車両/地点/料金) をそのまま参照して保存が通る
- [ ] 距離マスタ が空でも ケース A / B が保存できる

不合格の場合: 該当行のスクリーンショット + 投稿ログ該当行 + エラーメッセージを添付して issue 化。

---

## 6. オペレーター報告欄 (実施時に埋める)

| 項目 | 値 |
|---|---|
| 実施日時 | |
| Web App URL (先頭 40 文字) | |
| ケース A 送迎記録_test 行番号 | |
| ケース B 送迎記録_test 行番号 | |
| 投稿ログ ok 行番号 (A / B) | |
| PIN 文字列検索結果 (送迎記録_test / 投稿ログ) | |
| 失敗系 F1 UI メッセージ | |
| 失敗系 F2 UI メッセージ | |
| 失敗系 F3 UI メッセージ | |
| 合格判定 | PASS / FAIL |

---

## 7. OneDrive Excel ブリッジ E2E 受入 (修理10–12)

### 7.1 Script Properties セットアップ

| key | 値 | 必須 |
|---|---|---|
| `POWER_AUTOMATE_WEBHOOK_URL` | Power Automate Flow の HTTP trigger URL | **必須** (未設定なら 投稿ログ に `excel_sync_skipped:webhook_url_unset`) |
| `MONTH_DIGIT_WIDTH` | `zenkaku` (既定) or `hankaku` | 任意。SharePoint 実ファイル名が半角の場合のみ `hankaku` |
| ~~`EXCEL_PATH`~~ | **削除する** — 使っていない。Properties に残っていたら Delete。正本は `MONTH_DIGIT_WIDTH` + 動的 ExcelPath に統一 | — |

### 7.2 Apps Script 実行ログの出力項目 (修理12 以降)

Code.gs `postRowToPowerAutomate_` は 1 件送信ごとに以下 4 つを必ず出す:

```
postRowToPowerAutomate_ monthDigitWidth=<zenkaku|hankaku> ExcelPath=<full path> status=<code> body=<prefix 500 chars>
```

skip 時:
```
postRowToPowerAutomate_ skipped monthDigitWidth=<...> ExcelPath=<...> reason=webhook_url_unset
```

例外時:
```
postRowToPowerAutomate_ fetch_exception monthDigitWidth=<...> ExcelPath=<...> err=<error>
```

### 7.3 response status 別 トリアージ

| status | response body | 一次判断 | 対処 |
|---|---|---|---|
| 2xx | 空 or Flow の OK 応答 | 成功 | OneDrive Excel の t_orders を確認して終わり |
| 400 | **必ず body を読む**。Flow の schema 検証エラーなら payload のキーや型 | **即切替しない** | body の指摘箇所を Code.gs の `toPowerAutomatePayload_` と突合。`MONTH_DIGIT_WIDTH` 切替では直らない |
| 404 + body が `file not found` / `ExcelPath not resolved` 系 | ExcelPath 文字列不一致が濃厚 | `MONTH_DIGIT_WIDTH` を切替可 | Script Property `MONTH_DIGIT_WIDTH=hankaku` を追加 (または削除して既定に戻す) → もう 1 件送信 → 再確認 |
| 404 + body が別系 | 別原因 (Flow ID 失効 / URL 変更 等) | まず body を読む | Flow URL 更新 or Flow 側確認 |
| 401/403 | auth error | Webhook URL の署名失効 | 新 URL に差し替え |
| 5xx | Flow 内部エラー | Power Automate 側 | Power Automate ポータル → 実行履歴 → エラー詳細 |

### 7.4 E2E 証明の 3 点セット (必ず保存)

1 件送信ごとに、以下 3 つをスクショ or テキストで保存:

1. **Apps Script 実行ログ** (`postRowToPowerAutomate_` 行の全文、`monthDigitWidth` / `ExcelPath` / `status` / `body` 4 項目必ず全部入り)
2. **Power Automate 実行履歴** (該当フローの 1 件分、トリガ時刻と成否)
3. **t_orders 追記結果** (OneDrive Excel Sheet1 or t_orders テーブルの末尾行スクショ、送信した 日付 / 運転者 / 車両 / 金額 / 総走行距離 Y が一致していること)

3 点がそろって初めて E2E PASS とする。欠けたら FAIL。

### 7.5 E2E チェックリスト

- [ ] `POWER_AUTOMATE_WEBHOOK_URL` を Script Properties に登録済
- [ ] `EXCEL_PATH` が残っていないか確認、残っていたら削除
- [ ] 再デプロイ済
- [ ] LIFF から 通常ルート 1 件送信 → Apps Script ログ `status=2xx`、ExcelPath が 4 月ファイル、monthDigitWidth が想定値
- [ ] Power Automate 実行履歴に 4 月送信の 1 件が成功で並ぶ
- [ ] OneDrive 4 月 Excel の t_orders に 1 行増えた (運転者 / 金額 / 総走行距離 Y が送信値と一致)
- [ ] LIFF から バス 1 件送信 → 同様に 4 月 Excel に 1 行増える (D=空, N=2000)
- [ ] テスト用に 5 月日付で 1 件送信 → Apps Script ログの ExcelPath が 5 月ファイルに切替 / t_orders も 5 月ファイル側に追記
- [ ] Google Sheet 投稿ログ に `result=ok, message=''` (sync 成功時) or `message=excel_sync_failed:status=...` (失敗時) が残る
- [ ] Google Sheet 投稿ログ / 送迎記録_test / Apps Script ログ のどれにも PIN 文字列が混入していない
