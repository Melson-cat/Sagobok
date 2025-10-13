/* =================== Konfiguration =================== */
const BACKEND = "https://bokpilot-backend.sebastian-runell.workers.dev";
const STORAGE_KEY = "bokpiloten_form_v5";
const MAX_AGE = 120;
const MIN_AGE = 1;
const VALID_PAGES = new Set([12, 16, 20]);
const MAX_REF_DIM = 1024; // nedskala uppladdat foto i browsern

/* =================== Elementrefs =================== */
const els = {
  body: document.body,
  form: document.getElementById("storyForm"),

  // kategori toggle
  catKidsBtn: document.getElementById("catKidsBtn"),
  catPetsBtn: document.getElementById("catPetsBtn"),

  // inputs
  name: document.getElementById("name"),
  age: document.getElementById("age"),
  pages: document.getElementById("pages"),
  style: document.getElementById("style"),
  theme: document.getElementById("theme"),
  traits: document.getElementById("traits"),
  charPhoto: document.getElementById("charPhoto"),
  photoPreview: document.getElementById("photoPreview"),

  // referensläge
  refDescBtn: document.getElementById("refDescBtn"),
  refPhotoBtn: document.getElementById("refPhotoBtn"),
  traitsBlock: document.getElementById("traitsBlock"),
  photoBlock: document.getElementById("photoBlock"),

  // preview
  previewSection: document.getElementById("preview"),
  previewGrid: document.getElementById("bookPreview"),

  // actions
  submitBtn: document.querySelector("#storyForm .btn-primary"),
  demoBtn: document.getElementById("demoBtn"),

  // nav
  navToggle: document.getElementById("navToggle"),
  mobileMenu: document.getElementById("mobileMenu"),
};

/* =================== State =================== */
const state = {
  form: {
    category: "kids",        // "kids" | "pets"
    name: "Nova",
    age: 6,
    pages: 16,
    style: "cartoon",        // cartoon/pixar/storybook – matchar workern
    theme: "",
    refMode: "photo",        // FOTO som default
    traits: "",
    photoDataUrl: null,      // dataURL (nedskalad i browsern)
  },
  visibleCount: 4,

  // data från backend
  story: null,               // { book: { pages: [...] } }
  plan: null,                // { plan: [...] }
  imagePrompts: [],          // [{ page, prompt, ... }]
  refImageDataUrl: null,     // dataURL för referensbilden

  // mappar för snabb åtkomst
  pageMap: new Map(),        // pageNo -> pageObj
  promptMap: new Map(),      // pageNo -> promptObj

  // UI-styrning
  tickerTimer: null,
  phase: 0,                  // 0=idle, 1=story, 2=ref, 3=images, 4=done
};

/* =================== Hjälpare =================== */
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function toInt(v, fb = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fb; }
function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function smoothScrollTo(el) { el?.scrollIntoView({ behavior: "smooth", block: "start" }); }

/* ========= “Levande” statuspanel ========= */
const TIP_ROTATION = [
  "✏️ Skapar scener som passar texten…",
  "🎬 Blandar vinklar (EW/W/M/CU) för rytm…",
  "🎨 Väljer mjuka pasteller för barnvänlig känsla…",
  "📸 Låser utseendet mot din referensbild…",
  "🌊 Lägger till små miljödetaljer utan brus…",
  "🧶 Säkerställer att inga extra figurer smyger in…",
  "✨ Håller siluetten tydlig och läsbar i miniatyr…",
];

function ensureStatusPanel() {
  let bar = document.getElementById("statusBar");
  if (bar) return bar;
  bar = document.createElement("div");
  bar.id = "statusBar";
  bar.className = "status-bar rich";
  bar.innerHTML = `
    <div class="phases">
      <div class="phase" data-step="1"><span>1</span><label>Berättelse</label></div>
      <div class="phase" data-step="2"><span>2</span><label>Referensbild</label></div>
      <div class="phase" data-step="3"><span>3</span><label>Illustrationer</label></div>
    </div>
    <div class="status-main">
      <div class="status-line">
        <span class="status-emoji">⏳</span>
        <span class="status-text">Förbereder…</span>
      </div>
      <div class="progress">
        <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
        <span class="progress-label"></span>
      </div>
      <div class="live-log" aria-live="polite"></div>
    </div>
  `;
  els.previewSection?.insertAdjacentElement("beforebegin", bar);
  return bar;
}
function setPhase(step) {
  state.phase = step;
  const bar = ensureStatusPanel();
  const nodes = bar.querySelectorAll(".phase");
  nodes.forEach(n => {
    const s = Number(n.getAttribute("data-step"));
    n.classList.toggle("done", s < step);
    n.classList.toggle("current", s === step);
    n.classList.toggle("todo", s > step);
  });
  bar.classList.remove("hidden");
}
function setStatus(text, emoji = "⏳") {
  const bar = ensureStatusPanel();
  const line = bar.querySelector(".status-text");
  const e = bar.querySelector(".status-emoji");
  if (line) line.textContent = text || "";
  if (e) e.textContent = emoji || "⏳";
  bar.classList.toggle("hidden", !text);
}
function updateProgress(current, total, label) {
  const bar = ensureStatusPanel();
  const fill = bar.querySelector(".progress-fill");
  const lab = bar.querySelector(".progress-label");
  const pct = total ? Math.round((current / total) * 100) : 0;
  if (fill) fill.style.width = pct + "%";
  if (lab) lab.textContent = label || "";
  bar.classList.remove("hidden");
}
function pushLiveLog(msg) {
  const bar = ensureStatusPanel();
  const log = bar.querySelector(".live-log");
  if (!log) return;
  const row = document.createElement("div");
  row.className = "live-row";
  row.textContent = msg;
  log.appendChild(row);
  // håll det “levande”, men inte oändligt
  const rows = log.querySelectorAll(".live-row");
  if (rows.length > 6) log.removeChild(rows[0]);
}
function startTicker() {
  stopTicker();
  let i = 0;
  state.tickerTimer = setInterval(() => {
    pushLiveLog(TIP_ROTATION[i % TIP_ROTATION.length]);
    i++;
  }, 1500);
}
function stopTicker() {
  if (state.tickerTimer) clearInterval(state.tickerTimer);
  state.tickerTimer = null;
}

/* ========= Loading button ========= */
function setLoading(is) {
  if (!els.submitBtn) return;
  els.submitBtn.disabled = is;
  els.submitBtn.innerHTML = is
    ? 'Jobbar för fullt… <span class="spinner"></span>'
    : "Skapa förhandsvisning";
}

/* ========= LocalStorage ========= */
function saveForm(){ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.form)); }catch{} }
function loadForm(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) || {};
    Object.assign(state.form, saved);
  }catch{}
}

/* ========= UI toggles ========= */
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

/* ========= Form read/write ========= */
function readForm() {
  const f = state.form;
  f.name = (els.name.value || "Nova").trim();
  f.age = clamp(toInt(els.age.value, 6), MIN_AGE, MAX_AGE);
  f.pages = VALID_PAGES.has(toInt(els.pages.value)) ? toInt(els.pages.value) : 16;
  f.style = els.style.value || "cartoon";
  f.theme = (els.theme.value || "").trim();
  f.traits = (els.traits.value || "").trim();
}
function writeForm() {
  els.name.value = state.form.name;
  els.age.value = state.form.age;
  els.pages.value = state.form.pages;
  els.style.value = state.form.style;
  els.theme.value = state.form.theme;
  els.traits.value = state.form.traits;
  setCategory(state.form.category, false);
  setRefMode(state.form.refMode, false);
  if (state.form.photoDataUrl) {
    els.photoPreview.src = state.form.photoDataUrl;
    els.photoPreview.classList.remove("hidden");
  }
}

/* ========= Bildkomprimering ========= */
async function downscaleFileToDataURL(file, maxDim = MAX_REF_DIM) {
  const img = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const im = new Image(); im.onload = () => resolve(im); im.onerror = reject; im.src = r.result; };
    r.onerror = reject; r.readAsDataURL(file);
  });
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return img.src; // redan liten
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png", 0.92);
}

/* ========= Foto-preview ========= */
async function onPhotoChange() {
  const file = els.charPhoto.files?.[0];
  if (!file) {
    state.form.photoDataUrl = null;
    els.photoPreview.classList.add("hidden");
    els.photoPreview.src = "";
    saveForm();
    return;
  }
  const dataUrl = await downscaleFileToDataURL(file, MAX_REF_DIM);
  state.form.photoDataUrl = dataUrl;
  els.photoPreview.src = dataUrl;
  els.photoPreview.classList.remove("hidden");
  saveForm();
}

/* ========= Skeletons ========= */
function renderSkeleton(count = 4) {
  els.previewGrid.innerHTML = "";
  for (let i = 0; i < count; i++) {
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
function validateForm() {
  readForm();
  const problems = [];
  if (!state.form.name) problems.push("Ange ett namn.");
  if (state.form.age < MIN_AGE || state.form.age > MAX_AGE) problems.push("Åldern verkar orimlig.");
  if (!VALID_PAGES.has(state.form.pages)) problems.push("Ogiltigt sidantal.");
  if (state.form.theme.length > 160) problems.push("Tema/handling: håll det kort (≤ 160 tecken).");

  if (state.form.refMode === "desc") {
    if (!state.form.traits || state.form.traits.length < 10) {
      problems.push("Beskriv gärna kännetecken (minst ~10 tecken) – eller ladda upp foto för bäst resultat.");
    }
  } else if (state.form.refMode === "photo") {
    if (!state.form.photoDataUrl) problems.push("Ladda upp ett foto – eller byt till Beskrivning.");
  }
  return problems;
}

/* ========= Kortbygge ========= */
function buildCards(pages, visibleCount) {
  els.previewGrid.innerHTML = "";
  state.pageMap.clear();
  pages.forEach((pg, i) => {
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

/* ========= Submit (hela flödet) ========= */
async function onSubmit(e) {
  e.preventDefault();
  const problems = validateForm();
  if (problems.length) { alert("Korrigera:\n\n• " + problems.join("\n• ")); return; }

  readForm();
  renderSkeleton(4);
  setLoading(true);
  setPhase(1);
  setStatus("✏️ Skriver berättelsen …", "✏️");
  updateProgress(0, 3, "1/3 – Berättelse");
  startTicker();

  try {
    // -- 1) STORY + PLAN --
    const storyRes = await fetch(`${BACKEND}/api/story`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: state.form.name,
        age: state.form.age,
        pages: state.form.pages,
        category: state.form.category,
        style: state.form.style,
        theme: state.form.theme,
        refMode: state.form.refMode,
        traits: state.form.traits
      }),
    });
    const storyData = await storyRes.json().catch(()=> ({}));
    if (!storyRes.ok || storyData?.error) throw new Error(storyData?.error || `HTTP ${storyRes.status}`);

    state.story = storyData.story;
    state.plan = storyData.plan || { plan: [] };
    state.imagePrompts = storyData.image_prompts || [];

    // mappa prompts per sida
    state.promptMap.clear();
    state.imagePrompts.forEach(p => state.promptMap.set(p.page, p));

    const pages = state.story?.book?.pages || [];
    if (!pages.length) throw new Error("Berättelsen saknar sidor.");
    buildCards(pages, state.visibleCount);

    // -- 2) REF IMAGE --
    setPhase(2);
    setStatus("🖼️ Förbereder referensbild …", "🖼️");
    updateProgress(1, 3, "2/3 – Referensbild");

    let refImageDataUrl = null;
    if (state.form.refMode === "photo" && state.form.photoDataUrl) {
      // skicka data_url enligt nya workern
      const refRes = await fetch(`${BACKEND}/api/ref-image`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          data_url: state.form.photoDataUrl
        }),
      });
      const refData = await refRes.json().catch(()=> ({}));
      if (!refRes.ok || refData?.error) throw new Error(refData?.error || `HTTP ${refRes.status}`);
      refImageDataUrl = refData.ref_image_data_url || null;
    }
    state.refImageDataUrl = refImageDataUrl || null;

    // -- 3) IMAGES --
    setPhase(3);
    setStatus("🎨 Illustrerar sidor …", "🎨");
    updateProgress(2, 3, "3/3 – Bilder");

    const imgRes = await fetch(`${BACKEND}/api/images`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image_prompts: state.imagePrompts,
        ref_image_data_url: state.refImageDataUrl || null,
        concurrency: 4
      })
    });
    const imgData = await imgRes.json().catch(() => ({}));
    if (!imgRes.ok || imgData?.error) throw new Error(imgData?.error || "Bildgenerering misslyckades");

    const results = imgData.images || [];
    let received = 0;

    const byPageCard = new Map();
    Array.from(els.previewGrid.children).forEach(card => {
      const p = Number(card.querySelector(".imgwrap")?.getAttribute("data-page"));
      if (p) byPageCard.set(p, card);
    });

    for (const row of results) {
      const card = byPageCard.get(row.page);
      if (!card) continue;
      const imgEl = card.querySelector("img");
      const skeleton = card.querySelector(".skeleton");

      if (row.image_url) {
        await new Promise((resolve) => {
          const tmp = new Image();
          tmp.onload = () => {
            imgEl.src = tmp.src;
            skeleton?.remove();
            imgEl.style.opacity = "1";
            const prov = card.querySelector(".img-provider");
            if (prov) { prov.textContent = "🎨 Gemini"; prov.classList.remove("hidden"); }
            card.querySelector(".retry-wrap")?.classList.add("hidden");
            resolve();
          };
          tmp.onerror = () => { skeleton?.remove(); resolve(); };
          tmp.src = row.image_url;
        });
      } else {
        skeleton?.remove();
        const fb = document.createElement("div");
        fb.className = "img-fallback";
        fb.innerHTML = `
          Kunde inte generera bild
          <div class="retry-wrap" style="margin-top:8px;">
            <button class="retry-btn retry" data-page="${row.page}">🔄 Generera igen</button>
          </div>`;
        card.querySelector(".imgwrap").appendChild(fb);
        card.querySelector(".retry-wrap")?.classList.remove("hidden");
      }

      received++;
      setStatus(`🖌️ Illustrerar sida ${received} av ${results.length} …`, "🖌️");
      updateProgress(received, results.length, `Illustrerar ${received}/${results.length} …`);
      await new Promise(r => setTimeout(r, 120));
    }

    setPhase(4);
    stopTicker();
    setStatus("✅ Klart! Sagans förhandsvisning är redo.", "✅");
  } catch (err) {
    console.error(err);
    stopTicker();
    setStatus(null);
    alert("Ett fel uppstod: " + (err?.message || err));
  } finally {
    setLoading(false);
  }
}

/* ========= Regenerera en sida ========= */
async function regenerateOne(page) {
  const promptObj = state.promptMap.get(page);
  if (!promptObj) return;

  const card = Array.from(els.previewGrid.children).find(a =>
    a.querySelector(`.imgwrap[data-page="${page}"]`)
  );
  if (!card) return;

  const wrap = card.querySelector(".imgwrap");
  const imgEl = card.querySelector("img");
  wrap.querySelector(".img-fallback")?.remove();
  const sk = document.createElement("div");
  sk.className = "skeleton";
  wrap.prepend(sk);

  try {
    const res = await fetch(`${BACKEND}/api/image/regenerate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: promptObj.prompt,
        page,
        ref_image_data_url: state.refImageDataUrl || null
      })
    });
    const j = await res.json().catch(()=> ({}));
    if (!res.ok || j?.error) throw new Error(j?.error || `HTTP ${res.status}`);

    await new Promise(resolve => {
      const tmp = new Image();
      tmp.onload = () => {
        imgEl.src = tmp.src;
        imgEl.style.opacity = "1";
        sk.remove();
        const prov = card.querySelector(".img-provider");
        if (prov) { prov.textContent = "🎨 Gemini"; prov.classList.remove("hidden"); }
        card.querySelector(".retry-wrap")?.classList.add("hidden");
        resolve();
      };
      tmp.onerror = () => { sk.remove(); resolve(); };
      tmp.src = j.image_url;
    });
  } catch (e) {
    sk.remove();
    const fb = document.createElement("div");
    fb.className = "img-fallback";
    fb.innerHTML = `
      Kunde inte generera bild
      <div class="retry-wrap" style="margin-top:8px;">
        <button class="retry-btn retry" data-page="${page}">🔄 Generera igen</button>
      </div>`;
    wrap.appendChild(fb);
  }
}

/* ========= Demo ========= */
function onDemo() {
  const total = 12;
  els.previewGrid.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const card = document.createElement("article");
    card.className = "thumb";
    if (i >= state.visibleCount) card.classList.add("locked");
    card.innerHTML = `
      <div class="imgwrap">
        <img src="https://picsum.photos/seed/demo_${i}/600/400" />
      </div>
      <div class="txt">Sida ${i + 1}: ${escapeHtml(state.form.name)}s lilla äventyr.</div>`;
    els.previewGrid.appendChild(card);
  }
  els.previewSection.classList.remove("hidden");
  smoothScrollTo(els.previewSection);
}

/* ========= Eventbindningar ========= */
function bindEvents() {
  // Kategori
  els.catKidsBtn?.addEventListener("click", () => setCategory("kids"));
  els.catPetsBtn?.addEventListener("click", () => setCategory("pets"));

  // Referensläge
  els.refDescBtn?.addEventListener("click", () => setRefMode("desc"));
  els.refPhotoBtn?.addEventListener("click", () => setRefMode("photo"));

  // Foto
  els.charPhoto?.addEventListener("change", onPhotoChange);

  // Spara inputs löpande
  ["name","age","pages","style","theme","traits"].forEach(id=>{
    const el = document.getElementById(id);
    el?.addEventListener("input", () => { readForm(); saveForm(); });
  });

  // Submit + demo
  els.form?.addEventListener("submit", onSubmit);
  els.demoBtn?.addEventListener("click", onDemo);

  // Regenerate (delegation)
  els.previewGrid?.addEventListener("click", (e) => {
    const t = e.target;
    if (t && t.classList.contains("retry-btn")) {
      e.preventDefault();
      const page = Number(t.getAttribute("data-page"));
      if (page) regenerateOne(page);
    }
  });

  // Mobilmeny
  els.navToggle?.addEventListener("click", () => {
    els.mobileMenu.classList.toggle("open");
    const open = els.mobileMenu.classList.contains("open");
    els.navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    els.mobileMenu.setAttribute("aria-hidden", open ? "false" : "true");
  });
}

/* ========= Init ========= */
(function init() {
  loadForm();
  // säkerställ att vi defaultar till FOTO
  if (state.form.refMode !== "photo" && state.form.refMode !== "desc") state.form.refMode = "photo";
  writeForm();
  bindEvents();
  // initialt dolt
  const bar = document.getElementById("statusBar");
  if (bar) bar.classList.add("hidden");
})();
