/**
 * OCR モード (modes/ocr.js)
 * Tesseract.js v5 を使った日本語＋英語テキスト認識モジュール。
 * 全アセット自己ホスト。外部CDNへの通信なし。
 */

let worker = null;
let loadPromise = null;

export default {
  id: "ocr",
  label: "文字",
  icon: "🔤",
  mode: "shutter",

  /**
   * Tesseract.js worker を一度だけ初期化する（冪等）。
   * パスはアプリルート基準の "./" で渡す（Tesseract は window.location 基準で fetch するため）。
   */
  async load() {
    if (worker) return;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      // ESM default export → Tesseract オブジェクト（createWorker を持つ）
      const Tesseract = (await import("../vendor/ocr/tesseract.esm.min.js")).default;

      worker = await Tesseract.createWorker(
        ["jpn", "eng"],
        1, // OEM: LSTM_ONLY
        {
          workerPath: "./vendor/ocr/worker.min.js",
          corePath:   "./vendor/ocr/",   // 4 つの *.wasm.js が置かれたディレクトリ
          langPath:   "./models/ocr",    // jpn.traineddata.gz / eng.traineddata.gz
          gzip: true,                    // .gz ファイルをそのまま使う
          logger: () => {},              // ログ抑制
        }
      );
    })();

    return loadPromise;
  },

  /**
   * シャッター押下時: 現フレームを OCR して結果を表示する。
   * @param {object} api - シェルから渡される API オブジェクト
   */
  async onCapture(api) {
    api.setBusy(true, "解析中…");

    try {
      // ---- オフスクリーン canvas に現フレームを描画 ----
      const vw = api.video.videoWidth;
      const vh = api.video.videoHeight;

      const offscreen = document.createElement("canvas");
      offscreen.width  = vw;
      offscreen.height = vh;
      const octx = offscreen.getContext("2d");

      // 内カメラは video が CSS で反転しているが、実際の映像データは未反転。
      // OCR は元データで認識すれば良いのでそのまま描画。
      octx.drawImage(api.video, 0, 0, vw, vh);

      // ---- OCR 実行 ----
      const { data } = await worker.recognize(offscreen);

      const text       = (data.text || "").trim();
      const confidence = Math.round(data.confidence ?? 0);

      // ---- オーバーレイに認識枠を描画（任意: 単語レベル bbox）----
      api.ctx.clearRect(0, 0, api.canvas.width, api.canvas.height);
      if (data.words && data.words.length > 0) {
        api.ctx.strokeStyle = "rgba(0,200,255,0.85)";
        api.ctx.lineWidth   = 2;
        for (const word of data.words) {
          if (!word.bbox || word.confidence < 30) continue;
          const { x0, y0, x1, y1 } = word.bbox;
          const drawX = api.fx(x0);
          const w     = x1 - x0;
          // mirror 時は x0/x1 が反転するため幅だけ取り出す
          api.ctx.strokeRect(
            api.isMirror() ? drawX - w : drawX,
            y0,
            w,
            y1 - y0
          );
        }
      }

      // ---- 結果パネル表示 ----
      if (text.length === 0) {
        api.setResult(`<p style="color:#aaa;text-align:center;padding:8px">文字を検出できませんでした</p>`);
      } else {
        const escaped = text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        api.setResult(`
          <div style="padding:6px 8px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <span style="font-size:11px;color:#888">OCR 結果</span>
              <span style="font-size:11px;background:rgba(0,200,255,.2);color:#0cf;border-radius:4px;padding:2px 6px">
                信頼度 ${confidence}%
              </span>
            </div>
            <pre style="
              margin:0;
              white-space:pre-wrap;
              word-break:break-all;
              font-size:13px;
              line-height:1.6;
              max-height:220px;
              overflow-y:auto;
              background:rgba(255,255,255,.06);
              border-radius:6px;
              padding:8px;
              color:#eee;
              font-family:'Hiragino Sans','Meiryo',monospace;
            ">${escaped}</pre>
          </div>
        `);
      }
    } catch (err) {
      console.error("[OCR] recognize error:", err);
      api.setResult(`<p style="color:#f88;padding:8px">認識エラー: ${err && err.message ? err.message : err}</p>`);
    } finally {
      api.setBusy(false);
    }
  },

  /**
   * モード停止時のクリーンアップ（worker は次回のため保持する）。
   */
  onStop() {
    // worker は load() で一度初期化したら保持し続ける（再初期化コスト削減）。
    // 明示的に終了したい場合は worker.terminate() を呼ぶ。
  },
};
