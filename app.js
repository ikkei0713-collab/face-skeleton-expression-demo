import * as faceapi from "./vendor/face-api.esm.js";

window.__APP_MODULE_LOADED = true;

// ---- DOM ----
const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const startScreen = document.getElementById("startScreen");
const resultEl = document.getElementById("result");
const fpsEl = document.getElementById("fps");
const switchCamBtn = document.getElementById("switchCamBtn");
const registerBtn = document.getElementById("registerBtn");
const toggleSkeleton = document.getElementById("toggleSkeleton");
const toggleExpression = document.getElementById("toggleExpression");
const toggleHand = document.getElementById("toggleHand");
const dbCountEl = document.getElementById("dbCount");
const manageBtn = document.getElementById("manageBtn");

const registerModal = document.getElementById("registerModal");
const regName = document.getElementById("regName");
const regGender = document.getElementById("regGender");
const regSave = document.getElementById("regSave");
const regCancel = document.getElementById("regCancel");
const regPreview = document.getElementById("regPreview");
const manageModal = document.getElementById("manageModal");
const manageList = document.getElementById("manageList");
const manageClose = document.getElementById("manageClose");

const MODELS = "./models";
const MATCH_THRESHOLD = 0.55; // これ未満の距離なら同一人物とみなす
const DB_KEY = "faces_db_v1";

let running = false;
let facingMode = "user"; // user=内カメラ / environment=外カメラ
let currentStream = null;
let lastFrameAt = 0;
let detectOptions = null;

// 直近の「未登録の主役顔」を登録用に保持
let pendingFace = null; // { descriptor:Float32Array, gender:string }

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
  if (kind === "ready") window.__APP_READY = true;
  if (kind === "error") window.__APP_ERROR = text;
}
function showHint(text) {
  const h = startScreen.querySelector(".hint");
  if (h) h.textContent = text;
}

// ---- 登録DB（localStorage）----
function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return [];
    return JSON.parse(raw).map((p) => ({ ...p, descriptor: Float32Array.from(p.descriptor) }));
  } catch {
    return [];
  }
}
function saveDB(db) {
  const ser = db.map((p) => ({ ...p, descriptor: Array.from(p.descriptor) }));
  localStorage.setItem(DB_KEY, JSON.stringify(ser));
}
let db = [];
function refreshDbCount() {
  dbCountEl.textContent = `登録: ${db.length}人`;
}

// ---- モデル読み込み ----
async function initModel() {
  try {
    setStatus("モデル読み込み中…");
    showHint("初回はモデルの読み込みに数秒かかります…");
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODELS);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODELS);
    await faceapi.nets.ageGenderNet.loadFromUri(MODELS);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODELS);
    detectOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });
    db = loadDB();
    refreshDbCount();
    setStatus("準備完了", "ready");
    showHint("「カメラを起動」を押してください。カメラの許可が出たら「許可」を選択。");
    startBtn.disabled = false;
  } catch (e) {
    console.error(e);
    setStatus("読み込み失敗", "error");
    showHint("読み込み失敗: " + (e && e.message ? e.message : e) + "\n再読み込みしてください。");
  }
}

// ---- カメラ ----
// 内カメラは自撮りが自然に見えるよう video のみCSS反転。
// canvasは反転せず、描画座標だけ反転する（テキストは反転させない＝読める）。
function applyMirror() {
  video.style.transform = facingMode === "user" ? "scaleX(-1)" : "scaleX(1)";
  canvas.style.transform = "scaleX(1)";
}
function isMirror() {
  return facingMode === "user";
}
function fx(x) {
  return isMirror() ? canvas.width - x : x;
}

async function startCamera() {
  try {
    startBtn.disabled = true;
    setStatus("カメラ起動中…");
    if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
    currentStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false,
    });
    video.srcObject = currentStream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    startScreen.style.display = "none";
    applyMirror();
    setStatus("認証中", "ready");
    if (!running) {
      running = true;
      detectLoop();
    }
  } catch (e) {
    console.error(e);
    setStatus("カメラ起動失敗", "error");
    startBtn.disabled = false;
    showHint("カメラにアクセスできません。Safariの設定でカメラを許可してください。");
  }
}
startBtn.addEventListener("click", startCamera);

switchCamBtn.addEventListener("click", async () => {
  facingMode = facingMode === "user" ? "environment" : "user";
  if (running) await startCamera();
});

// ---- 照合 ----
function matchFace(descriptor) {
  let best = null;
  let bestDist = Infinity;
  for (const p of db) {
    const d = faceapi.euclideanDistance(descriptor, p.descriptor);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  if (best && bestDist < MATCH_THRESHOLD) {
    return { matched: true, person: best, dist: bestDist };
  }
  return { matched: false, dist: bestDist };
}

function genderJP(g) {
  return g === "male" ? "男性" : g === "female" ? "女性" : "不明";
}

const EXPRESSION_MAP = {
  neutral: "無表情😐",
  happy: "笑顔😄",
  sad: "悲しい😢",
  angry: "怒り😠",
  fearful: "驚き・不安😨",
  disgusted: "嫌悪😖",
  surprised: "驚き😲",
};

function getTopExpression(expressions) {
  if (!expressions) return null;
  let topKey = null;
  let topScore = -1;
  for (const [key, score] of Object.entries(expressions)) {
    if (score > topScore) { topScore = score; topKey = key; }
  }
  if (!topKey) return null;
  const label = EXPRESSION_MAP[topKey] || topKey;
  return `${label} ${Math.round(topScore * 100)}%`;
}

// ---- 検出ループ ----
async function detectLoop() {
  if (!running) return;

  if (canvas.width !== video.videoWidth && video.videoWidth) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  let detections = [];
  try {
    detections = await faceapi
      .detectAllFaces(video, detectOptions)
      .withFaceLandmarks()
      .withFaceExpressions()
      .withAgeAndGender()
      .withFaceDescriptors();
  } catch (e) {
    console.warn("detect error", e);
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const cards = [];
  let primaryUnknown = null;
  let primaryArea = 0;

  for (const det of detections) {
    const box = det.detection.box;
    const m = matchFace(det.descriptor);
    const detectedGender = genderJP(det.gender);
    const age = Math.round(det.age);

    // 表情解析
    const expr = toggleExpression.checked ? getTopExpression(det.expressions) : null;

    // オーバーレイ枠＋ラベル
    const known = m.matched;
    drawBox(box, known ? "#36d399" : "#ffb454");
    const label = known ? m.person.name : "未登録";
    drawLabel(box, label, known ? "#36d399" : "#ffb454");

    // 表情ラベル（オーバーレイ）
    if (expr) drawExpressionLabel(box, expr);

    // 骨格サブ機能
    if (toggleSkeleton.checked) drawSkeleton(det.landmarks);

    // 結果カード情報
    if (known) {
      cards.push({
        known: true, name: m.person.name, gender: m.person.gender,
        sub: `${detectedGender}・推定${age}歳`, conf: Math.round((1 - m.dist / MATCH_THRESHOLD) * 100),
        expr,
      });
    } else {
      cards.push({
        known: false, name: "未登録の人物", gender: detectedGender,
        sub: `推定${age}歳`, conf: 0,
        expr,
      });
      const area = box.width * box.height;
      if (area > primaryArea) {
        primaryArea = area;
        primaryUnknown = { descriptor: det.descriptor, gender: detectedGender, box };
      }
    }
  }

  renderCards(cards);

  // 未登録の主役がいれば登録ボタンを有効化
  pendingFace = primaryUnknown;
  registerBtn.disabled = !primaryUnknown;

  // 手検出
  if (toggleHand.checked && handLandmarker) {
    try {
      const res = handLandmarker.detectForVideo(video, performance.now());
      if (res && res.landmarks) {
        for (let i = 0; i < res.landmarks.length; i++) {
          const lm = res.landmarks[i];
          drawHand(lm);
          const g = classifyGesture(lm);
          drawHandGesture(lm, g);
        }
      }
    } catch (e) {
      console.warn("hand detect error", e);
    }
  }

  // FPS
  const now = performance.now();
  if (lastFrameAt) fpsEl.textContent = `${(1000 / (now - lastFrameAt)).toFixed(0)} FPS`;
  lastFrameAt = now;

  requestAnimationFrame(detectLoop);
}

// ---- 描画（内カメラ時は座標をfx()で左右反転。テキストは反転しない）----
function drawBox(box, color) {
  const x = isMirror() ? canvas.width - box.x - box.width : box.x;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, box.y, box.width, box.height);
}
function drawLabel(box, text, color) {
  ctx.font = "bold 22px -apple-system, sans-serif";
  const padding = 6;
  const w = ctx.measureText(text).width + padding * 2;
  const h = 28;
  const x = isMirror() ? canvas.width - box.x - box.width : box.x;
  const y = Math.max(0, box.y - h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#0b0f1a";
  ctx.fillText(text, x + padding, y + 21);
}
function drawExpressionLabel(box, text) {
  ctx.font = "15px -apple-system, sans-serif";
  const padding = 5;
  const w = ctx.measureText(text).width + padding * 2;
  const h = 22;
  const x = isMirror() ? canvas.width - box.x - box.width : box.x;
  const y = box.y + box.height + 2;
  ctx.fillStyle = "rgba(30,30,60,0.75)";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x + padding, y + 16);
}
function drawSkeleton(landmarks) {
  const pts = landmarks.positions;
  // 点
  ctx.fillStyle = "rgba(79,140,255,0.9)";
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(fx(p.x), p.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // 主要パーツの輪郭線
  const groups = [
    landmarks.getJawOutline(),
    landmarks.getLeftEyeBrow(),
    landmarks.getRightEyeBrow(),
    landmarks.getNose(),
    landmarks.getLeftEye(),
    landmarks.getRightEye(),
    landmarks.getMouth(),
  ];
  ctx.strokeStyle = "rgba(120,180,255,0.6)";
  ctx.lineWidth = 1.5;
  for (const g of groups) {
    ctx.beginPath();
    g.forEach((p, i) => (i === 0 ? ctx.moveTo(fx(p.x), p.y) : ctx.lineTo(fx(p.x), p.y)));
    ctx.stroke();
  }
}

function renderCards(cards) {
  if (cards.length === 0) {
    resultEl.innerHTML = `<div class="result-empty">顔を映してください…</div>`;
    return;
  }
  resultEl.innerHTML = cards
    .map((c) => `
      <div class="person ${c.known ? "known" : "unknown"}">
        <div>
          <div class="pname">${escapeHtml(c.name)}</div>
          <div class="pmeta">性別: ${escapeHtml(c.gender)} ／ ${escapeHtml(c.sub)}${c.expr ? " ／ 表情: " + c.expr : ""}</div>
        </div>
        <span class="pbadge">${c.known ? "本人 " + c.conf + "%" : "未登録"}</span>
      </div>`)
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ---- 登録 ----
registerBtn.addEventListener("click", () => {
  if (!pendingFace) return;
  // プレビュー（現フレームの顔を切り出し）
  try {
    const b = pendingFace.box;
    const pctx = regPreview.getContext("2d");
    pctx.clearRect(0, 0, 120, 120);
    pctx.drawImage(video, b.x, b.y, b.width, b.height, 0, 0, 120, 120);
  } catch {}
  regName.value = "";
  regGender.value = pendingFace.gender === "男性" ? "男性" : pendingFace.gender === "女性" ? "女性" : "その他";
  registerModal.hidden = false;
});
regCancel.addEventListener("click", () => { registerModal.hidden = true; });
regSave.addEventListener("click", () => {
  if (!pendingFace) { registerModal.hidden = true; return; }
  const name = regName.value.trim() || "名称未設定";
  db.push({
    id: "p_" + Date.now(),
    name,
    gender: regGender.value,
    descriptor: pendingFace.descriptor,
  });
  saveDB(db);
  refreshDbCount();
  registerModal.hidden = true;
});

// ---- 登録一覧 ----
manageBtn.addEventListener("click", () => {
  renderManage();
  manageModal.hidden = false;
});
manageClose.addEventListener("click", () => { manageModal.hidden = true; });
function renderManage() {
  if (db.length === 0) {
    manageList.innerHTML = `<div class="manage-empty">まだ登録がありません</div>`;
    return;
  }
  manageList.innerHTML = db
    .map((p) => `
      <div class="manage-row">
        <div>
          <div class="mname">${escapeHtml(p.name)}</div>
          <div class="mmeta">性別: ${escapeHtml(p.gender)}</div>
        </div>
        <button class="del" data-id="${p.id}">削除</button>
      </div>`)
    .join("");
  manageList.querySelectorAll(".del").forEach((btn) => {
    btn.addEventListener("click", () => {
      db = db.filter((x) => x.id !== btn.dataset.id);
      saveDB(db);
      refreshDbCount();
      renderManage();
    });
  });
}

// ---- 手の認識（MediaPipe Hand Landmarker）----
let handLandmarker = null;
let handLoading = false;

async function ensureHands() {
  if (handLandmarker || handLoading) return;
  handLoading = true;
  try {
    const mp = await import("./vendor/mediapipe/vision_bundle.mjs");
    const fileset = await mp.FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");
    try {
      handLandmarker = await mp.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "./models/hand_landmarker.task", delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
      });
    } catch (e) {
      console.warn("Hand GPU init failed, fallback to CPU", e);
      handLandmarker = await mp.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "./models/hand_landmarker.task", delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 2,
      });
    }
  } catch (e) {
    console.error("Hand landmarker init failed", e);
  } finally {
    handLoading = false;
  }
}

toggleHand.addEventListener("change", () => {
  if (toggleHand.checked) ensureHands();
});

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17],
];

function drawHand(lm) {
  const W = canvas.width;
  const H = canvas.height;
  // 接続線
  ctx.strokeStyle = "rgba(54,211,153,0.7)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(fx(lm[a].x * W), lm[a].y * H);
    ctx.lineTo(fx(lm[b].x * W), lm[b].y * H);
  }
  ctx.stroke();
  // 21点
  ctx.fillStyle = "rgba(54,211,153,0.9)";
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(fx(p.x * W), p.y * H, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function classifyGesture(lm) {
  // 指のtip/pip インデックス: [tip, pip]
  const fingerPairs = [
    [8, 6],   // 人差し指
    [12, 10], // 中指
    [16, 14], // 薬指
    [20, 18], // 小指
  ];
  const extended = fingerPairs.map(([tip, pip]) => lm[tip].y < lm[pip].y - 0.02);
  const [indexExt, middleExt, ringExt, pinkyExt] = extended;

  const thumbExtended =
    Math.hypot(lm[4].x - lm[2].x, lm[4].y - lm[2].y) >
    Math.hypot(lm[3].x - lm[2].x, lm[3].y - lm[2].y) * 1.4;

  const allFolded = !indexExt && !middleExt && !ringExt && !pinkyExt;
  const allExtended = indexExt && middleExt && ringExt && pinkyExt;

  // 判定（優先度順）
  if (!indexExt && middleExt && !ringExt && !pinkyExt) {
    return { label: "中指", emoji: "🖕" };
  }
  if (indexExt && middleExt && !ringExt && !pinkyExt) {
    return { label: "ピース", emoji: "✌️" };
  }
  if (allExtended) {
    return { label: "パー", emoji: "✋" };
  }
  if (allFolded && thumbExtended && lm[4].y < lm[0].y) {
    return { label: "いいね", emoji: "👍" };
  }
  if (allFolded) {
    return { label: "グー", emoji: "✊" };
  }
  if (indexExt && !middleExt && !ringExt && !pinkyExt) {
    return { label: "指差し", emoji: "☝️" };
  }
  if (indexExt && !middleExt && !ringExt && pinkyExt) {
    return { label: "ロック", emoji: "🤟" };
  }
  return { label: "…", emoji: "🖐" };
}

function drawHandGesture(lm, g) {
  const W = canvas.width;
  const H = canvas.height;
  const x = fx(lm[9].x * W);
  const y = lm[9].y * H;
  const text = g.emoji + " " + g.label;
  ctx.font = "15px -apple-system, sans-serif";
  const padding = 5;
  const w = ctx.measureText(text).width + padding * 2;
  const h = 22;
  const tx = x;
  const ty = y - 30;
  ctx.fillStyle = "rgba(30,30,60,0.75)";
  ctx.fillRect(tx, ty, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, tx + padding, ty + 16);
}

// ---- 起動 ----
initModel();
