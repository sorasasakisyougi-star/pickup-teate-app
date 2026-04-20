# pickup.vege-office.com → LIFF redirect (Cloudflare Worker)

独自ドメインへのアクセスを既存 LIFF URL へ 302 で飛ばすだけの最小構成。

**対象**: `pickup.vege-office.com/*`
**リダイレクト先**: `https://liff.line.me/2009831071-PQmkoa5u`
**追加課金**: なし (Cloudflare Workers 無料枠、100k req/日)

---

## ファイル

| ファイル | 役割 |
|---|---|
| `worker.js` | redirect 本体。302 返し / `/healthz` は 200。LIFF URL と status コードを const で保持 |
| `wrangler.toml` | Cloudflare project 設定 (name / route / zone) |
| `.gitignore` | Wrangler ローカルキャッシュ + 将来の local secrets を除外 |
| `README.md` | 本文書 |

## 前提

- Cloudflare アカウントがある
- `vege-office.com` が Cloudflare の管理下 (nameserver 委任済) になっている
- Cloudflare 上で Workers Free プランが有効

確認方法: Cloudflare ダッシュボード → Websites → `vege-office.com` が見えれば OK。

## Wrangler インストール + ログイン

```bash
# グローバルに入れる場合
npm install -g wrangler

# もしくは npx で都度 (推奨、グローバル汚染なし)
cd migration/cloudflare-worker
npx wrangler login
```

ログイン成功で `~/.wrangler/config/default.toml` に auth token が保存される。
このトークンは **docs にもチャットにも載せない**。

## ローカル確認

```bash
cd migration/cloudflare-worker
npx wrangler dev
# → http://localhost:8787 で Worker が立つ

# 別ターミナルで:
curl -sv http://localhost:8787/                    # → 302 Location: https://liff.line.me/2009831071-PQmkoa5u
curl -sv 'http://localhost:8787/?foo=1&bar=2'      # → 302 Location: https://liff.line.me/2009831071-PQmkoa5u?foo=1&bar=2
curl -sv http://localhost:8787/healthz             # → 200 "ok"
curl -sv http://localhost:8787/anything/path       # → 302 (path 無視)
```

すべて期待どおりなら次の deploy へ。

## デプロイ (本番)

```bash
cd migration/cloudflare-worker
npx wrangler deploy
```

初回だけ Cloudflare ダッシュボードで DNS 確認:
- Websites → `vege-office.com` → DNS
- `pickup` subdomain の A/CNAME レコードが proxied (橙色の雲) になっている
- なければ Cloudflare が自動追加する (Workers Custom Domain 経由)

確認 curl:

```bash
curl -sv https://pickup.vege-office.com/            # → 302 Location: https://liff.line.me/2009831071-PQmkoa5u
curl -sv https://pickup.vege-office.com/healthz     # → 200 "ok"
curl -sv 'https://pickup.vege-office.com/?x=1'      # → 302 Location: https://liff.line.me/2009831071-PQmkoa5u?x=1
```

## スマホで実機確認

`https://pickup.vege-office.com` をスマホの LINE アプリ or ブラウザで開く → LIFF に飛んで送迎フォームが表示される。

`pickup.vege-office.com` を公式LINE リッチメニューに載せるかどうかは別判断 (載せると本番切替=Phase 5 相当)。
本 Worker は **Phase 4/5 を独自ドメインでやるときの準備**。公式LINE リッチメニューを今すぐ触る必要はない。

## 302 → 301 への切替タイミングと場所

**切替場所**: `worker.js` の定数 1 箇所

```js
const REDIRECT_STATUS = 302;   // ← ここを 301 に変える
```

変更後:
```bash
npx wrangler deploy
```

**切替タイミング**:
- Phase 4 の本番切替が成功し、運用が安定した後 (14 日の保険期間経過後くらい)
- 302 のうちはブラウザがキャッシュしない → 切戻し即時可
- 301 にすると Chrome/Safari が数日〜半年キャッシュする → **切戻しは即効性が落ちる**
- 一度 301 を返してしまうと、同じクライアントからは再度アクセス時にサーバーに問い合わせず LIFF 直接飛ぶ

切替前チェックリスト:
- [ ] LIFF URL を当面変えない自信がある
- [ ] 公式LINE リッチメニューがこの pickup.vege-office.com を指している (or Phase 5 で指す予定)
- [ ] 戻し先 (Azure 旧本線) の 14 日保険期間が終わっている
- [ ] `/healthz` も 200 返し続けている (外形監視 OK)

## 既存システム無影響確認

本 Worker は以下のいずれにも触らない:
- Google スプレッドシート / GAS プロジェクト
- Mac 同期スクリプト
- OneDrive `/General/雇用/送迎/...`
- Azure VM (`pickup-teate-app-wus2d2.westus2.cloudapp.azure.com`)
- LINE Developers Console 側の LIFF app 設定 (`liff.line.me/<LIFF_ID>` はそのまま)

`pickup.vege-office.com` へのトラフィックが来ない限りこの Worker は発火しないので、
routes 登録 + DNS 設定が整うまでは既存運用に完全に透明。

## 戻し手順 (緊急時)

Cloudflare ダッシュボード → Workers & Pages → `pickup-liff-redirect` → Delete

or CLI:
```bash
npx wrangler delete --name pickup-liff-redirect
```

削除後、`pickup.vege-office.com` は NXDOMAIN に戻る。
運用ユーザーは既存 LIFF URL を直接開く or 旧 Azure URL をブックマークしたまま使い続ける。

## トラブル切り分け

| 症状 | 原因候補 | 対処 |
|---|---|---|
| deploy で `Zone not found` | `vege-office.com` が Cloudflare 未登録 | ドメイン Cloudflare 登録 + nameserver 委任 |
| `pickup.vege-office.com` が NXDOMAIN | Workers route 未反映 | deploy 直後 2-5 分待つ / DNS タブで pickup レコード確認 |
| 302 が返るが LIFF が開かない | LIFF app が閉じられている or LIFF ID 誤り | LINE Developers Console で LIFF app status 確認 |
| `/healthz` も 302 | `worker.js` の条件分岐を消してしまった | `url.pathname === "/healthz"` が残っているか確認 |
| query が壊れる | `target.search = url.search` が消えた | worker.js 差分確認 |

---

## スナップショット (現時点)

- worker status code: **302** (テスト中)
- LIFF URL: `https://liff.line.me/2009831071-PQmkoa5u`
- compatibility date: `2026-04-20`
- 無料枠: 100k req/日 まで $0
