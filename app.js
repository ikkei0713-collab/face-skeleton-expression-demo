import {
  FaceLandmarker,
  FilesetResolver,
} from "./vendor/vision_bundle.mjs";

// モジュールが実行開始したことをHTML側のウォッチドッグに通知
window.__APP_MODULE_LOADED = true;

// ---- DOM ----
const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const startScreen = document.getElementById("startScreen");
const emojiEl = document.getElementById("emoji");
const exprLabel = document.getElementById("exprLabel");
const barsEl = document.getElementById("bars");
const fpsEl = document.getElementById("fps");
const stage = document.getElementById("stage");

const toggleMesh = document.getElementById("toggleMesh");
const toggleContours = document.getElementById("toggleContours");
const togglePoints = document.getElementById("togglePoints");
const toggleMirror = document.getElementById("toggleMirror");

let faceLandmarker = null;
let running = false;
let lastVideoTime = -1;
let lastFrameAt = 0;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
  // HTML側ウォッチドッグへ状態を通知
  if (kind === "ready") window.__APP_READY = true;
  if (kind === "error") window.__APP_ERROR = text;
}

function applyMirror() {
  const t = toggleMirror.checked ? "scaleX(-1)" : "scaleX(1)";
  video.style.transform = t;
  canvas.style.transform = t;
}
toggleMirror.addEventListener("change", applyMirror);

// ---- モデル読み込み（全てローカル自己ホスト：CDN/通信ブロックの影響を受けない）----
const WASM_PATH = "./vendor/wasm";
const MODEL_PATH = "./models/face_landmarker.task";

function showHint(text) {
  const hint = startScreen.querySelector(".hint");
  if (hint) hint.textContent = text;
}

// 一定時間で解決しない場合に reject させる（GPUハング対策）
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} がタイムアウト(${ms}ms)`)), ms)
    ),
  ]);
}

async function createLandmarker(filesetResolver, delegate) {
  return FaceLandmarker.createFromOptions(filesetResolver, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    outputFaceBlendshapes: true,
    runningMode: "VIDEO",
    numFaces: 1,
  });
}

async function initModel() {
  try {
    setStatus("WASM取得中…");
    showHint("初回はモデルの読み込みに数秒かかります…");
    const filesetResolver = await FilesetResolver.forVisionTasks(WASM_PATH);

    setStatus("モデル取得中(GPU)…");
    try {
      // GPU は iOS Safari でハングすることがあるため、タイムアウトで打ち切って CPU に切替
      faceLandmarker = await withTimeout(
        createLandmarker(filesetResolver, "GPU"),
        8000,
        "GPU初期化"
      );
    } catch (gpuErr) {
      console.warn("GPU初期化に失敗/タイムアウト。CPUで再試行します:", gpuErr);
      setStatus("モデル取得中(CPU)…");
      faceLandmarker = await createLandmarker(filesetResolver, "CPU");
    }

    setStatus("準備完了", "ready");
    showHint("「カメラを起動」を押してください。カメラの許可が出たら「許可」を選択。");
    startBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("読み込み失敗", "error");
    showHint("読み込みに失敗しました: " + (e && e.message ? e.message : e) + "\nページを再読み込みしてください。");
  }
}

// ---- カメラ起動 ----
async function startCamera() {
  try {
    startBtn.disabled = true;
    setStatus("カメラ起動中…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    startScreen.style.display = "none";
    setStatus("検出中", "ready");
    running = true;
    applyMirror();
    requestAnimationFrame(renderLoop);
  } catch (e) {
    console.error(e);
    setStatus("カメラ起動失敗", "error");
    startBtn.disabled = false;
    startScreen.querySelector(".hint").textContent =
      "カメラへのアクセスが拒否されました。Safariの設定からカメラを許可してください。";
  }
}
startBtn.addEventListener("click", startCamera);

// ---- 描画ループ ----
function renderLoop() {
  if (!running) return;

  if (canvas.width !== video.videoWidth && video.videoWidth) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  const now = performance.now();
  let result = null;
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    result = faceLandmarker.detectForVideo(video, now);
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (result && result.faceLandmarks && result.faceLandmarks.length > 0) {
    for (const landmarks of result.faceLandmarks) {
      drawSkeleton(landmarks);
    }
    if (result.faceBlendshapes && result.faceBlendshapes.length > 0) {
      updateExpression(result.faceBlendshapes[0].categories);
    }
  } else if (result) {
    exprLabel.textContent = "顔が見つかりません";
    emojiEl.textContent = "🔍";
  }

  // FPS
  if (lastFrameAt) {
    const fps = 1000 / (now - lastFrameAt);
    fpsEl.textContent = `${fps.toFixed(0)} FPS`;
  }
  lastFrameAt = now;

  requestAnimationFrame(renderLoop);
}

// ---- 描画ヘルパー（DrawingUtilsに依存せず自前実装）----
// connections: [{start, end}, ...] / landmarks: [{x, y}, ...]（正規化座標0..1）
function drawConnectors(landmarks, connections, color, lineWidth) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (const c of connections) {
    const a = landmarks[c.start];
    const b = landmarks[c.end];
    if (!a || !b) continue;
    ctx.moveTo(a.x * w, a.y * h);
    ctx.lineTo(b.x * w, b.y * h);
  }
  ctx.stroke();
}

function drawPoints(landmarks, fillColor, radius) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = fillColor;
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- 骨格オーバーレイ描画 ----
function drawSkeleton(landmarks) {
  const C = FaceLandmarker;

  // メッシュ（テッセレーション）
  if (toggleMesh.checked) {
    drawConnectors(landmarks, C.FACE_LANDMARKS_TESSELATION, "rgba(120, 180, 255, 0.30)", 1);
  }

  // 輪郭・目・眉・唇・虹彩
  if (toggleContours.checked) {
    drawConnectors(landmarks, C.FACE_LANDMARKS_FACE_OVAL, "#4f8cff", 3);
    drawConnectors(landmarks, C.FACE_LANDMARKS_LEFT_EYE, "#36d399", 2);
    drawConnectors(landmarks, C.FACE_LANDMARKS_RIGHT_EYE, "#36d399", 2);
    drawConnectors(landmarks, C.FACE_LANDMARKS_LEFT_EYEBROW, "#ffd166", 2);
    drawConnectors(landmarks, C.FACE_LANDMARKS_RIGHT_EYEBROW, "#ffd166", 2);
    drawConnectors(landmarks, C.FACE_LANDMARKS_LIPS, "#ff6b9d", 2);
    drawConnectors(landmarks, C.FACE_LANDMARKS_LEFT_IRIS, "#ffffff", 2);
    drawConnectors(landmarks, C.FACE_LANDMARKS_RIGHT_IRIS, "#ffffff", 2);
  }

  // 全ランドマーク点
  if (togglePoints.checked) {
    drawPoints(landmarks, "rgba(79, 140, 255, 0.9)", 1.6);
  }
}

// ---- 表情判定 ----
function score(cats, name) {
  const c = cats.find((x) => x.categoryName === name);
  return c ? c.score : 0;
}

// 表示するバー（左目/右目はまとめる）
const BAR_DEFS = [
  { key: "smile", label: "笑顔" },
  { key: "jawOpen", label: "口開け" },
  { key: "blink", label: "目つむり" },
  { key: "browUp", label: "眉上げ" },
  { key: "pucker", label: "口すぼめ" },
];

let barEls = null;
function ensureBars() {
  if (barEls) return;
  barEls = {};
  for (const def of BAR_DEFS) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `<span class="bar-name">${def.label}</span><div class="bar-track"><div class="bar-fill"></div></div><span class="bar-val">0</span>`;
    barsEl.appendChild(row);
    barEls[def.key] = {
      fill: row.querySelector(".bar-fill"),
      val: row.querySelector(".bar-val"),
    };
  }
}

function setBar(key, v) {
  const b = barEls[key];
  if (!b) return;
  const pct = Math.round(v * 100);
  b.fill.style.width = pct + "%";
  b.val.textContent = pct;
}

function updateExpression(cats) {
  ensureBars();

  const smile = (score(cats, "mouthSmileLeft") + score(cats, "mouthSmileRight")) / 2;
  const jawOpen = score(cats, "jawOpen");
  const blink = (score(cats, "eyeBlinkLeft") + score(cats, "eyeBlinkRight")) / 2;
  const browUp = (score(cats, "browInnerUp") + score(cats, "browOuterUpLeft") + score(cats, "browOuterUpRight")) / 3;
  const browDown = (score(cats, "browDownLeft") + score(cats, "browDownRight")) / 2;
  const pucker = score(cats, "mouthPucker");
  const frown = (score(cats, "mouthFrownLeft") + score(cats, "mouthFrownRight")) / 2;
  const tongue = score(cats, "tongueOut");

  setBar("smile", smile);
  setBar("jawOpen", jawOpen);
  setBar("blink", blink);
  setBar("browUp", browUp);
  setBar("pucker", pucker);

  // ルールベースで最も強い表情を選ぶ
  const candidates = [
    { name: "ベー😛", emoji: "😛", v: tongue, th: 0.3 },
    { name: "驚き", emoji: "😲", v: Math.min(jawOpen, browUp) * 1.6, th: 0.35 },
    { name: "笑顔", emoji: "😄", v: smile, th: 0.4 },
    { name: "口あんぐり", emoji: "😮", v: jawOpen, th: 0.45 },
    { name: "口すぼめ", emoji: "😗", v: pucker, th: 0.4 },
    { name: "怒り・しかめ面", emoji: "😠", v: browDown, th: 0.4 },
    { name: "への字（不満）", emoji: "🙁", v: frown, th: 0.35 },
    { name: "目を閉じる", emoji: "😑", v: blink, th: 0.5 },
  ];

  let best = null;
  for (const c of candidates) {
    if (c.v >= c.th && (!best || c.v > best.v)) best = c;
  }

  if (best) {
    emojiEl.textContent = best.emoji;
    exprLabel.textContent = best.name;
  } else {
    emojiEl.textContent = "🙂";
    exprLabel.textContent = "無表情";
  }
}

// ---- 起動 ----
initModel();
