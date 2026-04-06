/**
 * 画像前処理ユーティリティ
 * - HEIC/HEIFのJPEGアプローチ変換
 * - 特大画像のCanvasリサイズ
 * - 圧縮品質最適化
 */

export async function normalizeUploadImage(file: File): Promise<File> {
  let blob: Blob = file;

  // 1. HEIC/HEIF の場合は heic2any で JPEG Blobへ変換
  const fileNameLower = file.name.toLowerCase();
  const isHeic =
    fileNameLower.endsWith(".heic") ||
    fileNameLower.endsWith(".heif") ||
    file.type === "image/heic" ||
    file.type === "image/heif";

  if (isHeic) {
    try {
      // heic2any はブラウザ依存・サイズ大のため、動的インポートで読み込む
      const heic2any = (await import("heic2any")).default;
      const converted = await heic2any({
        blob: file,
        toType: "image/jpeg",
        quality: 0.85,
      });
      // 変換結果は Blob または Blob[] となるが、基本は単一Blob
      blob = Array.isArray(converted) ? converted[0] : converted;
    } catch (err: unknown) {
      console.warn("HEIC conversion failed, falling back to original:", err);
      // 万一失敗した場合は、後続のCanvas圧縮か生ファイルにフォールバック（iOSの対応状況による）
    }
  }

  // 2. Canvasを用いてリサイズと圧縮を行う
  return new Promise((resolve, reject) => {
    const img = document.createElement("img");
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url);

      const MAX_SIZE = 1600;
      let width = img.width;
      let height = img.height;

      // リサイズ計算
      if (width > MAX_SIZE || height > MAX_SIZE) {
        if (width > height) {
          height = Math.round((height * MAX_SIZE) / width);
          width = MAX_SIZE;
        } else {
          width = Math.round((width * MAX_SIZE) / height);
          height = MAX_SIZE;
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        // ctxが取れない場合はBlobのままFile化して返す
        return resolve(new File([blob], generateSafeFileName(file, isHeic), { type: blob.type || "image/jpeg" }));
      }

      ctx.drawImage(img, 0, 0, width, height);

      // JPEG品質 0.8 に再エンコード
      canvas.toBlob(
        (compressedBlob) => {
          if (!compressedBlob) {
            return reject(new Error("画像の圧縮処理に失敗しました。"));
          }
          const safeName = generateSafeFileName(file, isHeic);
          resolve(new File([compressedBlob], safeName, { type: "image/jpeg" }));
        },
        "image/jpeg",
        0.8
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      if (isHeic) {
         // HEICかつCanvas読み出しでもコケた場合は、どうしようもないのでエラーとするかそのまま通す
         reject(new Error("非対応の画像フォーマット（HEIC読込失敗）です"));
      } else {
         // 通常画像で失敗した場合は、生のFileを返す
         resolve(file);
      }
    };

    img.src = url;
  });
}

function generateSafeFileName(originalFile: File, wasHeic: boolean): string {
  const originalName = originalFile.name;
  const parts = originalName.split(".");
  const ext = parts.pop()?.toLowerCase();
  let base = parts.join(".");
  if (!base) base = "image";
  
  if (wasHeic || ext === "heic" || ext === "heif") {
    return `${base}.jpg`;
  }
  
  // PNGやWebPの場合もJPEG圧縮しているため、本来はjpgにするのが安全だが、
  // 元がJPEG・PNGならそのままの拡張子を使っても良い（ここでは簡便化のため全てjpgに丸めるか、元の拡張子を使う）
  // 圧縮結果は image/jpeg なので .jpg に統一する
  return `${base}.jpg`;
}
