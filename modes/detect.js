/**
 * detect.js — 物体検出・カウントモジュール
 * TensorFlow.js + COCO-SSD を使用した物体検出
 */

// UMD スクリプトを動的注入するヘルパー
function loadScript(src) {
  return new Promise((res, rej) => {
    // 既にロード済みなら即 resolve
    if (document.querySelector(`script[src="${src}"]`)) {
      res();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

// COCO 80クラスの日本語マップ
const CLASS_JP = {
  person: "人",
  bicycle: "自転車",
  car: "車",
  motorcycle: "バイク",
  airplane: "飛行機",
  bus: "バス",
  train: "電車",
  truck: "トラック",
  boat: "ボート",
  "traffic light": "信号機",
  "fire hydrant": "消火栓",
  "stop sign": "一時停止",
  "parking meter": "パーキングメーター",
  bench: "ベンチ",
  bird: "鳥",
  cat: "猫",
  dog: "犬",
  horse: "馬",
  sheep: "羊",
  cow: "牛",
  elephant: "ゾウ",
  bear: "クマ",
  zebra: "シマウマ",
  giraffe: "キリン",
  backpack: "バックパック",
  umbrella: "傘",
  handbag: "ハンドバッグ",
  tie: "ネクタイ",
  suitcase: "スーツケース",
  frisbee: "フリスビー",
  skis: "スキー",
  snowboard: "スノーボード",
  "sports ball": "ボール",
  kite: "凧",
  "baseball bat": "バット",
  "baseball glove": "グローブ",
  skateboard: "スケボー",
  surfboard: "サーフボード",
  "tennis racket": "テニスラケット",
  bottle: "ボトル",
  "wine glass": "ワイングラス",
  cup: "カップ",
  fork: "フォーク",
  knife: "ナイフ",
  spoon: "スプーン",
  bowl: "ボウル",
  banana: "バナナ",
  apple: "リンゴ",
  sandwich: "サンドイッチ",
  orange: "オレンジ",
  broccoli: "ブロッコリー",
  carrot: "ニンジン",
  "hot dog": "ホットドッグ",
  pizza: "ピザ",
  donut: "ドーナツ",
  cake: "ケーキ",
  chair: "椅子",
  couch: "ソファ",
  "potted plant": "植物",
  bed: "ベッド",
  "dining table": "テーブル",
  toilet: "トイレ",
  tv: "TV",
  laptop: "ノートPC",
  mouse: "マウス",
  remote: "リモコン",
  keyboard: "キーボード",
  "cell phone": "スマホ",
  microwave: "電子レンジ",
  oven: "オーブン",
  toaster: "トースター",
  sink: "シンク",
  refrigerator: "冷蔵庫",
  book: "本",
  clock: "時計",
  vase: "花瓶",
  scissors: "ハサミ",
  "teddy bear": "ぬいぐるみ",
  "hair drier": "ドライヤー",
  toothbrush: "歯ブラシ",
};

function getLabel(className) {
  return CLASS_JP[className] || className;
}

// モジュール内部状態
let model = null;
let loadStarted = false;
let frameCount = 0;
let lastDetections = []; // 直近の検出結果（間引き用キャッシュ）
const DETECT_INTERVAL = 4; // 4フレームに1回検出

export default {
  id: "detect",
  label: "物体",
  icon: "📦",
  mode: "continuous",

  async load() {
    if (model) return; // 冪等
    if (loadStarted) {
      // 既にロード中なら完了待ち
      await new Promise((res) => {
        const check = setInterval(() => {
          if (model) { clearInterval(check); res(); }
        }, 200);
      });
      return;
    }
    loadStarted = true;

    // UMD ライブラリを順番に注入
    const base = new URL("../vendor/detect/", import.meta.url).href;
    await loadScript(base + "tf.min.js");
    await window.tf.ready();
    await loadScript(base + "coco-ssd.min.js");

    model = await window.cocoSsd.load();
  },

  async onFrame(api) {
    if (!model) return;

    frameCount++;

    // 4フレームに1回だけ検出実行
    if (frameCount % DETECT_INTERVAL === 0) {
      try {
        const raw = await model.detect(api.video);
        // score >= 0.5 のみ採用
        lastDetections = raw.filter((d) => d.score >= 0.5);
      } catch (e) {
        // 検出エラーは無視して前回結果を使い続ける
      }
    }

    const ctx = api.ctx;
    const canvasWidth = api.canvas.width;
    const isMirror = api.isMirror();

    // 検出結果を毎フレーム描画（キャッシュ利用でカクつき防止）
    for (const det of lastDetections) {
      const [bx, by, bw, bh] = det.bbox;
      const label = getLabel(det.class);
      const scoreText = Math.round(det.score * 100) + "%";
      const displayText = `${label} ${scoreText}`;

      // ミラー反転時は枠のx座標を補正（枠左端を反転）
      const drawX = isMirror ? canvasWidth - bx - bw : bx;

      ctx.save();

      // 枠描画（水色系）
      ctx.strokeStyle = "#00d4ff";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(drawX, by, bw, bh);

      // 枠上部に半透明背景でラベル描画
      ctx.font = "bold 14px sans-serif";
      const textMetrics = ctx.measureText(displayText);
      const textWidth = textMetrics.width;
      const textHeight = 18;
      const padding = 3;

      const labelX = drawX;
      const labelY = by - textHeight - padding * 2;
      const labelBgY = labelY < 0 ? by : labelY;

      ctx.fillStyle = "rgba(0, 212, 255, 0.75)";
      ctx.fillRect(labelX, labelBgY, textWidth + padding * 2, textHeight + padding * 2);

      ctx.fillStyle = "#000000";
      ctx.textBaseline = "top";
      ctx.fillText(displayText, labelX + padding, labelBgY + padding);

      ctx.restore();
    }

    // クラスごとのカウント集計
    const countMap = {};
    for (const det of lastDetections) {
      const lbl = getLabel(det.class);
      countMap[lbl] = (countMap[lbl] || 0) + 1;
    }

    // 多い順にソート
    const sorted = Object.entries(countMap).sort((a, b) => b[1] - a[1]);
    const total = lastDetections.length;

    if (sorted.length === 0) {
      api.setResult(`<span class="result-empty" style="display:block">物体を検出中…</span>`);
    } else {
      const chips = sorted
        .map(([name, cnt]) => `<span class="count-chip">${name} ×${cnt}</span>`)
        .join("");
      api.setResult(`
        <div class="card-result">
          <div class="count-list">${chips}</div>
          <div class="count-total">合計: ${total} 個</div>
        </div>
      `);
    }
  },

  onStop() {
    // フレームカウンタと直近検出結果をリセット
    frameCount = 0;
    lastDetections = [];
  },
};
