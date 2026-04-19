# Phase 0 — Azure Freeze & Rollback Reference

**作成日**: 2026-04-19
**branch**: `free-migration/gas-liff-phase0` (main/`a55bf56` 基点)
**目的**: 既存送迎システム無停止のまま、新無料系 (GAS + Google Sheets + LINE LIFF)
を別系統で構築するための前提を固定する。

---

## 1. 最重要原則 (移行完了まで絶対禁止)

**以下 3 点は、新無料系の受入合格+公式LINE切替+14日保険期間の完走までは一切変更しない。**

| # | 対象 | 状態 (凍結値) |
|---|---|---|
| A | 現行送迎LIFF本番エンドポイントURL | **変更禁止** (LINE Login channel 側の LIFF app 設定) |
| B | 公式LINE本番リッチメニューの送迎ボタン | **変更禁止** (現行LIFFを指したまま維持) |
| C | Azure本番URL | **変更禁止** (`https://pickup-teate-app-wus2d2.westus2.cloudapp.azure.com`) |

違反した場合の即時影響:
- A変更 → 運転者が送迎報告画面を開けない
- B変更 → 公式LINE経由の入口が壊れる
- C変更 → DNS/証明書/Power Automate 宛先が全部ズレる

## 2. Azure 側の方針 (凍結期間中)

- **追加縮小しない** (VM resize、SKU変更、別リージョン移設すべて停止)
- **追加移設しない** (別クラウド、別アカウントへの移動なし)
- **削除しない** (rg-pickup-teate-prod-westus2 配下の全リソース維持)
- **構成変更しない** (NSG、VNet、Public IP、OS disk すべて現状維持)
- 唯一許可: **read-only 監視** (`az vm show`, HTTPS HEAD probe)
- 切替成功の 14 日後以降、別途判断のうえで停止検討

## 3. 現行 Azure 凍結 snapshot (2026-04-19 取得)

### Resource Groups
```json
[{ "loc": "westus2", "name": "rg-pickup-teate-prod-westus2", "state": "Succeeded" }]
```
(eastasia RG + 空 RG × 3 は本フェーズ前に削除済。詳細は git log 参照。)

### VM
```json
{
  "host": "pickup-teate-app-wus2d2.westus2.cloudapp.azure.com",
  "ip":   "20.80.191.252",
  "size": "Standard_D2s_v5",
  "state": "VM running"
}
```

### Public IP
```json
{
  "sku":   "Standard",
  "alloc": "Static",
  "ip":    "20.80.191.252",
  "fqdn":  "pickup-teate-app-wus2d2.westus2.cloudapp.azure.com"
}
```

### OS Disk
```json
{ "sku": "StandardSSD_LRS", "state": "Attached" }
```

### 稼働プロセス
- systemd unit: `pickup-teate-app.service` → active
- WorkingDirectory: `/srv/pickup-teate-app`
- User: `azureuser`
- Port: 127.0.0.1:3000 (Next.js standalone)
- .next/BUILD_ID: `8HRG6qIlMYTNtDHiS_YEN` (2026-04-09 19:06 JST build)

### HTTPS probe (取得時)
```
HTTP:200 time:0.55s
https://pickup-teate-app-wus2d2.westus2.cloudapp.azure.com/
```

### 稼働 commit (GitHub 側)
- `main` = `a55bf56 fix: finalize pickup rollback and powerautomate test closures`
- production VM には git clone が無く、ビルド成果物のみ配置 (rsync/scp 運用)
- 稼働 build は 2026-04-09 時点のものなので、pre-task24 の main 状態と一致するとみなす

## 4. 非常時ロールバック手順

新無料系切替後に障害が起きた場合、**公式LINE送迎ボタンの URL を旧LIFFに戻すだけ**で復旧する。

```
1. LINE Official Account Manager → リッチメニュー
2. 送迎ボタンのアクション URL を「凍結値 A の旧LIFF URL」に戻す
3. 3 分以内に浸透、運転者は旧導線で報告再開
4. 原因調査は新無料系側で並行実施
```

Azure 本番は凍結中なので起動・構成変更は不要。URL戻しだけでサービス復旧。

## 5. User が Phase 0 として控えるべき LINE 側設定

**正本は LINE Login channel 側**。Messaging API channel ではない。

| # | 対象 | 参照場所 | 控える項目 |
|---|---|---|---|
| 1 | 送迎報告用 LIFF app | LINE Developers Console → **送迎報告 LINE Login channel** → LIFF tab | LIFF ID、エンドポイント URL、サイズ、scope、`liff.getProfile()` / `liff.getIDToken()` のうち利用中のもの |
| 2 | 有給申請用 LIFF app | LINE Developers Console → **有給申請 LINE Login channel** → LIFF tab | 同上 (別 channel の別 LIFF app) |
| 3 | 公式LINE リッチメニュー | LINE Official Account Manager → ホーム → リッチメニュー | 送迎ボタン (右ボタン想定) の action URL 現状値、他ボタンの配置、画像 |
| 4 | LINE User ID 許可マスタ | 既存の管理表 or Sheet | 運転者 / 有給申請可能者の LINE User ID 一覧 (新無料系で allowlist として流用) |

### 控えない・送らない・repo に置かない

**Channel secret** (Messaging API channel / LINE Login channel 双方) は本移行では使いません。
- スクショに含めない
- チャットに貼らない
- docs にコピーしない
- `.env*` にもまだ書かない

## 6. 新無料系の設計原則 (Phase 1 以降で守るルール)

| # | 原則 | 理由 |
|---|---|---|
| 1 | 最初は **test sheet** に保存、受入合格後に本番 sheet へ切替 | 本番データを誤って壊さない |
| 2 | 保存は **`google.script.run` 優先** (`doPost` は使わない) | HTML Service 内で完結、CORS/URL露出/Webhook回避 |
| 3 | Google 側オーナーは **会社管理アカウント** | 個人アカウント引継ぎ問題回避 |
| 4 | 写真は Phase 1 で扱わない | まず保存を壊さず無料化する |
| 5 | 新無料系の設計・文書は **main から切った branch** | task24 凍結 branch には混入させない |
| 6 | 既存本線と責務を混ぜない | 失敗しても戻せる前提 |
| 7 | allowlist は LINE User ID で判定 | LIFF 経由で `userId` 取得 → sheet の許可マスタと照合 |

## 7. 凍結タグ (git)

| tag | SHA | 意味 |
|---|---|---|
| `pre-free-migration-freeze` | `a55bf56` | main の本番相当点。新無料系開発はここから分岐 |
| `task24-frozen-liff-pivot` | `f3d7b6b` | LINE WORKS Bot 路線を凍結。LIFF + GAS 方針へピボット |

## 8. 14日保険期間のルール

新無料系の本番切替成功後:
- **D+0** (切替日): 切替実機確認、1件本番送信成功
- **D+1〜D+13**: 旧 Azure 本線はそのまま稼働、即 rollback 可能な体制維持
- **D+14**: 安定判断 + Azure 停止検討開始 (別タスクで判断)

14日の間は Azure VM の **resize/停止/削除禁止**。新無料系が壊れた場合の戻し先として温存。

## 9. 参照 (task24 branch 凍結)

- LINE WORKS Bot 路線 (task24/phase2b/2c/2d-1) は **永続凍結**
- 本 branch (`free-migration/gas-liff-phase0`) とは独立。交差させない
- task24 の成果物 (webhook / inbox / mapper / bot reply) は本移行では使用しない

---

**次の action**: User が「§5 の LINE 側 4 点を控えた」ことを確認したら、Phase 1
(新無料系 GAS プロジェクト骨格) に進む。Phase 1 以降は別 doc
(`docs/PHASE1_GAS_DESIGN.md`) で管理予定。
