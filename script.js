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
    category: "kids", // "kids" | "pets"
    name: "Nova",
    age: 6,
    pages: 16,
    style: "storybook",
    theme: "",
    refMode: "desc", // "desc" | "photo"
    traits: "",
    photoDataUrl: null,
  },
  visibleCount: 4,
   imagePrompts: []
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
    // lägg den ovanför previewSection om det finns
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

/* ---- Progress helper ---- */
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

  if (val === "kids") {
    els.catKidsBtn?.classList.add("active");
    els.catKidsBtn?.setAttribute("aria-selected", "true");
    els.catPetsBtn?.classList.remove("active");
    els.catPetsBtn?.setAttribute("aria-selected", "false");
  } else {
    els.catPetsBtn?.classList.add("active");
    els.catPetsBtn?.setAttribute("aria-selected", "true");
    els.catKidsBtn?.classList.remove("active");
    els.catKidsBtn?.setAttribute("aria-selected", "false");
  }

  document.body.dataset.theme = val;
  if (save) saveForm();
}

/* ---- Karaktärsreferens toggle ---- */
function setRefMode(mode, focus = true) {
  const m = mode === "photo" ? "photo" : "desc";
  state.form.refMode = m;

  if (m === "desc") {
    els.refDescBtn.classList.add("active");
    els.refDescBtn.setAttribute("aria-selected", "true");
    els.refPhotoBtn.classList.remove("active");
    els.refPhotoBtn.setAttribute("aria-selected", "false");
    els.traitsBlock.classList.remove("hidden");
    els.photoBlock.classList.add("hidden");
    if (focus) els.traits?.focus();
  } else {
    els.refPhotoBtn.classList.add("active");
    els.refPhotoBtn.setAttribute("aria-selected", "true");
    els.refDescBtn.classList.remove("active");
    els.refDescBtn.setAttribute("aria-selected", "false");
    els.photoBlock.classList.remove("hidden");
    els.traitsBlock.classList.add("hidden");
    if (focus) els.charPhoto?.focus();
  }
  saveForm();
}

/* ---- Läs/skriv formulär ---- */
function readForm() {
  const f = state.form;
  f.name = (els.name.value || "Nova").trim();
  f.age = clamp(toInt(els.age.value, 6), MIN_AGE, MAX_AGE);
  f.pages = toInt(els.pages.value, 16);
  if (!VALID_PAGES.has(f.pages)) f.pages = 16;
  f.style = els.style.value || "storybook";
  f.theme = (els.theme.value || "").trim();
  f.traits = (els.traits.value || "").trim();
}
function writeForm() {
  els.name.value = state.form.name;
  els.age.value = state.form.age;
  els.pages.value = String(state.form.pages);
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

/* ---- Skeletons ---- */
function renderSkeleton(count = 4) {
  const grid = els.previewGrid;
  const sec = els.previewSection;
  if (!grid || !sec) return;

  grid.innerHTML = "";
  for (let i = 0; i < count; i++) {
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

/* ---- Validering ---- */
function validateForm() {
  readForm();
  const problems = [];
  if (!state.form.name) problems.push("Ange ett namn.");
  if (state.form.age < MIN_AGE || state.form.age > MAX_AGE) problems.push("Åldern verkar orimlig.");
  if (!VALID_PAGES.has(state.form.pages)) problems.push("Ogiltigt sidantal.");
  if (state.form.theme.length > 160) problems.push("Tema/handling: håll det kort (≤ 160 tecken).");

  if (state.form.refMode === "desc") {
    if (!state.form.traits || state.form.traits.length < 10) {
      problems.push("Beskriv gärna kännetecken (minst ~10 tecken).");
    }
  } else if (state.form.refMode === "photo") {
    if (!state.form.photoDataUrl) {
      problems.push("Ladda upp ett foto eller byt till Beskrivning.");
    }
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
  const payload = {
    name: state.form.name,
    age: state.form.age,
    pages: state.form.pages,
    category: state.form.category,
    style: state.form.style,
    theme: state.form.theme,
    refMode: state.form.refMode,
    traits: state.form.traits || null,
  };

  renderSkeleton(4);
  setLoading(true);
  setStatus("🪄 Skapar berättelse med AI …");
  updateProgress(0, 1, "Skapar berättelse …");

  try {
    // === Steg 1: Skapa story ===
    const res = await fetch(`${BACKEND}/api/story`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data?.error) {
      setStatus(null);
      alert("Tyvärr uppstod ett fel: " + (data?.error || `HTTP ${res.status}`));
      return;
    }

    console.log("Story JSON:", data.story);
    window.lastStory = data.story;

    const visible = data?.previewVisible ?? state.visibleCount;
    const prompts = data.image_prompts || [];
    state.imagePrompts = prompts;
    const pagesJson = data?.story?.book?.pages || [];
    if (!prompts.length || !pagesJson.length) {
      setStatus("Ingen bilddata hittades.");
      return;
    }

    // === Steg 2: Förbered kort – sidtexter direkt, tomma bilder ===
    setStatus("✏️ Förbereder illustrationer …");
    updateProgress(0, prompts.length, "Förbereder kort …");

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
    <button class="retry-btn retry" data-page="${p.page}">
      🔄 Generera igen
    </button>
  </div>
`;

      els.previewGrid.appendChild(card);
    });
    els.previewSection.classList.remove("hidden");
    smoothScrollTo(els.previewSection);

    // Kartlägg kort per sida (om ordningen diffar i stream)
    const byPageCard = new Map();
    prompts.forEach((p, i) => byPageCard.set(p.page, els.previewGrid.children[i]));

    // === Steg 3: Streama bilder (NDJSON) ===
    setStatus("🎨 AI illustrerar sidor … (live)");
    updateProgress(0, prompts.length, "Illustrerar …");

    const streamRes = await fetch(`${BACKEND}/api/images`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image_prompts: prompts }),
    });
    if (!streamRes.ok) {
      const t = await streamRes.text().catch(() => "");
      throw new Error(`Images stream failed: ${streamRes.status} ${t}`);
    }

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }

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

      // visa provider-tag (valfritt men nice)
      const prov = card.querySelector(".img-provider");
      if (prov) {
        prov.textContent = row.provider === "google" ? "🎨 Gemini" : (row.provider || "");
        prov.classList.remove("hidden");
        prov.style.position = "absolute";
        prov.style.right = "8px";
        prov.style.bottom = "8px";
        prov.style.background = "rgba(255,255,255,.9)";
        prov.style.border = "1px solid var(--border)";
        prov.style.borderRadius = "8px";
        prov.style.padding = "2px 6px";
        prov.style.fontSize = "12px";
      }

      // om knappen fanns från tidigare fel – göm den
      const rw = card.querySelector(".retry-wrap");
      rw?.classList.add("hidden");
      resolve();
    };
    tmp.onerror = () => {
      skeleton?.remove();
      const fb = document.createElement("div");
      fb.className = "img-fallback";
      fb.innerHTML = `
        Kunde inte ladda bild
        <div class="retry-wrap" style="margin-top:8px;">
          <button class="retry-btn retry" data-page="${row.page}">🔄 Generera igen</button>
        </div>`;
      card.querySelector(".imgwrap").appendChild(fb);
      resolve();
    };
    tmp.src = row.image_url;
  });
} else {
  // ERROR-GREN: visa tydlig fallback + retry-knapp
  skeleton?.remove();
  const fb = document.createElement("div");
  fb.className = "img-fallback";
  fb.innerHTML = `
    Kunde inte generera bild
    <div class="retry-wrap" style="margin-top:8px;">
      <button class="retry-btn retry" data-page="${row.page}">🔄 Generera igen</button>
    </div>`;
  card.querySelector(".imgwrap").appendChild(fb);
  // visa även knappen under texten om du vill ha den där
  const below = card.querySelector(".retry-wrap");
  below?.classList.remove("hidden");
}


        received += 1;
        setStatus(`🖌️ Illustrerar sida ${received} av ${prompts.length} …`);
        updateProgress(received, prompts.length, `Illustrerar ${received}/${prompts.length} …`);

        // Liten pause för mjuk känsla
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    setStatus("✅ Klart! Sagans förhandsvisning är redo.");
  } catch (err) {
    console.error(err);
    setStatus(null);
    alert("Nätverksfel eller serverfel. Försök igen.");
  } finally {
    setLoading(false);
  }
}

/* ---- Demo ---- */
function onDemo() {
  const total = 12;
  const pages = Array.from({ length: total }, (_, i) => ({
    idx: i + 1,
    text: `Sida ${i + 1}: ${state.form.name || "Nova"} fortsätter ${state.form.theme || "ett litet äventyr"}.`,
    img: `https://picsum.photos/seed/bp_${i + 1}/600/400`,
  }));
  setStatus("Detta är en demo. Endast de 4 första visas skarpt.");
  // enkel preview
  els.previewGrid.innerHTML = "";
  pages.forEach((p, i) => {
    const card = document.createElement("article");
    card.className = "thumb";
    if (i >= state.visibleCount) card.classList.add("locked");
    card.innerHTML = `
      <div class="imgwrap">
        <div class="skeleton"></div>
        <img alt="Sida ${p.idx}" style="opacity:0" />
      </div>
      <div class="txt">${escapeHtml(p.text)}</div>
    `;
    els.previewGrid.appendChild(card);

    const imgEl = card.querySelector("img");
    const sk = card.querySelector(".skeleton");
    const i2 = new Image();
    i2.onload = () => {
      imgEl.src = i2.src;
      sk?.remove();
      imgEl.style.opacity = "1";
    };
    i2.onerror = () => {
      sk?.remove();
      const fb = document.createElement("div");
      fb.className = "img-fallback";
      fb.textContent = "Kunde inte ladda bild";
      card.querySelector(".imgwrap").appendChild(fb);
    };
    i2.src = p.img;
  });

  els.previewSection.classList.remove("hidden");
  smoothScrollTo(els.previewSection);
}

async function regenerateOne(page) {
  // Hitta prompten för sidan
  const entry = (state.imagePrompts || []).find(p => p.page === page);
  if (!entry) {
    alert("Kunde inte hitta prompt för sidan " + page);
    return;
  }

  // Hitta kortet i DOM
  const card = Array.from(els.previewGrid.children).find(a => {
    const wrap = a.querySelector(".imgwrap");
    return wrap && Number(wrap.getAttribute("data-page")) === page;
  });
  if (!card) return;

  const btn = card.querySelector('.retry-btn[data-page="'+page+'"]');
  const imgEl = card.querySelector("img");
  const wrap = card.querySelector(".imgwrap");
  const providerTag = card.querySelector(".img-provider");

  // UI: visa att vi jobbar
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Genererar …";
  }
  // Rensa ev. felruta och visa skeleton
  const prevFallback = card.querySelector(".img-fallback");
  prevFallback?.remove();
  const sk = document.createElement("div");
  sk.className = "skeleton";
  wrap.prepend(sk);

  try {
    const res = await fetch(`${BACKEND}/api/image/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: entry.prompt, page })
    });
    const j = await res.json().catch(()=> ({}));
    if (!res.ok || j?.error) throw new Error(j?.error || `HTTP ${res.status}`);

    await new Promise((resolve) => {
      const tmp = new Image();
      tmp.onload = () => {
        imgEl.src = tmp.src;
        imgEl.style.opacity = "1";
        sk.remove();
        if (providerTag) {
          providerTag.textContent = "🎨 Gemini";
          providerTag.classList.remove("hidden");
        }
        const below = card.querySelector(".retry-wrap");
        below?.classList.add("hidden");
        resolve();
      };
      tmp.onerror = () => {
        sk.remove();
        const fb = document.createElement("div");
        fb.className = "img-fallback";
        fb.innerHTML = `
          Kunde inte generera bild
          <div class="retry-wrap" style="margin-top:8px;">
            <button class="retry-btn retry" data-page="${page}">🔄 Generera igen</button>
          </div>`;
        wrap.appendChild(fb);
        resolve();
      };
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
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🔄 Generera igen";
    }
  }
}


/* ---- Eventbindningar ---- */
/* ---- Eventbindningar ---- */
function bindEvents() {
  // Kategori
  els.catKidsBtn?.addEventListener("click", () => setCategory("kids"));
  els.catPetsBtn?.addEventListener("click", () => setCategory("pets"));

  // Karaktärsreferens
  els.refDescBtn?.addEventListener("click", () => setRefMode("desc"));
  els.refPhotoBtn?.addEventListener("click", () => setRefMode("photo"));

  // Foto-preview
  els.charPhoto?.addEventListener("change", onPhotoChange);

  // Formfält -> spara löpande
  ["name", "age", "pages", "style", "theme", "traits"].forEach((id) => {
    const el = document.getElementById(id);
    el?.addEventListener("input", () => {
      readForm();
      saveForm();
    });
  });

  // Submit + demo
  els.form?.addEventListener("submit", onSubmit);
  els.demoBtn?.addEventListener("click", onDemo);

  // Mobilmeny
  els.navToggle?.addEventListener("click", () => {
    els.mobileMenu.classList.toggle("open");
    const open = els.mobileMenu.classList.contains("open");
    els.navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    els.mobileMenu.setAttribute("aria-hidden", open ? "false" : "true");
  });

  // 🔄 Retry-knapp (event delegation på hela previewGrid)
  // Fångar klick på dynamiskt skapade .retry-btn inne i korten
  els.previewGrid?.addEventListener("click", (e) => {
    const t = e.target;
    if (t && t.classList.contains("retry-btn")) {
      e.preventDefault();
      const page = Number(t.getAttribute("data-page"));
      if (page) regenerateOne(page);
    }
  });
}


/* ---- Init ---- */
(function init() {
  loadForm();
  if (state.form.category !== "kids" && state.form.category !== "pets") {
    state.form.category = "kids";
  }
  writeForm();
  bindEvents();
  setStatus(null);
})();
