/* =================== Konfiguration =================== */
// Tillåt override via ?backend=
const BACKEND = new URLSearchParams(location.search).get("backend")
  || "https://bokpilot-backend.sebastian-runell.workers.dev";

const STORAGE_KEY = "bokpiloten_form_v6";
const MAX_AGE = 120;
const MIN_AGE = 1;
const VALID_PAGES = new Set([12, 16, 20]);
const MAX_REF_DIM = 1024;

/* =================== Elementrefs =================== */
const els = {
  body: document.body,
  form: document.getElementById("storyForm"),
  catKidsBtn: document.getElementById("catKidsBtn"),
  catPetsBtn: document.getElementById("catPetsBtn"),
  name: document.getElementById("name"),
  age: document.getElementById("age"),
  pages: document.getElementById("pages"),
  style: document.getElementById("style"),
  theme: document.getElementById("theme"),
  traits: document.getElementById("traits"),
  charPhoto: document.getElementById("charPhoto"),
  photoPreview: document.getElementById("photoPreview"),
  refDescBtn: document.getElementById("refDescBtn"),
  refPhotoBtn: document.getElementById("refPhotoBtn"),
  traitsBlock: document.getElementById("traitsBlock"),
  photoBlock: document.getElementById("photoBlock"),
  previewSection: document.getElementById("preview"),
  previewGrid: document.getElementById("bookPreview"),
  submitBtn: document.querySelector("#storyForm .btn-primary"),
  demoBtn: document.getElementById("demoBtn"),
  navToggle: document.getElementById("navToggle"),
  mobileMenu: document.getElementById("mobileMenu"),
  readingAgeNumber: document.getElementById("readingAge"),
  pdfBtn: document.getElementById("pdfBtn"),
  printMode: document.getElementById("printMode"), // <input type="checkbox" id="printMode">
};

/* Läsålder segmented knappar */
const readingAgeSeg = Array.from(document.querySelectorAll('[data-readage]'));

/* =================== State =================== */
const state = {
  form: {
    category: "kids",
    name: "Nova",
    age: 6,              // hjälte
    reading_age: 6,      // läsålder
    pages: 16,
    style: "cartoon",
    theme: "",
    refMode: "photo",
    traits: "",
    photoDataUrl: null,
  },
  visibleCount: 4,
  story: null,
  plan: null,
  refB64: null,
  pageMap: new Map(),
  planMap: new Map(),

  // PDF
  generatedImages: [],      // [{page, image_url}]
  uploadedToCF: [],         // [{page, image_id, url}]
};

/* =================== Helpers =================== */
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toInt = (v, fb=0)=> { const n = parseInt(v,10); return Number.isFinite(n) ? n : fb; };
const escapeHtml = (s)=> String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
const smoothScrollTo = (el)=> el?.scrollIntoView({ behavior: "smooth", block: "start" });

/* ========= Statusbar ========= */
const STATUS_QUIPS = [
  "puffar kuddar…","polerar morrhår…","tänder nattlampan…",
  "drar undan tunga skuggor…","räknar stjärnor…","lägger mjukare bokeh…",
  "sorterar leksaker…","justerar rim light…"
];
let quipTimer = null;

function ensureStatusBar(){
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
function setStatus(msg){
  const bar = ensureStatusBar();
  bar.textContent = msg || "";
  if (!msg) bar.classList.add("hidden");
}
function startQuips(){
  stopQuips();
  const bar = ensureStatusBar();
  bar.querySelector(".status-quips")?.remove();
  const aside = document.createElement("span");
  aside.className = "status-quips";
  aside.style.marginLeft = "8px";
  bar.appendChild(aside);
  let i = 0;
  quipTimer = setInterval(()=>{ aside.textContent = STATUS_QUIPS[i % STATUS_QUIPS.length]; i++; }, 1800);
}
function stopQuips(){
  if (quipTimer) clearInterval(quipTimer);
  quipTimer = null;
  document.querySelector(".status-quips")?.remove();
}
function updateProgress(current, total, label){
  const bar = ensureStatusBar();
  let prog = bar.querySelector(".progress");
  if (!prog) {
    prog = document.createElement("div");
    prog.className = "progress";
    prog.innerHTML = '<div class="progress-track"><div class="progress-fill" style="width:0%"></div></div><span class="progress-label"></span>';
    bar.appendChild(prog);
  }
  const pct = total ? Math.round((current/total)*100) : 0;
  prog.querySelector(".progress-fill").style.width = pct + "%";
  prog.querySelector(".progress-label").textContent = label || "";
}

/* ========= LocalStorage ========= */
function saveForm(){ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.form)); }catch{} }
function loadForm(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw)||{};
    Object.assign(state.form, saved);
  }catch{}
}

/* ========= UI toggles ========= */
function setCategory(cat, save=true){
  const val = cat === "pets" ? "pets" : "kids";
  state.form.category = val;
  document.body.dataset.theme = val;
  els.catKidsBtn?.classList.toggle("active", val==="kids");
  els.catPetsBtn?.classList.toggle("active", val==="pets");
  if (save) saveForm();
}
function setRefMode(mode, focus=true){
  const m = mode === "photo" ? "photo" : "desc";
  state.form.refMode = m;
  els.refDescBtn?.classList.toggle("active", m==="desc");
  els.refPhotoBtn?.classList.toggle("active", m==="photo");
  els.traitsBlock?.classList.toggle("hidden", m!=="desc");
  els.photoBlock?.classList.toggle("hidden", m!=="photo");
  if (focus) (m==="desc" ? els.traits : els.charPhoto)?.focus();
  saveForm();
}

/* ========= Läsålder segmented ========= */
function setReadingAgeByChip(range){
  const map = { "4-5": 5, "6-8": 7, "9-12": 10, "familj": 8 };
  const val = map[range] || 6;
  state.form.reading_age = val;
  if (els.readingAgeNumber) els.readingAgeNumber.value = val;
  readingAgeSeg.forEach(btn=>{
    btn.classList.toggle("active", btn.getAttribute("data-readage")===range);
  });
  saveForm();
}

/* ========= Form read/write ========= */
function readForm(){
  const f = state.form;
  f.name = (els.name?.value || "Nova").trim();
  f.age = clamp(toInt(els.age?.value,6), MIN_AGE, MAX_AGE);
  f.pages = VALID_PAGES.has(toInt(els.pages?.value)) ? toInt(els.pages.value) : 16;
  f.style = els.style?.value || "cartoon";
  f.theme = (els.theme?.value || "").trim();
  f.traits = (els.traits?.value || "").trim();
  f.reading_age = clamp(toInt(els.readingAgeNumber?.value ?? f.reading_age, f.reading_age), 3, 12);
}
function writeForm(){
  if (els.name) els.name.value = state.form.name;
  if (els.age) els.age.value = state.form.age;
  if (els.pages) els.pages.value = state.form.pages;
  if (els.style) els.style.value = state.form.style;
  if (els.theme) els.theme.value = state.form.theme;
  if (els.traits) els.traits.value = state.form.traits;
  if (els.readingAgeNumber) els.readingAgeNumber.value = state.form.reading_age;
  const target = state.form.reading_age<=5 ? "4-5" : state.form.reading_age<=8 ? "6-8" : state.form.reading_age<=12 ? "9-12" : "familj";
  setReadingAgeByChip(target);
  setCategory(state.form.category, false);
  setRefMode(state.form.refMode, false);
  if (state.form.photoDataUrl && els.photoPreview) {
    els.photoPreview.src = state.form.photoDataUrl;
    els.photoPreview.classList.remove("hidden");
  }
}

/* ========= Downscale (med enkel rotationsfix) ========= */
async function downscaleFileToDataURL(file, maxDim = MAX_REF_DIM) {
  const img = await new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=> { const im = new Image(); im.onload = ()=> resolve(im); im.onerror = reject; im.src = r.result; };
    r.onerror = reject; r.readAsDataURL(file);
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  const long = Math.max(w, h);
  const scale = Math.min(1, maxDim / long);
  let cw = Math.round(w*scale), ch = Math.round(h*scale);

  const c = document.createElement("canvas");
  const ctx = c.getContext("2d");
  // enkel heuristik: vänd “stående” om EXIF saknas men foto verkar felvänt
  if (w < h && h > w*1.2) {
    c.width = ch; c.height = cw;
    ctx.translate(c.width, 0); ctx.rotate(Math.PI/2);
    ctx.drawImage(img, 0, 0, cw, ch);
  } else {
    c.width = cw; c.height = ch;
    ctx.drawImage(img, 0, 0, cw, ch);
  }
  return c.toDataURL("image/png", 0.92);
}

/* ========= Foto-preview ========= */
async function onPhotoChange(){
  const f = els.charPhoto?.files?.[0];
  if (!f) {
    state.form.photoDataUrl = null;
    els.photoPreview?.classList.add("hidden");
    if (els.photoPreview) els.photoPreview.src = "";
    saveForm(); return;
  }
  const dataUrl = await downscaleFileToDataURL(f, MAX_REF_DIM);
  state.form.photoDataUrl = dataUrl;
  if (els.photoPreview) {
    els.photoPreview.src = dataUrl;
    els.photoPreview.classList.remove("hidden");
  }
  saveForm();
}

/* ========= Skeleton ========= */
function renderSkeleton(count=4){
  if (!els.previewGrid) return;
  els.previewGrid.innerHTML = "";
  for (let i=0;i<count;i++){
    const el = document.createElement("article");
    el.className = "thumb";
    el.innerHTML = `
      <div class="imgwrap"><div class="skeleton"></div></div>
      <div class="txt">
        <span class="skeleton" style="display:block;height:12px;margin-bottom:8px"></span>
        <span class="skeleton" style="display:block;height:12px;width:60%"></span>
      </div>`;
    els.previewGrid.appendChild(el);
  }
  els.previewSection?.classList.remove("hidden");
}

/* ========= Validering ========= */
function validateForm(){
  readForm();
  const problems = [];
  if (!state.form.name) problems.push("Ange ett namn.");
  if (state.form.age < MIN_AGE || state.form.age > MAX_AGE) problems.push("Hjältens ålder verkar orimlig.");
  if (!VALID_PAGES.has(state.form.pages)) problems.push("Ogiltigt sidantal.");
  if (state.form.reading_age < 3 || state.form.reading_age > 12) problems.push("Läsålder bör vara 3–12 (eller välj Familj).");
  if (state.form.refMode === "desc") {
    if (!state.form.traits || state.form.traits.length < 6) problems.push("Beskriv gärna kännetecken – eller ladda upp foto för bäst resultat.");
  } else if (state.form.refMode === "photo") {
    if (!state.form.photoDataUrl) problems.push("Ladda upp ett foto – eller byt till Beskrivning.");
  }
  return problems;
}

/* ========= Cards ========= */
function buildCards(pages, visibleCount){
  if (!els.previewGrid) return;
  els.previewGrid.innerHTML = "";
  state.pageMap.clear();
  pages.forEach((pg,i)=>{
    state.pageMap.set(pg.page, pg);
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
  els.previewSection?.classList.remove("hidden");
  smoothScrollTo(els.previewSection);
}

/* ========= URL → DataURL ========= */
async function urlToDataURL(url) {
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`Hämtning misslyckades (${res.status})`);
  const blob = await res.blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

/* ========= Skörda från DOM om state saknar bilder ========= */
function harvestFromDOMIfNeeded() {
  if (state.generatedImages && state.generatedImages.length) return;
  if (!els.previewGrid) return;
  const cards = Array.from(els.previewGrid.querySelectorAll(".imgwrap"));
  const harvested = [];
  for (const wrap of cards) {
    const page = Number(wrap.getAttribute("data-page"));
    const img = wrap.querySelector("img");
    const src = img?.currentSrc || img?.src || "";
    if (page && src) harvested.push({ page, image_url: src });
  }
  if (harvested.length) {
    const byPage = new Map();
    harvested.forEach(x => { if (!byPage.has(x.page)) byPage.set(x.page, x); });
    state.generatedImages = Array.from(byPage.values());
    console.debug("🔎 Skördade bilder från DOM:", state.generatedImages);
  }
}

/* ========= Uppladdning till CF Images ========= */
async function ensureUploads() {
  harvestFromDOMIfNeeded();
  if (!state.generatedImages.length) throw new Error("Inga genererade bilder hittades i minnet eller DOM.");

  // de vi redan har
  const have = new Set(state.uploadedToCF.map(r => r.page));
  const missing = [];

  for (const row of state.generatedImages) {
    if (!row?.page || !row?.image_url || have.has(row.page)) continue;
    const src = row.image_url;
    if (src.startsWith("data:image/")) {
      missing.push({ page: row.page, data_url: src });
    } else if (/^https?:\/\//i.test(src)) {
      try { missing.push({ page: row.page, data_url: await urlToDataURL(src) }); }
      catch (e) { console.warn(`⚠️ Kunde inte hämta URL för sida ${row.page}:`, e); }
    } else if (src.startsWith("blob:")) {
      try {
        const wrap = els.previewGrid?.querySelector(`.imgwrap[data-page="${row.page}"]`);
        const imgEl = wrap?.querySelector("img");
        if (imgEl && imgEl.naturalWidth > 0) {
          const c = document.createElement("canvas");
          c.width = imgEl.naturalWidth; c.height = imgEl.naturalHeight;
          c.getContext("2d").drawImage(imgEl, 0, 0);
          const d = c.toDataURL("image/png");
          if (d?.startsWith("data:image/")) missing.push({ page: row.page, data_url: d });
        }
      } catch (e) { console.warn(`⚠️ Kunde inte konvertera blob: för sida ${row.page}`, e); }
    }
  }

  if (!missing.length) { console.debug("☁️ Alla sidor redan uppladdade:", state.uploadedToCF); return; }

  setStatus("☁️ Laddar upp illustrationer…");
  updateProgress(0, 1, `Laddar upp ${missing.length} sidor`);

  const BATCH = 6;
  for (let i = 0; i < missing.length; i += BATCH) {
    const payload = missing.slice(i, i + BATCH).filter(x => x?.data_url?.startsWith("data:image/"));
    if (!payload.length) continue;

    const upRes = await fetch(`${BACKEND}/api/images/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: payload })
    });
    const upData = await upRes.json().catch(()=> ({}));
    if (!upRes.ok || upData?.error) throw new Error(upData?.error || `Upload HTTP ${upRes.status}`);

    const rows = upData.uploads || [];
    for (const r of rows) {
      if (r.image_id) state.uploadedToCF.push(r);
      else if (r.error) throw new Error(`Uppladdning misslyckades (sida ${r.page}): ${r.error}`);
    }
    updateProgress(Math.min(i + payload.length, missing.length), missing.length, `Laddar upp ${Math.min(i + payload.length, missing.length)}/${missing.length}`);
  }

  // Dedupe (senaste vinner)
  const byPage = new Map();
  for (const r of state.uploadedToCF) if (r?.page && r?.image_id) byPage.set(r.page, r);
  state.uploadedToCF = Array.from(byPage.values());
}

/* ========= PDF ========= */
let pdfBusy = false;

async function onCreatePdf() {
  if (pdfBusy) return;
  pdfBusy = true;
  if (els.pdfBtn) els.pdfBtn.disabled = true;
  try {
    if (!state.story) throw new Error("Ingen story i minnet.");

    try { await ensureUploads(); }
    catch (e) { console.warn("⚠️ ensureUploads misslyckades, använder direkta URL:er:", e); }

    const images = (state.uploadedToCF?.length
      ? state.uploadedToCF.map(r => ({ page: r.page, image_id: r.image_id, url: r.url }))
      : (state.generatedImages || []).map(r => ({ page: r.page, url: r.image_url }))
    ).sort((a,b)=>a.page-b.page);

    if (!images.length) throw new Error("Hittade inga illustrationer att lägga i PDF:en.");

    setStatus("📕 Bygger PDF…");
    const res = await fetch(`${BACKEND}/api/pdf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        story: state.story,
        images,
        mode: els.printMode?.checked ? "print" : "preview",
        trim: "square210",
        watermark_text: "FÖRHANDSVISNING"
      }),
    });
    if (!res.ok) throw new Error(`PDF misslyckades (HTTP ${res.status})`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    setStatus(null);
  } catch (e) {
    console.error(e);
    setStatus(null);
    alert(e?.message || "Kunde inte skapa PDF.");
  } finally {
    pdfBusy = false;
    if (els.pdfBtn) els.pdfBtn.disabled = false;
  }
}

/* ========= Bildladdning med retry ========= */
async function loadImgWithRetry(src, tries=3, delay=500){
  for (let i=0;i<tries;i++){
    try {
      await new Promise((res, rej) => { const im = new Image(); im.onload = res; im.onerror = rej; im.src = src; });
      return src;
    } catch(e) { if (i===tries-1) throw e; await new Promise(r=>setTimeout(r, delay*(i+1))); }
  }
}

/* ========= Submit ========= */
async function onSubmit(e){
  e.preventDefault();
  const problems = validateForm();
  if (problems.length) { alert("Korrigera:\n\n• " + problems.join("\n• ")); return; }

  readForm();
  renderSkeleton(4);
  setStatus("✏️ Skriver berättelsen…"); updateProgress(0,3,"1/3 – Berättelsen");
  startQuips();
  if (els.submitBtn){ els.submitBtn.disabled = true; els.submitBtn.innerHTML = 'Skapar förhandsvisning… <span class="spinner"></span>'; }
  if (els.pdfBtn) els.pdfBtn.disabled = true;

  // rensa tidigare resultat
  state.generatedImages = [];
  state.uploadedToCF = [];

  try{
    // 1) STORY + PLAN
    const storyRes = await fetch(`${BACKEND}/api/story`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: state.form.name,
        age: state.form.age,
        reading_age: state.form.reading_age,
        pages: state.form.pages,
        category: state.form.category,
        style: state.form.style,
        theme: state.form.theme,
        traits: state.form.traits
      }),
    });
    const storyData = await storyRes.json().catch(()=> ({}));
    if (!storyRes.ok || storyData?.error) throw new Error(storyData?.error || `HTTP ${storyRes.status}`);

    state.story = storyData.story;
    state.plan = storyData.plan || { plan: [] };
    state.planMap = new Map((state.plan.plan || []).map(p => [p.page, p]));

    const pages = state.story?.book?.pages || [];
    if (!pages.length) throw new Error("Berättelsen saknar sidor.");
    buildCards(pages, state.visibleCount);

    // 2) REF IMAGE
    setStatus("🖼️ Låser hjälten (referens)…"); updateProgress(1,3,"2/3 – Referens");
    const refRes = await fetch(`${BACKEND}/api/ref-image`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        style: state.form.style,
        photo_b64: state.form.refMode === "photo" ? (state.form.photoDataUrl || null) : null,
        bible: state.story?.book?.bible || null,
        traits: state.form.traits || ""
      })
    });
    const refData = await refRes.json().catch(()=> ({}));
    if (!refRes.ok || refData?.error) throw new Error(refData?.error || `HTTP ${refRes.status}`);
    state.refB64 = refData.ref_image_b64 || null;
    if (!state.refB64) throw new Error("Ingen referensbild kunde hämtas/skapas.");

    // 3) IMAGES
    setStatus("🎥 Lägger kameror & ljus…"); updateProgress(2,3,"3/3 – Bildplan");
    const imgRes = await fetch(`${BACKEND}/api/images`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        style: state.form.style,
        ref_image_b64: state.refB64,
        story: state.story,
        plan: state.plan,
        concurrency: 4
      })
    });
    const imgData = await imgRes.json().catch(()=> ({}));
    if (!imgRes.ok || imgData?.error) throw new Error(imgData?.error || "Bildgenerering misslyckades");

    const results = imgData.images || [];
    // spara för PDF-steget
    state.generatedImages = results
      .filter(r => r?.image_url)
      .map(r => ({ page: r.page, image_url: r.image_url }));

    let received = 0;
    const byPageCard = new Map();
    Array.from(els.previewGrid.children).forEach(card=>{
      const p = Number(card.querySelector(".imgwrap")?.getAttribute("data-page"));
      if (p) byPageCard.set(p, card);
    });

    for (const row of results) {
      const card = byPageCard.get(row.page);
      if (!card) continue;
      const imgEl = card.querySelector("img");
      const sk = card.querySelector(".skeleton");

      if (row.image_url) {
        try {
          const okSrc = await loadImgWithRetry(row.image_url);
          imgEl.src = okSrc; sk?.remove(); imgEl.style.opacity = "1";
          const prov = card.querySelector(".img-provider");
          if (prov){ prov.textContent = "🎨 Gemini"; prov.classList.remove("hidden"); }
          card.querySelector(".retry-wrap")?.classList.add("hidden");
        } catch {
          sk?.remove();
          card.querySelector(".retry-wrap")?.classList.remove("hidden");
        }
      } else {
        sk?.remove();
        const fb = document.createElement("div");
        fb.className = "img-fallback";
        fb.innerHTML = `Kunde inte generera bild
          <div class="retry-wrap" style="margin-top:8px;">
            <button class="retry-btn retry" data-page="${row.page}">🔄 Generera igen</button>
          </div>`;
        card.querySelector(".imgwrap").appendChild(fb);
        card.querySelector(".retry-wrap")?.classList.remove("hidden");
      }

      received++;
      setStatus(`🎨 Målar sida ${received} av ${results.length} …`);
      updateProgress(received, results.length, `Illustrerar ${received}/${results.length} …`);
      await new Promise(r=> setTimeout(r, 120));
    }

    // lås upp resterande kort när allt är inne
    Array.from(els.previewGrid.children).forEach((card,i)=>{
      if (i >= state.visibleCount) card.classList.remove("locked");
    });

    stopQuips();
    setStatus("✅ Klart! Sagans förhandsvisning är redo.");
    els.pdfBtn && (els.pdfBtn.disabled = false);
  } catch (e) {
    console.error(e);
    stopQuips(); setStatus(null);
    alert("Ett fel uppstod: " + (e?.message || e));
  } finally {
    if (els.submitBtn){ els.submitBtn.disabled = false; els.submitBtn.textContent = "Skapa förhandsvisning"; }
  }
}

/* ========= Regenerera en sida ========= */
async function regenerateOne(page){
  const pageObj = state.pageMap.get(page);
  const planObj = state.planMap.get(page) || null;
  if (!pageObj || !state.refB64) return;

  const card = Array.from(els.previewGrid.children).find(a =>
    a.querySelector(`.imgwrap[data-page="${page}"]`));
  if (!card) return;

  const wrap = card.querySelector(".imgwrap");
  const imgEl = card.querySelector("img");
  wrap.querySelector(".img-fallback")?.remove();
  const sk = document.createElement("div"); sk.className = "skeleton"; wrap.prepend(sk);

  try{
    const res = await fetch(`${BACKEND}/api/image/regenerate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        style: state.form.style,
        ref_image_b64: state.refB64,
        page_text: pageObj.text,
        scene_text: (pageObj.scene || "").replace(/“.+?”|".+?"/g,"").trim(),
        frame: planObj,
        story: state.story
      })
    });
    const j = await res.json().catch(()=> ({}));
    if (!res.ok || j?.error) throw new Error(j?.error || `HTTP ${res.status}`);

    const okSrc = await loadImgWithRetry(j.image_url);
    imgEl.src = okSrc; imgEl.style.opacity = "1"; sk.remove();
    const prov = card.querySelector(".img-provider");
    if (prov){ prov.textContent = "🎨 Gemini"; prov.classList.remove("hidden"); }
    card.querySelector(".retry-wrap")?.classList.add("hidden");

    // uppdatera state för PDF
    const idx = state.generatedImages.findIndex(x => x.page === page);
    if (idx >= 0) state.generatedImages[idx].image_url = okSrc;
    else state.generatedImages.push({ page, image_url: okSrc });
    // ta bort ev tidigare upload för sidan
    state.uploadedToCF = state.uploadedToCF.filter(x => x.page !== page);

  } catch {
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

/* ========= Demo ========= */
function onDemo(){
  const total = 12;
  els.previewGrid.innerHTML = "";
  for (let i=0;i<total;i++){
    const card = document.createElement("article");
    card.className = "thumb";
    if (i >= state.visibleCount) card.classList.add("locked");
    card.innerHTML = `
      <div class="imgwrap" data-page="${i+1}">
        <img src="https://picsum.photos/seed/demo_${i}/600/600" />
      </div>
      <div class="txt">Sida ${i+1}: ${escapeHtml(state.form.name)}s lilla äventyr.</div>`;
    els.previewGrid.appendChild(card);
  }
  state.generatedImages = Array.from({length: total}, (_,k)=>({
    page: k+1,
    image_url: els.previewGrid.querySelector(`.imgwrap[data-page="${k+1}"] img`)?.src || ""
  }));
  els.previewSection.classList.remove("hidden");
  smoothScrollTo(els.previewSection);
  if (els.pdfBtn) els.pdfBtn.disabled = false;
}

/* ========= Events ========= */
function bindEvents(){
  els.catKidsBtn?.addEventListener("click", ()=> setCategory("kids"));
  els.catPetsBtn?.addEventListener("click", ()=> setCategory("pets"));
  els.refDescBtn?.addEventListener("click", ()=> setRefMode("desc"));
  els.refPhotoBtn?.addEventListener("click", ()=> setRefMode("photo"));
  els.charPhoto?.addEventListener("change", onPhotoChange);

  readingAgeSeg.forEach(btn=>{
    btn.addEventListener("click", ()=>{
      readingAgeSeg.forEach(b=> b.classList.remove("active"));
      btn.classList.add("active");
      setReadingAgeByChip(btn.getAttribute("data-readage"));
    });
  });

  ["name","age","pages","style","theme","traits","readingAge","readingAgeNumber"].forEach(id=>{
    const el = document.getElementById(id);
    el?.addEventListener("input", ()=> { readForm(); saveForm(); });
  });

  els.form?.addEventListener("submit", onSubmit);
  els.demoBtn?.addEventListener("click", onDemo);

  els.previewGrid?.addEventListener("click", (e)=>{
    const t = e.target;
    if (t && t.classList.contains("retry-btn")) {
      e.preventDefault();
      const page = Number(t.getAttribute("data-page"));
      if (page) regenerateOne(page);
    }
  });

  els.navToggle?.addEventListener("click", ()=>{
    els.mobileMenu?.classList.toggle("open");
    const open = els.mobileMenu?.classList.contains("open");
    els.navToggle?.setAttribute("aria-expanded", open ? "true":"false");
    els.mobileMenu?.setAttribute("aria-hidden", open ? "false":"true");
  });

  els.pdfBtn?.addEventListener("click", onCreatePdf);
  if (els.pdfBtn) els.pdfBtn.disabled = true;  // aktiveras när preview är klar
}

/* ========= Init ========= */
(function init(){
  loadForm();
  if (state.form.refMode !== "photo" && state.form.refMode !== "desc") state.form.refMode = "photo";
  writeForm(); bindEvents(); setStatus(null);
})();
