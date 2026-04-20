/**
 * pickup.vege-office.com → LIFF redirector (Cloudflare Worker).
 *
 * 役割: 独自ドメインへのアクセスを既存 LIFF URL へ 302 で飛ばす。
 * テスト中は 302。安定後に 301 へ変える (下の REDIRECT_STATUS を 301 に)。
 * 既存の GAS / Google スプレッドシート / Mac 同期 / OneDrive Excel 反映 /
 * Azure にはいっさい影響しない。
 */

const LIFF_URL = "https://liff.line.me/2009831071-PQmkoa5u";
// 302=一時 (テスト中。キャッシュ残らない)。301=恒久 (安定後。ブラウザキャッシュに強く残る)。
const REDIRECT_STATUS = 302;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ヘルスチェック: Cloudflare の route 監視や外形監視で叩く用途。
    if (url.pathname === "/healthz") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // query string だけ保持して LIFF に渡す (path は無視)。
    const target = new URL(LIFF_URL);
    target.search = url.search;

    return Response.redirect(target.toString(), REDIRECT_STATUS);
  },
};
