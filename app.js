// ビジョン認識アプリ シェル（モード管理）
window.__APP_MODULE_LOADED = true;

const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const modeTitle = document.getElementById("modeTitle");
const startBtn = document.getElementById("startBtn");
const startScreen = document.getElementById("startScreen");
const switchCamBtn = document.getElementById("switchCamBtn");
const shutterBtn = document.getElementById("shutterBtn");
const busyEl = document.getElementById("busy");
const busyMsg = document.getElementById("busyMsg");
const resultEl = document.getElementById("result");
const tabbar = document.getElementById("tabbar");

let running = false;
let facingMode = "user";
let currentStream = null;
let active = null;        // 現在のモードオブジェクト
let activeId = null;
let frameBusy = false;

// モード定義（遅延import）
const MODE_DEFS = [
  { id: "face", icon: "🙂", label: "人物", loader: () => import("./modes/face.js") },
  { id: "qr", icon: "🔳", label: "QR", loader: () => import("./modes/qr.js") },
  { id: "ocr", icon: "🔤", label: "文字", loader: () => import("./modes/ocr.js") },
  { id: "detect", icon: "📦", label: "物体", loader: () => import("./modes/detect.js") },
];
const moduleCache = {};

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
  if (kind === "ready") window.__APP_READY = true;
  if (kind === "error") window.__APP_ERROR = text;
}
function showHint(text) { const h = startScreen.querySelector(".hint"); if (h) h.textContent = text; }

// 内カメラは見た目だけ反転。canvasは反転せず座標で補正。
function applyMirror() {
  video.style.transform = facingMode === "user" ? "scaleX(-1)" : "scaleX(1)";
  canvas.style.transform = "scaleX(1)";
}
function isMirror() { return facingMode === "user"; }
function fx(x) { return isMirror() ? canvas.width - x : x; }

// モードへ渡すAPI
const api = {
  video, canvas, ctx, fx, isMirror,
  setResult(html) { resultEl.innerHTML = html; },
  setBusy(on, msg) { busyEl.hidden = !on; if (msg) busyMsg.textContent = msg; },
};

// ---- カメラ ----
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
    setStatus(active ? active.label : "準備完了", "ready");
    if (!running) { running = true; loop(); }
  } catch (e) {
    console.error(e);
    setStatus("カメラ起動失敗", "error");
    startBtn.disabled = false;
    showHint("カメラにアクセスできません。Safariの設定でカメラを許可してください。");
  }
}
startBtn.addEventListener("click", async () => { await startCamera(); if (!activeId) selectMode("face"); });

switchCamBtn.addEventListener("click", async () => {
  facingMode = facingMode === "user" ? "environment" : "user";
  if (running) await startCamera();
  else applyMirror();
});

shutterBtn.addEventListener("click", async () => {
  if (active && active.onCapture) {
    try { await active.onCapture(api); } catch (e) { console.error(e); api.setResult(`<div class="result-empty">解析エラー: ${e.message || e}</div>`); api.setBusy(false); }
  }
});

// ---- モード切替 ----
async function selectMode(id) {
  if (id === activeId) return;
  // 退出
  if (active) { try { active.onDeactivate && active.onDeactivate(api); active.onStop && active.onStop(); } catch {} }
  document.querySelectorAll(".controls").forEach((c) => c.classList.remove("active"));
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const def = MODE_DEFS.find((m) => m.id === id);
  if (!def) return;
  setTab(id);
  modeTitle.textContent = def.label;
  api.setResult(`<div class="result-empty">読み込み中…</div>`);

  try {
    if (!moduleCache[id]) {
      api.setBusy(true, `${def.label}モジュール読み込み中…`);
      const mod = await def.loader();
      moduleCache[id] = mod.default;
    }
    const mode = moduleCache[id];
    if (mode.load) await mode.load(api);
    api.setBusy(false);

    active = mode;
    activeId = id;
    // モード別コントロール表示
    const ctrl = document.getElementById("controls-" + id);
    if (ctrl) ctrl.classList.add("active");
    // シャッターボタン
    shutterBtn.hidden = mode.mode !== "shutter";
    // 初期結果
    api.setResult(`<div class="result-empty">${def.label}モード</div>`);
    if (mode.onActivate) mode.onActivate(api);
    setStatus(def.label, "ready");
  } catch (e) {
    console.error(e);
    api.setBusy(false);
    api.setResult(`<div class="result-empty">${def.label}の読み込みに失敗: ${e.message || e}</div>`);
  }
}

function setTab(id) {
  tabbar.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.id === id));
}
function buildTabs() {
  tabbar.innerHTML = MODE_DEFS.map((m) =>
    `<button class="tab" data-id="${m.id}"><span class="tab-ic">${m.icon}</span><span class="tab-lb">${m.label}</span></button>`
  ).join("");
  tabbar.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      if (!running) { showHint("先に「カメラを起動」を押してください。"); return; }
      selectMode(t.dataset.id);
    })
  );
}

// ---- 描画ループ ----
async function loop() {
  if (!running) return;
  if (canvas.width !== video.videoWidth && video.videoWidth) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  if (active && active.mode === "continuous" && active.onFrame && !frameBusy) {
    frameBusy = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try { await active.onFrame(api); } catch (e) { console.warn("frame", e); }
    frameBusy = false;
  }
  requestAnimationFrame(loop);
}

// ---- 起動 ----
buildTabs();
setTab("face");
setStatus("準備完了", "ready");
startBtn.disabled = false;
showHint("「カメラを起動」を押してください。カメラの許可が出たら「許可」を選択。");
