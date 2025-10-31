/* ===================================================================
   BokPiloten – Frontend v4.1 (CF Images + Cover + PDF)
   End-to-end: story -> ref -> images -> cover -> Cloudflare -> PDF
   Ändring: sidantalet är låst (skickar alltid 14 till /api/story)
   =================================================================== */
const API = "https://bokpilot-backend.sebastian-runell.workers.dev";

// Cover-strategi: "skip" = generera inte omslag alls, "async" = generera i bakgrunden (rekommenderas)
const COVER_STRATEGY = "async";

// Fast antal story-sidor (ger 32-sidors bok: framsida + 30 blad + baksida)
const STORY_PAGES = 14;

/* --------------------------- Elements --------------------------- */
const els = {
  body: document.body,
  form: document.getElementById("storyForm"),
  catKidsBtn: document.getElementById("catKidsBtn"),
  catPetsBtn: document.getElementById("catPetsBtn"),
  name: document.getElementById("name"),
  age: document.getElementById("age"),
  style: document.getElementById("style"),
  theme: document.getElementById("theme"),
  traits: document.getElementById("traits"),
  charPhoto: document.getElementById("charPhoto"),
  photoPreview: document.getElementById("photoPreview"),
  refDescBtn: document.getElementById("refDescBtn"),
  refPhotoBtn: document.getElementById("refPhotoBtn"),
  traitsBlock: document.getElementById("traitsBlock"),
  photoBlock: document.getElementById("photoBlock"),
  readingAgeNumber: document.getElementById("readingAge"),
  previewSection: document.getElementById("preview"),
  previewGrid: document.getElementById("bookPreview"),
  submitBtn: document.querySelector("#storyForm .btn-primary"),
  demoBtn: document.getElementById("demoBtn"),
  navToggle: document.getElementById("navToggle"),
  mobileMenu: document.getElementById("mobileMenu"),
  pdfBtn: document.getElementById("pdfBtn"),
};
const readingAgeSeg = Array.from(document.querySelectorAll("[data-readage]"));

/* --------------------------- State --------------------------- */
const STORAGE_KEY = "bokpiloten_form_v6";
const MAX_AGE = 120;
const MIN_AGE = 1;
const MAX_REF_DIM = 1024;

const state = {
  form: {
    category: "kids",
    name: "Nova",
    age: 6,
    reading_age: 6,
    style: "cartoon",
    theme: "",
    refMode: "photo", // "photo" | "desc"
    traits: "",
    photoDataUrl: null,
  },
  visibleCount: 4,

  story: null,
  plan: null,

  ref_b64: null,

  // local preview
  cover_preview_url: null, // can be data_url/http
  cover_image_id: null,

  images_by_page: new Map(), // page -> {image_url|data_url|image_id}
};

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

/* --------------------------- Status/Progress --------------------------- */
const STATUS_QUIPS = [
  "puffar kuddar…",
  "polerar morrhår…",
  "tänder nattlampan…",
  "räknar stjärnor…",
  "justerar rim light…",
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
  const val = cat === "pets" ? "pets" : "kids";
  state.form.category = val;
  document.body.dataset.theme = val;
  els.catKidsBtn?.classList.toggle("active", val === "kids");
  els.catPetsBtn?.classList.toggle("active", val === "pets");
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

function readForm() {
  const f = state.form;
  f.name = (els.name.value || "Nova").trim();
  f.age = clamp(toInt(els.age.value, 6), MIN_AGE, MAX_AGE);
  f.style = els.style.value || "cartoon";
  f.theme = (els.theme.value || "").trim();
  f.traits = (els.traits.value || "").trim();
  f.reading_age = clamp(
    toInt(els.readingAgeNumber?.value ?? f.reading_age, f.reading_age),
    3,
    12
  );
}
function writeForm() {
  els.name.value = state.form.name;
  els.age.value = state.form.age;
  els.style.value = state.form.style;
  els.theme.value = state.form.theme;
  els.traits.value = state.form.traits;
  if (els.readingAgeNumber) els.readingAgeNumber.value = state.form.reading_age;
  const target =
    state.form.reading_age <= 5
      ? "4-5"
      : state.form.reading_age <= 8
      ? "6-8"
      : state.form.reading_age <= 12
      ? "9-12"
      : "familj";
  setReadingAgeByChip(target);
  setCategory(state.form.category, false);
  setRefMode(state.form.refMode, false);
  if (state.form.photoDataUrl) {
    els.photoPreview.src = state.form.photoDataUrl;
    els.photoPreview.classList.remove("hidden");
  }
}

/* --------------------------- Preview rendering --------------------------- */
function renderSkeleton(count = 4) {
  els.previewGrid.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const el = document.createElement("article");
    el.className = "thumb";
    el.innerHTML = `
      <div class="imgwrap"><div class="skeleton"></div></div>
      <div class="txt"><span class="skeleton" style="display:block;height:12px;margin-bottom:8px"></span><span class="skeleton" style="display:block;height:12px;width:60%"></span></div>`;
    els.previewGrid.appendChild(el);
  }
  els.previewSection.classList.remove("hidden");
}

function buildCards(pages, visibleCount) {
  els.previewGrid.innerHTML = "";
  // Cover först
  const cover = document.createElement("article");
  cover.className = "thumb cover";
  cover.innerHTML = `
    <div class="imgwrap" data-page="0">
      <div class="skeleton"></div>
      <img alt="Omslag" style="opacity:0" />
      <span class="img-provider hidden"></span>
    </div>
    <div class="txt">Omslag</div>`;
  els.previewGrid.appendChild(cover);

  // Interiör
  pages.forEach((pg, i) => {
    const card = document.createElement("article");
    card.className = "thumb";
    if (i >= visibleCount) card.classList.add("locked");
    card.innerHTML = `
      <div class="imgwrap" data-page="${pg.page}">
        <div class="skeleton"></div>
        <img alt="Sida ${pg.page}" style="opacity:0" />
        <span class="img-provider hidden"></span>
      </div>
      <div class="txt">${escapeHtml(pg.text || "")}</div>
      <div class="retry-wrap hidden" style="padding:10px 12px;">
        <button class="retry-btn retry" data-page="${pg.page}">🔄 Generera igen</button>
      </div>`;
    els.previewGrid.appendChild(card);
  });
  els.previewSection.classList.remove("hidden");
  smoothScrollTo(els.previewSection);
}

// Ersätt hela fillCard med denna version
async function fillCard(page, imgUrl, providerLabel = "") {
  // Hitta befintlig "slot" (cover = 0, interiör = 1..14)
  const wrap = els.previewGrid.querySelector(`.imgwrap[data-page="${page}"]`);
  if (!wrap) return; // om något gått snett

  const imgEl = wrap.querySelector("img");
  const sk    = wrap.querySelector(".skeleton");
  const prov  = wrap.querySelector(".img-provider");

  // Lazy-load med mjuk in-fade
  const tmp = new Image();
  tmp.loading = "lazy";

  tmp.onload = () => {
    // sätt bild och visa mjukt
    imgEl.src = tmp.src;
    imgEl.style.opacity = "1";
    sk?.remove();

    if (prov) {
      prov.textContent = providerLabel || "";
      prov.classList.toggle("hidden", !providerLabel);
    }
  };

  tmp.onerror = () => {
    sk?.remove();
    // fallback i SAMMA slot (inte ett nytt kort)
    const fb = document.createElement("div");
    fb.className = "img-fallback";
    fb.innerHTML = `
      <p>Misslyckades att ladda bilden.</p>
      <button class="retry" data-page="${page}">Försök igen</button>
    `;
    // enkel retry: trigga din befintliga regenerateOne om inte cover
    const btn = fb.querySelector(".retry");
    if (btn && page) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        fb.remove();
        const sk2 = document.createElement("div");
        sk2.className = "skeleton";
        wrap.prepend(sk2);
        if (page === 0) {
          generateCoverAsync().catch(() => {});
        } else {
          regenerateOne(page);
        }
      });
    }
    wrap.appendChild(fb);
  };

  tmp.src = imgUrl;
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
// in script.js (your onCreatePdf)
async function onCreatePdf() {
  try {
    if (!state.story) throw new Error("Ingen story i minnet.");

    const images = [];
    if (state.cover_image_id) images.push({ kind: "cover", image_id: state.cover_image_id });
    else if (state.cover_preview_url) images.push({ kind: "cover", data_url: state.cover_preview_url });
    const pages = state.story?.book?.pages || [];
    for (const p of pages) {
      const row = state.images_by_page.get(p.page);
      if (!row) continue;
      images.push(row.image_id ? { page: p.page, image_id: row.image_id }
        : row.data_url ? { page: p.page, data_url: row.data_url }
        : row.image_url ? { page: p.page, url: row.image_url } : null);
    }

    setStatus("📕 Bygger PDF…", 100);
    const res = await fetch(`${API}/api/pdf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        story: state.story,
        images,
        mode: "preview",
        trim: "square210",
        watermark_text: "FÖRHANDSVISNING",
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(()=>"");
      console.error("PDF backend error:", body);
      throw new Error(`PDF misslyckades (HTTP ${res.status})\n${body}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setStatus(null);
  } catch (e) {
    console.error(e);
    setStatus(null);
    alert(e?.message || "Kunde inte skapa PDF.");
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
  state.images_by_page.clear();
  state.cover_preview_url = null;
  state.cover_image_id = null;

  els.previewGrid.innerHTML = "";
  setStatus(null);
  stopQuips();

  // validera
  readForm();
  const problems = [];
  if (!state.form.name) problems.push("Ange ett namn.");
  if (state.form.age < MIN_AGE || state.form.age > MAX_AGE) problems.push("Hjältens ålder verkar orimlig.");
  if (state.form.reading_age < 3 || state.form.reading_age > 12) problems.push("Läsålder bör vara 3–12 (eller välj Familj).");
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
      }),
    });
    const storyData = await storyRes.json().catch(() => ({}));
    if (!storyRes.ok || storyData?.error) throw new Error(storyData?.error || `HTTP ${storyRes.status}`);
    state.story = storyData.story;
    state.plan = storyData.plan || { plan: [] };

    const pages = state.story?.book?.pages || [];
    if (!pages.length) throw new Error("Berättelsen saknar sidor.");
    buildCards(pages, state.visibleCount);
    setStatus("🖼️ Låser hjälten (referens)…", 22);

    // 2) REF IMAGE
    const refRes = await fetch(`${API}/api/ref-image`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        style: state.form.style,
        photo_b64: state.form.refMode === "photo" ? state.form.photoDataUrl : null,
        bible: state.story?.book?.bible || null,
        traits: state.form.traits || "",
      }),
    });
    const refData = await refRes.json().catch(() => ({}));
    if (!refRes.ok || refData?.error) throw new Error(refData?.error || `HTTP ${refRes.status}`);
    state.ref_b64 = refData.ref_image_b64 || null;
    if (!state.ref_b64) throw new Error("Ingen referensbild kunde skapas.");

    // 3) INTERIOR IMAGES — SEKVENSIELLT (sida för sida, med föregående bild som stil-ankare)
setStatus("🎥 Lägger kameror & ljus…", 38);

let received = 0;
let prevBareB64 = null; // för nästa sida

for (const pg of pages) {
  // visa skeleton om tom
  const wrap = els.previewGrid.querySelector(`.imgwrap[data-page="${pg.page}"]`);
  if (wrap && !wrap.querySelector("img")?.src) {
    const sk = wrap.querySelector(".skeleton") || document.createElement("div");
    sk.className = "skeleton";
    if (!wrap.querySelector(".skeleton")) wrap.prepend(sk);
  }

  try {
    const res = await fetch(`${API}/api/images/next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        style: state.form.style,
        story: state.story,
        plan: state.plan,
        page: pg.page,
        ref_image_b64: state.ref_b64,
        prev_b64: prevBareB64, // ← nyckeln som ger koherens
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.error || !j?.image_url) throw new Error(j?.error || `HTTP ${res.status}`);

    // visa direkt
    fillCard(pg.page, j.image_url, "Gemini");
    state.images_by_page.set(pg.page, { image_url: j.image_url });

    // för nästa sida: gör om till bare b64
    const du = await urlToDataURL(j.image_url);
    const bare = dataUrlToBareB64(du);
    prevBareB64 = bare || null;

    // ladda upp till CF direkt (ersätter batch senare)
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
      wrap.querySelector(".skeleton")?.remove();
      const fb = document.createElement("div");
      fb.className = "img-fallback";
      fb.textContent = "Kunde inte generera bild";
      wrap.appendChild(fb);
      wrap.parentElement.querySelector(".retry-wrap")?.classList.remove("hidden");
    }
  }

  received++;
  setStatus(`🎨 Målar sida ${received}/${pages.length}…`, 38 + (received / Math.max(1, pages.length)) * 32);
}


   // 4) COVER (icke-blockerande eller hoppa över)
if (COVER_STRATEGY === "async") {
  // Fire-and-forget – UI visar omslag när/om det hinner
  generateCoverAsync().catch(() => {});
  setStatus("☁️ Laddar upp illustrationer…", 86);
} else if (COVER_STRATEGY === "sync") {
  // Vill du blocka tills omslaget är klart:
  setStatus("🎨 Skapar omslag…", 84);
  await generateCoverAsync();
  setStatus("☁️ Laddar upp illustrationer…", 86);
} else {
  // "skip": låt workern använda sida 1 som omslag
  setStatus("☁️ Laddar upp illustrationer…", 86);
}

// 5) CLOUDFLARE IMAGES (alla sidor; omslaget läggs till separat)
const items = [];
for (const p of pages) {
  const row = state.images_by_page.get(p.page);
  if (!row) continue;
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

// 5.5) Catch-up: om omslaget redan kom men inte hunnit till CF → ladda upp nu
if (state.cover_preview_url && !state.cover_image_id) {
  const duCover = await urlToDataURL(state.cover_preview_url);
  if (duCover) {
    const ups = await uploadToCF([{ kind: "cover", data_url: duCover }]).catch(() => []);
    const uc = ups?.find(x => x.kind === "cover" || x.page === 0);
    if (uc?.image_id) {
      state.cover_image_id = uc.image_id;
      state.cover_preview_url = uc.url || state.cover_preview_url;
      await fillCard(0, state.cover_preview_url, "CF");
    }
  }
}


    stopQuips();
    URL.revokeObjectURL(state.previewUrl || "");
state.previewUrl = null;

    setStatus("✅ Klart! Förhandsvisning redo.", 100);
    els.pdfBtn && (els.pdfBtn.disabled = false);
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


/* --------------------------- Single regenerate --------------------------- */
async function regenerateOne(page) {
  if (!state.ref_b64) return;
  const pg = state.story?.book?.pages?.find((p) => p.page === page);
  const frame = state.plan?.plan?.find((f) => f.page === page);

  const wrap = els.previewGrid.querySelector(`.imgwrap[data-page="${page}"]`);
  if (!wrap) return;
  wrap.querySelector(".img-fallback")?.remove();
  const sk = document.createElement("div");
  sk.className = "skeleton";
  wrap.prepend(sk);

  try {
    const res = await fetch(`${API}/api/image/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        style: state.form.style,
        ref_image_b64: state.ref_b64,
        page_text: pg?.text || "",
        scene_text: (pg?.scene || "").replace(/“.+?”|".+?"/g, "").trim(),
        frame,
        story: state.story,
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.error) throw new Error(j?.error || `HTTP ${res.status}`);

    sk.remove();
    await fillCard(page, j.image_url, "Gemini");
    // uppdatera state
    state.images_by_page.set(page, { image_url: j.image_url });
  } catch (e) {
    sk.remove();
    const fb = document.createElement("div");
    fb.className = "img-fallback";
    fb.innerHTML = `Kunde inte generera bild
      <div class="retry-wrap" style="margin-top:8px;">
        <button class="retry-btn retry" data-page="${page}">🔄 Generera igen</button>
      </div>`;
    wrap.appendChild(fb);
  }
}

async function generateCoverAsync() {
  try {
    const timeoutMs = 25000;
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("cover-timeout")), timeoutMs));

    const covRes = await Promise.race([
      fetch(`${API}/api/cover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          style: state.form.style,
          character_ref_b64: state.ref_b64,   // ← FIX: correct key for backend
          story: state.story,
        }),
      }),
      timeout,
    ]);

    if (!(covRes instanceof Response)) return; // timed out silently
    const cov = await covRes.json().catch(() => ({}));
    if (!covRes.ok || cov?.error) {
      console.warn("cover generation failed", cov?.error);
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


/* --------------------------- Events & Init --------------------------- */
function bindEvents() {
  els.catKidsBtn?.addEventListener("click", () => setCategory("kids"));
  els.catPetsBtn?.addEventListener("click", () => setCategory("pets"));
  els.refDescBtn?.addEventListener("click", () => setRefMode("desc"));
  els.refPhotoBtn?.addEventListener("click", () => setRefMode("photo"));

  readingAgeSeg.forEach((btn) => {
    btn.addEventListener("click", () => {
      readingAgeSeg.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setReadingAgeByChip(btn.getAttribute("data-readage"));
    });
  });

  ["name", "age", "style", "theme", "traits", "readingAge"].forEach(
    (id) => {
      const el = document.getElementById(id);
      el?.addEventListener("input", () => {
        readForm();
        saveForm();
      });
    }
  );

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

  els.form?.addEventListener("submit", onSubmit);

  els.previewGrid?.addEventListener("click", (e) => {
    const t = e.target;
    if (t && t.classList.contains("retry-btn")) {
      e.preventDefault();
      const page = Number(t.getAttribute("data-page"));
      if (page) regenerateOne(page);
    }
  });

  els.navToggle?.addEventListener("click", () => {
    els.mobileMenu.classList.toggle("open");
    const open = els.mobileMenu.classList.contains("open");
    els.navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    els.mobileMenu.setAttribute("aria-hidden", open ? "false" : "true");
  });

  els.pdfBtn?.addEventListener("click", onCreatePdf);
  if (els.pdfBtn) els.pdfBtn.disabled = false;
}

(function init() {
  loadForm();
  if (state.form.refMode !== "photo" && state.form.refMode !== "desc")
    state.form.refMode = "photo";
  writeForm();
  bindEvents();
  setStatus(null);
})();
