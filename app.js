import {
  FaceLandmarker,
  FilesetResolver,
  DrawingUtils,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20";

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
let drawingUtils = null;
let running = false;
let lastVideoTime = -1;
let lastFrameAt = 0;

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function applyMirror() {
  const t = toggleMirror.checked ? "scaleX(-1)" : "scaleX(1)";
  video.style.transform = t;
  canvas.style.transform = t;
}
toggleMirror.addEventListener("change", applyMirror);

// ---- モデル読み込み ----
async function initModel() {
  try {
    setStatus("モデル読み込み中…");
    const filesetResolver = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm"
    );
    faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      outputFaceBlendshapes: true,
      runningMode: "VIDEO",
      numFaces: 1,
    });
    drawingUtils = new DrawingUtils(ctx);
    setStatus("準備完了", "ready");
    startBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("モデル読み込み失敗", "error");
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

// ---- 骨格オーバーレイ描画 ----
function drawSkeleton(landmarks) {
  const C = FaceLandmarker;

  // メッシュ（テッセレーション）
  if (toggleMesh.checked) {
    drawingUtils.drawConnectors(landmarks, C.FACE_LANDMARKS_TESSELATION, {
      color: "rgba(120, 180, 255, 0.30)",
      lineWidth: 1,
    });
  }

  // 輪郭・目・眉・唇・虹彩
  if (toggleContours.checked) {
    drawingUtils.drawConnectors(landmarks, C.FACE_LANDMARKS_FACE_OVAL, {
      color: "#4f8cff",
      lineWidth: 3,
    });
    drawingUtils.drawConnectors(landmarks, C.FACE_LANDMARKS_LEFT_EYE, {
      color: "#36d399",
      lineWidth: 2,
    });
    drawingUtils.drawConnectors(landmarks, C.FACE_LANDMARKS_RIGHT_EYE, {
      color: "#36d399",
      lineWidth: 2,
    });
    drawingUtils.drawConnectors(landmarks, C.FACE_LANDMARKS_LEFT_EYEBROW, {
      color: "#ffd166",
      lineWidth: 2,
    });
    drawingUtils.drawConnectors(landmarks, C.FACE_LANDMARKS_RIGHT_EYEBROW, {
      color: "#ffd166",
      lineWidth: 2,
    });
    drawingUtils.drawConnectors(landmarks, C.FACE_LANDMARKS_LIPS, {
      color: "#ff6b9d",
      lineWidth: 2,
    });
    drawingUtils.drawConnectors(landmarks, C.FACE_LANDMARKS_LEFT_IRIS, {
      color: "#ffffff",
      lineWidth: 2,
    });
    drawingUtils.drawConnectors(landmarks, C.FACE_LANDMARKS_RIGHT_IRIS, {
      color: "#ffffff",
      lineWidth: 2,
    });
  }

  // 全ランドマーク点
  if (togglePoints.checked) {
    drawingUtils.drawLandmarks(landmarks, {
      color: "rgba(255, 255, 255, 0.9)",
      fillColor: "rgba(79, 140, 255, 0.9)",
      radius: 1.4,
      lineWidth: 0.5,
    });
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
