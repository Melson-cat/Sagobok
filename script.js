/* =================== Konfiguration =================== */
const BACKEND = "https://bokpilot-backend.sebastian-runell.workers.dev";
const STORAGE_KEY = "bokpiloten_form_v3";
const MAX_AGE = 120;
const MIN_AGE = 1;
const VALID_PAGES = new Set([12, 16, 20]);

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

  // karaktärsreferens toggle
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
    category: "kids",      // "kids" | "pets"
    name: "Nova",
    age: 6,
    pages: 16,
    style: "storybook",
    theme: "",
    refMode: "desc",       // "desc" | "photo"
    traits: "",
    photoDataUrl: null,
  },
  visibleCount: 4,
  loadingImages: new Set(),
};

/* =================== Hjälpare =================== */
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function toInt(v, fb = 0){ const n = parseInt(v, 10); return Number.isFinite(n) ? n : fb; }
function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function smoothScrollTo(el){ el?.scrollIntoView({ behavior:"smooth", block:"start" }); }

function setStatus(msg){
  const bar = document.getElementById("statusBar");
  if(!bar) return;
  if(!msg){ bar.textContent = ""; bar.classList.add("hidden"); return; }
  bar.textContent = msg;
  bar.classList.remove("hidden");
}

function setLoading(is){
  if(!els.submitBtn) return;
  els.submitBtn.disabled = is;
  els.submitBtn.innerHTML = is
    ? 'Skapar berättelse… <span class="spinner"></span>'
    : 'Skapa förhandsvisning';
}

/* ---- LocalStorage ---- */
function saveForm(){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.form)); } catch {}
}
function loadForm(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const saved = JSON.parse(raw) || {};
    Object.assign(state.form, saved);
  } catch {}
}

/* ---- Kategori toggle ---- */
function setCategory(cat, save = true){
  const val = (cat === "pets") ? "pets" : "kids";
  state.form.category = val;

  // UI
  if(val === "kids"){
    els.catKidsBtn?.classList.add("active");
    els.catKidsBtn?.setAttribute("aria-selected","true");
    els.catPetsBtn?.classList.remove("active");
    els.catPetsBtn?.setAttribute("aria-selected","false");
  } else {
    els.catPetsBtn?.classList.add("active");
    els.catPetsBtn?.setAttribute("aria-selected","true");
    els.catKidsBtn?.classList.remove("active");
    els.catKidsBtn?.setAttribute("aria-selected","false");
  }

  document.body.dataset.theme = val;
  if(save) saveForm();
}

/* ---- Karaktärsreferens toggle ---- */
function setRefMode(mode, focus = true){
  const m = (mode === "photo") ? "photo" : "desc";
  state.form.refMode = m;

  if(m === "desc"){
    els.refDescBtn.classList.add("active");
    els.refDescBtn.setAttribute("aria-selected","true");
    els.refPhotoBtn.classList.remove("active");
    els.refPhotoBtn.setAttribute("aria-selected","false");
    els.traitsBlock.classList.remove("hidden");
    els.photoBlock.classList.add("hidden");
    if(focus) els.traits?.focus();
  } else {
    els.refPhotoBtn.classList.add("active");
    els.refPhotoBtn.setAttribute("aria-selected","true");
    els.refDescBtn.classList.remove("active");
    els.refDescBtn.setAttribute("aria-selected","false");
    els.photoBlock.classList.remove("hidden");
    els.traitsBlock.classList.add("hidden");
    if(focus) els.charPhoto?.focus();
  }
  saveForm();
}

/* ---- Läs/skriv formulär ---- */
function readForm(){
  const f = state.form;
  f.name = (els.name.value || "Nova").trim();
  f.age = clamp(toInt(els.age.value, 6), MIN_AGE, MAX_AGE);
  f.pages = toInt(els.pages.value, 16); if(!VALID_PAGES.has(f.pages)) f.pages = 16;
  f.style = els.style.value || "storybook";
  f.theme = (els.theme.value || "").trim();
  f.traits = (els.traits.value || "").trim();
}
function writeForm(){
  els.name.value = state.form.name;
  els.age.value = state.form.age;
  els.pages.value = String(state.form.pages);
  els.style.value = state.form.style;
  els.theme.value = state.form.theme;
  els.traits.value = state.form.traits;

  setCategory(state.form.category, false);
  setRefMode(state.form.refMode, false);

  if(state.form.photoDataUrl){
    els.photoPreview.src = state.form.photoDataUrl;
    els.photoPreview.classList.remove("hidden");
  }
}

/* ---- Foto-preview ---- */
function onPhotoChange(){
  const file = els.charPhoto.files?.[0];
  if(!file){
    state.form.photoDataUrl = null;
    els.photoPreview.classList.add("hidden");
    els.photoPreview.src = "";
    saveForm();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.form.photoDataUrl = reader.result;
    els.photoPreview.src = state.form.photoDataUrl;
    els.photoPreview.classList.remove("hidden");
    saveForm();
  };
  reader.readAsDataURL(file);
}

/* ---- Skeletons ---- */
function renderSkeleton(count = 4){
  const grid = els.previewGrid;
  const sec = els.previewSection;
  if(!grid || !sec) return;

  grid.innerHTML = "";
  for(let i=0;i<count;i++){
    const el = document.createElement("article");
    el.className = "thumb";
    el.innerHTML = `
      <div class="imgwrap"><div class="skeleton"></div></div>
      <div class="txt">
        <span class="skeleton" style="display:block;height:12px;margin-bottom:8px"></span>
        <span class="skeleton" style="display:block;height:12px;width:60%"></span>
      </div>
    `;
    grid.appendChild(el);
  }
  sec.classList.remove("hidden");
}

/* ---- Bildladdning med throttling ---- */
async function loadImageThrottled(src, concurrency = 4){
  while (state.loadingImages.size >= concurrency)
    await new Promise(r => setTimeout(r, 50));
  state.loadingImages.add(src);
  try{
    await new Promise((res, rej) => {
      const i = new Image();
      i.onload = res; i.onerror = rej; i.src = src;
    });
  } finally {
    state.loadingImages.delete(src);
  }
}

/* ---- Preview-render ---- */
function renderPreview(pages, visibleCount = 4){
  els.previewGrid.innerHTML = "";
  const frag = document.createDocumentFragment();

  pages.forEach((p, i) => {
    const card = document.createElement("article");
    card.className = "thumb";
    if(i >= visibleCount) card.classList.add("locked");

    card.innerHTML = `
      <div class="imgwrap">
        <div class="skeleton"></div>
        <img alt="Sida ${p.idx}" style="opacity:0" />
      </div>
      <div class="txt">${escapeHtml(p.text)}</div>
    `;
    frag.appendChild(card);

    const imgEl = card.querySelector("img");
    loadImageThrottled(p.img).then(() => {
      imgEl.src = p.img;
      imgEl.onload = () => {
        card.querySelector(".skeleton")?.remove();
        imgEl.style.opacity = "1";
      };
    }).catch(() => {
      card.querySelector(".skeleton")?.remove();
      imgEl.replaceWith(Object.assign(document.createElement("div"), {
        className:"img-fallback",
        textContent:"Kunde inte ladda bild"
      }));
    });
  });

  els.previewGrid.appendChild(frag);
  els.previewSection.classList.remove("hidden");
  smoothScrollTo(els.previewSection);
}

/* ---- Demo-sidor ---- */
function makeDemoPages(total = 12, name = "Nova", theme = "ett litet äventyr"){
  return Array.from({length: total}, (_,i)=>({
    idx: i+1,
    text: `Sida ${i+1}: ${name} fortsätter ${theme}.`,
    img: `https://picsum.photos/seed/bp_${i+1}/600/400`
  }));
}

/* ---- Validering ---- */
function validateForm(){
  readForm();
  const problems = [];
  if(!state.form.name) problems.push("Ange ett namn.");
  if(state.form.age < MIN_AGE || state.form.age > MAX_AGE) problems.push("Åldern verkar orimlig.");
  if(!VALID_PAGES.has(state.form.pages)) problems.push("Ogiltigt sidantal.");
  if(state.form.theme.length > 160) problems.push("Tema/handling: håll det kort (≤ 160 tecken).");

  if(state.form.refMode === "desc"){
    if(!state.form.traits || state.form.traits.length < 10){
      problems.push("Beskriv gärna kännetecken (minst ~10 tecken).");
    }
  } else if(state.form.refMode === "photo"){
    if(!state.form.photoDataUrl){
      problems.push("Ladda upp ett foto eller byt till Beskrivning.");
    }
  }
  return problems;
}

/* ---- Submit ---- */
async function onSubmit(e){
  e.preventDefault();

  const problems = validateForm();
  if(problems.length){
    alert("Korrigera:\n\n• " + problems.join("\n• "));
    return;
  }

  readForm();
  const payload = {
    name: state.form.name,
    age: state.form.age,
    pages: state.form.pages,
    category: state.form.category,  // "kids" | "pets"
    style: state.form.style,
    theme: state.form.theme,
    refMode: state.form.refMode,
    traits: state.form.traits || null,
    // foto skickas inte här; din backend förväntar text-traits (enligt nuvarande kod)
  };

  renderSkeleton(4);
  setLoading(true);
  setStatus("Skickar till story-agent...");

  try{
    const res = await fetch(`${BACKEND}/api/story`, {
      method: "POST",
      headers: { "content-type":"application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(()=> ({}));

    if(!res.ok || data?.error){
      console.error("Story error:", res.status, data?.error);
      setStatus(null);
      alert("Tyvärr uppstod ett fel: " + (data?.error || `HTTP ${res.status}`));
      return;
    }

    // Debugvänligt i devtools
    console.log("Story title:", data?.story?.book?.title);
    console.log("Pages count:", data?.story?.book?.pages?.length);
    console.dir(data.story);
    console.log("Raw JSON:", JSON.stringify(data.story, null, 2));
    window.lastStory = data.story;

    const pages = (data?.story?.book?.pages || []).map(p => ({
      idx: p.page,
      text: p.text,
      // placeholder-img tills din bildgenerering kopplas in
      img: `https://picsum.photos/seed/preview_${p.page}/600/400`
    }));

    const visible = data?.previewVisible ?? state.visibleCount;
    setStatus(`Visar de ${visible} första sidorna. Övriga är suddade tills du skapar boken.`);
    renderPreview(pages, visible);

  } catch (err){
    console.error(err);
    setStatus(null);
    alert("Nätverksfel eller serverfel. Försök igen.");
  } finally {
    setLoading(false);
  }
}

/* ---- Demo-knapp ---- */
function onDemo(){
  state.visibleCount = 4;
  const pages = makeDemoPages(12, state.form.name || "Nova", state.form.theme || "ett litet äventyr");
  setStatus("Detta är en demo. Endast de 4 första visas skarpt.");
  renderPreview(pages, state.visibleCount);
}

/* ---- Eventbindningar ---- */
function bindEvents(){
  // kategori
  els.catKidsBtn?.addEventListener("click", ()=> setCategory("kids"));
  els.catPetsBtn?.addEventListener("click", ()=> setCategory("pets"));

  // karaktärsreferens
  els.refDescBtn?.addEventListener("click", ()=> setRefMode("desc"));
  els.refPhotoBtn?.addEventListener("click", ()=> setRefMode("photo"));

  // foto
  els.charPhoto?.addEventListener("change", onPhotoChange);

  // inputs autosave
  ["name","age","pages","style","theme","traits"].forEach(id=>{
    const el = document.getElementById(id);
    el?.addEventListener("input", ()=>{ readForm(); saveForm(); });
  });

  // submit + demo
  els.form?.addEventListener("submit", onSubmit);
  els.demoBtn?.addEventListener("click", onDemo);

  // mobilmeny
  els.navToggle?.addEventListener("click", ()=>{
    els.mobileMenu.classList.toggle("open");
    const open = els.mobileMenu.classList.contains("open");
    els.navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    els.mobileMenu.setAttribute("aria-hidden", open ? "false" : "true");
  });
}

/* ---- Init ---- */
(function init(){
  loadForm();
  if(state.form.category !== "kids" && state.form.category !== "pets"){
    state.form.category = "kids";
  }
  writeForm();
  bindEvents();
  setStatus(null);
})();
