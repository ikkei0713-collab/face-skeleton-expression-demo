// QR・バーコードモード（ZXing 自己ホスト）
let reader = null;
let loaded = false;
let last = null; // { text, points:[{x,y}], format, ts }

function ensureLib() {
  if (window.ZXing) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = new URL("../vendor/qr/zxing.umd.min.js", import.meta.url).href;
    s.onload = res;
    s.onerror = () => rej(new Error("ZXing読み込み失敗"));
    document.head.appendChild(s);
  });
}

function formatName(fmt) {
  try { return window.ZXing.BarcodeFormat[fmt] || "コード"; } catch { return "コード"; }
}

function showResult(api) {
  if (!last) { api.setResult(`<div class="result-empty">QR / バーコードを枠に映してください…</div>`); return; }
  const isUrl = /^https?:\/\//i.test(last.text);
  const body = isUrl
    ? `<a href="${last.text}" target="_blank" rel="noopener" class="qr-link">${last.text}</a>`
    : `<span class="qr-text">${last.text.replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]))}</span>`;
  api.setResult(`
    <div class="card-result">
      <div class="cr-label">${formatName(last.format)}</div>
      <div class="cr-body">${body}</div>
      <button id="qrCopy" class="ctrl-btn small">コピー</button>
    </div>`);
  const copy = document.getElementById("qrCopy");
  if (copy) copy.addEventListener("click", () => navigator.clipboard?.writeText(last.text));
}

export default {
  id: "qr",
  label: "QR",
  icon: "🔳",
  mode: "continuous",

  async load(api) {
    if (loaded) return;
    api.setBusy(true, "読取準備中…");
    await ensureLib();
    reader = new window.ZXing.BrowserMultiFormatReader();
    api.setBusy(false);
    loaded = true;
  },

  onActivate(api) {
    last = null;
    showResult(api);
    try {
      // ZXing 自身のループで連続デコード（既存の<video>を利用）
      reader.decodeFromVideoElement(api.video, (result) => {
        if (result) {
          last = {
            text: result.getText(),
            points: (result.getResultPoints && result.getResultPoints()) || [],
            format: result.getBarcodeFormat ? result.getBarcodeFormat() : null,
            ts: performance.now(),
          };
          showResult(api);
        }
      }).catch((e) => console.warn("qr decode loop", e));
    } catch (e) {
      console.warn("qr start", e);
    }
  },

  onDeactivate() {
    try { reader && reader.reset(); } catch {}
    last = null;
  },

  onFrame(api) {
    if (!last) return;
    // 1.5秒以内に読めたコードの位置に枠を描く
    if (performance.now() - last.ts > 1500) return;
    const { ctx, fx } = api;
    const pts = last.points;
    if (!pts || pts.length < 2) return;
    ctx.strokeStyle = "#36d399";
    ctx.lineWidth = 4;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = fx(p.getX ? p.getX() : p.x);
      const y = p.getY ? p.getY() : p.y;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  },

  onStop() {
    try { reader && reader.reset(); } catch {}
  },
};
