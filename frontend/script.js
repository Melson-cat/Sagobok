/* ============================================================================
   BokPiloten – Frontend v14 (worker-kompatibel)
   - Steg: STORY -> REF -> COVER -> IMAGES -> (valfr) UPLOAD -> PDF
   - Visar 4 första sidor skarpt i griden (som tidigare)
   - Omslag renderas i egen ruta över förhandsvisningen (valfritt)
   ========================================================================== */

/* =================== Konfiguration =================== */
const BACKEND = "https://bokpilot-backend.sebastian-runell.workers.dev";
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
};

/* Läsålder segmented knappar */
const readingAgeSeg = Array.from(document.querySelectorAll('[data-readage]'));

/* =================== State =================== */
const state = {
  form: {
    category: "kids",
    name: "Nova",
    age: 6,                 // hjälte
    reading_age: 6,         // läsnivå
    pages: 16,
    style: "cartoon",
    theme: "",
    refMode: "photo",
    traits: "",
    photoDataUrl: null,
  },

  visibleCount: 4,

  // worker-data
  story: null,
  plan: null,
  refB64: null,

  // UI-index
  pageMap: new Map(),
  planMap: new Map(),

  // bilder
  cover: null,                 // { image_url } eller { image_id, url }
  generatedImages: [],         // [{page, image_url}]
  uploadedToCF: [],            // [{page|0, kind?, image_id, url}]

  pdfReady: false,
};

/* =================== Helpers =================== */
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function toInt(v, fb=0){ const n = parseInt(v,10); return Number.isFinite(n) ? n : fb; }
function escapeHtml(s){ return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;"); }
function smoothScrollTo(el){ el?.scrollIntoView({ behavior: "smooth", block: "start" }); }

/* ===== Levande status ===== */
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
  const q = document.querySelector(".status-quips"); if (q) q.remove();
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

/* LocalStorage */
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
  els.refDescBtn.classList.toggle("active", m==="desc");
  els.refPhotoBtn.classList.toggle("active", m==="photo");
  els.traitsBlock.classList.toggle("hidden", m!=="desc");
  els.photoBlock.classList.toggle("hidden", m!=="photo");
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
  f.name = (els.name.value || "Nova").trim();
  f.age = clamp(toInt(els.age.value,6), MIN_AGE, MAX_AGE);
  f.pages = VALID_PAGES.has(toInt(els.pages.value)) ? toInt(els.pages.value) : 16;
  f.style = els.style.value || "cartoon";
  f.theme = (els.theme.value || "").trim();
  f.traits = (els.traits.value || "").trim();
  f.reading_age = clamp(toInt(els.readingAgeNumber?.value ?? f.reading_age, f.reading_age), 3, 12);
}
function writeForm(){
  els.name.value = state.form.name;
  els.age.value = state.form.age;
  els.pages.value = state.form.pages;
  els.style.value = state.form.style;
  els.theme.value = state.form.theme;
  els.traits.value = state.form.traits;
  if (els.readingAgeNumber) els.readingAgeNumber.value = state.form.reading_age;
  const target = state.form.reading_age<=5 ? "4-5" : state.form.reading_age<=8 ? "6-8" : state.form.reading_age<=12 ? "9-12" : "familj";
  setReadingAgeByChip(target);
  setCategory(state.form.category, false);
  setRefMode(state.form.refMode, false);
  if (state.form.photoDataUrl) {
    els.photoPreview.src = state.form.photoDataUrl;
    els.photoPreview.classList.remove("hidden");
  }
}

/* ========= Downscale ========= */
async function downscaleFileToDataURL(file, maxDim = MAX_REF_DIM) {
  const img = await new Promise((resolve,reject)=>{
    const r = new FileReader();
    r.onload = ()=> { const im = new Image(); im.onload = ()=> resolve(im); im.onerror = reject; im.src = r.result; };
    r.onerror = reject; r.readAsDataURL(file);
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(w,h));
  if (scale >= 1) return img.src;
  const c = document.createElement("canvas");
  c.width = Math.round(w*scale); c.height = Math.round(h*scale);
  const ctx = c.getContext("2d"); ctx.drawImage(img,0,0,c.width,c.height);
  return c.toDataURL("image/png", 0.92);
}

/* ========= Foto-preview ========= */
async function onPhotoChange(){
  const f = els.charPhoto.files?.[0];
  if (!f) {
    state.form.photoDataUrl = null;
    els.photoPreview.classList.add("hidden");
    els.photoPreview.src = "";
    saveForm(); return;
  }
  const dataUrl = await downscaleFileToDataURL(f, MAX_REF_DIM);
  state.form.photoDataUrl = dataUrl;
  els.photoPreview.src = dataUrl;
  els.photoPreview.classList.remove("hidden");
  saveForm();
}

/* ========= Skeleton ========= */
function renderSkeleton(count=4){
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
  els.previewSection.classList.remove("hidden");
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

/* ========= Kort ========= */
function buildCards(pages, visibleCount){
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
  els.previewSection.classList.remove("hidden");
  smoothScrollTo(els.previewSection);
}

/* ========= Cover-preview ========= */
function showCoverPreview() {
  const id = "coverPreview";
  let cont = document.getElementById(id);
  if (!state.cover?.image_url) { cont?.remove(); return; }
  if (!cont) {
    cont = document.createElement("section");
    cont.id = id;
    cont.className = "panel";
    const h = document.createElement("h3");
    h.textContent = "Omslag";
    cont.appendChild(h);
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    wrap.innerHTML = `<div class="imgwrap"><img alt="Omslag" /></div>`;
    cont.appendChild(wrap);
    els.previewSection.parentNode.insertBefore(cont, els.previewSection);
  }
  cont.querySelector("img").src = state.cover.image_url;
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

/* ========= Skörda från DOM som fallback ========= */
function harvestFromDOMIfNeeded() {
  if (state.generatedImages && state.generatedImages.length) return;
  const cards = Array.from(els.previewGrid.querySelectorAll(".imgwrap"));
  const harvested = [];
  for (const wrap of cards) {
    const page = Number(wrap.getAttribute("data-page"));
    const img = wrap.querySelector("img");
    const src = img?.src || "";
    if (page && src) harvested.push({ page, image_url: src });
  }
  if (harvested.length) {
    const byPage = new Map();
    harvested.forEach(x => { if (!byPage.has(x.page)) byPage.set(x.page, x); });
    state.generatedImages = Array.from(byPage.values());
    console.debug("🔎 Skördade bilder från DOM:", state.generatedImages);
  }
}

/* ========= Säkerställ CF-uppladdningar (inkl. cover) ========= */
async function ensureUploads() {
  harvestFromDOMIfNeeded();

  if (!state.generatedImages.length && !state.cover?.image_url) {
    throw new Error("Inga genererade bilder (eller omslag) hittades.");
  }

  const have = new Set(
    state.uploadedToCF.map(r => (r.kind === "cover" ? "cover" : `p${r.page}`))
  );

  const missing = [];

  // 1) Omslag
  if (state.cover?.image_url && !have.has("cover")) {
    let d = null;
    if (state.cover.image_url.startsWith("data:image/")) d = state.cover.image_url;
    else d = await urlToDataURL(state.cover.image_url).catch(()=> null);
    if (d) missing.push({ kind: "cover", data_url: d });
  }

  // 2) Sidor
  for (const row of state.generatedImages) {
    if (!row?.page || !row?.image_url) continue;
    if (have.has(`p${row.page}`)) continue;

    const src = row.image_url;
    let d = null;
    if (src.startsWith("data:image/")) d = src;
    else if (/^https?:\/\//i.test(src)) d = await urlToDataURL(src).catch(()=> null);
    else if (src.startsWith("blob:")) {
      const wrap = els.previewGrid.querySelector(`.imgwrap[data-page="${row.page}"] img`);
      if (wrap && wrap.naturalWidth > 0) {
        const c = document.createElement("canvas");
        c.width = wrap.naturalWidth; c.height = wrap.naturalHeight;
        c.getContext("2d").drawImage(wrap, 0, 0);
        d = c.toDataURL("image/png");
      }
    }
    if (d) missing.push({ page: row.page, data_url: d });
  }

  if (!missing.length) {
    console.debug("☁️ Alla sidor/omslag verkar redan uppladdade:", state.uploadedToCF);
    return;
  }

  setStatus("☁️ Laddar upp illustrationer…");
  updateProgress(0, 1, `Laddar upp ${missing.length} bild(er)`);

  const BATCH = 6;
  for (let i = 0; i < missing.length; i += BATCH) {
    const slice = missing.slice(i, i + BATCH).filter(x => x?.data_url?.startsWith("data:image/"));
    if (!slice.length) continue;

    const upRes = await fetch(`${BACKEND}/api/images/upload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: slice })
    });

    const upData = await upRes.json().catch(()=> ({}));
    if (!upRes.ok || upData?.error) throw new Error(upData?.error || `Upload HTTP ${upRes.status}`);

    for (const r of (upData.uploads || [])) {
      if (r.image_id) state.uploadedToCF.push(r);
      else if (r.error) throw new Error(`Uppladdning misslyckades (${r.page ?? r.kind}): ${r.error}`);
    }

    updateProgress(Math.min(i + slice.length, missing.length), missing.length, `Laddar upp ${Math.min(i + slice.length, missing.length)}/${missing.length}`);
  }
}

/* ========= PDF ========= */
async function onCreatePdf() {
  try {
    if (!state.story) throw new Error("Ingen story i minnet.");

    try { await ensureUploads(); } catch (e) { console.warn("ensureUploads varnade:", e); }

    const images = [];

    // 1) Cover
    const coverUploaded = state.uploadedToCF.find(x => x.kind === "cover" || x.page === 0);
    if (coverUploaded) images.push({ kind: "cover", image_id: coverUploaded.image_id, url: coverUploaded.url });
    else if (state.cover?.image_url) images.push({ kind: "cover", url: state.cover.image_url });

    // 2) Sidor
    if (state.uploadedToCF.length) {
      for (const r of state.uploadedToCF) {
        if (r.kind === "cover" || r.page === 0) continue;
        images.push({ page: r.page, image_id: r.image_id, url: r.url });
      }
    } else {
      for (const r of state.generatedImages) images.push({ page: r.page, url: r.image_url });
    }

    if (!images.length) throw new Error("Hittade inga illustrationer att lägga i PDF:en.");

    setStatus("📕 Bygger PDF…");
    const res = await fetch(`${BACKEND}/api/pdf`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        story: state.story,
        images,
        mode: "preview",
        trim: "square210",
        watermark_text: "FÖRHANDSVISNING" // sätt null om du vill ta bort watermark
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
  }
}

/* ========= Submit (hela flödet) ========= */
async function onSubmit(e){
  e.preventDefault();
  const problems = validateForm();
  if (problems.length) { alert("Korrigera:\n\n• " + problems.join("\n• ")); return; }

  readForm();
  renderSkeleton(4);
  setStatus("✏️ Skriver berättelsen…"); updateProgress(0,4,"1/4 – Berättelsen");
  startQuips();
  if (els.submitBtn){ els.submitBtn.disabled = true; els.submitBtn.innerHTML = 'Skapar förhandsvisning… <span class="spinner"></span>'; }

  // rensa tidigare resultat
  state.generatedImages = [];
  state.uploadedToCF = [];
  state.cover = null;
  state.pdfReady = false;

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
    setStatus("🖼️ Låser hjälten (referens)…"); updateProgress(1,4,"2/4 – Referens");
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

    // 3) COVER (nytt steg)
    setStatus("🎯 Tar fram omslaget…"); updateProgress(2,4,"3/4 – Omslag");
    const coverRes = await fetch(`${BACKEND}/api/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        style: state.form.style,
        ref_image_b64: state.refB64,
        story: state.story
      })
    });
    const coverData = await coverRes.json().catch(()=> ({}));
    if (!coverRes.ok || coverData?.error) throw new Error(coverData?.error || `HTTP ${coverRes.status}`);
    state.cover = { image_url: coverData.image_url };
    showCoverPreview();

    // 4) IMAGES
    setStatus("🎨 Illustrerar sidor…"); updateProgress(3,4,"4/4 – Sidor");
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
    state.generatedImages = results.filter(r => r?.image_url).map(r => ({ page: r.page, image_url: r.image_url }));

    // Rendera till korten
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
        await new Promise(resolve=>{
          const tmp = new Image();
          tmp.onload = ()=>{
            imgEl.src = tmp.src; sk?.remove(); imgEl.style.opacity = "1";
            const prov = card.querySelector(".img-provider");
            if (prov){ prov.textContent = "🎨 Gemini"; prov.classList.remove("hidden"); }
            card.querySelector(".retry-wrap")?.classList.add("hidden");
            resolve();
          };
          tmp.onerror = ()=>{ sk?.remove(); resolve(); };
          tmp.src = row.image_url;
        });
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

    await new Promise(resolve=>{
      const tmp = new Image();
      tmp.onload = ()=>{
        imgEl.src = tmp.src; imgEl.style.opacity = "1"; sk.remove();
        const prov = card.querySelector(".img-provider");
        if (prov){ prov.textContent = "🎨 Gemini"; prov.classList.remove("hidden"); }
        card.querySelector(".retry-wrap")?.classList.add("hidden");

        // uppdatera generatedImages
        const idx = state.generatedImages.findIndex(x => x.page === page);
        if (idx >= 0) state.generatedImages[idx].image_url = tmp.src;
        else state.generatedImages.push({ page, image_url: tmp.src });

        // ta bort ev. tidigare CF-uppladdning för sidan
        state.uploadedToCF = state.uploadedToCF.filter(x => x.page !== page);

        resolve();
      };
      tmp.onerror = ()=>{ sk.remove(); resolve(); };
      tmp.src = j.image_url;
    });
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
        <img src="https://picsum.photos/seed/demo_${i}/600/400" />
      </div>
      <div class="txt">Sida ${i+1}: ${escapeHtml(state.form.name)}s lilla äventyr.</div>`;
    els.previewGrid.appendChild(card);
  }
  state.cover = { image_url: "https://picsum.photos/seed/cover_demo/1200/1200" };
  showCoverPreview();
  state.generatedImages = Array.from({length: total}, (_,k)=>({
    page: k+1,
    image_url: els.previewGrid.querySelector(`.imgwrap[data-page="${k+1}"] img`)?.src || ""
  }));
  els.previewSection.classList.remove("hidden");
  smoothScrollTo(els.previewSection);
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

  ["name","age","pages","style","theme","traits","readingAge"].forEach(id=>{
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
    els.mobileMenu.classList.toggle("open");
    const open = els.mobileMenu.classList.contains("open");
    els.navToggle.setAttribute("aria-expanded", open ? "true":"false");
    els.mobileMenu.setAttribute("aria-hidden", open ? "false":"true");
  });

  els.pdfBtn?.addEventListener("click", onCreatePdf);
  if (els.pdfBtn) els.pdfBtn.disabled = false;
}

/* ========= Init ========= */
(function init(){
  loadForm();
  if (state.form.refMode !== "photo" && state.form.refMode !== "desc") state.form.refMode = "photo";
  writeForm(); bindEvents(); setStatus(null);
})();
