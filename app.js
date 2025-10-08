// app.js – preview auto-show + smooth scroll + badges
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

function revealPreviewAndScroll(){
  // visa preview om vi har sidor
  if(state.pages.length > 0){
    const wasHidden = preview.classList.contains('hidden');
    preview.classList.remove('hidden');
    updateBadges();

    // scrolla mjukt bara när preview nyss dök upp eller när man klickar "Demosidor"
    if (wasHidden) {
      // liten delay så layouten hinner måla
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
  // toggla preview + badges
  revealPreviewAndScroll();

  // bygg sidor
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

/* ————— Interaktion ————— */

// Kategori & stil → uppdatera hints/badges
$$('input[name="category"]').forEach(r=>{
  r.addEventListener('change', ()=>{
    state.form.category = $('input[name="category"]:checked').value;
    catHint.textContent = CAT_PRESETS[state.form.category].hint;
    updateBadges();
  });
});

styleSelect.addEventListener('change', ()=>{
  state.form.style = styleSelect.value;
  styleHint.textContent = STYLE_PRESETS[state.form.style].hint;
  updateBadges();
});

// Form → skapa grund (text placeholders tills API kopplas)
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
  state.pages = [
    { id:'p1', text:'Här är Nova. Hon är 6 år gammal och älskar äventyr.' },
    { id:'p2', text:'Vid bäcken hittar Nova ett löv som flyter. Hon följer det nyfiket.' },
    { id:'p3', text:'En liten träbro leder över vattnet. Nova tar mod till sig och går över.' },
    { id:'p4', text:'I gläntan står ett tält. Ryggsäcken får vila medan hon läser en bok.' }
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
  updateBadges();
  render(); // initial state (preview hålls dold)
})();
