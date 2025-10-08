const form = document.getElementById('storyForm');
const preview = document.getElementById('preview');
const previewWrap = document.getElementById('bookPreview');
const category = document.getElementById('category');
const demoBtn = document.getElementById('demoBtn');

// Tema-byte efter kategori
category.addEventListener('change', () => {
  document.body.dataset.theme = category.value;
});

// Demo-data
demoBtn.addEventListener('click', () => {
  const pages = [
    { text: "Här är Nova. Hon älskar äventyr.", img: "https://picsum.photos/seed/nova/600/400" },
    { text: "Vid bäcken hittar hon ett löv som flyter.", img: "https://picsum.photos/seed/forest/600/400" },
    { text: "Hon bestämmer sig för att följa lövet längs vattnet.", img: "https://picsum.photos/seed/river/600/400" }
  ];
  showPreview(pages);
});

// Visa förhandsvisning (mock)
form.addEventListener('submit', e => {
  e.preventDefault();
  const name = document.getElementById('name').value || "Nova";
  const theme = document.getElementById('theme').value || "Ett äventyr vid bäcken";
  const pages = [
    { text: `${name} påbörjar sitt äventyr.`, img: "https://picsum.photos/seed/1/600/400" },
    { text: `${name} hittar något magiskt längs vägen.`, img: "https://picsum.photos/seed/2/600/400" },
    { text: `Slutet på ${theme.toLowerCase()}.`, img: "https://picsum.photos/seed/3/600/400" }
  ];
  showPreview(pages);
});

function showPreview(pages){
  previewWrap.innerHTML = "";
  pages.forEach(p=>{
    const card = document.createElement('div');
    card.className = 'preview-card';
    card.innerHTML = `<img src="${p.img}" alt=""><p>${p.text}</p>`;
    previewWrap.appendChild(card);
  });
  preview.classList.remove('hidden');
  preview.scrollIntoView({behavior:'smooth'});
}
