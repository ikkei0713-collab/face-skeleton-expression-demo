/**
 * pose.js — 姿勢検知モジュール
 * MediaPipe PoseLandmarker を使用した全身骨格描画＋行動推論
 */

// モジュール内部状態
let poseLandmarker = null;
let loadStarted = false;

// MediaPipe Pose 標準接続ペア（インデックス）
const POSE_CONNECTIONS = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [27, 31], [28, 30], [28, 32],
  [15, 17], [15, 19], [15, 21], [16, 18], [16, 20], [16, 22],
  [0, 11], [0, 12],
];

// 主要ランドマーク（大きく描画）
const MAJOR_LANDMARKS = new Set([0, 11, 12, 15, 16, 23, 24, 27, 28]);

/**
 * 行動推論 — 正規化座標(y下向き)を元にヒューリスティック判定
 * @param {Array} lm  33点の正規化ランドマーク配列 [{x,y,z,visibility}]
 * @returns {{label:string, emoji:string}}
 */
function inferActivity(lm) {
  const vis = (i) => (lm[i] ? lm[i].visibility ?? 1 : 0);
  const pt = (i) => (vis(i) >= 0.4 ? lm[i] : null);

  const nose = pt(0);
  const lShoulder = pt(11);
  const rShoulder = pt(12);
  const lElbow = pt(13);
  const rElbow = pt(14);
  const lWrist = pt(15);
  const rWrist = pt(16);
  const lHip = pt(23);
  const rHip = pt(24);
  const lKnee = pt(25);
  const rKnee = pt(26);
  const lAnkle = pt(27);
  const rAnkle = pt(28);

  // 可視点が極めて少ない場合
  const visCount = [nose, lShoulder, rShoulder, lHip, rHip, lKnee, rKnee].filter(Boolean).length;
  if (visCount < 2) {
    return { label: "検出中…", emoji: "❓" };
  }

  // --- 肩・腰・膝・足首 Y座標の平均 ---
  const shoulderY = avg([lShoulder?.y, rShoulder?.y]);
  const hipY = avg([lHip?.y, rHip?.y]);
  const kneeY = avg([lKnee?.y, rKnee?.y]);
  const ankleY = avg([lAnkle?.y, rAnkle?.y]);

  // --- 両手首が両肩より上 ---
  if (lWrist && rWrist && lShoulder && rShoulder) {
    if (lWrist.y < shoulderY && rWrist.y < shoulderY) {
      return { label: "両手を上げている", emoji: "🙌" };
    }
  }

  // --- 片手首が肩より上 ---
  if (shoulderY !== null) {
    const lUp = lWrist && lWrist.y < shoulderY;
    const rUp = rWrist && rWrist.y < shoulderY;
    if (lUp || rUp) {
      return { label: "手を上げている / 手を振っている", emoji: "👋" };
    }
  }

  // --- 体がほぼ水平（寝そべっている）---
  // 肩・腰・足首がほぼ同じY座標（差が小さい）かつ体の縦幅が横幅より短い
  if (shoulderY !== null && ankleY !== null) {
    const vertSpan = Math.abs(ankleY - shoulderY);
    const shoulderX = avg([lShoulder?.x, rShoulder?.x]);
    const ankleX = avg([lAnkle?.x, rAnkle?.x]);
    const horizSpan = ankleX !== null ? Math.abs(ankleX - shoulderX) : 0;
    if (vertSpan < 0.25 && horizSpan > vertSpan) {
      return { label: "寝そべっている", emoji: "🛌" };
    }
  }

  // --- 座っている / しゃがんでいる ---
  if (hipY !== null && kneeY !== null) {
    const hipKneeDiff = Math.abs(hipY - kneeY);
    if (hipKneeDiff < 0.15) {
      // 腰と膝が非常に近い → しゃがみ
      if (ankleY !== null && Math.abs(ankleY - hipY) < 0.2) {
        return { label: "しゃがんでいる", emoji: "🧎" };
      }
      return { label: "座っている", emoji: "🪑" };
    }
    if (hipKneeDiff < 0.28) {
      return { label: "座っている", emoji: "🪑" };
    }
  }

  // --- Tポーズ（腕が水平に開いている）---
  if (lWrist && rWrist && lShoulder && rShoulder) {
    const wristYDiffL = Math.abs(lWrist.y - lShoulder.y);
    const wristYDiffR = Math.abs(rWrist.y - rShoulder.y);
    const horizSpread = Math.abs(lWrist.x - rWrist.x);
    if (wristYDiffL < 0.12 && wristYDiffR < 0.12 && horizSpread > 0.5) {
      return { label: "Tポーズ", emoji: "🤸" };
    }
  }

  // --- 立っている（デフォルト）---
  if (hipY !== null && kneeY !== null && hipY < kneeY) {
    return { label: "立っている", emoji: "🧍" };
  }

  return { label: "検出中…", emoji: "❓" };
}

/**
 * 数値配列の平均（null/undefinedを除く）
 */
function avg(arr) {
  const valid = arr.filter((v) => v != null);
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

export default {
  id: "pose",
  label: "姿勢",
  icon: "🧍",
  mode: "continuous",
  selfClear: true,

  async load(api) {
    if (poseLandmarker) return; // 冪等
    if (loadStarted) {
      // ロード中なら完了待ち
      await new Promise((res) => {
        const check = setInterval(() => {
          if (poseLandmarker) { clearInterval(check); res(); }
        }, 200);
      });
      return;
    }
    loadStarted = true;

    try {
      if (api && api.setBusy) api.setBusy(true, "姿勢モデルを読み込み中…");

      const mp = await import("../vendor/mediapipe/vision_bundle.mjs");
      const fileset = await mp.FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");

      const opt = (delegate) => ({
        baseOptions: {
          modelAssetPath: "./models/pose_landmarker_lite.task",
          delegate,
        },
        runningMode: "VIDEO",
        numPoses: 1,
      });

      try {
        poseLandmarker = await mp.PoseLandmarker.createFromOptions(fileset, opt("GPU"));
      } catch {
        poseLandmarker = await mp.PoseLandmarker.createFromOptions(fileset, opt("CPU"));
      }
    } finally {
      if (api && api.setBusy) api.setBusy(false);
    }
  },

  async onFrame(api) {
    if (!poseLandmarker) return;

    // 映像が未準備なら早期リターン
    if (!api.video.videoWidth || api.video.readyState < 2) {
      api.clear();
      return;
    }

    const W = api.canvas.width;
    const H = api.canvas.height;
    const ctx = api.ctx;

    // 検出実行
    let res;
    try {
      res = poseLandmarker.detectForVideo(api.video, performance.now());
    } catch {
      api.clear();
      return;
    }

    // 検出完了後にクリア（点滅防止）
    api.clear();

    const landmarks = res.landmarks;

    if (!landmarks || landmarks.length === 0) {
      api.setResult(`<div class="result-empty">全身が映るように立ってください…</div>`);
      return;
    }

    // 各人物について描画
    for (const lm of landmarks) {
      if (!lm || lm.length === 0) continue;

      // --- 接続線の描画 ---
      ctx.save();
      ctx.strokeStyle = "rgba(91,155,255,0.85)";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";

      for (const [a, b] of POSE_CONNECTIONS) {
        const pa = lm[a];
        const pb = lm[b];
        if (!pa || !pb) continue;
        if ((pa.visibility ?? 1) < 0.4 || (pb.visibility ?? 1) < 0.4) continue;

        const ax = api.fx(pa.x * W);
        const ay = pa.y * H;
        const bx = api.fx(pb.x * W);
        const by = pb.y * H;

        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      ctx.restore();

      // --- 関節点の描画 ---
      for (let i = 0; i < lm.length; i++) {
        const p = lm[i];
        if (!p) continue;
        if ((p.visibility ?? 1) < 0.4) continue;

        const px = api.fx(p.x * W);
        const py = p.y * H;
        const radius = MAJOR_LANDMARKS.has(i) ? 6 : 4;

        ctx.save();
        ctx.fillStyle = "rgba(54,211,153,0.95)";
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // --- 行動推論 ---
      const { label, emoji } = inferActivity(lm);

      // キャンバス上に emoji+label を表示
      const nose = lm[0];
      let labelX = W / 2;
      let labelY = 40;

      if (nose && (nose.visibility ?? 1) >= 0.4) {
        labelX = api.fx(nose.x * W);
        labelY = Math.max(nose.y * H - 30, 24);
      }

      const text = `${emoji} ${label}`;
      ctx.save();
      ctx.font = "bold 18px sans-serif";
      const tm = ctx.measureText(text);
      const tw = tm.width;
      const th = 22;
      const pad = 6;
      const bgX = labelX - tw / 2 - pad;
      const bgY = labelY - th;

      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.beginPath();
      ctx.roundRect(bgX, bgY, tw + pad * 2, th + pad, 6);
      ctx.fill();

      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, labelX, bgY + (th + pad) / 2);
      ctx.restore();

      // --- setResult ---
      api.setResult(`
        <div class="card-result">
          <div class="cr-label">姿勢推定</div>
          <div class="cr-body">${emoji} ${label}</div>
        </div>
      `);
    }
  },

  onStop() {
    // 特にリセット不要（poseLandmarker は使い回す）
  },
};
