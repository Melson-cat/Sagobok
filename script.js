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
};

/* =================== State =================== */
const state = {
  form: {
    category: "kids",
    name: "Nova",
    age: 6,
    pages: 16,
    style: "storybook",
    theme: "",
    refMode: "desc",
    traits: "",
    photoDataUrl: null,
  },
  visibleCount: 4,
  imagePrompts: [],
};

/* =================== Hjälpare =================== */
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
function toInt(v, fb = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fb;
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function smoothScrollTo(el) {
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setStatus(msg) {
  let bar = document.getElementById("statusBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "statusBar";
    bar.className = "status-bar";
    els.previewSection?.insertAdjacentElement("beforebegin", bar);
  }
  if (!msg) {
    bar.textContent = "";
    bar.classList.add("hidden");
    return;
  }
  bar.textContent = msg;
  bar.classList.remove("hidden");
}

function setLoading(is) {
  if (!els.submitBtn) return;
  els.submitBtn.disabled = is;
  els.submitBtn.innerHTML = is
    ? 'Skapar berättelse… <span class="spinner"></span>'
    : "Skapa förhandsvisning";
}

function updateProgress(current, total, label) {
  let bar = document.getElementById("statusBar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "statusBar";
    bar.className = "status-bar";
    els.previewSection?.insertAdjacentElement("afterbegin", bar);
  }
  bar.classList.remove("hidden");

  let prog = bar.querySelector(".progress");
  if (!prog) {
    prog = document.createElement("div");
    prog.className = "progress";
    prog.innerHTML =
      '<div class="progress-track"><div class="progress-fill" style="width:0%"></div></div><span class="progress-label"></span>';
    bar.appendChild(prog);
  }
  const pct = total ? Math.round((current / total) * 100) : 0;
  prog.querySelector(".progress-fill").style.width = pct + "%";
  prog.querySelector(".progress-label").textContent = label || "";
}

/* ---- LocalStorage ---- */
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

/* ---- Kategori toggle ---- */
function setCategory(cat, save = true) {
  const val = cat === "pets" ? "pets" : "kids";
  state.form.category = val;
  document.body.dataset.theme = val;

  els.catKidsBtn?.classList.toggle("active", val === "kids");
  els.catPetsBtn?.classList.toggle("active", val === "pets");

  if (save) saveForm();
}

/* ---- Karaktärsreferens toggle ---- */
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

/* ---- Läs/skriv formulär ---- */
function readForm() {
  const f = state.form;
  f.name = (els.name.value || "Nova").trim();
  f.age = clamp(toInt(els.age.value, 6), MIN_AGE, MAX_AGE);
  f.pages = VALID_PAGES.has(toInt(els.pages.value)) ? toInt(els.pages.value) : 16;
  f.style = els.style.value || "storybook";
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

/* ---- Foto-preview ---- */
function onPhotoChange() {
  const file = els.charPhoto.files?.[0];
  if (!file) {
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

/* ---- Skeleton ---- */
function renderSkeleton(count = 4) {
  els.previewGrid.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const el = document.createElement("article");
    el.className = "thumb";
    el.innerHTML = `
      <div class="imgwrap"><div class="skeleton"></div></div>
      <div class="txt">
        <span class="skeleton" style="height:12px;margin-bottom:8px"></span>
        <span class="skeleton" style="height:12px;width:60%"></span>
      </div>`;
    els.previewGrid.appendChild(el);
  }
  els.previewSection.classList.remove("hidden");
}

/* ---- Validering ---- */
function validateForm() {
  readForm();
  const problems = [];
  if (!state.form.name) problems.push("Ange ett namn.");
  if (state.form.age < MIN_AGE || state.form.age > MAX_AGE) problems.push("Åldern verkar orimlig.");
  if (!VALID_PAGES.has(state.form.pages)) problems.push("Ogiltigt sidantal.");
  if (state.form.theme.length > 160) problems.push("Tema/handling: håll det kort.");

  if (state.form.refMode === "desc" && (!state.form.traits || state.form.traits.length < 10)) {
    problems.push("Beskriv gärna kännetecken (minst 10 tecken).");
  }
  if (state.form.refMode === "photo" && !state.form.photoDataUrl) {
    problems.push("Ladda upp ett foto eller byt till beskrivning.");
  }
  return problems;
}

/* ---- Submit ---- */
async function onSubmit(e) {
  e.preventDefault();
  const problems = validateForm();
  if (problems.length) {
    alert("Korrigera:\n\n• " + problems.join("\n• "));
    return;
  }

  readForm();
  const payload = { ...state.form };
  renderSkeleton(4);
  setLoading(true);
  setStatus("🪄 Skapar berättelse med AI …");
  updateProgress(0, 1, "Skapar berättelse …");

  try {
    // === STEG 1: Story ===
    const res = await fetch(`${BACKEND}/api/story`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);

    const visible = data?.previewVisible ?? state.visibleCount;
    const prompts = data.image_prompts || [];
    const pagesJson = data?.story?.book?.pages || [];
    state.imagePrompts = prompts;
    if (!prompts.length || !pagesJson.length) throw new Error("Ingen bilddata hittades.");

    // === STEG 2: Förbered kort ===
    els.previewGrid.innerHTML = "";
    prompts.forEach((p, i) => {
      const card = document.createElement("article");
      card.className = "thumb";
      if (i >= visible) card.classList.add("locked");
      card.innerHTML = `
        <div class="imgwrap" data-page="${p.page}">
          <div class="skeleton"></div>
          <img alt="Sida ${p.page}" style="opacity:0" />
          <span class="img-provider hidden"></span>
        </div>
        <div class="txt">${escapeHtml(pagesJson[i]?.text || "")}</div>
        <div class="retry-wrap hidden" style="padding:10px 12px;">
          <button class="retry-btn retry" data-page="${p.page}">🔄 Generera igen</button>
        </div>`;
      els.previewGrid.appendChild(card);
    });

    const byPageCard = new Map();
    prompts.forEach((p, i) => byPageCard.set(p.page, els.previewGrid.children[i]));

    // === STEG 3: Generera bilder ===
    setStatus("🎨 AI illustrerar sidor …");
    updateProgress(0, prompts.length, "Illustrerar …");

    const imgRes = await fetch(`${BACKEND}/api/images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_prompts: prompts }),
    });
    const imgData = await imgRes.json().catch(() => ({}));
    if (!imgRes.ok || imgData?.error) throw new Error(imgData?.error || "Bildgenerering misslyckades");

    const results = imgData.images || [];
    let received = 0;

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
            if (prov) {
              prov.textContent = row.provider === "google" ? "🎨 Gemini" : (row.provider || "");
              prov.classList.remove("hidden");
            }
            card.querySelector(".retry-wrap")?.classList.add("hidden");
            resolve();
          };
          tmp.onerror = resolve;
          tmp.src = row.image_url;
        });
      }

      received++;
      setStatus(`🖌️ Illustrerar sida ${received} av ${prompts.length} …`);
      updateProgress(received, prompts.length);
      await new Promise((r) => setTimeout(r, 150));
    }

    setStatus("✅ Klart! Sagans förhandsvisning är redo.");
  } catch (err) {
    console.error(err);
    setStatus(null);
    alert("Ett fel uppstod: " + err.message);
  } finally {
    setLoading(false);
  }
}

/* ---- Retry per sida ---- */
async function regenerateOne(page) {
  const entry = (state.imagePrompts || []).find((p) => p.page === page);
  if (!entry) return;

  const card = Array.from(els.previewGrid.children).find((a) =>
    a.querySelector(`.imgwrap[data-page="${page}"]`)
  );
  if (!card) return;

  const imgEl = card.querySelector("img");
  const wrap = card.querySelector(".imgwrap");
  wrap.querySelector(".img-fallback")?.remove();
  wrap.prepend(Object.assign(document.createElement("div"), { className: "skeleton" }));

  try {
    const res = await fetch(`${BACKEND}/api/image/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: entry.prompt, page }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j?.error) throw new Error(j?.error || `HTTP ${res.status}`);
    const tmp = new Image();
    tmp.onload = () => {
      imgEl.src = tmp.src;
      wrap.querySelector(".skeleton")?.remove();
      imgEl.style.opacity = "1";
    };
    tmp.src = j.image_url;
  } catch {
    wrap.querySelector(".skeleton")?.remove();
    wrap.insertAdjacentHTML(
      "beforeend",
      `<div class="img-fallback">Kunde inte generera bild</div>`
    );
  }
}

/* ---- Demo ---- */
function onDemo() {
  const total = 12;
  els.previewGrid.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const card = document.createElement("article");
    card.className = "thumb";
    if (i >= state.visibleCount) card.classList.add("locked");
    card.innerHTML = `
      <div class="imgwrap">
        <img src="https://picsum.photos/seed/demo${i}/600/400" />
      </div>
      <div class="txt">Sida ${i + 1}: ${state.form.name || "Nova"}s lilla äventyr.</div>`;
    els.previewGrid.appendChild(card);
  }
  els.previewSection.classList.remove("hidden");
}

/* ---- Eventbindningar ---- */
function bindEvents() {
  els.catKidsBtn?.addEventListener("click", () => setCategory("kids"));
  els.catPetsBtn?.addEventListener("click", () => setCategory("pets"));
  els.refDescBtn?.addEventListener("click", () => setRefMode("desc"));
  els.refPhotoBtn?.addEventListener("click", () => setRefMode("photo"));
  els.charPhoto?.addEventListener("change", onPhotoChange);
  els.form?.addEventListener("submit", onSubmit);
  els.demoBtn?.addEventListener("click", onDemo);
  els.previewGrid?.addEventListener("click", (e) => {
    const t = e.target;
    if (t.classList.contains("retry-btn")) {
      e.preventDefault();
      regenerateOne(Number(t.dataset.page));
    }
  });
  els.navToggle?.addEventListener("click", () => {
    els.mobileMenu.classList.toggle("open");
  });
}

/* ---- Init ---- */
(function init() {
  loadForm();
  writeForm();
  bindEvents();
  setStatus(null);
})();
