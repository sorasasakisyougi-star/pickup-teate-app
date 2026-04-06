-- 独立した後付け写真機能用メタデータテーブル
CREATE TABLE IF NOT EXISTS photo_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL, -- pickup_orders のID
  photo_kind VARCHAR NOT NULL, -- 'depart' または 'arrival_X'
  file_name VARCHAR NOT NULL,
  file_path VARCHAR NOT NULL, -- 保存先の相対パス
  status VARCHAR DEFAULT 'pending', -- pending, uploaded, failed
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- RLS設定 (適宜環境に合わせる)
ALTER TABLE photo_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Enable all for authenticated users" 
ON photo_metadata FOR ALL 
TO authenticated 
USING (true) WITH CHECK (true);

-- 【注意: セキュリティについて】
-- 下記の設定は「誰でも自由に未認証で書き込める」設定です。
-- 写真メタ情報の外部更新API（Power Automate等やWebhook）が認証情報を持たない場合のみ、
-- セキュリティの脆弱性（DDoS等の不正レコード追加リスク）を承知の上で暫定的に許可するものです。
-- 本来は、anon に対する INSERT 許可は外し、サービスキー付きの社内PC（または専用API）からのみ更新させるのが正本です。

/*
CREATE POLICY "Enable insert for anon" 
ON photo_metadata FOR INSERT 
TO anon 
WITH CHECK (true);
*/
