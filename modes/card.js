/**
 * 名刺スキャンモジュール (modes/card.js)
 * Tesseract.js v5 を使って名刺をOCRし、項目を抽出してCSVとして蓄積表示する。
 * 全アセット自己ホスト。外部CDNへの通信なし。
 */

let worker = null;
let loadPromise = null;
let rows = [];
let busy = false;

// ---- 都道府県リスト ----
const PREFECTURES =
  "北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|" +
  "埼玉県|千葉県|東京都|神奈川県|新潟県|富山県|石川県|福井県|山梨県|長野県|" +
  "岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県|和歌山県|" +
  "鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|" +
  "福岡県|佐賀県|長崎県|熊本県|大分県|宮崎県|鹿児島県|沖縄県";

// ---- CSV セルエスケープ ----
function csvCell(v) {
  const s = String(v == null ? "" : v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ---- 名刺テキスト解析 ----
function parseCard(text) {
  const result = {
    company: "",
    name: "",
    title: "",
    address: "",
    zip: "",
    phone: "",
    email: "",
  };

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  // ---- email ----
  const emailMatches = text.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g);
  if (emailMatches) {
    result.email = [...new Set(emailMatches)].join(" / ");
  }

  // ---- zip ----
  const zipMatch = text.match(/〒?\s*(\d{3}[-－ー]?\d{4})/);
  if (zipMatch) {
    result.zip = zipMatch[1]
      .replace(/[－ー]/g, "-")
      .replace(/(\d{3})(\d{4})/, "$1-$2");
  }

  // ---- phone: 日本の電話番号（TEL/FAX/電話等のラベルあり・なし）----
  const phoneRawMatches = [];
  const phonePatterns = [
    /(?:TEL|FAX|電話|Tel|Phone|Fax|ＴＥＬ|ＦＡＸ)?[:：]?\s*(0\d{1,4}[-－()\s]\d{1,4}[-－()\s]\d{3,4})/g,
    /(?:TEL|FAX|電話|Tel|Phone|Fax|ＴＥＬ|ＦＡＸ)[:：]\s*([0-9０-９()\-－\s]{7,20})/g,
  ];
  for (const pat of phonePatterns) {
    let m;
    const re = new RegExp(pat.source, pat.flags);
    while ((m = re.exec(text)) !== null) {
      const normalized = m[1].replace(/[－]/g, "-").replace(/\s+/g, "").trim();
      if (normalized) phoneRawMatches.push(normalized);
    }
  }
  if (phoneRawMatches.length > 0) {
    result.phone = [...new Set(phoneRawMatches)].join(" / ");
  }

  // ---- company ----
  const companyRe = /株式会社|有限会社|合同会社|（株）|\(株\)|Inc\.?|Corp\.?|Co\.,?\s*Ltd|LLC|K\.K\./;
  const companyLines = lines.filter((l) => companyRe.test(l));
  if (companyLines.length > 0) {
    result.company = companyLines.join(" / ");
  }

  // ---- title (部署/役職) ----
  const titleRe =
    /部|課|室|本部|事業部|グループ|代表|取締役|社長|部長|課長|係長|主任|マネージャ|エンジニア|ディレクター|CEO|CTO|COO|President|Manager|Director|Officer/;
  const titleLines = lines.filter(
    (l) => titleRe.test(l) && !companyRe.test(l)
  );
  if (titleLines.length > 0) {
    result.title = titleLines.join(" / ");
  }

  // ---- address ----
  const prefRe = new RegExp(PREFECTURES);
  // 〒直後の行インデックスを探す
  let zipLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/〒/.test(lines[i])) { zipLineIdx = i; break; }
  }

  const addressLines = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (prefRe.test(l)) {
      addressLines.push(l);
    } else if (zipLineIdx >= 0 && i === zipLineIdx + 1 && !prefRe.test(lines[zipLineIdx])) {
      // 〒行の直後（都道府県が同行でない場合）
      addressLines.push(l);
    }
  }
  if (addressLines.length > 0) {
    result.address = addressLines.join(" ");
  }

  // ---- name ----
  // 上記いずれにも該当しない行から候補を絞る
  const usedLines = new Set([
    ...companyLines,
    ...titleLines,
    ...addressLines,
  ]);

  // emailアドレスを含む行も除外
  const emailLineRe = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;
  // 電話番号・郵便番号を含む行も除外
  const phoneLineRe = /0\d{1,4}[-－()\s]\d{1,4}[-－()\s]\d{3,4}/;
  const zipLineRe = /〒?\s*\d{3}[-－ー]?\d{4}/;

  const nameCandidateLines = lines.filter((l) => {
    if (usedLines.has(l)) return false;
    if (emailLineRe.test(l)) return false;
    if (phoneLineRe.test(l)) return false;
    if (zipLineRe.test(l)) return false;
    return true;
  });

  // 2〜8文字の漢字/かな/全角スペース混じり、または英字氏名（2単語以上）
  const kanjiNameRe = /^[一-鿿぀-ゟ゠-ヿ　\s]{2,8}$/;
  const engNameRe = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+$/;
  // ふりがな候補（ひらがな/カタカナのみ）
  const furiganaRe = /^[぀-ゟ゠-ヿ\s]{2,10}$/;

  let bestName = "";
  let hasFurigana = false;

  for (const l of nameCandidateLines) {
    const normalized = l.replace(/　/g, " ").trim();
    if (furiganaRe.test(normalized)) {
      // ふりがな行は補助として記録するが氏名にはしない（すでにbestNameがあれば）
      if (!bestName) hasFurigana = true;
      continue;
    }
    if (kanjiNameRe.test(normalized) || engNameRe.test(normalized)) {
      if (!bestName) bestName = normalized;
    }
  }

  // bestNameが見つからなければ最も短い非空候補を採用
  if (!bestName && nameCandidateLines.length > 0) {
    const nonFuri = nameCandidateLines.filter((l) => !furiganaRe.test(l.replace(/　/g, " ").trim()));
    if (nonFuri.length > 0) {
      bestName = nonFuri.reduce((a, b) => (a.length <= b.length ? a : b));
    }
  }

  result.name = bestName;

  return result;
}

// ---- CSV 全文生成 ----
function buildCSV() {
  const header = ["会社名", "氏名", "部署/役職", "住所", "郵便番号", "電話番号", "メールアドレス"];
  const headerLine = header.join(",");
  const dataLines = rows.map((r) =>
    [r.company, r.name, r.title, r.address, r.zip, r.phone, r.email]
      .map(csvCell)
      .join(",")
  );
  return [headerLine, ...dataLines].join("\n");
}

// ---- 結果パネル描画 ----
function renderCSV(api) {
  if (rows.length === 0) {
    api.setResult(`<p class="result-empty">シャッターで名刺を撮影してください</p>`);
    return;
  }

  const csvText = buildCSV();
  const escaped = csvText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  api.setResult(`
    <div class="card-result">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:4px">
        <span style="font-size:12px;color:var(--accent);font-weight:bold">${rows.length}枚 読取済み</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button id="cardCopyBtn" class="ctrl-btn small">コピー</button>
          <button id="cardUndoBtn" class="ctrl-btn small" style="color:var(--warn);border-color:var(--warn)">1件取消</button>
          <button id="cardClearBtn" class="ctrl-btn small" style="color:var(--danger);border-color:var(--danger)">全消去</button>
        </div>
      </div>
      <pre class="ocr-pre" id="cardCsv" style="white-space:pre;overflow-x:auto;font-size:11px;">${escaped}</pre>
    </div>
  `);

  // ボタンイベント登録（setResult 後に DOM に存在する）
  // setTimeout で1フレーム後に登録（setResult の innerHTML 反映を待つ）
  setTimeout(() => {
    const copyBtn = document.getElementById("cardCopyBtn");
    const undoBtn = document.getElementById("cardUndoBtn");
    const clearBtn = document.getElementById("cardClearBtn");

    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(buildCSV()).catch(() => {});
      });
    }
    if (undoBtn) {
      undoBtn.addEventListener("click", () => {
        rows.pop();
        renderCSV(api);
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        rows = [];
        renderCSV(api);
      });
    }
  }, 0);
}

export default {
  id: "card",
  label: "名刺",
  icon: "📇",
  mode: "shutter",

  /**
   * Tesseract.js worker を一度だけ初期化する（冪等）。
   */
  async load(api) {
    if (worker) return;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      const T = await import("../vendor/ocr/tesseract.esm.min.js");
      const Tesseract = T.default || T;

      worker = await Tesseract.createWorker(
        ["jpn", "eng"],
        1, // OEM: LSTM_ONLY
        {
          workerPath: "./vendor/ocr/worker.min.js",
          corePath: "./vendor/ocr/",
          langPath: "./models/ocr",
          gzip: true,
          logger: () => {},
        }
      );
    })();

    return loadPromise;
  },

  /**
   * シャッター押下時: 現フレームをOCRして名刺情報を抽出・蓄積する。
   */
  async onCapture(api) {
    // 連打防止
    if (busy) return;
    busy = true;
    api.setBusy(true, "名刺を解析中…");

    try {
      // ---- videoWidth ガード ----
      const vw = api.video.videoWidth;
      const vh = api.video.videoHeight;
      if (!vw || !vh) return;

      // ---- オフスクリーン canvas に現フレームを描画 ----
      const offscreen = document.createElement("canvas");
      offscreen.width = vw;
      offscreen.height = vh;
      const octx = offscreen.getContext("2d");
      octx.drawImage(api.video, 0, 0, vw, vh);

      // ---- OCR 実行 ----
      const { data } = await worker.recognize(offscreen);
      const text = (data.text || "").trim();

      // ---- 項目抽出 ----
      const parsed = parseCard(text);
      rows.push(parsed);

      // ---- 結果パネル更新 ----
      renderCSV(api);
    } catch (err) {
      console.error("[card] recognize error:", err);
      api.setResult(
        `<p style="color:var(--danger);padding:8px">認識エラー: ${
          err && err.message ? err.message : String(err)
        }</p>`
      );
    } finally {
      api.setBusy(false);
      busy = false;
    }
  },

  onStop() {
    busy = false;
    // worker は保持し続ける（再初期化コスト削減）
  },
};
