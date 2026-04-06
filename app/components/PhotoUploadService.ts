// PhotoUploadService.ts
// 「本体保存成功後」に、この関数を呼び出して非同期で写真を送信します。
// 接続先は社内PC内で立ち上げた Tunnel (ngrok等) 経由の公開URLを想定しています。

const LOCAL_API_URL = process.env.NEXT_PUBLIC_PHOTO_API_URL;

export interface PhotoUploadParams {
  orderId: string;
  photoKind: string; // 'depart' または 'arrival_0', 'arrival_1', etc.
  file: File;
}

export async function uploadPhotoAsync(params: PhotoUploadParams): Promise<boolean> {
  if (!LOCAL_API_URL) {
    console.warn("[PhotoUpload] NEXT_PUBLIC_PHOTO_API_URL が設定されていないため、写真送信をスキップします");
    return false;
  }

  try {
    const formData = new FormData();
    formData.append("order_id", params.orderId);
    formData.append("photo_kind", params.photoKind);
    formData.append("photo", params.file);

    const res = await fetch(LOCAL_API_URL, {
      method: "POST",
      body: formData,
    });

    if (!res.ok) {
      console.warn(`[PhotoUpload] HTTP Error: ${res.status} for ${params.photoKind}`);
      return false;
    }

    const data = await res.json();
    return !!data.success;
  } catch (error) {
    console.warn(`[PhotoUpload] exception for ${params.photoKind}:`, error);
    return false;
  }
}
