// app.js – steg 1: layout + presets för kategori och stil (ingen API-koppling än)
const $ = (q, r=document)=> r.querySelector(q);
const $$ = (q, r=document)=> Array.from(r.querySelectorAll(q));

const form = $('#story-form');
const bookEl = $('#book');
const statusEl = $('#status');
const exportBtn = $('#btn-export');
const mockBtn = $('#btn-mock');
const clearBtn = $('#btn-clear');
const preview = $('#preview');
const badgeCat = $('#badge-cat');
const badgeStyle = $('#badge-style');
const styleSelect = $('#style');
const catHint = $('#cat-hint');
const styleHint = $('#style-hint');

// Presets för kategori & stil (enkla texter för UI och senare prompts)
const CAT_PRESETS = {
  kids: {
    label: 'Barn',
    hint: 'Varm ton, enkla meningar, akvarell/pastell.',
    defaultStyle: 'storybook'
  },
  pets: {
    label: 'Husdjur',
    hint: 'Lekfull ton, nos-nivå, färgkrita.',
    defaultStyle: 'storybook'
  },
  adult: {
    label: 'Vuxen',
    hint: 'Humoristisk ton (SFW), serietidningskänsla.',
    defaultStyle: 'comic'
  }
};

const STYLE_PRESETS = {
  storybook: {
    label: 'Barnbok',
    hint: 'Akvarell, mjuka penseldrag, pastell.',
    badge: 'storybook'
  },
  comic: {
    label: 'Serietidning',
    hint: 'Tjockare konturer, halftone, stark kontrast.',
    badge: 'comic'
  },
  painting: {
    label: 'Målning',
    hint: 'Oljemåleri/impasto, texturer, penseldrag.',
    badge: 'painting'
  },
  realism: {
    label: 'Realism',
    hint: 'Naturliga proportioner, foto-lika detaljer.',
    badge: 'realism'
  }
};

// Enkel state-maskin
let state = {
  phase: 'idle', // idle → story_ready → preview_ready
  form: {
    name: 'Nova',
    age: 6,
    pages: 10,
    theme: '',
    category: 'kids',
    style: 'storybook',
    keepAspect: true,
    keepCamera: true
  },
  title: 'Min AI-Sagobok',
  pages: [] // { id, text, imgUrl? }
};

function setStatus(msg){
  if(!msg){ statusEl.classList.add('hidden'); statusEl.textContent=''; return; }
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
}

function updateBadges(){
  const cat = state.form.category;
  const style = state.form.style;
  badgeCat.textContent = `Kategori: ${CAT_PRESETS[cat].label}`;
  badgeStyle.textContent = `Stil: ${STYLE_PRESETS[style].label}`;
  badgeStyle.dataset.style = STYLE_PRESETS[style].badge;
}

function ensurePreviewVisibility(){
  if(state.pages.length > 0){ preview.classList.remove('hidden'); }
  else { preview.classList.add('hidden'); }
}

function render(){
  ensurePreviewVisibility();
  updateBadges();

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

// Händelser: kategori & stil uppdaterar hints
$$('input[name="category"]').forEach(radio=>{
  radio.addEventListener('change', ()=>{
    const val = $('input[name="category"]:checked').value;
    state.form.category = val;
    catHint.textContent = CAT_PRESETS[val].hint;
    // auto-välj default stil för vald kategori om användaren inte redan ändrat
    if(!state.userChangedStyle){
      state.form.style = CAT_PRESETS[val].defaultStyle;
      styleSelect.value = state.form.style;
      styleHint.textContent = STYLE_PRESETS[state.form.style].hint;
    }
    updateBadges();
  });
});

styleSelect.addEventListener('change', ()=>{
  const val = styleSelect.value;
  state.form.style = val;
  state.userChangedStyle = true;
  styleHint.textContent = STYLE_PRESETS[val].hint;
  updateBadges();
});

// Form – steg 1: skapa grund (mockade sidor)
form.addEventListener('submit', (e)=>{
  e.preventDefault();
  const fd = new FormData(form);
  state.form.name = (fd.get('name') || 'Nova').toString().trim();
  state.form.age = Number(fd.get('age') || 6);
  state.form.pages = Math.max(6, Math.min(20, Number(fd.get('pages') || 10)));
  state.form.theme = (fd.get('theme') || '').toString().trim();
  state.form.keepAspect = !!$('#keepAspect')?.checked;
  state.form.keepCamera = !!$('#keepCamera')?.checked;

  state.phase = 'story_ready';
  state.title = `${state.form.name} – ett äventyr`;

  // Mocka sidor tills vi kopplar API
  const txt = state.form.theme || 'Ett litet äventyr börjar…';
  state.pages = Array.from({length: state.form.pages}, (_,i)=>({
    id:`p${i+1}`,
    text:`(Sida ${i+1}) ${txt}`
  }));

  render();
});

// Demo-sidor
$('#btn-mock')?.addEventListener('click', ()=>{
  state.phase = 'story_ready';
  state.pages = [
    { id:'p1', text:'Här är Nova. Hon är 6 år gammal och älskar äventyr.' },
    { id:'p2', text:'Vid bäcken hittar Nova ett löv som flyter. Hon följer det nyfiket.' },
    { id:'p3', text:'En liten träbro leder över vattnet. Nova tar mod till sig och går över.' },
    { id:'p4', text:'I gläntan står ett tält. Ryggsäcken får vila medan hon läser en bok.' }
  ];
  render();
});

$('#btn-clear')?.addEventListener('click', ()=>{
  state.phase = 'idle';
  state.pages = [];
  render();
});

// Enkel redigering (utan API än)
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

// Hjälp
function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

// Init: sätt initiala hints/badges
(function init(){
  catHint.textContent = CAT_PRESETS[state.form.category].hint;
  styleHint.textContent = STYLE_PRESETS[state.form.style].hint;
  updateBadges();
  // preview är dold tills sidor finns
})();
