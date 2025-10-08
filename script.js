/* =========================================================
   BokPiloten – Front state & UI helpers (v1.2)
   Fokus: robust UI utan riktig API-koppling (än)
   ========================================================= */

// ---------- DOM lookups ----------
const els = {
  body: document.body,
  form: document.getElementById('storyForm'),
  category: document.getElementById('category'),
  name: document.getElementById('name'),
  age: document.getElementById('age'),
  pages: document.getElementById('pages'),
  style: document.getElementById('style'),
  theme: document.getElementById('theme'),
  traits: document.getElementById('traits'),
  charPhoto: document.getElementById('charPhoto'),
  photoPreview: document.getElementById('photoPreview'),
  demoBtn: document.getElementById('demoBtn'),

  previewSection: document.getElementById('preview'),
  previewGrid: document.getElementById('bookPreview'),

  navToggle: document.getElementById('navToggle'),
  mobileMenu: document.getElementById('mobileMenu'),
};

// ---------- App state ----------
const state = {
  form: {
    name: 'Nova',
    age: 6,
    pages: 16,
    category: 'kids',
    style: 'storybook',
    theme: '',
    traits: '',
    photoDataUrl: null,
    tone: 'vardaglig',
  },
  pages: [],                  // [{idx, text, img}]
  visibleCount: 4,            // antal skarpa kort i preview
  loadingImages: new Set(),   // pågående bildladdningar
  status: null,               // ev. statusmeddelande
};

// ---------- Constants ----------
const STORAGE_KEY = 'bokpiloten_form_v1';
const MAX_AGE = 120;
const MIN_AGE = 1;
const VALID_PAGES = new Set([12, 16, 20]);

// ---------- Utils ----------
const $ = (q, r=document)=> r.querySelector(q);
function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function toInt(v, fallback=0){
  const n = parseInt(v,10);
  return Number.isFinite(n) ? n : fallback;
}
function smoothScrollTo(el){
  el?.scrollIntoView({behavior:'smooth', block:'start'});
}

// Throttle loader: släpp in X bilder i taget för att undvika nät-burst
async function loadImageThrottled(src, concurrency = 4){
  // enkel gate via Set storlek
  while (state.loadingImages.size >= concurrency){
    await new Promise(r => setTimeout(r, 60));
  }
  state.loadingImages.add(src);
  try {
    await new Promise((resolve, reject)=>{
      const img = new Image();
      img.onload = resolve;
      img.onerror = reject;
      img.src = src;
    });
  } finally {
    state.loadingImages.delete(src);
  }
}

// ---------- Persistence ----------
function saveFormToStorage(){
  try {
    const payload = JSON.stringify(state.form);
    localStorage.setItem(STORAGE_KEY, payload);
  } catch {}
}
function loadFormFromStorage(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    const obj = JSON.parse(raw);
    Object.assign(state.form, obj || {});
  } catch {}
}

// ---------- Form <-> State sync ----------
function readForm(){
  const f = state.form;
  f.name = (els.name.value || 'Nova').trim();
  f.age = clamp(toInt(els.age.value, 6), MIN_AGE, MAX_AGE);
  f.pages = toInt(els.pages.value, 16);
  if(!VALID_PAGES.has(f.pages)) f.pages = 16;
  f.category = els.category.value || 'kids';
  f.style = els.style.value || 'storybook';
  f.theme = (els.theme.value || '').trim();
  f.traits = (els.traits.value || '').trim();
}
function writeForm(){
  els.name.value = state.form.name ?? 'Nova';
  els.age.value = state.form.age ?? 6;
  els.pages.value = String(state.form.pages ?? 16);
  els.category.value = state.form.category ?? 'kids';
  els.style.value = state.form.style ?? 'storybook';
  els.theme.value = state.form.theme ?? '';
  els.traits.value = state.form.traits ?? '';
  els.body.dataset.theme = state.form.category;
}
function setStatus(msg){
  state.status = msg;
  let bar = $('#statusBar');
  if(!bar){
    bar = document.createElement('div');
    bar.id = 'statusBar';
    bar.className = 'status-bar';
    els.previewSection?.insertAdjacentElement('afterbegin', bar);
  }
  if(!msg){ bar.classList.add('hidden'); bar.textContent=''; return; }
  bar.textContent = msg;
  bar.classList.remove('hidden');
}

// ---------- Validation ----------
function validateForm(){
  readForm();
  const problems = [];

  if(!state.form.name) problems.push('Ange ett namn.');
  if(state.form.age < MIN_AGE || state.form.age > MAX_AGE) problems.push('Åldern verkar orimlig.');
  if(!VALID_PAGES.has(state.form.pages)) problems.push('Ogiltigt sidantal.');

  // (valfri) enkel sanity på tematext
  if(state.form.theme.length > 140) problems.push('Tema/handling är väl långt – håll det kort (≤ 140 tecken).');

  return problems;
}

// ---------- Demo / Mock ----------
function makeDemoPages(total = 12, name = 'Nova', theme = 'äventyr'){
  // deterministiska seeds så samma sida alltid ger samma bild-URL
  return Array.from({length: total}, (_,i)=>({
    idx: i+1,
    text: `Sida ${i+1}: ${name} fortsätter ${theme}.`,
    img: `https://picsum.photos/seed/bp_${i+1}/600/400`
  }));
}

// ---------- Preview rendering ----------
function renderPreview(pages, visibleCount=4){
  els.previewGrid.innerHTML = '';
  const frag = document.createDocumentFragment();

  pages.forEach((p, i) => {
    const card = document.createElement('article');
    card.className = 'thumb';
    if (i >= visibleCount) card.classList.add('locked');

    // Skeleton medan bild laddar
    card.innerHTML = `
      <div class="imgwrap">
        <div class="skeleton"></div>
        <img alt="Sida ${p.idx}" style="opacity:0" />
      </div>
      <div class="txt">${escapeHtml(p.text)}</div>
    `;
    frag.appendChild(card);

    // Ladda bild throttlat
    const imgEl = card.querySelector('img');
    loadImageThrottled(p.img).then(()=>{
      imgEl.src = p.img;
      imgEl.onload = () => {
        card.querySelector('.skeleton')?.remove();
        imgEl.style.opacity = '1';
      };
    }).catch(()=>{
      card.querySelector('.skeleton')?.remove();
      imgEl.replaceWith(Object.assign(document.createElement('div'), {
        className:'img-fallback',
        textContent:'Kunde inte ladda bild'
      }));
    });
  });

  els.previewGrid.appendChild(frag);
  els.previewSection.classList.remove('hidden');
  smoothScrollTo(els.previewSection);
}

// ---------- Events ----------
function onThemeChange(){
  state.form.category = els.category.value;
  document.body.dataset.theme = state.form.category;
  saveFormToStorage();
}

function onPhotoChange(){
  const file = els.charPhoto.files?.[0];
  if(!file){ state.form.photoDataUrl = null; els.photoPreview.classList.add('hidden'); els.photoPreview.src=''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    state.form.photoDataUrl = reader.result;
    els.photoPreview.src = state.form.photoDataUrl;
    els.photoPreview.classList.remove('hidden');
    saveFormToStorage();
  };
  reader.readAsDataURL(file);
}

function onSubmit(e){
  e.preventDefault();
  const problems = validateForm();
  if(problems.length){
    alert('Korrigera innan förhandsvisning:\n\n• ' + problems.join('\n• '));
    return;
  }
  saveFormToStorage();

  // mocka fram sidor enligt valt sidantal
  state.pages = makeDemoPages(state.form.pages, state.form.name, state.form.theme || 'ett äventyr');
  setStatus(`Visar de ${state.visibleCount} första sidorna. Övriga är suddade tills du skapar boken.`);

  renderPreview(state.pages, state.visibleCount);
}

function onDemo(){
  // demo alltid 12 sidor
  state.pages = makeDemoPages(12, 'Nova', 'ett litet äventyr');
  setStatus('Detta är en demo. Endast de 4 första visas skarpt.');
  renderPreview(state.pages, 4);
}

// Mobilmeny
els.navToggle?.addEventListener('click', ()=>{
  els.mobileMenu.classList.toggle('open');
  const open = els.mobileMenu.classList.contains('open');
  els.mobileMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
});

// Persistens & bindingar
function bindEvents(){
  els.category.addEventListener('change', onThemeChange);
  els.charPhoto.addEventListener('change', onPhotoChange);
  els.form.addEventListener('submit', onSubmit);
  els.demoBtn.addEventListener('click', onDemo);

  // Spara löpande när fält ändras
  ['name','age','pages','style','theme','traits'].forEach(id=>{
    const el = document.getElementById(id);
    el?.addEventListener('input', ()=>{
      readForm(); saveFormToStorage();
    });
  });
}

// ---------- Init ----------
(function init(){
  // ladda tidigare val (om finns)
  loadFormFromStorage();
  writeForm();
  bindEvents();

  // initialt tema
  document.body.dataset.theme = state.form.category;

  // “clean up” på ev. statusbar från tidigare session
  setStatus(null);
})();
