// 人物モード：顔認証・表情・骨格・手ジェスチャー
import * as faceapi from "../vendor/face-api.esm.js";

const MODELS = "./models";
const MATCH_THRESHOLD = 0.55;
const DB_KEY = "faces_db_v1";

let loaded = false;
let detectOptions = null;
let db = [];
let pendingFace = null;
let apiRef = null;

// DOM（index.html内）
let toggleSkeleton, toggleExpression, toggleHand;
let registerBtn, registerModal, regName, regGender, regSave, regCancel, regPreview;
let manageBtn, manageModal, manageList, manageClose, dbCountEl;

function $(id) { return document.getElementById(id); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ---- DB ----
function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (!raw) return [];
    return JSON.parse(raw).map((p) => ({ ...p, descriptor: Float32Array.from(p.descriptor) }));
  } catch { return []; }
}
function saveDB() {
  localStorage.setItem(DB_KEY, JSON.stringify(db.map((p) => ({ ...p, descriptor: Array.from(p.descriptor) }))));
}
function refreshDbCount() { if (dbCountEl) dbCountEl.textContent = `登録: ${db.length}人`; }

function matchFace(descriptor) {
  let best = null, bestDist = Infinity;
  for (const p of db) {
    const d = faceapi.euclideanDistance(descriptor, p.descriptor);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  if (best && bestDist < MATCH_THRESHOLD) return { matched: true, person: best, dist: bestDist };
  return { matched: false, dist: bestDist };
}
function genderJP(g) { return g === "male" ? "男性" : g === "female" ? "女性" : "不明"; }

const EXPRESSION_MAP = {
  neutral: "無表情😐", happy: "笑顔😄", sad: "悲しい😢", angry: "怒り😠",
  fearful: "驚き・不安😨", disgusted: "嫌悪😖", surprised: "驚き😲",
};
function getTopExpression(expressions) {
  if (!expressions) return null;
  let topKey = null, topScore = -1;
  for (const [k, s] of Object.entries(expressions)) if (s > topScore) { topScore = s; topKey = k; }
  if (!topKey) return null;
  return `${EXPRESSION_MAP[topKey] || topKey} ${Math.round(topScore * 100)}%`;
}

// ---- 手 ----
let handLandmarker = null, handLoading = false;
async function ensureHands() {
  if (handLandmarker || handLoading) return;
  handLoading = true;
  try {
    const mp = await import("../vendor/mediapipe/vision_bundle.mjs");
    const fileset = await mp.FilesetResolver.forVisionTasks("./vendor/mediapipe/wasm");
    const opt = (delegate) => ({
      baseOptions: { modelAssetPath: "./models/hand_landmarker.task", delegate },
      runningMode: "VIDEO", numHands: 2,
    });
    try { handLandmarker = await mp.HandLandmarker.createFromOptions(fileset, opt("GPU")); }
    catch { handLandmarker = await mp.HandLandmarker.createFromOptions(fileset, opt("CPU")); }
  } catch (e) { console.error("hand init failed", e); }
  finally { handLoading = false; }
}
const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function drawHand(api, lm) {
  const { ctx, canvas, fx } = api;
  const W = canvas.width, H = canvas.height;
  ctx.strokeStyle = "rgba(54,211,153,0.7)"; ctx.lineWidth = 2; ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    ctx.moveTo(fx(lm[a].x * W), lm[a].y * H);
    ctx.lineTo(fx(lm[b].x * W), lm[b].y * H);
  }
  ctx.stroke();
  ctx.fillStyle = "rgba(54,211,153,0.9)";
  for (const p of lm) { ctx.beginPath(); ctx.arc(fx(p.x * W), p.y * H, 3, 0, Math.PI * 2); ctx.fill(); }
}
function classifyGesture(lm) {
  const pairs = [[8,6],[12,10],[16,14],[20,18]];
  const [indexExt, middleExt, ringExt, pinkyExt] = pairs.map(([t, p]) => lm[t].y < lm[p].y - 0.02);
  const thumbExt = Math.hypot(lm[4].x-lm[2].x, lm[4].y-lm[2].y) > Math.hypot(lm[3].x-lm[2].x, lm[3].y-lm[2].y) * 1.4;
  const allFolded = !indexExt && !middleExt && !ringExt && !pinkyExt;
  const allExt = indexExt && middleExt && ringExt && pinkyExt;
  if (!indexExt && middleExt && !ringExt && !pinkyExt) return { label: "中指", emoji: "🖕" };
  if (indexExt && middleExt && !ringExt && !pinkyExt) return { label: "ピース", emoji: "✌️" };
  if (allExt) return { label: "パー", emoji: "✋" };
  if (allFolded && thumbExt && lm[4].y < lm[0].y) return { label: "いいね", emoji: "👍" };
  if (allFolded) return { label: "グー", emoji: "✊" };
  if (indexExt && !middleExt && !ringExt && !pinkyExt) return { label: "指差し", emoji: "☝️" };
  if (indexExt && !middleExt && !ringExt && pinkyExt) return { label: "ロック", emoji: "🤟" };
  return { label: "…", emoji: "🖐" };
}
function drawHandGesture(api, lm, g) {
  const { ctx, canvas, fx } = api;
  const x = fx(lm[9].x * canvas.width), y = lm[9].y * canvas.height;
  const text = g.emoji + " " + g.label;
  ctx.font = "15px -apple-system, sans-serif";
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = "rgba(30,30,60,0.75)"; ctx.fillRect(x, y - 30, w, 22);
  ctx.fillStyle = "#fff"; ctx.fillText(text, x + 5, y - 14);
}

// ---- 顔の描画 ----
function drawBox(api, box, color) {
  const { ctx, canvas, isMirror } = api;
  const x = isMirror() ? canvas.width - box.x - box.width : box.x;
  ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.strokeRect(x, box.y, box.width, box.height);
}
function drawLabel(api, box, text, color) {
  const { ctx, canvas, isMirror } = api;
  ctx.font = "bold 22px -apple-system, sans-serif";
  const w = ctx.measureText(text).width + 12;
  const x = isMirror() ? canvas.width - box.x - box.width : box.x;
  const y = Math.max(0, box.y - 28);
  ctx.fillStyle = color; ctx.fillRect(x, y, w, 28);
  ctx.fillStyle = "#0b0f1a"; ctx.fillText(text, x + 6, y + 21);
}
function drawExpressionLabel(api, box, text) {
  const { ctx, canvas, isMirror } = api;
  ctx.font = "15px -apple-system, sans-serif";
  const w = ctx.measureText(text).width + 10;
  const x = isMirror() ? canvas.width - box.x - box.width : box.x;
  const y = box.y + box.height + 2;
  ctx.fillStyle = "rgba(30,30,60,0.75)"; ctx.fillRect(x, y, w, 22);
  ctx.fillStyle = "#fff"; ctx.fillText(text, x + 5, y + 16);
}
function drawSkeleton(api, landmarks) {
  const { ctx, fx } = api;
  ctx.fillStyle = "rgba(79,140,255,0.9)";
  for (const p of landmarks.positions) { ctx.beginPath(); ctx.arc(fx(p.x), p.y, 1.6, 0, Math.PI * 2); ctx.fill(); }
  const groups = [landmarks.getJawOutline(), landmarks.getLeftEyeBrow(), landmarks.getRightEyeBrow(),
    landmarks.getNose(), landmarks.getLeftEye(), landmarks.getRightEye(), landmarks.getMouth()];
  ctx.strokeStyle = "rgba(120,180,255,0.6)"; ctx.lineWidth = 1.5;
  for (const g of groups) {
    ctx.beginPath();
    g.forEach((p, i) => (i === 0 ? ctx.moveTo(fx(p.x), p.y) : ctx.lineTo(fx(p.x), p.y)));
    ctx.stroke();
  }
}

function renderCards(cards) {
  if (cards.length === 0) { apiRef.setResult(`<div class="result-empty">顔を映してください…</div>`); return; }
  apiRef.setResult(cards.map((c) => `
    <div class="person ${c.known ? "known" : "unknown"}">
      <div>
        <div class="pname">${escapeHtml(c.name)}</div>
        <div class="pmeta">性別: ${escapeHtml(c.gender)} ／ ${escapeHtml(c.sub)}${c.expr ? " ／ 表情: " + c.expr : ""}</div>
      </div>
      <span class="pbadge">${c.known ? "本人 " + c.conf + "%" : "未登録"}</span>
    </div>`).join(""));
}

// ---- UI 配線（一度だけ）----
function wireUI(api) {
  toggleSkeleton = $("toggleSkeleton"); toggleExpression = $("toggleExpression"); toggleHand = $("toggleHand");
  registerBtn = $("registerBtn"); registerModal = $("registerModal");
  regName = $("regName"); regGender = $("regGender"); regSave = $("regSave"); regCancel = $("regCancel"); regPreview = $("regPreview");
  manageBtn = $("manageBtn"); manageModal = $("manageModal"); manageList = $("manageList"); manageClose = $("manageClose");
  dbCountEl = $("dbCount");

  toggleHand?.addEventListener("change", () => { if (toggleHand.checked) ensureHands(); });

  registerBtn?.addEventListener("click", () => {
    if (!pendingFace) return;
    try {
      const b = pendingFace.box;
      const pctx = regPreview.getContext("2d");
      pctx.clearRect(0, 0, 120, 120);
      pctx.drawImage(api.video, b.x, b.y, b.width, b.height, 0, 0, 120, 120);
    } catch {}
    regName.value = "";
    regGender.value = pendingFace.gender === "男性" ? "男性" : pendingFace.gender === "女性" ? "女性" : "その他";
    registerModal.hidden = false;
  });
  regCancel?.addEventListener("click", () => { registerModal.hidden = true; });
  regSave?.addEventListener("click", () => {
    if (!pendingFace) { registerModal.hidden = true; return; }
    db.push({ id: "p_" + Date.now(), name: regName.value.trim() || "名称未設定", gender: regGender.value, descriptor: pendingFace.descriptor });
    saveDB(); refreshDbCount(); registerModal.hidden = true;
  });
  manageBtn?.addEventListener("click", () => { renderManage(); manageModal.hidden = false; });
  manageClose?.addEventListener("click", () => { manageModal.hidden = true; });
}
function renderManage() {
  if (db.length === 0) { manageList.innerHTML = `<div class="manage-empty">まだ登録がありません</div>`; return; }
  manageList.innerHTML = db.map((p) => `
    <div class="manage-row">
      <div><div class="mname">${escapeHtml(p.name)}</div><div class="mmeta">性別: ${escapeHtml(p.gender)}</div></div>
      <button class="del" data-id="${p.id}">削除</button>
    </div>`).join("");
  manageList.querySelectorAll(".del").forEach((btn) => btn.addEventListener("click", () => {
    db = db.filter((x) => x.id !== btn.dataset.id); saveDB(); refreshDbCount(); renderManage();
  }));
}

// ---- モード契約 ----
export default {
  id: "face",
  label: "人物",
  icon: "🙂",
  mode: "continuous",
  selfClear: true, // 検出後に自前でクリア（点滅防止）

  async load(api) {
    if (loaded) return;
    apiRef = api;
    api.setBusy(true, "顔モデル読み込み中…");
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODELS);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODELS);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODELS);
    await faceapi.nets.ageGenderNet.loadFromUri(MODELS);
    await faceapi.nets.faceExpressionNet.loadFromUri(MODELS);
    detectOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });
    db = loadDB();
    wireUI(api);
    refreshDbCount();
    api.setBusy(false);
    loaded = true;
  },

  async onFrame(api) {
    apiRef = api;
    let detections = [];
    try {
      detections = await faceapi
        .detectAllFaces(api.video, detectOptions)
        .withFaceLandmarks().withFaceExpressions().withAgeAndGender().withFaceDescriptors();
    } catch (e) { console.warn("face detect", e); }

    // 検出が終わってから一括クリア→描画（点滅させない）
    api.clear();

    const cards = [];
    let primaryUnknown = null, primaryArea = 0;

    for (const det of detections) {
      const box = det.detection.box;
      const m = matchFace(det.descriptor);
      const detectedGender = genderJP(det.gender);
      const age = Math.round(det.age);
      const expr = toggleExpression?.checked ? getTopExpression(det.expressions) : null;
      const known = m.matched;
      drawBox(api, box, known ? "#36d399" : "#ffb454");
      drawLabel(api, box, known ? m.person.name : "未登録", known ? "#36d399" : "#ffb454");
      if (expr) drawExpressionLabel(api, box, expr);
      if (toggleSkeleton?.checked) drawSkeleton(api, det.landmarks);
      if (known) {
        cards.push({ known: true, name: m.person.name, gender: m.person.gender, sub: `${detectedGender}・推定${age}歳`, conf: Math.round((1 - m.dist / MATCH_THRESHOLD) * 100), expr });
      } else {
        cards.push({ known: false, name: "未登録の人物", gender: detectedGender, sub: `推定${age}歳`, conf: 0, expr });
        const area = box.width * box.height;
        if (area > primaryArea) { primaryArea = area; primaryUnknown = { descriptor: det.descriptor, gender: detectedGender, box }; }
      }
    }

    // 手
    if (toggleHand?.checked && handLandmarker) {
      try {
        const res = handLandmarker.detectForVideo(api.video, performance.now());
        if (res && res.landmarks) for (const lm of res.landmarks) { drawHand(api, lm); drawHandGesture(api, lm, classifyGesture(lm)); }
      } catch (e) { console.warn("hand detect", e); }
    }

    renderCards(cards);
    pendingFace = primaryUnknown;
    if (registerBtn) registerBtn.disabled = !primaryUnknown;
  },

  onStop() {
    if (registerModal) registerModal.hidden = true;
    if (manageModal) manageModal.hidden = true;
  },
};
