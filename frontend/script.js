/* ===================================================================
renderSkeleton(5); setStatus("✏️ Skriver berättelsen…", 8); startQuips();
els.submitBtn.disabled = true; els.submitBtn.innerHTML = 'Skapar förhandsvisning… <span class="spinner"></span>';


state.images_by_page.clear(); state.cover_preview_url = null; state.cover_image_id = null;


try {
// 1) STORY (alltid 14 sidor för uppslag)
const storyRes = await fetch(`${API}/api/story`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: state.form.name, age: state.form.age, reading_age: state.form.reading_age, pages: STORY_PAGES, category: state.form.category, style: state.form.style, theme: state.form.theme, traits: state.form.traits }) });
const storyData = await storyRes.json().catch(()=>({}));
if (!storyRes.ok || storyData?.error) throw new Error(storyData?.error || `HTTP ${storyRes.status}`);
state.story = storyData.story; state.plan = storyData.plan || { plan: [] };


const pages = state.story?.book?.pages || []; if (!pages.length) throw new Error("Berättelsen saknar sidor.");
// klipp för säkerhets skull till 14
if (pages.length > STORY_PAGES) state.story.book.pages = pages.slice(0, STORY_PAGES);
buildCards(state.story.book.pages, state.visibleCount);
setStatus("🖼️ Låser hjälten (referens)…", 22);


// 2) REF IMAGE
const refRes = await fetch(`${API}/api/ref-image`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ style: state.form.style, photo_b64: state.form.refMode === "photo" ? state.form.photoDataUrl : null, bible: state.story?.book?.bible || null, traits: state.form.traits || "" }) });
const refData = await refRes.json().catch(()=>({})); if (!refRes.ok || refData?.error) throw new Error(refData?.error || `HTTP ${refRes.status}`);
state.ref_b64 = refData.ref_image_b64 || null; if (!state.ref_b64) throw new Error("Ingen referensbild kunde skapas.");


// 3) INTERIOR IMAGES
setStatus("🎥 Lägger kameror & ljus…", 38);
const imgRes = await fetch(`${API}/api/images`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ style: state.form.style, ref_image_b64: state.ref_b64, story: state.story, plan: state.plan, concurrency: 4 }) });
const imgData = await imgRes.json().catch(()=>({})); if (!imgRes.ok || imgData?.error) throw new Error(imgData?.error || "Bildgenerering misslyckades");


const results = imgData.images || []; let received = 0; for (const row of results) {
if (row?.image_url) { state.images_by_page.set(row.page, { image_url: row.image_url }); fillCard(row.page, row.image_url, "Gemini"); }
else { const wrap = els.previewGrid.querySelector(`.imgwrap[data-page="${row.page}"]`); if (wrap) { const fb = document.createElement("div"); fb.className = "img-fallback"; fb.textContent = "Kunde inte generera bild"; wrap.appendChild(fb); wrap.parentElement.querySelector(".retry-wrap")?.classList.remove("hidden"); } }
received++; setStatus(`🎨 Målar sida ${received}/${results.length}…`, 38 + (received/Math.max(1,results.length))*32);
}


// 4) COVER (icke-blockerande)
if (COVER_STRATEGY === "async") { generateCoverAsync().catch(()=>{}); setStatus("☁️ Laddar upp illustrationer…", 86); }
else { setStatus("☁️ Laddar upp illustrationer…", 86); }


// 5) CF Images upload
const items = []; for (const p of state.story.book.pages) { const row = state.images_by_page.get(p.page); if (!row) continue; const du = row.data_url || (row.image_url ? await urlToDataURL(row.image_url) : null); if (du) items.push({ page: p.page, data_url: du }); }
if (items.length) {
const uploads = await uploadToCF(items);
const byPage = new Map(); for (const u of uploads) if (Number.isFinite(u.page)) byPage.set(u.page, u);
for (const p of state.story.book.pages) { const u = byPage.get(p.page); if (u?.image_id) { state.images_by_page.set(p.page, { image_id: u.image_id, image_url: u.url }); fillCard(p.page, u.url || state.images_by_page.get(p.page)?.image_url || "", "CF"); } }
}


stopQuips(); setStatus("✅ Klart! Förhandsvisning redo.", 100); if (els.pdfBtn) els.pdfBtn.disabled = false;
} catch (e) {
console.error(e); stopQuips(); setStatus(null); alert("Ett fel uppstod: " + (e?.message || e));
} finally { els.submitBtn.disabled = false; els.submitBtn.textContent = "Skapa förhandsvisning"; }
}


/* --------------------------- Single regenerate --------------------------- */
async function regenerateOne(page) {
if (!state.ref_b64) return; const pg = state.story?.book?.pages?.find((p) => p.page === page); const frame = state.plan?.plan?.find((f) => f.page === page);
const wrap = els.previewGrid.querySelector(`.imgwrap[data-page="${page}"]`); if (!wrap) return; wrap.querySelector(".img-fallback")?.remove(); const sk = document.createElement("div"); sk.className = "skeleton"; wrap.prepend(sk);
try {
const res = await fetch(`${API}/api/image/regenerate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ style: state.form.style, ref_image_b64: state.ref_b64, page_text: pg?.text || "", scene_text: (pg?.scene || "").replace(/“.+?”|".+?"/g, "").trim(), frame, story: state.story }) });
const j = await res.json().catch(()=>({})); if (!res.ok || j?.error) throw new Error(j?.error || `HTTP ${res.status}`);
sk.remove(); await fillCard(page, j.image_url, "Gemini"); state.images_by_page.set(page, { image_url: j.image_url });
} catch (e) {
sk.remove(); const fb = document.createElement("div"); fb.className = "img-fallback"; fb.innerHTML = `Kunde inte generera bild\n <div class="retry-wrap" style="margin-top:8px;">\n <button class="retry-btn retry" data-page="${page}">🔄 Generera igen</button>\n </div>`; wrap.appendChild(fb);
}
}


// Generera omslag i bakgrunden
async function generateCoverAsync() {
try {
const timeoutMs = 12000; const timeout = new Promise((_, rej) => setTimeout(()=>rej(new Error("cover-timeout")), timeoutMs));
const covRes = await Promise.race([ fetch(`${API}/api/cover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ style: state.form.style, ref_image_b64: state.ref_b64, story: state.story }) }) , timeout ]);
if (!(covRes instanceof Response)) return; const cov = await covRes.json().catch(()=>({})); if (!covRes.ok || cov?.error) return;
state.cover_preview_url = cov.image_url || null; if (state.cover_preview_url) fillCard(0, state.cover_preview_url, "Gemini");
const du = await urlToDataURL(state.cover_preview_url); if (!du) return; const uploads = await uploadToCF([{ kind: "cover", data_url: du }]).catch(()=>[]);
const u = uploads?.find(x => x.kind === "cover" || x.page === 0); if (u?.image_id) { state.cover_image_id = u.image_id; state.cover_preview_url = u.url || state.cover_preview_url; fillCard(0, state.cover_preview_url, "CF"); }
} catch { /* no-op */ }
}


/* --------------------------- Events & Init --------------------------- */
function bindEvents() {
els.catKidsBtn?.addEventListener("click", () => setCategory("kids"));
els.catPetsBtn?.addEventListener("click", () => setCategory("pets"));
els.refDescBtn?.addEventListener("click", () => setRefMode("desc"));
els.refPhotoBtn?.addEventListener("click", () => setRefMode("photo"));
readingAgeSeg.forEach((btn) => { btn.addEventListener("click", () => { readingAgeSeg.forEach((b)=>b.classList.remove("active")); btn.classList.add("active"); setReadingAgeByChip(btn.getAttribute("data-readage")); }); });
["name","age","style","theme","traits","readingAge"].forEach((id) => { const el = document.getElementById(id); el?.addEventListener("input", () => { readForm(); saveForm(); }); });
els.charPhoto?.addEventListener("change", async () => { const f = els.charPhoto.files?.[0]; if (!f) { state.form.photoDataUrl = null; els.photoPreview.classList.add("hidden"); els.photoPreview.src = ""; saveForm(); return; } const dataUrl = await downscaleFileToDataURL(f, MAX_REF_DIM); state.form.photoDataUrl = dataUrl; els.photoPreview.src = dataUrl; els.photoPreview.classList.remove("hidden"); saveForm(); });
els.form?.addEventListener("submit", onSubmit);
els.previewGrid?.addEventListener("click", (e) => { const t = e.target; if (t && t.classList.contains("retry-btn")) { e.preventDefault(); const page = Number(t.getAttribute("data-page")); if (page) regenerateOne(page); } });
els.navToggle?.addEventListener("click", () => { els.mobileMenu.classList.toggle("open"); const open = els.mobileMenu.classList.contains("open"); els.navToggle.setAttribute("aria-expanded", open ? "true" : "false"); els.mobileMenu.setAttribute("aria-hidden", open ? "false" : "true"); });
els.pdfBtn?.addEventListener("click", onCreatePdf); if (els.pdfBtn) els.pdfBtn.disabled = false;
}
(function init(){ loadForm(); if (state.form.refMode !== "photo" && state.form.refMode !== "desc") state.form.refMode = "photo"; writeForm(); bindEvents(); setStatus(null); })();