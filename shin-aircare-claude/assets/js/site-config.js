/*
 * 真 −SHIN−  サイト設定
 * ------------------------------------------------------------------
 * 差し替え前提の値をここに集約しています。HTML 側は data-config 属性で
 * この値を参照し、未設定（空文字）の項目は「確認中」の表示のまま残ります。
 *
 * 【本番のメール送信へ切り替える箇所】
 *   form.endpoint に送信先 URL を入れると、contact.js はデモ動作をやめ、
 *   入力内容を JSON で POST します（詳細は README「フォームの本番化」）。
 *   例：
 *     - 自前のサーバーレス関数（Cloudflare Pages Functions / Vercel など）で
 *       受け取り、Resend / SendGrid / SES 等の API からメール送信する
 *     - Formspree / Web3Forms のようなフォーム受信サービスの URL を使う
 *       （サービス側の仕様に合わせて contact.js の payload を調整してください）
 */
window.SHIN_CONFIG = {
  company: {
    name: "真 −SHIN−",
    nameReading: "SHIN",
    address: "",        // 例: "〒000-0000 東京都○○区○○ 1-2-3"
    tel: "",            // 例: "03-0000-0000"
    email: "",          // 例: "info@example.com"
    hours: "",          // 例: "平日 9:00–18:00"
    representative: "", // 代表者名
    established: ""     // 設立年月
  },
  form: {
    endpoint: "",       // 空のままならデモ動作（外部送信なし）
    method: "POST"
  }
};
