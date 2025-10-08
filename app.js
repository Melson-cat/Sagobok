// app.js – dropdowns för kategori/stil, fasta sidantal, tema-switch + preview
const $ = (q, r=document)=> r.querySelector(q);
const $$ = (q, r=document)=> Array.from(r.querySelectorAll(q));

const form = $('#story-form');
const preview = $('#preview');
const bookEl = $('#book');
const statusEl = $('#status');
const exportBtn = $('#btn-export');
const mockBtn = $('#btn-mock');
const clearBtn = $('#btn-clear');
const badgeCat = $('#badge-cat');
const badgeStyle = $('#badge-style');
const styleSelect = $('#style');
const catSelect = $('#category');
const pagesSelect = $('#pages');
const catHint = $('#cat-hint');
const styleHint = $('#style-hint');

const CAT_PRESETS = {
  kids:  { label:'Barn',    hint:'Varm ton, enkla meningar, akvarell/pastell.' },
  pets:  { label:'Husdjur', hint:'Lekfull ton, nos-nivå, färgkrita.' },
  adult: { label:'Vuxen',   hint:'Humoristisk ton (SFW), serietidningskänsla.' }
};
const STYLE_PRESETS = {
  storybook:{ label:'Barnbok',     hint:'Akvarell, mjuka penseldrag, pastell.', badge:'storybook' },
  comic:    { label:'Serietidning',hint:'Tjockare konturer, halftone, kontrast.', badge:'comic' },
  painting: { label:'Målning',     hint:'Oljemåleri/impasto, texturer.', badge:'painting' },
  realism:  { label:'Realism',     hint:'Naturliga proportioner, foto-lika detaljer.', badge:'realism' }
};

let state = {
  phase: 'idle',
  form: {
    name: 'Nova',
    age: 6,
    pages: 12,            // default kort
    theme: '',
    category: 'kids',
    style: 'storybook'
  },
  title: 'Min AI-Sagobok',
  pages: [] // { id, text, imgUrl? }
};

function setStatus(msg){
  if(!msg){ statusEl.classList.add('hidden'); statusEl.textContent=''; return; }
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
}

function updateTheme(){
  // kategoristyrd palett
  document.body.setAttribute('data-theme', state.form.category);
}

function updateBadges(){
  badgeCat.textContent = `Kategori: ${CAT_PRESETS[state.form.category].label}`;
  badgeStyle.textContent = `Stil: ${STYLE_PRESETS[state.form.style].label}`;
  badgeStyle.dataset.style = STYLE_PRESETS[state.form.style].badge;
}

function revealPreviewAndScroll(){
  if(state.pages.length > 0){
    const wasHidden = preview.classList.contains('hidden');
    preview.classList.remove('hidden');
    updateBadges();
    if (wasHidden) {
      requestAnimationFrame(()=>{
        const header = document.querySelector('.site-header');
        const headerH = header ? header.getBoundingClientRect().height : 0;
        const top = preview.getBoundingClientRect().top + window.scrollY - (headerH + 12);
        window.scrollTo({ top, behavior:'smooth' });
      });
    }
  } else {
    preview.classList.add('hidden');
  }
}

function render(){
  revealPreviewAndScroll();

  bookEl.innerHTML = '';
  if(!state.pages.length){
    setStatus('Inga sidor ännu. Fyll i formuläret och klicka ”Skapa grund”, eller prova demo.');
    exportBtn.disabled = true;
    return;
  }
  setStatus('');
  exportBtn.disabled = false;

  state.pages.forEach((pg, idx)=>{
    const card = document.createElement('article');
    card.className = 'page';
    card.dataset.pageId = pg.id;

    const imgbox = document.createElement('div');
    imgbox.className = 'imgbox';
    imgbox.innerHTML = pg.imgUrl
      ? `<img alt="Illustration sida ${idx+1}" src="${pg.imgUrl}">`
      : `<span>Illustration kommer i steg 3</span>`;

    const content = document.createElement('div');
    content.className = 'content';
    content.innerHTML = `
      <h3>Sida ${idx+1}</h3>
      <p>${escapeHtml(pg.text)}</p>
      <div class="actions">
        <button class="btn btn-ghost" data-action="edit" data-id="${pg.id}">Redigera text</button>
        <button class="btn btn-ghost" data-action="img" data-id="${pg.id}" disabled>Skapa bild (steg 3)</button>
      </div>
    `;

    card.append(imgbox, content);
    bookEl.append(card);
  });
}

/* ——— Interaktion ——— */

// Kategori → tema + hint + badge
catSelect.addEventListener('change', ()=>{
  state.form.category = catSelect.value;
  catHint.textContent = CAT_PRESETS[state.form.category].hint;
  updateTheme();
  updateBadges();
});

// Stil → hint + badge
styleSelect.addEventListener('change', ()=>{
  state.form.style = styleSelect.value;
  styleHint.textContent = STYLE_PRESETS[state.form.style].hint;
  updateBadges();
});

// Form → skapa grund (sidantal från select)
form.addEventListener('submit', (e)=>{
  e.preventDefault();
  const fd = new FormData(form);
  state.form.name = (fd.get('name') || 'Nova').toString().trim();
  state.form.age = Number(fd.get('age') || 6);
  state.form.pages = Number(fd.get('pages') || 12);
  state.form.theme = (fd.get('theme') || '').toString().trim();

  state.phase = 'story_ready';
  state.title = `${state.form.name} – ett äventyr`;

  const txt = state.form.theme || 'Ett litet äventyr börjar…';
  state.pages = Array.from({length: state.form.pages}, (_,i)=>({
    id:`p${i+1}`,
    text:`(Sida ${i+1}) ${txt}`
  }));

  render();
});

// Demo-sidor
mockBtn?.addEventListener('click', ()=>{
  state.phase = 'story_ready';
  state.form.pages = 12;
  state.pages = [
    { id:'p1', text:'Här är Nova. Hon är 6 år gammal och älskar äventyr.' },
    { id:'p2', text:'Vid bäcken hittar Nova ett löv som flyter. Hon följer det nyfiket.' },
    { id:'p3', text:'En liten träbro leder över vattnet. Nova tar mod till sig och går över.' },
    { id:'p4', text:'I gläntan står ett tält. Ryggsäcken får vila medan hon läser en bok.' },
    { id:'p5', text:'Molnen speglar sig i vattnet när vinden viskar i träden.' },
    { id:'p6', text:'Nova möter en ekorre som visar en gömd stig.' },
    { id:'p7', text:'Stigen leder till en solig glänta med blommor.' },
    { id:'p8', text:'Hon bygger en liten lövbåt och sjösätter den.' },
    { id:'p9', text:'Båten fastnar – Nova räddar den med en pinne.' },
    { id:'p10', text:'På bron vinkar hon till spegelbilden i vattnet.' },
    { id:'p11', text:'I tältet tänder hon lampan och läser vidare.' },
    { id:'p12', text:'Dagen avslutas med en varm filt och stjärnljus.' }
  ];
  render();
});

// Rensa
clearBtn?.addEventListener('click', ()=>{
  state.phase = 'idle';
  state.pages = [];
  render();
});

// Redigering (modal)
const pageModal = $('#pageModal');
const modalText = $('#modalText');
bookEl.addEventListener('click', (e)=>{
  const btn = e.target.closest('button[data-action]');
  if(!btn) return;
  const id = btn.dataset.id;
  const pg = state.pages.find(p=>p.id===id);
  if(!pg) return;

  if(btn.dataset.action === 'edit'){
    modalText.value = pg.text;
    pageModal.showModal();

    const onClose = (ev)=>{
      if(ev?.target?.value === 'save'){
        pg.text = modalText.value.trim();
        render();
      }
      pageModal.removeEventListener('close', onClose);
    };
    pageModal.addEventListener('close', onClose);
  }
});

// Utility
function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

// Init
(function init(){
  catHint.textContent   = CAT_PRESETS[state.form.category].hint;
  styleHint.textContent = STYLE_PRESETS[state.form.style].hint;
  updateTheme();
  updateBadges();
})();
