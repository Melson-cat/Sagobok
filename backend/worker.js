// ============================================================================
// BokPiloten – Worker v17 "Print-first PDF (210x210 + bleed) + CORS + Preflight"
// Endpoints: story, ref-image, images, image/regenerate, images/upload, pdf
// Requires env: API_KEY, GEMINI_API_KEY, IMAGES_API_TOKEN, CF_ACCOUNT_ID,
//               CF_IMAGES_ACCOUNT_HASH, (CF_IMAGES_VARIANT)
// PDF layout = tryckfast grid; preview = samma PDF (med watermark).
// ============================================================================

import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

/* ------------------------------- CORS ---------------------------------- */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
  "access-control-expose-headers": "Content-Disposition",
  "vary": "Origin",
};
const JSONH = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS };
const ok  = (data, init={}) => new Response(JSON.stringify(data), { status: init.status || 200, headers: { ...JSONH, ...(init.headers||{}) } });
const err = (msg, code=400, extra={}) => ok({ error: msg, ...extra }, { status: code });
const withCORS = (resp) => {
  const h = new Headers(resp.headers); for (const [k,v] of Object.entries(CORS)) h.set(k,v);
  return new Response(resp.body, { status: resp.status, headers: h });
};
const log = (...a) => { try { console.log(...a); } catch {} };
const OPENAI_MODEL = "gpt-4o-mini";

/* --------------------------- OpenAI (JSON) ----------------------------- */
async function openaiJSON(env, system, user) {
  const sys = system.toLowerCase().includes("json") ? system : system + "\nSvara endast som giltig json.";
  const usr = user.toLowerCase().includes("json") ? user : user + "\n(returnera bara json)";
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.6,
      messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status} ${await r.text().catch(()=> "")}`);
  const j = await r.json();
  return JSON.parse(j?.choices?.[0]?.message?.content || "{}");
}

/* --------------------------- Gemini (image) ---------------------------- */
function findGeminiImagePart(json) {
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts || cand?.content?.[0]?.parts || [];
  let p = parts.find(x => x?.inlineData?.mimeType?.startsWith("image/") && x?.inlineData?.data);
  if (p) return { mime: p.inlineData.mimeType, b64: p.inlineData.data };
  p = parts.find(x => typeof x?.text === "string" && x.text.startsWith("data:image/"));
  if (p) { const m = p.text.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i); if (m) return { mime: m[1], b64: m[2] }; }
  p = parts.find(x => typeof x?.text === "string" && /^https?:\/\//.test(x.text));
  if (p) return { url: p.text };
  return null;
}
async function geminiImage(env, item, timeoutMs=75000, attempts=3) {
  const key = env.GEMINI_API_KEY; if (!key) throw new Error("GEMINI_API_KEY missing");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(key)}`;
  const parts = [];
  if (item.character_ref_b64) parts.push({ inlineData: { mimeType: "image/png", data: item.character_ref_b64 } });
  if (item.guidance) parts.push({ text: item.guidance });
  parts.push({ text: item.prompt });
  const body = { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"], temperature: 0.35, topP: 0.9 } };

  let last;
  for (let i=1;i<=attempts;i++){
    const ctl = new AbortController(); const t = setTimeout(()=> ctl.abort("timeout"), timeoutMs);
    try{
      const r = await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Gemini ${r.status} ${await r.text().catch(()=> "")}`);
      const j = await r.json(); const got = findGeminiImagePart(j);
      if (got?.b64 && got?.mime) return { image_url:`data:${got.mime};base64,${got.b64}`, provider:"google", b64:got.b64 };
      if (got?.url) return { image_url:got.url, provider:"google" };
      throw new Error("No image in response");
    }catch(e){ clearTimeout(t); last=e; await new Promise(r=>setTimeout(r, 180*i)); }
  }
  throw last || new Error("Gemini failed");
}

/* ----------------------------- Style ---------------------------------- */
function styleHint(style="cartoon"){
  const s=(style||"cartoon").toLowerCase();
  if (s==="storybook") return "storybook watercolor, soft edges, paper texture, warm and cozy";
  if (s==="pixar")     return "stylized 3D animated film still (not photographic): enlarged eyes, simplified forms, clean gradients";
  if (s==="comic")     return "bold comic style, inked lines, flat colors";
  if (s==="painting")  return "soft painterly illustration, visible brushwork";
  return "expressive 2D cartoon: thick-and-thin outlines, cel shading, vibrant palette";
}

/* --------------------------- Story prompts ----------------------------- */
const OUTLINE_SYS = `
Skriv en svensk dispositions-json för en bilderbok om en HJÄLTE (som användaren beskriver).
Returnera exakt:{
 "outline": {
   "logline": string,"theme": string,"reading_age": number,"tone": string,"motif": string,
   "beats": [
     {"id":"setup","summary":string},{"id":"inciting","summary":string},{"id":"progress","summary":string},
     {"id":"midpoint","summary":string},{"id":"setback","summary":string},{"id":"plan","summary":string},
     {"id":"climax","summary":string},{"id":"resolution","summary":string}
   ]
 }
}
Regler:
- Hjälten är den typ användaren anger (barn/husdjur).
- Tydligt mål, riktiga hinder, vändpunkt och payoff.
- Håll dig NOGA till användarens tema (plats/aktivitet).
- Anpassa ordförråd/meningslängd till reading_age.
- Endast JSON.
`;
const STORY_SYS = `
Du får en outline för en svensk bilderbok. Skriv boken enligt:
{ "book":{
  "title": string,"reading_age": number,"style": "cartoon"|"pixar"|"storybook"|"comic"|"painting",
  "category": "kids"|"pets",
  "bible":{"main_character": { "name": string, "age": number, "physique": string, "identity_keys": string[] },
           "wardrobe": string[], "palette": string[], "world": string, "tone": string},
  "theme": string,"lesson": string,
  "pages":[{ "page": number, "text": string, "scene": string, "time_of_day": "day"|"golden_hour"|"evening"|"night","weather":"clear"|"cloudy"|"rain"|"snow"}]
}}
Hårda regler: 12–20 sidor, 2–4 meningar/sida. Konkreta scener i huvudmiljö. Svenskt språk. Endast JSON.
`;
function heroDescriptor({ category, name, age, traits }) {
  if ((category||"kids") === "pets") return `HJÄLTE: ett husdjur vid namn ${name||"Nova"}; egenskaper: ${(traits||"nyfiken, lekfull")}.`;
  const a = parseInt(age||6,10); return `HJÄLTE: ett barn vid namn ${name||"Nova"} (${a} år), egenskaper: ${(traits||"modig, omtänksam")}.`;
}

/* --------------------------- Frame prompts ----------------------------- */
function normalizePlan(pages){
  const out=[]; pages.forEach((p,i)=>{ const order = [ "EW","M","CU","W" ];
    const t = order[i % order.length]; const lens = {EW:28,W:35,M:50,CU:85}[t] || 35; const size = {EW:30,W:45,M:60,CU:80}[t] || 60;
    out.push({ page:p.page, shot_type:t, lens_mm:lens, subject_size_percent:size });
  });
  return { plan: out };
}
function shotLine(f={}) { const map={EW:"extra wide",W:"wide",M:"medium",CU:"close-up"}; return `${map[f.shot_type||"M"]} shot, ~${f.subject_size_percent||60}% subject, ≈${f.lens_mm||35}mm`; }
function buildSeriesContext(story){
  const pages = story?.book?.pages || []; const locs = [];
  const beats = pages.map(p=>{ const key = (p.scene || p.text || "").replace(/\s+/g," ").trim();
    const lkey = key.toLowerCase().match(/(strand|skog|kök|sovrum|park|hav|stad|skola|gård|sjö|berg)/)?.[1] || "plats";
    if (!locs.includes(lkey)) locs.push(lkey); return `p${p.page}: ${key}`; });
  return [`SERIES CONTEXT — title: ${story?.book?.title || "Sagobok"}`, `locations: ${locs.join(", ")}`, `beats: ${beats.join(" | ")}`].join("\n");
}
function buildFramePrompt({ style, story, page, pageCount, frame, characterName }){
  const series = buildSeriesContext(story); const pg = page; const styleLine = styleHint(style);
  return [series, `This is page ${pg.page} of ${pageCount}.`,
    `Render in ${styleLine}. No text or speech bubbles.`,
    `Square composition (1:1), keep limbs fully in frame.`,
    `Keep the same hero (${characterName}) from reference. Adapt pose, camera, lighting.`,
    pg.time_of_day ? `Time of day: ${pg.time_of_day}.` : "", pg.weather ? `Weather: ${pg.weather}.` : "",
    `SCENE: ${pg.scene || pg.text || ""}`, `FRAMING: ${shotLine(frame)}.`, `VARIETY: each page unique yet coherent.`].filter(Boolean).join("\n");
}
function characterCardPrompt({ style, bible, traits }){ const mc=bible?.main_character||{}; const name=mc.name||"Nova";
  const phys=mc.physique||traits||"fluffy gray cat with curious eyes";
  return [`Character reference in ${styleHint(style)}.`,`One hero only, full body, neutral background.`,`Hero: ${name}, ${phys}. No text.`].join(" ");
}

/* ----------------------- Cloudflare Images ----------------------------- */
function dataUrlToBlob(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i); if (!m) return null;
  const mime = m[1]; const b64 = m[2]; const bin = atob(b64); const u8 = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
  return { blob: new Blob([u8], { type: mime }), mime };
}
function cfImagesDeliveryURL(env, image_id, variant) {
  const hash = env.CF_IMAGES_ACCOUNT_HASH; if (!hash) return null;
  const v = variant || env.CF_IMAGES_VARIANT || "public";
  return `https://imagedelivery.net/${hash}/${image_id}/${v}`;
}
async function uploadOneToCFImages(env, { data_url, id }) {
  const miss = []; if (!env.IMAGES_API_TOKEN) miss.push("IMAGES_API_TOKEN"); if (!env.CF_ACCOUNT_ID) miss.push("CF_ACCOUNT_ID");
  if (miss.length) throw new Error("Cloudflare Images env missing: " + miss.join(", "));
  const file = dataUrlToBlob(data_url); if (!file) throw new Error("Bad data_url");
  const form = new FormData(); form.append("file", file.blob, id || `page-${Date.now()}.png`);
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`, {
    method: "POST", headers: { "authorization": `Bearer ${env.IMAGES_API_TOKEN}` }, body: form
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j.success) throw new Error(`CF Images ${r.status} ${JSON.stringify(j)}`);
  const image_id = j?.result?.id; const url = cfImagesDeliveryURL(env, image_id);
  return { image_id, url };
}

/* ---------------------------- PDF helpers ------------------------------ */
const MM_PER_INCH = 25.4; const PT_PER_INCH = 72; const PT_PER_MM = PT_PER_INCH / MM_PER_INCH;
const TRIMS = { square210: { w_mm: 210, h_mm: 210, default_bleed_mm: 3 } };
const GRID = {
  // fasta mått i mm (print-first)
  bleed_mm: 3,
  safe_mm: 14,
  gap_mm: 6,
  img_side_mm: 160,        // kvadratisk bild
  text_panel_mm: 42,       // fast panelhöjd
  title_band_mm: 34,       // omslagsband
  pad_mm: 10,
};
function mmToPt(mm){ return mm * PT_PER_MM; }
function fontSpecForReadingAge(ra=6){ if (ra <= 5) return { size: 22, min: 14, leading: 1.35 }; if (ra <= 8) return { size: 20, min: 14, leading: 1.35 }; if (ra <= 12) return { size: 18, min: 13, leading: 1.32 }; return { size: 18, min: 13, leading: 1.32 }; }

async function tryEmbedTtf(pdfDoc, url) {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    return await pdfDoc.embedFont(bytes, { subset: true });
  } catch { return null; }
}

function drawWatermarkBehind(page, text="FÖRHANDSVISNING", color=rgb(0.2,0.2,0.2)){
  const { width, height } = page.getSize(); const fontSize = Math.min(width, height) * 0.12; const angleRad = Math.atan2(height, width); const angleDeg = (angleRad * 180) / Math.PI;
  // pdf-lib ritar i lagerordning; läggs "före" text/bilder om vi anropar detta tidigt.
  page.drawText(text, { x: width*0.12, y: height*0.32, size: fontSize, color, opacity: 0.08, rotate: degrees(angleDeg) });
}

/** layout helpers */
function centerX(pageW, boxW){ return (pageW - boxW) / 2; }
function drawImageContain(page, img, boxX, boxY, boxW, boxH) {
  const iw = img.width, ih = img.height; const scale = Math.min(boxW / iw, boxH / ih);
  const w = iw * scale, h = ih * scale; const x = boxX + (boxW - w) / 2; const y = boxY + (boxH - h) / 2; page.drawImage(img, { x, y, width: w, height: h });
}

async function getImageBytes(env, row) {
  try {
    if (row.image_id) {
      const url = cfImagesDeliveryURL(env, row.image_id);
      if (!url) return null;
      const r = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    }
    if (row.url && /^https?:\/\//i.test(row.url)) {
      const r = await fetch(row.url, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    }
    if (row.data_url && row.data_url.startsWith("data:image/")) {
      const m = row.data_url.match(/^data:([^;]+);base64,(.+)$/i); if (!m) return null;
      const b64 = m[2]; const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      return u8;
    }
    return null;
  } catch { return null; }
}
async function embedImage(pdfDoc, bytes){ if (!bytes) return null; try { return await pdfDoc.embedPng(bytes); } catch {} try { return await pdfDoc.embedJpg(bytes); } catch {} return null; }

/** Text: auto-fit med min-grad */
function drawWrappedTextFit(page, text, boxX, boxY, boxW, boxH, font, baseSize, minSize, leading) {
  for (let size = baseSize; size >= minSize; size -= 1) {
    const lineH = size * leading;
    const words = String(text || "").trim().split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(test, size) <= boxW) line = test;
      else { if (line) lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    const totalH = lines.length * lineH;
    if (totalH <= boxH) {
      let y = boxY + (boxH - totalH) / 2 + (lines.length-1) * lineH; // vertikal centrerad i panel
      for (const ln of lines) {
        page.drawText(ln, { x: boxX, y, size, font, color: rgb(0.08,0.08,0.08) });
        y -= lineH;
      }
      return { fits: true, usedSize: size, lines };
    }
  }
  return { fits: false };
}

/* --------------------------- Build PDF (print-first) ------------------- */
async function buildPdf({ story, images, mode="print", trim="square210", watermark_text }, env, doPreflight=false) {
  const trimSpec = TRIMS[trim] || TRIMS.square210;
  const bleed = GRID.bleed_mm;

  const trimWpt = mmToPt(trimSpec.w_mm);
  const trimHpt = mmToPt(trimSpec.h_mm);
  const pageW = trimWpt + mmToPt(bleed * 2);
  const pageH = trimHpt + mmToPt(bleed * 2);
  const contentX = mmToPt(bleed);
  const contentY = mmToPt(bleed);
  const safe = mmToPt(GRID.safe_mm);

  // fasta ytor i punkter
  const IMG_SIDE = mmToPt(GRID.img_side_mm);
  const PANEL_H  = mmToPt(GRID.text_panel_mm);
  const GAP      = mmToPt(GRID.gap_mm);
  const PAD      = mmToPt(GRID.pad_mm);
  const TITLE_BAND = mmToPt(GRID.title_band_mm);

  const pdfDoc = await PDFDocument.create();

  // Typsnitt – med robust fallback
  const nunito = await tryEmbedTtf(pdfDoc, "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito-Regular.ttf");
  const nunitoBold = await tryEmbedTtf(pdfDoc, "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito-Bold.ttf");
  const baloo2 = await tryEmbedTtf(pdfDoc, "https://raw.githubusercontent.com/google/fonts/main/ofl/baloo2/Baloo2-ExtraBold.ttf");
  const fontBody = nunito || await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const fontBodyBold = nunitoBold || await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontTitle = baloo2 || fontBodyBold;

  const pages = story?.book?.pages || [];
  const readingAge = story?.book?.reading_age || 6;
  const { size: baseSize, min: minSize, leading } = fontSpecForReadingAge(readingAge);

  const title = story?.book?.title || "Min bok";
  const heroName = story?.book?.bible?.main_character?.name || "";
  const theme = story?.book?.theme || "";

  // Indexera bilder (tillåt "cover" eller page:0)
  let coverSrc = images?.find(x => x?.kind === "cover" || x?.page === 0) || null;
  const imgByPage = new Map();
  (images || []).forEach(row => { if (Number.isFinite(row?.page) && row.page > 0 && (row.image_id || row.url || row.data_url)) imgByPage.set(row.page, row); });

  const preflight = [];

  /* ---------------- Cover ---------------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);

    if (mode === "preview" && watermark_text) drawWatermarkBehind(page, watermark_text);

    // Bild (contain) – full trim men lämna bleed-ram per automatik via pageW/pageH
    if (!coverSrc) coverSrc = imgByPage.get(1) || null;
    if (coverSrc) {
      const bytes = await getImageBytes(env, coverSrc);
      const coverImg = await embedImage(pdfDoc, bytes);
      if (coverImg) {
        // Lägg en färgad bakre band för "bok-känsla"
        // (låg opacitet jordgrön – men under bilden, påverkar ej)
        page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.98,0.98,0.98) });
        drawImageContain(page, coverImg, contentX, contentY, trimWpt, trimHpt);
      }
    } else {
      page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.98,0.98,0.98) });
    }

    // Titelband högst upp – vit, utan att ligga ovanpå motivets viktiga delar
    // (vi lägger bandet som ren vit rektangel med mjuka marginaler)
    const bandX = contentX + safe * 0.2;
    const bandW = trimWpt - safe * 0.4;
    const bandH = TITLE_BAND;
    const bandY = contentY + trimHpt - safe - bandH;

    page.drawRectangle({ x: bandX, y: bandY, width: bandW, height: bandH, color: rgb(1,1,1), opacity: 0.96 });

    // Titel typografi
    let tSize = Math.min(72, bandH * 0.62);
    while (fontTitle.widthOfTextAtSize(title, tSize) > bandW - PAD*2 && tSize > 24) tSize -= 1;

    page.drawText(title, {
      x: bandX + (bandW - fontTitle.widthOfTextAtSize(title, tSize)) / 2,
      y: bandY + (bandH - tSize) / 2 + 3,
      size: tSize, font: fontTitle, color: rgb(0.05,0.05,0.05)
    });

    const subtitle = theme ? theme : (heroName ? `Med ${heroName}` : "");
    if (subtitle) {
      const sSize = Math.max(14, Math.min(24, tSize * 0.42));
      page.drawText(subtitle, {
        size: sSize, font: fontBody, color: rgb(0.18,0.18,0.18),
        x: contentX + (trimWpt - fontBody.widthOfTextAtSize(subtitle, sSize)) / 2,
        y: bandY - sSize - mmToPt(4)
      });
    }
  } catch (e) {
    log("PDF COVER ERROR:", e?.message);
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Omslag kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: fontBody, color: rgb(0.8,0.1,0.1) });
  }

  /* ---------------- Inside pages ---------------- */
  for (const p of pages) {
    try {
      const page = pdfDoc.addPage([pageW, pageH]);

      if (mode === "preview" && watermark_text) drawWatermarkBehind(page, watermark_text);

      // 1) Bildruta – centrerad kvadrat
      const imgBoxW = IMG_SIDE, imgBoxH = IMG_SIDE;
      const imgBoxX = contentX + centerX(trimWpt, imgBoxW);
      const imgBoxY = contentY + trimHpt - safe - imgBoxH;

      // 2) Textpanel – fast höjd under bilden
      const panelW = trimWpt - safe*2;
      const panelH = PANEL_H;
      const panelX = contentX + safe;
      const panelY = imgBoxY - GAP - panelH;

      // säkerhetsyta bakgrund (rent papper) – paneln
      page.drawRectangle({ x: panelX, y: panelY, width: panelW, height: panelH, color: rgb(1,1,1) });

      // 3) Bild (contain)
      const src = imgByPage.get(p.page);
      let imgObj = null;
      if (src) { const bytes = await getImageBytes(env, src); imgObj = await embedImage(pdfDoc, bytes); }
      if (imgObj) drawImageContain(page, imgObj, imgBoxX, imgBoxY, imgBoxW, imgBoxH);

      // 4) Text – auto-fit i panel (centrerad vertikalt)
      const textBoxW = panelW - PAD*2;
      const textBoxH = panelH - PAD*2;
      const textX = panelX + PAD;
      const textY = panelY + PAD;
      const res = drawWrappedTextFit(page, p.text || "", textX, textY, textBoxW, textBoxH, fontBody, baseSize, minSize, leading);
      if (!res.fits) preflight.push({ page: p.page, fits: false, chars: (p.text||"").length, min_font: minSize });
    } catch (e) {
      log("PDF PAGE ERROR p=", p?.page, e?.message);
      const fallback = pdfDoc.addPage([pageW, pageH]);
      fallback.drawText(`Sida ${p?.page || "?"}: kunde inte rendera.`, {
        x: mmToPt(15), y: mmToPt(15), size: 12, font: fontBody, color: rgb(0.8, 0.1, 0.1)
      });
    }
  }

  /* ---------------- Back cover ---------------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    if (mode === "preview" && watermark_text) drawWatermarkBehind(page, watermark_text);

    const blurb = story?.book?.lesson ? `Lärdom: ${story.book.lesson}` : `En berättelse skapad med BokPiloten.`;
    const head = "Om boken"; const headSize = 18; const bodySize = 12; const lh = bodySize * 1.42;

    const startX = contentX + safe; let cursorY = contentY + trimHpt - safe - headSize;
    page.drawText(head, { x: startX, y: cursorY, size: headSize, font: fontBodyBold, color: rgb(0.1,0.1,0.1) });
    cursorY -= (headSize + mmToPt(4));

    const maxW = (trimWpt - safe*2);
    const words = blurb.split(/\s+/); let line="";
    for (const w of words) {
      const test = line ? line+" "+w : w;
      if (fontBody.widthOfTextAtSize(test, bodySize) <= maxW) line = test;
      else { page.drawText(line, { x:startX, y:cursorY, size:bodySize, font:fontBody, color: rgb(0.1,0.1,0.1) }); cursorY -= lh; line = w; }
    }
    if (line) page.drawText(line, { x:startX, y:cursorY, size:bodySize, font:fontBody, color: rgb(0.1,0.1,0.1) });
  } catch (e) {
    log("PDF BACK COVER ERROR:", e?.message);
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Baksidan kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: fontBody, color: rgb(0.8, 0.1, 0.1) });
  }

  if (doPreflight && preflight.length) {
    // returnera endast preflight-info
    return { preflight };
  }

  // Dok-info
  try {
    pdfDoc.setTitle(title);
    if (heroName) pdfDoc.setAuthor(heroName);
    pdfDoc.setSubject(theme || "Barnbok");
    pdfDoc.setCreator("BokPiloten");
  } catch {}

  const bytes = await pdfDoc.save();
  return bytes; // Uint8Array när PDF, eller {preflight} vid preflight
}

/* ----------------------- Upload handler (CF) ---------------------------- */
async function handleUploadRequest(req, env) {
  try {
    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : (body?.data_url ? [body] : []);
    if (!items.length) return err("Body must include items[] or {page|kind,data_url}", 400);

    const uploads = [];
    for (const it of items) {
      const hasIdentity = (Number.isFinite(it?.page) || it?.kind === "cover");
      if (!hasIdentity) { uploads.push({ page: it?.page ?? null, error: "missing page/kind" }); continue; }
      if (typeof it?.data_url !== "string" || !it.data_url.startsWith("data:image/")) {
        uploads.push({ page: it.page ?? it.kind, error: "invalid data_url" }); continue;
      }
      try {
        const idHint = it.kind === "cover" ? "cover" : `page-${it.page}`;
        const u = await uploadOneToCFImages(env, { data_url: it.data_url, id: idHint });
        uploads.push({ page: it.page ?? 0, kind: it.kind, image_id: u.image_id, url: u.url });
      } catch (e) {
        uploads.push({ page: it.page ?? it.kind, error: String(e?.message || e) });
      }
    }
    return ok({ uploads });
  } catch (e) { return err(e?.message || "Upload failed", 500); }
}

/* -------------------------------- API ---------------------------------- */
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      const url = new URL(req.url);

      // Health
      if (req.method === "GET" && url.pathname === "/") return ok({ ok: true, ts: Date.now() });

      // STORY
      if (req.method === "POST" && url.pathname === "/api/story") {
        try {
          const body = await req.json();
          const { name, age, pages, category, style, theme, traits, reading_age } = body || {};
          const targetAge = Number.isFinite(parseInt(reading_age, 10)) ? parseInt(reading_age, 10) : ((category || "kids") === "pets" ? 8 : parseInt(age || 6, 10));

          const outlineUser = `
${heroDescriptor({ category, name, age, traits })}
Kategori: ${category || "kids"}.
Läsålder: ${targetAge}.
Önskat tema/poäng (om angivet): ${theme || "vänskap"}.
Antal sidor: ${pages || 12}.
Returnera enbart json.`.trim();

          const outline = await openaiJSON(env, OUTLINE_SYS, outlineUser);

          const storyUser = `
OUTLINE:
${JSON.stringify(outline)}
${heroDescriptor({ category, name, age, traits })}
Läsålder: ${targetAge}. Sidor: ${pages || 12}. Stil: ${style || "cartoon"}. Kategori: ${category || "kids"}.
Boken ska ha tydlig lärdom (lesson) kopplad till temat.
Följ temat NOGA: håll platser/handlingar huvudsakligen inom tematisk ram.
Returnera enbart json.`.trim();

          const story = await openaiJSON(env, STORY_SYS, storyUser);
          const plan  = normalizePlan(story?.book?.pages || []);
          return ok({ story, plan, previewVisible: 4 });
        } catch (e) { return err(e.message || "Story failed", 500); }
      }

      // REF IMAGE
      if (req.method === "POST" && url.pathname === "/api/ref-image") {
        try {
          const { style="cartoon", photo_b64, bible, traits="" } = await req.json();
          if (photo_b64) {
            const b64 = String(photo_b64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
            return ok({ ref_image_b64: b64 });
          }
          const prompt = characterCardPrompt({ style, bible, traits });
          const g = await geminiImage(env, { prompt }, 70000, 2);
          if (!g?.b64) return ok({ ref_image_b64: null });
          return ok({ ref_image_b64: g.b64 });
        } catch (e) { return err("Ref generation failed", 500); }
      }

      // IMAGES
      if (req.method === "POST" && url.pathname === "/api/images") {
        try {
          const { style="cartoon", ref_image_b64, story, plan, concurrency=4 } = await req.json();
          const pages = story?.book?.pages || [];
          if (!pages.length) return err("No pages", 400);
          if (!ref_image_b64) return err("Missing reference image", 400);

          const frames = plan?.plan || []; const pageCount = pages.length;
          const heroName = story?.book?.bible?.main_character?.name || "Hjälten";
          const jobs = pages.map(pg => { const f = frames.find(x => x.page === pg.page) || {};
            const prompt = buildFramePrompt({ style, story, page: pg, pageCount, frame: f, characterName: heroName });
            return { page: pg.page, prompt }; });

          const out = []; const CONC = Math.min(Math.max(parseInt(concurrency || 3, 10), 1), 8); let idx = 0;
          async function worker() {
            while (idx < jobs.length) {
              const i = idx++; const item = jobs[i];
              try {
                const g = await geminiImage(env, { prompt: item.prompt, character_ref_b64: ref_image_b64 }, 75000, 3);
                out.push({ page: item.page, image_url: g.image_url, provider: g.provider || "google" });
              } catch (e) {
                out.push({ page: item.page, error: String(e?.message || e) });
              }
            }
          }
          await Promise.all(Array.from({ length: CONC }, worker));
          out.sort((a,b)=>(a.page||0)-(b.page||0));
          return ok({ images: out });
        } catch (e) { return err(e.message || "Images failed", 500); }
      }

      // UPLOADS -> CF Images
      if (req.method === "POST" && url.pathname === "/api/images/upload") {
        return withCORS(await handleUploadRequest(req, env));
      }

      // REGENERATE single
      if (req.method === "POST" && url.pathname === "/api/image/regenerate") {
        try {
          const { style="cartoon", ref_image_b64, page_text, scene_text, frame, story } = await req.json();
          if (!ref_image_b64) return err("Missing reference image", 400);
          const fakeStory = story || { book: { pages: [{ page: 1, scene: scene_text, text: page_text }] } };
          const pg = { page: 1, scene: scene_text, text: page_text };
          const f  = { shot_type: frame?.shot_type || "M", lens_mm: frame?.lens_mm || 50, subject_size_percent: frame?.subject_size_percent || 60 };
          const prompt = buildFramePrompt({ style, story: fakeStory, page: pg, pageCount: 1, frame: f, characterName: (fakeStory.book?.bible?.main_character?.name || "Hjälten") });
          const g = await geminiImage(env, { prompt, character_ref_b64: ref_image_b64 }, 75000, 3);
          return ok({ image_url: g.image_url, provider: g.provider || "google" });
        } catch (e) { return err(e.message || "Regenerate failed", 500); }
      }

      // PDF (print-first) + preflight
      if (req.method === "POST" && url.pathname === "/api/pdf") {
        try {
          const preflightOnly = url.searchParams.get("preflight") === "1";
          const body = await req.json().catch(()=> ({}));
          const { story, images, mode="preview", trim="square210", watermark_text="FÖRHANDSVISNING" } = body || {};

          if (!story?.book?.pages?.length) return err("story.pages missing", 400);
          if (!Array.isArray(images) || !images.length) return err("images[] missing", 400);

          const out = await buildPdf({ story, images, mode, trim, watermark_text }, env, preflightOnly);

          if (preflightOnly && out?.preflight?.length) {
            return ok({ ok: false, issues: out.preflight }, { status: 409 });
          }
          if (preflightOnly) return ok({ ok: true, issues: [] });

          const headers = {
            "content-type": "application/pdf",
            "content-disposition": `inline; filename="bokpiloten.pdf"`,
            ...CORS,
          };
          return new Response(out, { status: 200, headers });
        } catch (e) {
          return err(e?.message || "PDF failed", 500);
        }
      }

      // 404
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404, headers: { "content-type": "application/json; charset=utf-8", ...CORS }
      });
    } catch (e) {
      // Global airbag
      return new Response(JSON.stringify({ error: String(e?.message || e) }), {
        status: 500, headers: JSONH
      });
    }
  }
};
