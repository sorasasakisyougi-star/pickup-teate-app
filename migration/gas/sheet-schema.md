# Google Sheet スキーマ (Phase 1)

会社管理 Google アカウントで新規作成したスプレッドシート 1 冊に以下 9 タブを作る。
タブ名は exact。行 1 はヘッダー。データ行は行 2 以降。

すべての列は **synthetic example** で値の形式を示す。実データ投入は deploy 完了後。

---

## `許可マスタ`

LINE User ID で「送信権限あり」を判定する正本。Phase 0 時点は空、Phase 2 で自分 1 行を追加。

| A: line_user_id | B: display_name | C: role | D: active |
|---|---|---|---|
| `Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` | 山田太郎 | `送迎報告` | TRUE |
| `Uyyy...` | 鈴木花子 | `両方` | TRUE |
| `Uzzz...` | 退職者 | `送迎報告` | FALSE |

- `role`: `送迎報告` / `有給申請` / `両方` のどれか
- `active=FALSE` は `unauthorized` として扱う
- `line_user_id` の前方に空白禁止、exact match

---

## `運転者マスタ`

| A: driver_name | B: active | C: default_vehicle |
|---|---|---|
| 山田太郎 | TRUE | ハイエース |
| 鈴木花子 | TRUE | (空欄可) |

---

## `車両マスタ`

| A: vehicle_name | B: active |
|---|---|
| ハイエース | TRUE |
| 軽バン | TRUE |

---

## `地点マスタ`

| A: location_name | B: category |
|---|---|
| 会社 | 発着 |
| A病院 | 病院 |
| B老人ホーム | 施設 |

---

## `料金マスタ`

| A: from | B: to | C: amount_yen |
|---|---|---|
| 会社 | A病院 | 700 |
| 会社 | B老人ホーム | 900 |
| A病院 | B老人ホーム | 500 |

バス (`mode=バス`) は料金マスタを参照しない。`Code.gs` で一律 2000 を返す。

通常ルートの計算: `from→arrivals[0]`, `arrivals[0]→arrivals[1]`, … のペアごとに金額を合算。
どれか 1 ペアが未登録なら `fare_not_registered` エラー。
逆方向マッチ (`B→A` が見つかれば `A→B` の代替にする) はフェーズ 1 では実装しない。シンプル優先。

---

## `距離マスタ`

| A: from | B: to | C: distance_km |
|---|---|---|
| 会社 | A病院 | 5.2 |
| 会社 | B老人ホーム | 7.8 |
| A病院 | B老人ホーム | 3.1 |

同上、バスは距離マスタ参照なし。未登録ペアは `distance_not_registered` エラー。

---

## `送迎記録_test` (Phase 1 の書き込み先)

| 列 | 内容 | 例 |
|---|---|---|
| A: 報告時刻 | ISO-8601 (JST 変換後) | `2026-04-19T10:15:00+09:00` |
| B: 日付 | 表示用 `yyyy/M/d` | `2026/4/19` |
| C: 運転者 | 運転者マスタから選択 | 山田太郎 |
| D: 車両 | 車両マスタから選択 | ハイエース |
| E: 区分 | `通常ルート` / `バス` | 通常ルート |
| F: 出発地 | 地点マスタから選択 | 会社 |
| G: 到着1 | 地点マスタから選択 | A病院 |
| H: 到着2 | 同上 or 空欄 | B老人ホーム |
| I: 到着3 | | (空) |
| J: 到着4 | | (空) |
| K: 到着5 | | (空) |
| L: 到着6 | | (空) |
| M: 到着7 | | (空) |
| N: 到着8 | | (空) |
| O: ODO始 | 整数 | 215159 |
| P: ODO終 | 整数 | 215185 |
| Q: 金額 | 整数 | 1200 |
| R: 総走行距離 | 小数 | 8.3 |
| S: 備考 | 自由入力 | 雨 |
| T: 投稿userId | LINE userId | `Uxxx...` |
| U: 投稿者表示名 | 許可マスタから引いた display_name | 山田太郎 |

## `送迎記録` (Phase 3 以降で書込)

`送迎記録_test` と完全一致の列構成 (コピーで OK)。Phase 1 時点では空でもタブは作っておく。

## `投稿ログ`

| A: timestamp | B: userId | C: action | D: result | E: message |
|---|---|---|---|---|
| `2026-04-19T10:15:00+09:00` | `Uxxx...` | saveReport | ok | - |
| `2026-04-19T10:15:20+09:00` | `Uzzz...` | saveReport | unauthorized | - |
| `2026-04-19T10:16:01+09:00` | `Uxxx...` | saveReport | error | `fare_not_registered: 会社 → 未登録地点` |

`userId` と `message` が機微情報 (LINE userId は外部公開しない)。このシートを社外共有する場合は列削除してから。

---

## 参考: 既存 Excel の列構成との対応

Phase 4 で本番シートへ昇格させるとき、既存の OneDrive Excel (`送迎N月自動反映.xlsx`)
の列と揃える調整が入る。その時に `送迎記録` タブのヘッダーを Excel に合わせる
(現状の `送迎記録_test` とは列数・列順が異なる可能性あり)。

Phase 1 はあくまで `送迎記録_test` に書けることがゴール。本番列整合は Phase 4 で判断。
