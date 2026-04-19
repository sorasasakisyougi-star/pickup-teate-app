# migration/gas — Phase 1 GAS プロジェクト (会社管理アカウントでデプロイ)

このディレクトリは Google Apps Script + Google Sheets + LINE LIFF で動く新無料系
送迎報告システムの **repo 保存コピー**。実際のデプロイは Apps Script Editor 上で行う。

## 前提

- Phase 0 完了 (`docs/PHASE0_AZURE_FREEZE.md` 合格)
- LINE 側 4 点控え完了 (許可マスタは現状空でOK)
- **会社管理の Google アカウント** を持っている (個人アカウントで作成しないこと)

## ファイル

| ファイル | デプロイ先 |
|---|---|
| `appsscript.json` | GAS Editor → ⚙️ Project Settings → "appsscript.json" マニフェスト編集 (GAS 側で有効化が必要) |
| `Code.gs` | GAS Editor → 新規 Script ファイル名 `Code` として貼り付け |
| `index.html` | GAS Editor → 新規 HTML ファイル名 `index` として貼り付け |
| `sheet-schema.md` | 参照用。Spreadsheet 作成時の列定義ガイド |

## 手順 (operator が会社アカウントで実施)

### Step 1: Google Spreadsheet 作成

1. 会社管理アカウントで Google Drive を開く
2. 新規 → Google スプレッドシート、名前を `送迎報告_管理台帳` 等
3. `sheet-schema.md` に従って **9 タブ** を作成
   - `許可マスタ`, `運転者マスタ`, `車両マスタ`, `地点マスタ`,
     `料金マスタ`, `距離マスタ`, `送迎記録_test`, `送迎記録`, `投稿ログ`
4. 各タブの **行 1** にヘッダー列を入れる (schema 通り exact に)
5. URL の `/d/XXXXX/edit` 部分が **Spreadsheet ID** — メモ

### Step 2: GAS プロジェクト作成

1. 同じ会社管理アカウントで https://script.google.com/
2. 新規プロジェクト、名前 `送迎報告-phase1`
3. デフォルトの `Code.gs` を削除し、本 repo の `Code.gs` を丸ごとコピペ
4. ファイル追加 → HTML → 名前 `index` → 本 repo の `index.html` を丸ごとコピペ
5. ⚙️ Project Settings → "appsscript.json マニフェストファイルをエディタで表示" を ON
6. 左ペインに `appsscript.json` が出るので本 repo の内容で上書き

### Step 3: Script Properties を設定

GAS エディタ左 ⚙️ Project Settings → Script properties → Add:

| key | value |
|---|---|
| `LIFF_ID` | LINE Developers Console の新テスト LIFF app の ID |
| `SHEET_ID` | Step 1 でメモした Spreadsheet ID |
| `TEST_MODE` | `1` (test sheet に書き込み) |
| `TIMEZONE` | `Asia/Tokyo` |

**禁止**: Channel secret / OAuth token を Properties に入れない。

### Step 4: Web app としてデプロイ

1. 右上「デプロイ」 → 「新しいデプロイ」
2. 種類: **ウェブアプリ**
3. 説明: `phase1 test`
4. 実行ユーザー: **デプロイするユーザー (自分 = 会社アカウント)**
5. アクセスできるユーザー: **全員** (authz は Code.gs 内の allowlist で担保)
6. デプロイ → 初回のみ権限承認画面 → 承認
7. ウェブアプリ URL をコピー (`https://script.google.com/macros/s/XXXX/exec`)

### Step 5: LIFF app 作成 (テスト用、リッチメニューにはまだ載せない)

1. LINE Developers Console → **送迎報告 LINE Login channel**
2. LIFF タブ → 新規追加
3. 名前: `送迎報告 phase1 test`
4. エンドポイント URL: Step 4 でコピーした GAS webapp URL
5. サイズ: `Full`
6. scope: `profile`, `openid` (必要に応じて)
7. Bot link: 今は無し (Phase 5 で設定)
8. `liff.getProfile()` 使用: ON
9. 作成 → LIFF ID を控え、GAS の `LIFF_ID` プロパティに設定

### Step 6: 実機テスト (自分のスマホで)

1. `許可マスタ` に自分の LINE User ID を 1 行追加:
   - line_user_id: LIFF SDK の `liff.getProfile().userId` で取得できる値
   - display_name: 任意
   - role: `送迎報告`
   - active: `TRUE`
2. 公式 LINE アプリで `line://app/<LIFF_ID>` リンクを開く (自分だけ)
3. フォームが表示されれば OK
4. 1 件送信 → `送迎記録_test` タブに行追加されれば合格
5. `投稿ログ` タブにも記録されていること

### Step 7: Phase 1 完了条件チェック

- [ ] フォームが表示される
- [ ] 1 件保存できる
- [ ] 未登録 userId で開くとエラーメッセージ
- [ ] 既存本線 (Azure) は無停止 (`curl https://pickup-teate-app-wus2d2.westus2.cloudapp.azure.com/` → 200)
- [ ] LINE 公式リッチメニューは **未変更**
- [ ] 本番 LIFF URL は **未変更**

全チェックが通れば Phase 2 (テスト URL でさらに検証) に進む。

## 失敗時の対処

| 症状 | 対処 |
|---|---|
| LIFF 初期化失敗 | `LIFF_ID` 値、LINE Login channel の LIFF 設定 URL が GAS webapp URL と一致するか確認 |
| `unauthorized` | `許可マスタ` に userId 行を追加、`active=TRUE`、`role=送迎報告`/両方 |
| `fare_not_registered` | `料金マスタ` に該当ペアを追加 (from/to 方向一致させる) |
| `distance_not_registered` | `距離マスタ` に該当ペアを追加 |
| `シート ... が見つかりません` | タブ名タイポ確認 (半角/全角、スペース) |
| `列 N が想定と違います` | ヘッダー行の列順を schema と合わせる |

## セキュリティ注意

- Spreadsheet と GAS プロジェクトは **会社管理アカウント所有** のまま保つ
- 個人アカウントへの所有権移行禁止
- `許可マスタ` に LINE userId を書く際、シート自体を社外共有しない
- LIFF ID は非機密 (出てもOK)、Channel secret は機密 (扱わない)

## 次フェーズ

Phase 2: テスト URL のまま複数パターン送信、Phase 3: 並走検証、
Phase 4-5: 本番切替、Phase 6: 14 日保険、Phase 7: Azure 停止判断。

`docs/PHASE1_GAS_DESIGN.md` も参照。
