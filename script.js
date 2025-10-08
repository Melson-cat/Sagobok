/* =========================================================
   BokPiloten – Front state & UI (v1.3) – ref toggle / no tone
   ========================================================= */
const BACKEND = "https://bokpilot-backend.sebastian-runell.workers.dev"; 
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

  // ref toggle
  refDescBtn: document.getElementById('refDescBtn'),
  refPhotoBtn: document.getElementById('refPhotoBtn'),
  traitsBlock: document.getElementById('traitsBlock'),
  photoBlock: document.getElementById('photoBlock'),

  demoBtn: document.getElementById('demoBtn'),
  previewSection: document.getElementById('preview'),
  previewGrid: document.getElementById('bookPreview'),

  navToggle: document.getElementById('navToggle'),
  mobileMenu: document.getElementById('mobileMenu'),
};

const submitBtn = document.querySelector('#storyForm .btn-primary');

function setLoading(is){
  if(!submitBtn) return;
  submitBtn.disabled = is;
  submitBtn.innerHTML = is ? 'Skapar berättelse… <span class="spinner"></span>' : 'Skapa förhandsvisning';
}


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
    refMode: 'desc', // 'desc' | 'photo'
  },
  pages: [],
  visibleCount: 4,
  loadingImages: new Set(),
  status: null,
};

const STORAGE_KEY = 'bokpiloten_form_v2';
const MAX_AGE = 120;
const MIN_AGE = 1;
const VALID_PAGES = new Set([12, 16, 20]);

function escapeHtml(s){
  return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;')
    .replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function toInt(v, fb=0){ const n = parseInt(v,10); return Number.isFinite(n)?n:fb; }
function smoothScrollTo(el){ el?.scrollIntoView({behavior:'smooth', block:'start'}); }

async function loadImageThrottled(src, concurrency = 4){
  while (state.loadingImages.size >= concurrency) await new Promise(r=>setTimeout(r,60));
  state.loadingImages.add(src);
  try{
    await new Promise((res,rej)=>{ const i=new Image(); i.onload=res; i.onerror=rej; i.src=src; });
  } finally { state.loadingImages.delete(src); }
}

function saveForm(){ try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state.form)); }catch{} }
function loadForm(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return;
    Object.assign(state.form, JSON.parse(raw)||{});
  }catch{}
}

function readForm(){
  const f = state.form;
  f.name = (els.name.value || 'Nova').trim();
  f.age = clamp(toInt(els.age.value, 6), MIN_AGE, MAX_AGE);
  f.pages = toInt(els.pages.value, 16); if(!VALID_PAGES.has(f.pages)) f.pages = 16;
  f.category = els.category.value || 'kids';
  f.style = els.style.value || 'storybook';
  f.theme = (els.theme.value || '').trim();
  f.traits = (els.traits.value || '').trim();
}
function writeForm(){
  els.name.value = state.form.name;
  els.age.value = state.form.age;
  els.pages.value = String(state.form.pages);
  els.category.value = state.form.category;
  els.style.value = state.form.style;
  els.theme.value = state.form.theme;
  els.traits.value = state.form.traits;
  document.body.dataset.theme = state.form.category;

  // visa rätt block för refMode
  setRefMode(state.form.refMode, false);
  if(state.form.photoDataUrl){
    els.photoPreview.src = state.form.photoDataUrl;
    els.photoPreview.classList.remove('hidden');
  }
}

function setStatus(msg){
  let bar = document.getElementById('statusBar');
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

/* ===== Validation ===== */
function validateForm(){
  readForm();
  const problems = [];
  if(!state.form.name) problems.push('Ange ett namn.');
  if(state.form.age < MIN_AGE || state.form.age > MAX_AGE) problems.push('Åldern verkar orimlig.');
  if(!VALID_PAGES.has(state.form.pages)) problems.push('Ogiltigt sidantal.');
  if(state.form.theme.length > 160) problems.push('Tema/handling: håll det kort (≤ 160 tecken).');

  // refMode krav: antingen beskrivning eller foto
  if(state.form.refMode === 'desc'){
    if(!state.form.traits || state.form.traits.length < 10){
      problems.push('Beskriv gärna kännetecken (minst ~10 tecken).');
    }
  } else if(state.form.refMode === 'photo'){
    if(!state.form.photoDataUrl){
      problems.push('Ladda upp ett foto eller byt till Beskrivning.');
    }
  }
  return problems;
}

/* ===== Demo / Mock ===== */
function makeDemoPages(total=12, name='Nova', theme='äventyr'){
  return Array.from({length: total}, (_,i)=>({
    idx: i+1,
    text: `Sida ${i+1}: ${name} fortsätter ${theme}.`,
    img: `https://picsum.photos/seed/bp_${i+1}/600/400`
  }));
}

/* ===== Preview ===== */
function renderPreview(pages, visibleCount=4){
  els.previewGrid.innerHTML = '';
  const frag = document.createDocumentFragment();

  pages.forEach((p, i) => {
    const card = document.createElement('article');
    card.className = 'thumb';
    if (i >= visibleCount) card.classList.add('locked');

    card.innerHTML = `
      <div class="imgwrap">
        <div class="skeleton"></div>
        <img alt="Sida ${p.idx}" style="opacity:0" />
      </div>
      <div class="txt">${escapeHtml(p.text)}</div>
    `;
    frag.appendChild(card);

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
        className:'img-fallback', textContent:'Kunde inte ladda bild'
      }));
    });
  });

  els.previewGrid.appendChild(frag);
  els.previewSection.classList.remove('hidden');
  smoothScrollTo(els.previewSection);
}

/* ===== Ref toggle ===== */
function setRefMode(mode, focus = true){
  state.form.refMode = mode;
  // UI
  if(mode === 'desc'){
    els.refDescBtn.classList.add('active');
    els.refPhotoBtn.classList.remove('active');
    els.traitsBlock.classList.remove('hidden');
    els.photoBlock.classList.add('hidden');
    if(focus) els.traits.focus();
  } else {
    els.refPhotoBtn.classList.add('active');
    els.refDescBtn.classList.remove('active');
    els.photoBlock.classList.remove('hidden');
    els.traitsBlock.classList.add('hidden');
    if(focus) els.charPhoto.focus();
  }
  saveForm();
}

/* ===== Events ===== */
function onThemeChange(){
  state.form.category = els.category.value;
  document.body.dataset.theme = state.form.category;
  saveForm();
}

function onPhotoChange(){
  const file = els.charPhoto.files?.[0];
  if(!file){
    state.form.photoDataUrl = null;
    els.photoPreview.classList.add('hidden');
    els.photoPreview.src = '';
    saveForm();
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    state.form.photoDataUrl = reader.result;
    els.photoPreview.src = state.form.photoDataUrl;
    els.photoPreview.classList.remove('hidden');
    saveForm();
  };
  reader.readAsDataURL(file);
}

async function onSubmit(e){
  e.preventDefault();

  const problems = validateForm();
  if(problems.length){
    alert('Korrigera:\n\n• ' + problems.join('\n• '));
    return;
  }

  // samla state
  readForm();
  const payload = {
    name: state.form.name,
    age: state.form.age,
    pages: state.form.pages,
    category: state.form.category,
    style: state.form.style,
    theme: state.form.theme,
    refMode: state.form.refMode,
    traits: state.form.traits || null
  };
renderSkeleton(4);

  try{
    setStatus('Skickar till story-agent...');
    setLoading(true);

    const res = await fetch(`${BACKEND}/api/story`, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if(data?.error){
      setStatus(null);
      console.error("Story error:", data.error);
      alert("Tyvärr uppstod ett fel: " + data.error);
      return;
    }

    // 🔍 Gör console-läsningen tydlig
    console.log("Story title:", data?.story?.book?.title);
    console.log("Pages count:", data?.story?.book?.pages?.length);
    console.dir(data.story);                                // expandera i devtools
    console.log("Raw JSON:", JSON.stringify(data.story, null, 2));
    window.lastStory = data.story;                          // lätt att inspektera senare

    // 🖼 Snabb första render: ta text per sida + placeholder-bilder
    const pages = (data?.story?.book?.pages || []).map(p => ({
      idx: p.page,
      text: p.text,
      img: `https://picsum.photos/seed/preview_${p.page}/600/400`
    }));

    const visible = data?.previewVisible ?? 4;
    setStatus(`Visar de ${visible} första sidorna. Övriga är suddade tills du skapar boken.`);
    renderPreview(pages, visible);

  }catch(err){
    setStatus(null);
    console.error(err);
    alert('Nätverksfel eller serverfel. Försök igen.');
  }finally{
    setLoading(false);
  }
}


function renderSkeleton(count=4){
  grid.innerHTML = '';
  for(let i=0;i<count;i++){
    const el = document.createElement('article');
    el.className = 'thumb';
    el.innerHTML = `
      <div class="imgwrap"><div class="skeleton"></div></div>
      <div class="txt"><span class="skeleton" style="display:block;height:12px;margin-bottom:8px"></span>
      <span class="skeleton" style="display:block;height:12px;width:60%"></span></div>`;
    grid.appendChild(el);
  }
  preview.classList.remove('hidden');
}

function onDemo(){
  state.pages = makeDemoPages(12, 'Nova', 'ett litet äventyr');
  setStatus('Detta är en demo. Endast de 4 första visas skarpt.');
  renderPreview(state.pages, 4);
}

function bindEvents(){
  els.category.addEventListener('change', onThemeChange);
  els.charPhoto.addEventListener('change', onPhotoChange);
  els.form.addEventListener('submit', onSubmit);
  els.demoBtn.addEventListener('click', onDemo);

  els.refDescBtn.addEventListener('click', ()=> setRefMode('desc'));
  els.refPhotoBtn.addEventListener('click', ()=> setRefMode('photo'));

  ['name','age','pages','style','theme','traits'].forEach(id=>{
    const el = document.getElementById(id);
    el?.addEventListener('input', ()=>{ readForm(); saveForm(); });
  });

  // mobilmeny
  els.navToggle?.addEventListener('click', ()=>{
    els.mobileMenu.classList.toggle('open');
    const open = els.mobileMenu.classList.contains('open');
    els.mobileMenu.setAttribute('aria-hidden', open ? 'false' : 'true');
  });
}

/* ===== Init ===== */
(function init(){
  loadForm();
  writeForm();
  bindEvents();
  setStatus(null);
})();
