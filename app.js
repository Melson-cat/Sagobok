// app.js – steg 1: bara layout & mock, inga API-anrop ännu
const $ = (q, r=document)=> r.querySelector(q);
const $$ = (q, r=document)=> Array.from(r.querySelectorAll(q));

const bookEl = $('#book');
const statusEl = $('#status');
const exportBtn = $('#btn-export');
const mockBtn = $('#btn-mock');
const clearBtn = $('#btn-clear');
const form = $('#story-form');

const pageModal = $('#pageModal');
const modalText = $('#modalText');
const modalSave = $('#modalSave');

// Enkel state för detta steg
let state = {
  title: 'Min AI-Sagobok',
  pages: [] // { id, text, imgUrl? }
};

function setStatus(msg){
  if(!msg){
    statusEl.classList.add('hidden');
    statusEl.textContent = '';
    return;
  }
  statusEl.textContent = msg;
  statusEl.classList.remove('hidden');
}

function render(){
  bookEl.innerHTML = '';
  if(!state.pages.length){
    setStatus('Inga sidor ännu. Använd "Fyll med demo-sidor" för att se layouten.');
  } else {
    setStatus('');
  }

  state.pages.forEach((pg, idx)=>{
    const card = document.createElement('article');
    card.className = 'page';
    card.dataset.pageId = pg.id;

    const imgbox = document.createElement('div');
    imgbox.className = 'imgbox';
    imgbox.innerHTML = pg.imgUrl
      ? `<img alt="Illustration sida ${idx+1}" src="${pg.imgUrl}">`
      : `<span>Illustration saknas</span>`;

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

  exportBtn.disabled = !state.pages.length;
}

// Demo: Skapa mock-sidor (som om GPT levererat text)
mockBtn?.addEventListener('click', ()=>{
  const demo = [
    'Här är Nova. Hon är 6 år gammal och älskar äventyr.',
    'Vid bäcken hittar Nova ett löv som flyter. Hon följer det nyfiket.',
    'En liten träbro leder över vattnet. Nova tar mod till sig och går över.',
    'I gläntan står ett tält. Ryggsäcken får vila medan hon läser en bok.'
  ];
  state.pages = demo.map((t,i)=>({ id: `p${i+1}`, text: t }));
  render();
});

clearBtn?.addEventListener('click', ()=>{
  state.pages = [];
  render();
});

// Form – i steg 2 kommer vi byta till /api/story
form?.addEventListener('submit', (e)=>{
  e.preventDefault();
  const fd = new FormData(form);
  const name = (fd.get('name') || 'Nova').toString().trim();
  const age = Number(fd.get('age') || 6);
  const pages = Math.max(6, Math.min(20, Number(fd.get('pages') || 10)));
  const theme = (fd.get('theme') || '').toString().trim();

  state.title = `${name} – ett äventyr`;
  state.pages = Array.from({length: pages}, (_,i)=>({
    id:`p${i+1}`,
    text:`(Sida ${i+1}) Text läggs in i steg 2 – tema: ${theme || '—'}`
  }));

  render();
});

// Enkel delegering för redigering (placeholder för framtida API-koppling)
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

// Hjälp: enkel HTML-escape för att undvika konstiga injektioner i demo
function escapeHtml(s){
  return String(s)
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'",'&#039;');
}

// Init
render();
