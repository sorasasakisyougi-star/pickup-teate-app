const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const heicConvert = require('heic-convert');
const sharp = require('sharp');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3001;
const DEFAULT_SAVE_DIR = path.join(__dirname, 'photos');
const SAVE_DIR = process.env.ONEDRIVE_PATH || DEFAULT_SAVE_DIR;

// ディレクトリが存在しない場合は作成
if (!fs.existsSync(SAVE_DIR)) {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());

const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 例: 50MB
});

app.post('/api/photos', upload.single('photo'), async (req, res) => {
  try {
    const { order_id, photo_kind } = req.body;
    const file = req.file;

    if (!order_id || !photo_kind || !file) {
      return res.status(400).json({ error: 'Missing required fields or file' });
    }

    let buffer = file.buffer;
    const mimeType = file.mimetype.toLowerCase();
    const originalName = file.originalname.toLowerCase();
    let finalExt = '.jpg';

    // HEIC変換
    if (mimeType === 'image/heic' || mimeType === 'image/heif' || originalName.endsWith('.heic')) {
      console.log(`Converting HEIC for ${order_id}_${photo_kind}`);
      buffer = await heicConvert({
        buffer: buffer,
        format: 'JPEG',
        quality: 0.8
      });
    }

    // 必要に応じてリサイズ処理 (モバイル通信軽減と容量節約)
    buffer = await sharp(buffer)
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

    const fileName = `${order_id}_${photo_kind}${finalExt}`;
    const filePath = path.join(SAVE_DIR, fileName);

    fs.writeFileSync(filePath, buffer);
    console.log(`Saved photo to ${filePath}`);

    // 本来はココで Supabase の photo_metadata 等を更新する処理を入れるがローカルでは省略し、
    // フロント側で更新する。

    res.json({ success: true, fileName, filePath: filePath });
  } catch (error) {
    console.error('Error handling photo upload:', error);
    res.status(500).json({ error: 'Failed to process photo' });
  }
});

app.listen(port, () => {
  console.log(`Local Photo API server listening on port ${port}`);
  console.log(`Saving photos to: ${SAVE_DIR}`);
});
