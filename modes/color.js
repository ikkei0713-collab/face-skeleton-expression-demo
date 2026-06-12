/**
 * color.js — カラーピッカーモジュール
 * タップした位置のピクセル色を取得し、色見本・HEX・RGB・色名を表示
 */

// オフスクリーン canvas（使い回し）
let offCanvas = null;
let offCtx = null;

// 取得済みカラー情報
let picked = null;

// 登録したイベントリスナの参照（解除用）
let _tapHandler = null;
let _canvasRef = null;

// 代表色辞書（日本語色名 → RGB）
const COLOR_DICT = [
  { name: "黒",     rgb: [0,   0,   0  ] },
  { name: "グレー", rgb: [128, 128, 128] },
  { name: "白",     rgb: [255, 255, 255] },
  { name: "赤",     rgb: [220, 20,  20 ] },
  { name: "朱色",   rgb: [228, 72,  36 ] },
  { name: "オレンジ",rgb:[255, 140, 0  ] },
  { name: "黄色",   rgb: [255, 220, 0  ] },
  { name: "黄緑",   rgb: [154, 205, 50 ] },
  { name: "緑",     rgb: [34,  139, 34 ] },
  { name: "深緑",   rgb: [0,   100, 0  ] },
  { name: "青緑",   rgb: [0,   128, 128] },
  { name: "水色",   rgb: [135, 206, 235] },
  { name: "青",     rgb: [30,  80,  220] },
  { name: "紺",     rgb: [25,  25,  112] },
  { name: "紫",     rgb: [128, 0,   128] },
  { name: "ラベンダー", rgb: [182, 150, 220] },
  { name: "ピンク", rgb: [255, 105, 180] },
  { name: "赤紫",   rgb: [199, 21,  133] },
  { name: "茶色",   rgb: [139, 90,  43 ] },
  { name: "ベージュ",rgb:[245, 220, 185] },
  { name: "クリーム",rgb:[255, 253, 208] },
  { name: "サーモン",rgb:[250, 128, 114] },
  { name: "金色",   rgb: [212, 175, 55 ] },
  { name: "シルバー",rgb:[192, 192, 192] },
  { name: "コーラル",rgb:[255, 127, 80 ] },
  { name: "マゼンタ",rgb:[255, 0,   255] },
  { name: "ターコイズ",rgb:[64, 224, 208] },
  { name: "インディゴ",rgb:[75,  0,   130] },
];

/**
 * ユークリッド距離で最も近い色名を返す
 */
function nearestColorName(r, g, b) {
  let minDist = Infinity;
  let nearest = "不明";
  for (const entry of COLOR_DICT) {
    const [cr, cg, cb] = entry.rgb;
    const dist = Math.sqrt(
      (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
    );
    if (dist < minDist) {
      minDist = dist;
      nearest = entry.name;
    }
  }
  return nearest;
}

/**
 * 数値を2桁16進数文字列に変換
 */
function toHex2(v) {
  return v.toString(16).padStart(2, "0").toUpperCase();
}

/**
 * ピクセル色を取得し picked を更新して renderColor を呼ぶ
 */
function pickColor(e, api) {
  const clientX = e.clientX;
  const clientY = e.clientY;

  // videoWidth ガード
  const vw = api.video.videoWidth  || api.canvas.width;
  const vh = api.video.videoHeight || api.canvas.height;
  if (!vw || !vh) return;

  // オフスクリーン canvas に映像を描画
  if (!offCanvas) {
    offCanvas = document.createElement("canvas");
    offCtx    = offCanvas.getContext("2d");
  }
  offCanvas.width  = vw;
  offCanvas.height = vh;
  offCtx.drawImage(api.video, 0, 0, vw, vh);

  // client座標 → 動画ピクセル座標変換（object-fit: cover）
  const rect = api.canvas.getBoundingClientRect();
  const cw = api.canvas.width;
  const ch = api.canvas.height;
  const scale = Math.max(rect.width / cw, rect.height / ch);
  const dispW = cw * scale;
  const dispH = ch * scale;
  const offX = (rect.width  - dispW) / 2;
  const offY = (rect.height - dispH) / 2;
  let px = (clientX - rect.left - offX) / scale;
  let py = (clientY - rect.top  - offY) / scale;
  if (api.isMirror()) px = cw - px;   // 内カメラは左右反転
  px = Math.max(0, Math.min(cw - 1, px));
  py = Math.max(0, Math.min(ch - 1, py));

  // 3×3 平均でノイズ低減
  const x0 = Math.max(0, Math.round(px) - 1);
  const y0 = Math.max(0, Math.round(py) - 1);
  const x1 = Math.min(vw - 1, Math.round(px) + 1);
  const y1 = Math.min(vh - 1, Math.round(py) + 1);
  const imgData = offCtx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  const data = imgData.data;
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
    count++;
  }
  const r = Math.round(rSum / count);
  const g = Math.round(gSum / count);
  const b = Math.round(bSum / count);
  const hex = `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
  const name = nearestColorName(r, g, b);

  picked = { x: px, y: py, hex, rgb: [r, g, b], name };
  renderColor(api);
}

/**
 * 結果HTMLを生成して api.setResult に渡す
 */
function renderColor(api) {
  if (!picked) {
    api.setResult(`<p class="result-empty">画面をタップして色を取得</p>`);
    return;
  }
  const { hex, rgb, name } = picked;
  const [r, g, b] = rgb;
  // スウォッチの文字色を輝度で白黒切り替え
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  const swatchText = luma > 140 ? "#222" : "#fff";

  api.setResult(`
    <div class="card-result" style="display:flex;flex-direction:column;gap:8px;">
      <div style="
        background:${hex};
        height:60px;
        border-radius:10px;
        border:0.5px solid var(--hairline);
        display:flex;align-items:center;justify-content:center;
        font-size:13px;font-weight:bold;color:${swatchText};letter-spacing:.05em;">
        ${hex}
      </div>
      <div style="font-size:13px;line-height:1.8;color:var(--text);">
        <span style="font-weight:bold;color:var(--text2);">HEX:</span> ${hex}<br>
        <span style="font-weight:bold;color:var(--text2);">RGB:</span> ${r}, ${g}, ${b}<br>
        <span style="font-weight:bold;color:var(--text2);">色名:</span> ${name}
      </div>
      <button
        class="ctrl-btn small"
        onclick="navigator.clipboard.writeText('${hex}').then(()=>{this.textContent='コピー済み✓';setTimeout(()=>{this.textContent='HEXコピー'},1500)})">
        HEXコピー
      </button>
    </div>
  `);
}

export default {
  id:    "color",
  label: "カラー",
  icon:  "🎨",
  mode:  "continuous",

  async load(api) {
    // 外部ライブラリ不要のため何もしない
  },

  onActivate(api) {
    picked = null;
    renderColor(api);   // 案内メッセージを初期表示

    _tapHandler = (e) => pickColor(e, api);
    _canvasRef  = api.canvas;
    api.canvas.addEventListener("pointerdown", _tapHandler);
  },

  onDeactivate(api) {
    if (_canvasRef && _tapHandler) {
      _canvasRef.removeEventListener("pointerdown", _tapHandler);
    }
    _tapHandler = null;
    _canvasRef  = null;
    picked      = null;
    offCanvas   = null;
    offCtx      = null;
  },

  onFrame(api) {
    if (!picked) return;

    const ctx = api.ctx;
    // 動画ピクセル座標 → canvas描画座標（api.fx で左右反転対応）
    const drawX = api.fx(picked.x);
    const drawY = picked.y;
    const radius = 10;

    ctx.save();
    // 外縁（白）
    ctx.beginPath();
    ctx.arc(drawX, drawY, radius + 2, 0, Math.PI * 2);
    ctx.strokeStyle = "white";
    ctx.lineWidth   = 3;
    ctx.stroke();

    // 取得色で塗りつぶしリング
    ctx.beginPath();
    ctx.arc(drawX, drawY, radius, 0, Math.PI * 2);
    ctx.fillStyle   = picked.hex;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // 中央の白点
    ctx.beginPath();
    ctx.arc(drawX, drawY, 2, 0, Math.PI * 2);
    ctx.fillStyle = "white";
    ctx.fill();

    ctx.restore();
  },

  onStop() {
    picked    = null;
    offCanvas = null;
    offCtx    = null;
  },
};
