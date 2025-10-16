/* =================== Konfiguration =================== */
const BACKEND = "https://bokpilot-backend.sebastian-runell.workers.dev";
const STORAGE_KEY = "bokpiloten_form_v5";
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
};

const readingAgeSeg = Array.from(document.querySelectorAll('[data-readage]'));

/* =================== State =================== */
const state = {
  form: {
    category: "kids",
    name: "Nova",
    age: 6,
    reading_age: 6,
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

/* ========= Streaming-IMAGES (alla sidor i ett svep, NDJSON) ========= */
async function generateAllImagesStreaming() {
  setStatus("🎥 Genererar alla sidor…"); startQuips();

  const res = await fetch(`${BACKEND}/api/images`, {
    method: "POST",
    mode: "cors",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      style: state.form.style,
      ref_image_b64: state.refB64,
      story: state.story,
      plan: state.plan,
      concurrency: 3
    })
  });

  if (!res.ok || !res.body) {
    stopQuips(); setStatus(null);
    const j = await res.json().catch(()=> ({}));
    throw new Error(j?.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  const byPageCard = new Map();
  Array.from(els.previewGrid.children).forEach(card=>{
    const p = Number(card.querySelector(".imgwrap")?.getAttribute("data-page"));
    if (p) byPageCard.set(p, card);
  });

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.status === "started") {
        updateProgress(0, msg.total || 0, "Startar bildgenerering…");
        continue;
      }
      if (msg.status === "done") {
        stopQuips(); setStatus("✅ Bilderna är klara.");
        continue;
      }
      if (msg.status === "error") {
        stopQuips(); setStatus(null);
        alert("Fel i bildgenerering: " + (msg.message || "okänt fel"));
        continue;
      }
      if (typeof msg.page === "number") {
        const card = byPageCard.get(msg.page);
        if (card) {
          const imgEl = card.querySelector("img");
          const sk = card.querySelector(".skeleton");
          if (msg.image_url) {
            await new Promise(resolve=>{
              const tmp = new Image();
              tmp.onload = ()=>{
                imgEl.src = tmp.src; imgEl.style.opacity = "1"; sk?.remove();
                const prov = card.querySelector(".img-provider");
                if (prov){ prov.textContent = "🎨 Gemini"; prov.classList.remove("hidden"); }
                card.querySelector(".retry-wrap")?.classList.add("hidden");
                resolve();
              };
              tmp.onerror = ()=>{ sk?.remove(); resolve(); };
              tmp.src = msg.image_url;
            });
          } else {
            sk?.remove();
            const fb = document.createElement("div");
            fb.className = "img-fallback";
            fb.innerHTML = `Kunde inte generera bild
              <div class="retry-wrap" style="margin-top:8px;">
                <button class="retry-btn retry" data-page="${msg.page}">🔄 Generera igen</button>
              </div>`;
            card.querySelector(".imgwrap").appendChild(fb);
            card.querySelector(".retry-wrap")?.classList.remove("hidden");
          }
        }
        const prog = msg?.progress || {};
        if (prog.total) updateProgress(prog.completed||0, prog.total, `Illustrerar ${prog.completed||0}/${prog.total} …`);
      }
    }
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
        traits: state.form.traits || "",
        category: state.form.category
      })
    });
    const refData = await refRes.json().catch(()=> ({}));
    if (!refRes.ok || refData?.error) throw new Error(refData?.error || `HTTP ${refRes.status}`);
    state.refB64 = refData.ref_image_b64 || null;
    if (!state.refB64) throw new Error("Ingen referensbild kunde hämtas/skapas.");

    // 3) IMAGES (STREAM)
    updateProgress(2,3,"3/3 – Bildplan");
    await generateAllImagesStreaming();

    stopQuips();
    setStatus("✅ Klart! Sagans förhandsvisning är redo.");
  } catch (e) {
    console.error(e);
    stopQuips(); setStatus(null);
    alert("Ett fel uppstod: " + (e?.message || e));
  } finally {
    if (els.submitBtn){ els.submitBtn.disabled = false; els.submitBtn.textContent = "Skapa förhandsvisning"; }
  }
}

/* ========= Regenerera (singel) ========= */
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

/* ========= PDF: bygg inline JPEGs och skicka direkt ========= */

// Konvertera valfri bildkälla (data: eller https:) till komprimerad JPEG-dataURL
async function downscaleDataUrl(dataUrlOrHttpUrl, maxDim = 1600, jpegQuality = 0.82) {
  let dataUrl = dataUrlOrHttpUrl;

  // Om http(s), hämta som blob → dataURL
  if (/^https?:\/\//i.test(dataUrl)) {
    const blob = await fetch(dataUrl, { mode: "cors" }).then(r => r.blob());
    dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  }

  // Ladda till <img>
  const img = await new Promise((resolve,reject)=>{
    const im = new Image();
    im.onload = ()=> resolve(im);
    im.onerror = reject;
    im.src = dataUrl;
  });

  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(w,h));
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  const c = document.createElement("canvas");
  c.width = outW; c.height = outH;
  const ctx = c.getContext("2d", { alpha: false });
  ctx.drawImage(img, 0, 0, outW, outH);

  return c.toDataURL("image/jpeg", jpegQuality);
}

// Samla alla kort och skapa [{page, image_url: data:jpeg}] för PDF
async function buildImagesForPdfInline() {
  const results = [];
  const cards = Array.from(document.getElementById("bookPreview").children);
  for (const card of cards) {
    const wrap = card.querySelector(".imgwrap");
    const page = Number(wrap?.getAttribute("data-page"));
    const src  = wrap?.querySelector("img")?.src || "";
    if (!page || !src) continue;
    const jpegDataUrl = await downscaleDataUrl(src, 1600, 0.82);
    results.push({ page, image_url: jpegDataUrl });
  }
  return results;
}

const pdfBtn = document.getElementById("pdfBtn");
if (pdfBtn) {
  pdfBtn.addEventListener("click", async () => {
    if (!state.story) { alert("Skapa berättelsen först."); return; }
    try {
      setStatus("📄 Förbereder PDF… (optimerar bilder)"); startQuips();

      const imagesInline = await buildImagesForPdfInline(); // [{page, image_url}]
      const res = await fetch(`${BACKEND}/api/pdf`, {
        method: "POST",
        mode: "cors",
        headers: { "content-type":"application/json" },
        body: JSON.stringify({
          story: state.story,
          images: imagesInline,
          mode: "preview",
          trim: "square210",
          watermark_text: "FÖRHANDSVISNING – BokPiloten"
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setStatus("✅ PDF skapad.");
    } catch (e) {
      console.error(e);
      setStatus(null);
      alert("Kunde inte skapa PDF: " + (e?.message || e));
    } finally {
      stopQuips();
    }
  });
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
      <div class="imgwrap" data-page="${i+1}"><img src="https://picsum.photos/seed/demo_${i}/600/400" /></div>
      <div class="txt">Sida ${i+1}: ${escapeHtml(state.form.name)}s lilla äventyr.</div>`;
    els.previewGrid.appendChild(card);
  }
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
}

/* ========= Init ========= */
(function init(){
  loadForm();
  if (state.form.refMode !== "photo" && state.form.refMode !== "desc") state.form.refMode = "photo";
  writeForm(); bindEvents(); setStatus(null);
})();
