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

CREATE POLICY "Enable insert for anon" 
ON photo_metadata FOR INSERT 
TO anon 
WITH CHECK (true);
