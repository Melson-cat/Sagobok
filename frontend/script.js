/* ===================================================================
   BokPiloten – Frontend v4.1 (CF Images + Cover + PDF)
   End-to-end: story -> ref -> images -> cover -> Cloudflare -> PDF
   Ändring: sidantalet är låst (skickar alltid 16 till /api/story)
   =================================================================== */
const API = "https://bokpilot-backend.sebastian-runell.workers.dev";

const CHECKOUT_DRAFT_KEY = "bp_checkout_draft_v1";
// Två separata pris-ID:n: ett för digital PDF (explicit), ett för tryckt bok (valfritt – ENV i backend räcker)
const PRICE_ID_PDF     = "price_1SZChZLrEazOnLLmCn8xKejV";

const PRICE_ID_PRINTED = "price_1SZCiKLrEazOnLLmUxWoDNWt"; 


// === Checkout (KV/Webhook) ===
const ORDER_ID_KEY    = "bp_last_order_id";  // sessionStorage
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS  = 120000;



// Cover-strategi: "skip" = generera inte omslag alls, "async" = generera i bakgrunden (rekommenderas)
const COVER_STRATEGY = "async";

// Fast antal story-sidor 
const STORY_PAGES = 16;

const HAS_PRINT_PDF_ENDPOINTS = true; // sätt till false om /api/pdf/interior /api/pdf/cover inte är på plats



/* --------------------------- Elements --------------------------- */
const els = {
  body: document.body,
  form: document.getElementById("storyForm"),

  // Kategoriknappar
  catKidsBtn: document.getElementById("catKidsBtn"),
  catPetsBtn: document.getElementById("catPetsBtn"),
  catAdultBtn: document.getElementById("catAdultBtn"),

  // Grundfält
  name: document.getElementById("name"),
  nameField: document.getElementById("nameField"),
  age: document.getElementById("age"),
  ageField: document.getElementById("ageField"),
  style: document.getElementById("style"),
  theme: document.getElementById("theme"),

  // Läsålder
  readingAgeNumber: document.getElementById("readingAge"),
  readingAgeField: document.getElementById("readingAgeField"),

  // Vuxen: relation + tillfälle
  relation: document.getElementById("relation"),
  relationField: document.getElementById("relationField"),
  occasionField: document.getElementById("occasionField"),
  occasionHidden: document.getElementById("occasionHidden"),
  occasionCustom: document.getElementById("occasionCustom"),

  // Karaktärsreferens
  traits: document.getElementById("traits"),
  charPhoto: document.getElementById("charPhoto"),
  photoPreview: document.getElementById("photoPreview"),
  refDescBtn: document.getElementById("refDescBtn"),
  refPhotoBtn: document.getElementById("refPhotoBtn"),
  traitsBlock: document.getElementById("traitsBlock"),
  photoBlock: document.getElementById("photoBlock"),

  // Preview
  previewSection: document.getElementById("preview"),
  previewGrid: document.getElementById("bookPreview"),

  // Knappar
  submitBtn: document.querySelector("#storyForm .btn-primary"),
  demoBtn: document.getElementById("demoBtn"),
  pdfBtn: document.getElementById("pdfBtn"),
  buyPrintBtn: document.getElementById("buyPrintBtn"),
  buyPdfBtn: document.getElementById("buyPdfBtn"),

  // Header / nav
  navToggle: document.getElementById("navToggle"),
  mobileMenu: document.getElementById("mobileMenu"),

  // Labels
  ageLabel: document.getElementById("ageLabel"),
  ageHint: document.getElementById("ageHint"),

  // Extra karaktärer (om du använder)
  extraCharsToggle: document.getElementById("extraCharsToggle"),
  extraCharsContainer: document.getElementById("extraCharsContainer"),
  extraCharRows: Array.from(document.querySelectorAll("[data-extra-char-row]")),
};

const readingAgeSeg = Array.from(document.querySelectorAll("[data-readage]"));
const occasionSeg = Array.from(document.querySelectorAll("[data-occasion]"));


els.buyPdfBtn = document.getElementById("buyPdfBtn");



/* --------------------------- State --------------------------- */
const STORAGE_KEY = "bokpiloten_form_v6";
const MAX_AGE = 120;
const MIN_AGE = 1;
const MAX_REF_DIM = 1024;
const regeneratingPages = new Set();

const state = {
  form: {
    category: "kids",          // "kids" | "pets" | "adult"
    name: "Nova",
    age: 6,                    // barn
    reading_age: 6,
    petSpecies: "",            // för husdjur
    relation: "",              // för vuxen
    occasion: "justbecause",   // nyckel, t.ex. "bachelor"
    occasion_custom: "",       // fri text när "Annat"
    style: "cartoon",
    theme: "",
    refMode: "photo",          // "photo" | "desc"
    traits: "",
    photoDataUrl: null,
  },

  visibleCount: 4,

  story: null,
  plan: null,

  ref_b64: null,
  ref_hash: null,

  cover_preview_url: null,
  cover_image_id: null,

  images_by_page: new Map(),
  hashes_by_page: new Map(),
};


async function fetchJSON(url, init) {
  const r = await fetch(url, init);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("application/json") ? await r.json() : await r.text();
  if (!r.ok || (body && body.error)) {
    const msg = (body && body.error) || (typeof body === "string" ? body : `HTTP ${r.status}`);
    throw new Error(msg);
  }
  return body;
}

/* --------------------------- Helpers --------------------------- */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toInt = (v, fb = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fb;
};
const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function saveForm() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.form));
  } catch {}
}
function loadForm() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) || {};
    Object.assign(state.form, saved);
  } catch {}
}

function smoothScrollTo(el) {
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function downscaleFileToDataURL(file, maxDim = MAX_REF_DIM) {
  const img = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = r.result;
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const w = img.naturalWidth,
    h = img.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return img.src;
  const c = document.createElement("canvas");
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png", 0.92);
}

async function urlToDataURL(url) {
  if (!url || url.startsWith("data:")) return url || null;
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) return null;
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}


function dataUrlToBareB64(dataUrl){
  if(!dataUrl || !dataUrl.startsWith("data:image/")) return null;
  const m = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  return m ? m[1] : null;
}

// Enkel "perceptual" hash (aHash) → 64-bit → 16 hex-tecken
async function imageDataUrlToHashHex(dataUrl, size = 8) {
  if (!dataUrl || !dataUrl.startsWith("data:image/")) return null;

  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = dataUrl;
  });

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Rita ner till liten ruta
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const gray = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // enkel luma
    gray.push(0.299 * r + 0.587 * g + 0.114 * b);
  }

  const avg =
    gray.reduce((sum, v) => sum + v, 0) / Math.max(1, gray.length);

  // Bygg 64-bit hash
  let bits = "";
  for (const g of gray) {
    bits += g >= avg ? "1" : "0";
  }

  // Konvertera till hex (8 bytes = 16 hex)
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    const nibble = bits.slice(i, i + 4);
    hex += parseInt(nibble, 2).toString(16);
  }
  return hex;
}


function saveOrderId(id){ try { sessionStorage.setItem(ORDER_ID_KEY, id); } catch {} }
function loadOrderId(){ try { return sessionStorage.getItem(ORDER_ID_KEY) || null; } catch { return null; } }

async function pollOrderPaid(orderId, { intervalMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${API}/api/orders/status?id=${encodeURIComponent(orderId)}`, { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        if (j?.status === "paid") return j;
      }
    } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("Timeout: betalning ej verifierad ännu.");
}

function buildImagesPayload() {
  const images = [];

  // --- Cover ---
  if (state.cover_image_id) {
    images.push({ kind: "cover", image_id: state.cover_image_id });
  } else if (state.cover_preview_url) {
    if (state.cover_preview_url.startsWith("data:image/")) {
      images.push({ kind: "cover", data_url: state.cover_preview_url });
    } else {
      images.push({ kind: "cover", url: state.cover_preview_url });
    }
  }

  // --- Interiors ---
  const pages = state.story?.book?.pages || [];
  for (const p of pages) {
    const row = state.images_by_page.get(p.page);
    if (!row) continue;

    // 1) CF-bild vinner (stabilast)
    if (row.image_id) {
      images.push({ page: p.page, image_id: row.image_id });
      continue;
    }

    // 2) Om vi har explicit data_url – använd den
    if (row.data_url && row.data_url.startsWith("data:image/")) {
      images.push({ page: p.page, data_url: row.data_url });
      continue;
    }

    // 3) image_url kan vara HTTP/HTTPS eller data:image
    if (row.image_url) {
      if (row.image_url.startsWith("data:image/")) {
        images.push({ page: p.page, data_url: row.image_url });
      } else {
        images.push({ page: p.page, url: row.image_url });
      }
      continue;
    }

    // 4) Fallback om något har lagt URL i row.url
    if (row.url) {
      if (row.url.startsWith("data:image/")) {
        images.push({ page: p.page, data_url: row.url });
      } else {
        images.push({ page: p.page, url: row.url });
      }
      continue;
    }
  }

  return images;
}


function updateHeroFieldForCategory() {
  const cat = state.form.category || "kids";
  if (!els.age) return;

  if (cat === "kids") {
    // Barnläge: numerisk ålder
    if (els.ageLabel) els.ageLabel.textContent = "Barnets ålder";
    els.age.type = "number";
    els.age.min = String(MIN_AGE);
    els.age.max = String(MAX_AGE);
    els.age.placeholder = "t.ex. 6";
    els.age.value = state.form.age ?? 6;
  } else {
    // Djur-läge: djurslag
    if (els.ageLabel) els.ageLabel.textContent = "Djurslag";
    els.age.type = "text";
    els.age.removeAttribute("min");
    els.age.removeAttribute("max");
    els.age.placeholder = "t.ex. katt, hund, kanin";
    els.age.value = state.form.petSpecies || "";
  }
}




/* --------------------------- Status/Progress --------------------------- */
const STATUS_QUIPS = [
  "puffar kuddar…",
  "polerar morrhår…",
  "tänder nattlampan…",
  "räknar stjärnor…",
  "Vässar pennor…",
  "sorterar leksaker…",
];
let quipTimer = null;

function ensureStatusBar() {
  let bar = document.getElementById("statusBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "statusBar";
    bar.className = "status-bar";
    els.previewSection?.insertAdjacentElement("beforebegin", bar);
  }
  bar.classList.remove("hidden");
  return bar;
}
function setStatus(msg, pctLabel) {
  const bar = ensureStatusBar();
  bar.textContent = msg || "";
  if (pctLabel != null) {
    let prog = bar.querySelector(".progress");
    if (!prog) {
      prog = document.createElement("div");
      prog.className = "progress";
      prog.innerHTML =
        '<div class="progress-track"><div class="progress-fill" style="width:0%"></div></div><span class="progress-label"></span>';
      bar.appendChild(prog);
    }
    const fill = prog.querySelector(".progress-fill");
    fill.style.width = `${Math.min(100, Math.max(0, pctLabel))}%`;
    prog.querySelector(".progress-label").textContent = `${Math.round(
      pctLabel
    )}%`;
  }
  if (!msg) bar.classList.add("hidden");
}
function startQuips() {
  stopQuips();
  const bar = ensureStatusBar();
  const aside = document.createElement("span");
  aside.className = "status-quips";
  aside.style.marginLeft = "8px";
  bar.appendChild(aside);
  let i = 0;
  quipTimer = setInterval(() => {
    aside.textContent = STATUS_QUIPS[i % STATUS_QUIPS.length];
    i++;
  }, 1800);
}
function stopQuips() {
  if (quipTimer) clearInterval(quipTimer);
  quipTimer = null;
  const q = document.querySelector(".status-quips");
  if (q) q.remove();
}

/* --------------------------- UI logic --------------------------- */
function setCategory(cat, save = true) {
  // tillåt tre värden nu
  const val = cat === "pets" ? "pets" : cat === "adult" ? "adult" : "kids";

  state.form.category = val;

  // 👇 nu får body tre möjliga teman
  document.body.dataset.theme = val; // "kids" | "pets" | "adult"

  els.catKidsBtn?.classList.toggle("active", val === "kids");
  els.catPetsBtn?.classList.toggle("active", val === "pets");
  els.catAdultBtn?.classList.toggle("active", val === "adult");

  // resten av din befintliga logik (ålder/djurslag osv) kan ligga kvar här under
  const ageLabel = document.getElementById("ageLabel");
  const ageHint  = document.getElementById("ageHint");

  if (val === "kids") {
    els.age.type = "number";
    els.age.min = "1";
    els.age.max = String(MAX_AGE);
    els.age.inputMode = "numeric";
    els.age.placeholder = "Ex: 6";
    els.age.value = state.form.age ?? 6;

    if (ageLabel) ageLabel.textContent = "Ålder (hjälte)";
    if (ageHint)  ageHint.textContent  = "Barnets ålder";
  } else if (val === "pets") {
    els.age.type = "text";
    els.age.removeAttribute("min");
    els.age.removeAttribute("max");
    els.age.removeAttribute("inputmode");
    els.age.placeholder = "Ex: katt, hund, kanin";
    els.age.value = state.form.petSpecies || "";

    if (ageLabel) ageLabel.textContent = "Djurslag";
    if (ageHint)  ageHint.textContent  = "Ange djurslag, t.ex. katt, hund eller kanin.";
  } else if (val === "adult") {
    // här kan vi styra hur fältet ska funka i vuxen-läget, t.ex. "Relation"
    els.age.type = "text";
    els.age.removeAttribute("min");
    els.age.removeAttribute("max");
    els.age.removeAttribute("inputmode");
    els.age.placeholder = "Ex: mamma, bror, bästa vän";
    els.age.value = state.form.relation || "";

    if (ageLabel) ageLabel.textContent = "Relation till hjälten";
    if (ageHint)  ageHint.textContent  = "T.ex. mamma, partner, bror, kollega.";
  }

  if (save) saveForm();
}



function setRefMode(mode, focus = true) {
  const m = mode === "photo" ? "photo" : "desc";
  state.form.refMode = m;
  els.refDescBtn.classList.toggle("active", m === "desc");
  els.refPhotoBtn.classList.toggle("active", m === "photo");
  els.traitsBlock.classList.toggle("hidden", m !== "desc");
  els.photoBlock.classList.toggle("hidden", m !== "photo");
  if (focus) (m === "desc" ? els.traits : els.charPhoto)?.focus();
  saveForm();
}
function setReadingAgeByChip(range) {
  const map = { "4-5": 5, "6-8": 7, "9-12": 10, familj: 8 };
  const val = map[range] || 6;
  state.form.reading_age = val;
  if (els.readingAgeNumber) els.readingAgeNumber.value = val;
  readingAgeSeg.forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-readage") === range);
  });
  saveForm();
}

function setOccasionByKey(key, save = true) {
  const occ = key || "justbecause";
  state.form.occasion = occ;

  occasionSeg.forEach((btn) => {
    const k = btn.getAttribute("data-occasion");
    btn.classList.toggle("active", k === occ);
  });

  if (els.occasionHidden) els.occasionHidden.value = occ;

  // Visa / göm fritextfält för "Annat"
  const showCustom = occ === "other";
  if (els.occasionCustom) {
    els.occasionCustom.classList.toggle("hidden", !showCustom);
    if (!showCustom) {
      els.occasionCustom.value = state.form.occasion_custom || "";
    }
  }

  if (save) saveForm();
}


function readForm() {
  const f = state.form;
  f.category = f.category || "kids";

  f.name = (els.name.value || "Nova").trim();
  f.style = els.style.value || "cartoon";
  f.theme = (els.theme.value || "").trim();
  f.traits = (els.traits.value || "").trim();

  // Läsålder (för barn)
  if (f.category === "kids") {
    f.reading_age = clamp(
      toInt(els.readingAgeNumber?.value ?? f.reading_age, f.reading_age),
      3,
      12
    );
  }

  if (f.category === "kids") {
    // Barn
    f.age = clamp(toInt(els.age.value, 6), MIN_AGE, MAX_AGE);
    f.petSpecies = "";
    f.relation = "";
    f.occasion = f.occasion || "justbecause";
    f.occasion_custom = "";
  } else if (f.category === "pets") {
    // Husdjur
    f.petSpecies = (els.age.value || "").trim().toLowerCase();
    f.age = null;
    f.relation = "";
    f.occasion = f.occasion || "justbecause";
    f.occasion_custom = "";
  } else if (f.category === "adult") {
    // Vuxen
    f.age = null;
    f.petSpecies = "";

    f.relation = (els.relation.value || "").trim();

    // Tillfälle
    const activeOcc = occasionSeg.find((btn) =>
      btn.classList.contains("active")
    );
    const occKey = activeOcc?.getAttribute("data-occasion") || els.occasionHidden?.value || f.occasion || "justbecause";
    f.occasion = occKey;

    f.occasion_custom = (els.occasionCustom?.value || "").trim();
  }
}



function writeForm() {
  const f = state.form;
  f.category = f.category || "kids";

  els.name.value = f.name || "";
  els.style.value = f.style || "cartoon";
  els.theme.value = f.theme || "";
  els.traits.value = f.traits || "";

  // Läsålder
  if (els.readingAgeNumber) {
    els.readingAgeNumber.value = f.reading_age ?? 6;
  }
  const target =
    f.reading_age <= 5 ? "4-5" :
    f.reading_age <= 8 ? "6-8" :
    f.reading_age <= 12 ? "9-12" : "familj";
  setReadingAgeByChip(target, false);

  // Sätt kategori (visar/döljer rätt fält)
  setCategory(f.category, false);

  // Ålder/djurslag
  if (f.category === "kids") {
    els.age.value = f.age ?? 6;
  } else if (f.category === "pets") {
    els.age.value = f.petSpecies || "";
  }

  // Vuxen-fält
  if (f.category === "adult") {
    els.relation.value = f.relation || "";
    setOccasionByKey(f.occasion || "justbecause", false);
    if (els.occasionCustom) {
      els.occasionCustom.value = f.occasion_custom || "";
    }
  }

  // Ref-mode
  if (f.refMode !== "photo" && f.refMode !== "desc") f.refMode = "photo";
  setRefMode(f.refMode, false);

  // Foto-preview
  if (f.photoDataUrl) {
    els.photoPreview.src = f.photoDataUrl;
    els.photoPreview.classList.remove("hidden");
  } else {
    els.photoPreview.classList.add("hidden");
    els.photoPreview.src = "";
  }
}



function renderSkeleton(count = 4) {
  if (!els.previewGrid) return;

  // 🔹 Visa preview-sektionen
  if (els.previewSection) {
    els.previewSection.classList.remove("hidden");
  }

  els.previewGrid.innerHTML = "";

  for (let i = 0; i < count; i++) {
    const el = document.createElement("article");
    el.className = "thumb";

    const wrap = document.createElement("div");
    wrap.className = "imgwrap";

    // Klassisk skeleton (matchar CSS .thumb .imgwrap .skeleton)
    const sk = document.createElement("div");
    sk.className = "skeleton";
    wrap.appendChild(sk);

    const txt = document.createElement("div");
    txt.className = "page-text";
    txt.textContent = "Genererar sida…";
    txt.style.opacity = "0.5";

    el.appendChild(wrap);
    el.appendChild(txt);

    els.previewGrid.appendChild(el);
  }
}

function buildCards(pages, visibleCount) {
  if (!els.previewGrid) return;
  els.previewGrid.innerHTML = "";

  // Omslaget (page 0 – placeholder tills cover är klar)
  const coverCard = buildCard({
    page: 0,
    image_url: state.cover_preview_url || null,
    text: state.story?.book?.title || "",
  });
  els.previewGrid.appendChild(coverCard);

  // Innersidor
  for (const pg of pages) {
    const card = buildCard({
      page: pg.page,
      image_url: (state.images_by_page.get(pg.page) || {}).image_url || null,
      text:
        pg.text ||
        pg.scene_sv ||
        pg.scene_en ||
        "",
    });
    els.previewGrid.appendChild(card);
  }
}


function buildCard(item) {
  const article = document.createElement("article");
  article.className = "thumb";

  // Bild-wrapper
  const imgWrap = document.createElement("div");
  imgWrap.className = "imgwrap";
  imgWrap.dataset.page = item.page;

  if (!item.image_url) {
    const sk = document.createElement("div");
    sk.className = "skeleton-box";
    imgWrap.appendChild(sk);
  } else {
    const img = document.createElement("img");
    img.src = item.image_url;
    imgWrap.appendChild(img);
  }

  // 🔹 Hover overlay med flera val
  const over = document.createElement("div");
  over.className = "regen-overlay hidden";

  const btnWrap = document.createElement("div");
  btnWrap.className = "regen-btn-group"; // valfri klass för styling

  const btnGeneral = document.createElement("button");
  btnGeneral.className = "regen-btn";
  btnGeneral.textContent = "Generera om";
  btnGeneral.onclick = () => regenerateOne(item.page, "generic");

  const btnCharacter = document.createElement("button");
  btnCharacter.className = "regen-btn";
  btnCharacter.textContent = "Stämmer inte med hjälten";
  btnCharacter.onclick = () => regenerateOne(item.page, "character_mismatch");

  const btnScene = document.createElement("button");
  btnScene.className = "regen-btn";
  btnScene.textContent = "Stämmer inte med scenen";
  btnScene.onclick = () => regenerateOne(item.page, "scene_mismatch");

  const btnStyle = document.createElement("button");
  btnStyle.className = "regen-btn";
  btnStyle.textContent = "Fel stil";
  btnStyle.onclick = () => regenerateOne(item.page, "style_issue");

  btnWrap.appendChild(btnGeneral);
  btnWrap.appendChild(btnCharacter);
  btnWrap.appendChild(btnScene);
  btnWrap.appendChild(btnStyle);

  over.appendChild(btnWrap);
  imgWrap.appendChild(over);

  // Text – redigerbar
  const txt = document.createElement("div");
  txt.className = "page-text";
  txt.contentEditable = "true";
  txt.textContent = item.text || "";

  txt.oninput = () => {
    const page = state.story.book.pages.find((p) => p.page === item.page);
    if (page) page.text = txt.textContent;
  };

  article.appendChild(imgWrap);
  article.appendChild(txt);
  return article;
}



async function fillCard(page, imgUrl, providerLabel = "") {
  const wrap = els.previewGrid.querySelector(`.imgwrap[data-page="${page}"]`);
  if (!wrap || !imgUrl) return;

  const imgEl = wrap.querySelector("img");
  const sk    = wrap.querySelector(".skeleton, .skeleton-box");
  const prov  = wrap.querySelector(".img-provider");
  const over  = wrap.querySelector(".regen-overlay");

  wrap.querySelector(".img-fallback")?.remove();

  // undvik dubblettarbete
  if (wrap.dataset.currentUrl === imgUrl) return;
  wrap.dataset.currentUrl = imgUrl;

  const tmp = new Image();
  tmp.loading = "eager";
  tmp.referrerPolicy = "no-referrer";

  const show = () => {
    if (imgEl) {
      imgEl.src = tmp.src;
      imgEl.classList.add("is-ready"); // triggar fade-in via CSS
    } else {
      // fallback om inget img fanns
      const newImg = document.createElement("img");
      newImg.src = tmp.src;
      newImg.classList.add("is-ready");
      wrap.prepend(newImg);
    }

    sk?.remove();

    if (prov) {
      prov.textContent = providerLabel || "";
      prov.classList.toggle("hidden", !providerLabel);
    }

    // 🔓 NU låser vi upp regenerera – först när bild är klar
    if (over) over.classList.remove("hidden");
  };

  tmp.onload = show;
  tmp.onerror = () => {
    sk?.remove();
    const fb = document.createElement("div");
    fb.className = "img-fallback";
    fb.innerHTML = `
      <p>Misslyckades att ladda bilden.</p>
    `;
    wrap.appendChild(fb);

    // 🔓 Även vid load-fail ska man kunna regenerera
    if (over) over.classList.remove("hidden");
  };

  tmp.src = imgUrl;

  if (tmp.decode) {
    try { 
      await tmp.decode(); 
      show(); 
    } catch {}
  }
}





/* --------------------------- CF Images upload --------------------------- */
async function uploadToCF(items) {
  const r = await fetch(`${API}/api/images/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!r.ok)
    throw new Error(`/api/images/upload ${r.status} ${await r.text().catch(()=>"")}`);
  const j = await r.json().catch(() => ({}));
  return j.uploads || [];
}

/* --------------------------- PDF --------------------------- */



async function onBuyPdf() {
  if (!state.story) { alert("Skapa förhandsvisning först."); return; }

  const draft = {
    story: state.story,
    images: buildImagesPayload(),
    trim: "square210",
    mode: "final"
  };

  try { localStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(draft)); } catch {}

  setStatus("🧾 Startar checkout…", 92);

  const r = await fetch(`${API}/api/checkout/pdf`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ price_id: PRICE_ID_PDF, customer_email: "", draft })
  });

  if (!r.ok) {
    const body = await r.text().catch(()=> "");
    setStatus(null);
    throw new Error(`Checkout misslyckades (HTTP ${r.status})\n${body}`);
  }

  const { url, order_id, id: stripe_session_id, error } = await r.json();
  if (error) { setStatus(null); throw new Error(error); }

  // ⬅️ kritiskt för webhook-flödet: spara order_id så vi kan polla KV på success-sidan
  if (order_id) saveOrderId(order_id);

  // Öppna Stripe
  location.href = url;
}

async function onBuyPrint() {
  try {
    if (!state.story) { alert("Skapa förhandsvisning först."); return; }

    // Spara ett “draft” så vi vet vad som ska tryckas efter betalning
    const draft = {
      kind: "printed",
      story: state.story,
      images: buildImagesPayload(),
      trim: "square200",   // <- för Gelato 200x200 mm inlaga
      mode: "final"
    };
    try { localStorage.setItem(CHECKOUT_DRAFT_KEY, JSON.stringify(draft)); } catch {}

    setStatus("🧾 Startar checkout…", 92);

   const printedPayload = {
  customer_email: "", // Stripe samlar in
  draft             // sparas på ordern i KV
};
// Om du **vill** åsidosätta ENV från frontend: sätt PRICE_ID_PRINTED ovan.
if (PRICE_ID_PRINTED) printedPayload.price_id = PRICE_ID_PRINTED;

const r = await fetch(`${API}/api/checkout/printed`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(printedPayload)
});


    if (!r.ok) {
      const body = await r.text().catch(()=> "");
      setStatus(null);
      throw new Error(`Checkout (printed) misslyckades (HTTP ${r.status})\n${body}`);
    }

    const { url, order_id, id: stripe_session_id, error } = await r.json();
    if (error) { setStatus(null); throw new Error(error); }

    if (order_id) saveOrderId(order_id);
    location.href = url; // → Stripe Checkout
  } catch (e) {
    console.error(e);
    setStatus(null);
    alert(e?.message || "Kunde inte starta checkout för tryckt bok.");
  }
}





async function onSubmit(e) {
  e.preventDefault();

  if (state.abortController) state.abortController.abort();
  state.abortController = new AbortController();
  const signal = state.abortController.signal;


   // full reset
   state.story = null;
  state.plan = null;
  state.ref_b64 = null;
  state.ref_hash = null;              
  state.images_by_page.clear();
  state.hashes_by_page = new Map();  
  state.cover_preview_url = null;
  state.cover_image_id = null;


  els.previewGrid.innerHTML = "";
  setStatus(null);
  stopQuips();

  // validera
  readForm();
  const problems = [];
  if (!state.form.name) problems.push("Ange ett namn.");

  if (state.form.category === "kids") {
    if (state.form.age < MIN_AGE || state.form.age > MAX_AGE) {
      problems.push("Barnets ålder verkar orimlig.");
    }
  } else {
  const species = (state.form.petSpecies || "").trim();
  if (species.length < 2) {
    problems.push("Ange djurslag, t.ex. katt eller hund.");
  }
}


  if (state.form.reading_age < 3 || state.form.reading_age > 12) {
    problems.push("Läsålder bör vara 3–12 (eller välj Familj).");
  }

  if (state.form.refMode === "desc") {
    if (!state.form.traits || state.form.traits.length < 6) problems.push("Beskriv gärna kännetecken – eller ladda upp foto för bäst resultat.");
  } else if (state.form.refMode === "photo") {
    if (!state.form.photoDataUrl) problems.push("Ladda upp ett foto – eller byt till Beskrivning.");
  }
  if (problems.length) { alert("Korrigera:\n\n• " + problems.join("\n• ")); return; }

  // UI
  renderSkeleton(5);
  setStatus("✏️ Skriver berättelsen…", 8);
  startQuips();
  els.submitBtn.disabled = true;
  els.submitBtn.innerHTML = 'Skapar förhandsvisning… <span class="spinner"></span>';

  // reset
  state.images_by_page.clear();
  state.cover_preview_url = null;
  state.cover_image_id = null;

  try {
    // 1) STORY
    const storyRes = await fetch(`${API}/api/story`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: state.form.name,
        age: state.form.age,
        reading_age: state.form.reading_age,
        pages: STORY_PAGES, // <- låst
        category: state.form.category,
        style: state.form.style,
        theme: state.form.theme,
        traits: state.form.traits,
        petSpecies: state.form.petSpecies || "",
      }),
    });
    const storyData = await storyRes.json().catch(() => ({}));
    if (!storyRes.ok || storyData?.error) throw new Error(storyData?.error || `HTTP ${storyRes.status}`);
    state.story = storyData.story;
    state.plan = storyData.plan || { plan: [] };

    const pages = state.story?.book?.pages || [];
    if (!pages.length) throw new Error("Berättelsen saknar sidor.");
    buildCards(pages, state.visibleCount);
    setStatus("🖼️ Målar huvudkaraktären…", 22);

    // 2) REF IMAGE
    const refRes = await fetch(`${API}/api/ref-image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        style: state.form.style,
        photo_b64: state.form.refMode === "photo" ? state.form.photoDataUrl : null,
        bible: state.story?.book?.bible || null,
        traits: state.form.traits || "",
         category: state.form.category, 
      }),
    });
    const refData = await refRes.json().catch(() => ({}));
    if (!refRes.ok || refData?.error) throw new Error(refData?.error || `HTTP ${refRes.status}`);
    state.ref_b64 = refData.ref_image_b64 || null;
    if (!state.ref_b64) throw new Error("Ingen referensbild kunde skapas.");

    // DEBUG: visa referensbilden i konsolen
const refPreviewUrl =
  refData.image_url ||
  (state.ref_b64 ? `data:image/png;base64,${state.ref_b64}` : null);

if (refPreviewUrl) {
  console.log("[BokPiloten] Ref image preview URL:", refPreviewUrl);

  // 🔹 Beräkna hash för hjältereferensen
  try {
    const du = refPreviewUrl.startsWith("data:")
      ? refPreviewUrl
      : await urlToDataURL(refPreviewUrl);
    const hashHex = await imageDataUrlToHashHex(du);
    state.ref_hash = hashHex || null;
    console.log("[BokPiloten] Ref hash:", hashHex);
  } catch (err) {
    console.warn("[BokPiloten] Kunde inte beräkna ref-hash", err);
    state.ref_hash = null;
  }
}

   // 3) INTERIOR IMAGES — SEKVENSIELLT (Kedjan)
    setStatus("🎥 Spelar in scener…", 38);

   let received = 0;
// Håller koll på de senaste n (t.ex. 3) bilderna för kontinuitet
let prevBareFrames = [];


    for (const pg of pages) {
      // Visa skeleton om bilden saknas
      const wrap = els.previewGrid.querySelector(`.imgwrap[data-page="${pg.page}"]`);
      if (wrap && !wrap.querySelector("img")?.src) {
        const sk = wrap.querySelector(".skeleton") || document.createElement("div");
        sk.className = "skeleton";
        if (!wrap.querySelector(".skeleton")) wrap.prepend(sk);
      }

      try {

        const prevPageNum = pg.page - 1;
const prev_hash =
  (state.hashes_by_page && state.hashes_by_page.get(prevPageNum)) || null;

        // ANROPET: Skicka med prev_b64 (om det finns)
        const res = await fetch(`${API}/api/images/next`, {
          method: "POST",
          headers: { "content-type": "application/json" },
    body: JSON.stringify({
  style: state.form.style,
  story: state.story,
  page: pg.page,
  ref_image_b64: state.ref_b64,
  prev_b64:
    prevBareFrames.length
      ? prevBareFrames[prevBareFrames.length - 1]
      : null,
  hashes: {
    ref_hash: state.ref_hash || null,
    prev_hash,
    curr_hash: null, // backend kan räkna själv om det vill
  },
}),

        });
        
      const j = await res.json().catch(() => ({}));
if (!res.ok || j?.error || !j?.image_url) throw new Error(j?.error || `HTTP ${res.status}`);

// Visa bilden direkt
fillCard(pg.page, j.image_url, "Gemini");
state.images_by_page.set(pg.page, { image_url: j.image_url });

const du = await urlToDataURL(j.image_url);
const bare = dataUrlToBareB64(du);

// 🔹 Beräkna hash för den här sidan
let hashHex = null;
if (du) {
  try {
    hashHex = await imageDataUrlToHashHex(du);
  } catch (err) {
    console.warn("Kunde inte beräkna hash för page", pg.page, err);
  }
}
if (hashHex) {
  if (!state.hashes_by_page) state.hashes_by_page = new Map();
  state.hashes_by_page.set(pg.page, hashHex);
}

if (bare) {
  prevBareFrames.push(bare);
  if (prevBareFrames.length > 3) {
    prevBareFrames.shift();
  }
}



        // Ladda upp till Cloudflare i bakgrunden
        if (du) {
          const uploads = await uploadToCF([{ page: pg.page, data_url: du }]).catch(() => []);
          const u = uploads?.find(x => x.page === pg.page);
          if (u?.image_id) {
            state.images_by_page.set(pg.page, { image_id: u.image_id, image_url: u.url });
            fillCard(pg.page, u.url || j.image_url, "CF");
          }
        }

       } catch (err) {
    console.error("page", pg.page, err);
    if (wrap) {
      wrap.querySelector(".skeleton, .skeleton-box")?.remove();

      const fb = document.createElement("div");
      fb.className = "img-fallback";
      fb.textContent = "oj, Jag tänkte för länge! Prova gärna att generera bilden igen!";
      wrap.appendChild(fb);

      // 🔓 Viktigt: lås upp regenerera även vid total API-fail
      const over = wrap.querySelector(".regen-overlay");
      if (over) over.classList.remove("hidden");
    }
  }


      received++;
      setStatus(`🎨 Målar sida ${received}/${pages.length}…`, 38 + (received / Math.max(1, pages.length)) * 32);
    }

    // 4) COVER (Omslag)
    if (COVER_STRATEGY === "async") {
      generateCoverAsync().catch(() => {});
      setStatus("☁️ Laddar upp illustrationer…", 86);
    } else if (COVER_STRATEGY === "sync") {
      setStatus("🎨 Skapar omslag…", 84);
      await generateCoverAsync();
      setStatus("☁️ Laddar upp illustrationer…", 86);
    } else {
      setStatus("☁️ Laddar upp illustrationer…", 86);
    }

    // 5) SLUTLIG UPPLADDNING (Säkerställ att allt är på CF)
    const items = [];
    for (const p of pages) {
      const row = state.images_by_page.get(p.page);
      if (!row) continue;
      if (row.image_id) continue; // Redan klart

      const du = row.data_url || (row.image_url ? await urlToDataURL(row.image_url) : null);
      if (du) items.push({ page: p.page, data_url: du });
    }

    if (items.length) {
      const uploads = await uploadToCF(items);
      const byPage = new Map();
      for (const u of uploads) if (Number.isFinite(u.page)) byPage.set(u.page, u);

      for (const p of pages) {
        const u = byPage.get(p.page);
        if (u?.image_id) {
          state.images_by_page.set(p.page, { image_id: u.image_id, image_url: u.url });
          fillCard(p.page, u.url || state.images_by_page.get(p.page)?.image_url || "", "CF");
        }
      }
    }

    stopQuips();
    setStatus("✅ Klart! Förhandsvisning redo.", 100);

  } catch (e) {
    console.error(e);
    stopQuips();
    setStatus(null);
    alert("Ett fel uppstod: " + (e?.message || e));
  } finally {
    els.submitBtn.disabled = false;
    els.submitBtn.textContent = "Skapa förhandsvisning";
  }
}

async function chooseRegenReason() {
  const msg =
    "Varför vill du göra om bilden?\n\n" +
    "1 = Ser inte ut som huvudkaraktären\n" +
    "2 = Gör inte som texten beskriver\n" +
    "3 = Något ser konstigt ut (extra armar, konstiga ansikten, m.m.)\n\n" +
    "Skriv 1, 2 eller 3 (lämna tomt för att avbryta).";

  const val = window.prompt(msg, "1");
  if (!val) return null;

  const v = val.trim();
  if (v === "1") {
    return {
      code: "character_mismatch",
      note: ""
    };
  }
  if (v === "2") {
    const extra = window.prompt(
      "Vad stämmer inte med texten? (valfritt, men hjälper AI:n)",
      ""
    );
    return {
      code: "text_mismatch",
      note: extra || ""
    };
  }
  if (v === "3") {
    const extra = window.prompt(
      "Beskriv kort vad som ser konstigt ut (valfritt)",
      ""
    );
    return {
      code: "weird_artifacts",
      note: extra || ""
    };
  }

  // Ogiltigt val => avbryt
  return null;
}
/* --------------------------- Single regenerate --------------------------- */
async function regenerateOne(page, reasonCode = "generic") {
  if (!state.ref_b64 || !state.story) return;

  // Hindra dubbelklick / parallella requests per sida
  if (regeneratingPages.has(page)) return;
  regeneratingPages.add(page);

  const wrap = els.previewGrid.querySelector(`.imgwrap[data-page="${page}"]`);
  if (!wrap) {
    regeneratingPages.delete(page);
    return;
  }

  // 🔹 Läs nuvarande (felaktiga) bild till b64 innan vi rensar
  let currB64 = null;
  const currentImgEl = wrap.querySelector("img");
  if (currentImgEl?.src) {
    try {
      const du = await urlToDataURL(currentImgEl.src);
      currB64 = dataUrlToBareB64(du);
    } catch (err) {
      console.warn("Kunde inte läsa nuvarande bild som b64:", err);
    }
  }

  // 1) Rensa befintligt visuellt innehåll
  wrap.querySelector(".img-fallback")?.remove();
  wrap.querySelector("img")?.remove();
  wrap.querySelector(".skeleton, .skeleton-box")?.remove();

  // 2) Dölj overlay medan vi genererar
  const over = wrap.querySelector(".regen-overlay");
  if (over) {
    over.classList.add("hidden");
  }

  // 3) Ny skeleton
  const sk = document.createElement("div");
  sk.className = "skeleton";
  wrap.prepend(sk);

  try {
    const prevHash =
      (state.hashes_by_page && state.hashes_by_page.get(page - 1)) || null;

    const res = await fetch(`${API}/api/image/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        page,
        story: state.story,
        ref_image_b64: state.ref_b64,         // huvudkaraktär
        prev_b64: currB64,                    // nuvarande felaktiga bild
        style: state.form.style,
        coherence_code: state.coherence_code || null,
        style_refs_b64: state.style_refs_b64 || null,
        hashes: {
          ref_hash: state.ref_hash || null,
          prev_hash: prevHash,
          curr_hash: null,
        },
        reason_code: reasonCode,              // 🔹 nyckeln här
        reason_note: ""                       // kan fyllas senare om du vill ha fritext
      }),
    });

    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.error || !j.image_url) {
      throw new Error(j?.error || `HTTP ${res.status}`);
    }

    // Ta bort skeleton – fillCard sätter in nya bilden + overlay-logik
    sk.remove();
    await fillCard(page, j.image_url, j.provider || "Gemini");

    // Uppdatera state (bild)
    state.images_by_page.set(page, {
      image_url: j.image_url,
      provider: j.provider || "Gemini",
    });

    // Uppdatera hash
    try {
      const du = await urlToDataURL(j.image_url);
      if (du) {
        const hashHex = await imageDataUrlToHashHex(du);
        if (!state.hashes_by_page) state.hashes_by_page = new Map();
        state.hashes_by_page.set(page, hashHex || null);
      }
    } catch (err) {
      console.warn("Kunde inte uppdatera hash för regen page", page, err);
    }
  } catch (e) {
    console.error("regenerateOne error", e);
    sk.remove();

    const fb = document.createElement("div");
    fb.className = "img-fallback";
    fb.innerHTML = `
      Kunde inte generera bild
      <div class="retry-wrap" style="margin-top:8px;">
        <button class="retry-btn retry" data-page="${page}">🔄 Generera igen</button>
      </div>`;
    wrap.appendChild(fb);

    if (over) over.classList.remove("hidden");
  } finally {
    regeneratingPages.delete(page);
  }
}



async function generateCoverAsync() {
  try {
    const covRes = await fetch(`${API}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        style: state.form.style,
        character_ref_b64: state.ref_b64,   // samma som tidigare
        story: state.story,
      }),
    });

    const cov = await covRes.json().catch(() => ({}));
    if (!covRes.ok || cov?.error) {
      console.warn("cover generation failed", cov?.error || covRes.status);
      return;
    }

    const dataUrl =
      cov.image_url ||
      cov.data_url ||
      (cov.cover_b64 ? `data:image/png;base64,${cov.cover_b64}` : null);

    if (!dataUrl) return;

    state.cover_preview_url = dataUrl;
    await fillCard(0, dataUrl, "Gemini");

    const du = await urlToDataURL(dataUrl);
    if (!du) return;
    const uploads = await uploadToCF([{ kind: "cover", data_url: du }]).catch(() => []);
    const u = uploads?.find(x => x.kind === "cover" || x.page === 0);
    if (u?.image_id) {
      state.cover_image_id = u.image_id;
      state.cover_preview_url = u.url || dataUrl;
      await fillCard(0, state.cover_preview_url, "CF");
    }
  } catch (err) {
    console.warn("Cover async fail", err);
  }
}


async function fetchOrderIdFromSessionId(sessionId) {
  if (!sessionId) return null;
  try {
    const r = await fetch(`${API}/api/checkout/order-id?session_id=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    return j?.order_id || null;
  } catch { return null; }
}

// --- Safe Stripe-return handler (no-op på vanliga sidor) ---
function handleStripeReturnIfAny() {
  try {
    const url = new URL(location.href);
    const path = url.pathname.toLowerCase();

    // Om detta inte är success-sidan: gör inget.
    if (!/success/.test(path)) return;

    // Hämta session_id om det finns i URL, annars försök läsa från storage.
    const sid =
      url.searchParams.get("session_id") ||
      sessionStorage.getItem("bp:last_session_id") ||
      localStorage.getItem("bp:last_session_id") ||
      null;

    if (!sid) return;

    // Persist sid så success-skriptet kan använda det (idempotent).
    try {
      sessionStorage.setItem("bp:last_session_id", sid);
      localStorage.setItem("bp:last_session_id", sid);
    } catch {}

    // Viktigt: den här funktionen gör INTE mer – själva success-flödet hanteras
    // av success-sidans script. Vi vill bara undvika ReferenceError och säkra sid.
  } catch {
    // Swallow – absolut inget får kasta här.
  }
}


/* --------------------------- Events & Init --------------------------- */
/* --------------------------- Events & Init --------------------------- */
function bindEvents() {
  // 🔹 Kategori-knappar (nu med vuxen)
  els.catKidsBtn?.addEventListener("click", () => setCategory("kids"));
  els.catPetsBtn?.addEventListener("click", () => setCategory("pets"));
  els.catAdultBtn?.addEventListener("click", () => setCategory("adult"));

  // 🔹 Ref-läge (beskrivning/foto)
  els.refDescBtn?.addEventListener("click", () => setRefMode("desc"));
  els.refPhotoBtn?.addEventListener("click", () => setRefMode("photo"));

  // 🔹 Läsålder-chip (barn)
  readingAgeSeg.forEach((btn) => {
    btn.addEventListener("click", () => {
      readingAgeSeg.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setReadingAgeByChip(btn.getAttribute("data-readage"));
    });
  });

  // 🔹 Tillfälle-chip (vuxen)
  occasionSeg.forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-occasion");
      setOccasionByKey(key);
    });
  });

  // 🔹 Vanliga input-fält som ska trigga readForm/saveForm
  [
    "name",
    "age",
    "style",
    "theme",
    "traits",
    "readingAge",
    "relation",        // 👈 nytt för vuxen
    "occasionCustom",  // 👈 fritext-tillfälle
  ].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => {
      readForm();
      saveForm();
    });
  });

  // 🔹 Foto-upload
  els.charPhoto?.addEventListener("change", async () => {
    const f = els.charPhoto.files?.[0];
    if (!f) {
      state.form.photoDataUrl = null;
      els.photoPreview.classList.add("hidden");
      els.photoPreview.src = "";
      saveForm();
      return;
    }
    const dataUrl = await downscaleFileToDataURL(f, MAX_REF_DIM);
    state.form.photoDataUrl = dataUrl;
    els.photoPreview.src = dataUrl;
    els.photoPreview.classList.remove("hidden");
    saveForm();
  });

  // 🔹 Form submit
  els.form?.addEventListener("submit", onSubmit);

  // 🔹 Mobilmeny
  els.navToggle?.addEventListener("click", () => {
    els.mobileMenu.classList.toggle("open");
    const open = els.mobileMenu.classList.contains("open");
    els.navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    els.mobileMenu.setAttribute("aria-hidden", open ? "false" : "true");
  });

  // 🔹 Köp-knappar
  els.buyPdfBtn?.addEventListener("click", onBuyPdf);

  els.buyPrintBtn = document.getElementById("buyPrintBtn");
  els.buyPrintBtn?.addEventListener("click", onBuyPrint);
}

(function init() {
  loadForm();
  if (state.form.refMode !== "photo" && state.form.refMode !== "desc")
    state.form.refMode = "photo";
  writeForm();

  // Om vi landar på success-sidan, verifiera betalning nu
  handleStripeReturnIfAny?.();

  bindEvents();
  setStatus(null);
})();
