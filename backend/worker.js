// ============================================================================
// BokPiloten – Worker v13-PDF+
// Låser v13-story/bildflödet oförändrat och lägger till:
//  - POST /api/images/upload  → Cloudflare Images (tar data_url), svarar {uploads:[{page,image_id,url}]}
//  - POST /api/pdf            → bygger PDF av story + [{page, image_id|url|data_url}]
// Kräver env: API_KEY, GEMINI_API_KEY, IMAGES_API_TOKEN, CF_ACCOUNT_ID, CF_IMAGES_ACCOUNT_HASH, (CF_IMAGES_VARIANT)
// ============================================================================

import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

// ---------------- CORS & helpers ----------------
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
  "access-control-expose-headers": "Content-Disposition"
};
const JSONH = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS };
const OPENAI_MODEL = "gpt-4o-mini";

const ok  = (data, init={}) => new Response(JSON.stringify(data), { status: init.status || 200, headers: JSONH, ...init });
const err = (msg, code=400, extra={}) => ok({ error: msg, ...extra }, { status: code });
const log = (...a) => { try { console.log(...a); } catch {} };

// ---------------- OpenAI JSON (story) ----------------
async function openaiJSON(env, system, user) {
  const sys = system.toLowerCase().includes("json") ? system : system + "\nSvara endast som giltig json.";
  const usr = user.toLowerCase().includes("json") ? user : user + "\n(returnera bara json)";

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "authorization": `Bearer ${env.API_KEY}`, "content-type": "application/json" },
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

// ---------------- Gemini (image) ----------------
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

/** item: { prompt, character_ref_b64 } */
async function geminiImage(env, item, timeoutMs=75000, attempts=3) {
  const key = env.GEMINI_API_KEY; if (!key) throw new Error("GEMINI_API_KEY missing");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(key)}`;
  const parts = [];
  if (item.character_ref_b64) parts.push({ inlineData: { mimeType: "image/png", data: item.character_ref_b64 } });
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

// ---------------- Style (expressive!) ----------------
function styleHint(style="cartoon"){
  const s=(style||"cartoon").toLowerCase();
  if (s==="storybook") return "storybook watercolor, soft edges, paper texture, warm and cozy";
  if (s==="pixar")
    return "stylized 3D animated film still (not photographic): enlarged eyes, simplified forms, clean gradients, soft subsurface scattering, gentle rim light, shallow depth of field, expressive face rigs";
  if (s==="comic")     return "bold comic style, inked lines, flat colors, dynamic action framing, no speech balloons";
  if (s==="painting")  return "soft painterly illustration, visible brushwork, warm lighting, gentle textures";
  return "expressive 2D cartoon: thick-and-thin outlines, cel shading, squash-and-stretch poses, vibrant cheerful palette";
}

// ---------------- Strong Story: OUTLINE → PAGES ----------------
const OUTLINE_SYS = `
Skriv en svensk dispositions-json för en bilderbok om en HJÄLTE (som användaren beskriver).
Returnera exakt:
{
 "outline": {
   "logline": string,
   "theme": string,
   "reading_age": number,
   "tone": string,
   "motif": string,
   "beats": [
     {"id":"setup","summary":string},
     {"id":"inciting","summary":string},
     {"id":"progress","summary":string},
     {"id":"midpoint","summary":string},
     {"id":"setback","summary":string},
     {"id":"plan","summary":string},
     {"id":"climax","summary":string},
     {"id":"resolution","summary":string}
   ]
 }
}
Regler:
- Hjälten är den typ användaren anger (barn/husdjur).
- Tydligt mål, riktiga hinder, vändpunkt och känslomässig payoff kopplad till "motif".
- Håll dig NOGA till användarens tema som ram (plats/aktivitet); undvik sidospår som inte stödjer temat.
- Anpassa ordförråd/meningslängd till reading_age.
- Svara ENBART med json.
`;

const STORY_SYS = `
Du får en outline för en svensk bilderbok. Skriv nu boken enligt:
{ "book":{
  "title": string,
  "reading_age": number,
  "style": "cartoon"|"pixar"|"storybook"|"comic"|"painting",
  "category": "kids"|"pets",
  "bible":{
    "main_character": { "name": string, "age": number, "physique": string, "identity_keys": string[] },
    "wardrobe": string[], "palette": string[], "world": string, "tone": string
  },
  "theme": string,
  "lesson": string,
  "pages":[
    { "page": number, "text": string, "scene": string, "time_of_day": "day"|"golden_hour"|"evening"|"night", "weather":"clear"|"cloudy"|"rain"|"snow" }
  ]
}}
Hårda regler:
- 12–20 sidor; 2–4 meningar/sida.
- Starta i känsla/drivkraft (vad hjälten vill), bygg hinder, vändpunkt, lösning och avsluta med varm payoff kopplad till "lesson".
- "scene" ska vara konkret (plats + vad hjälten gör) och STÖDJA TEMAT. Om temat innebär en huvudplats (t.ex. "handla mat i affär"), håll majoriteten av scenerna i/kring den platsen (olika gångar, kundvagn, frukt, mejeri, kassan). Tillåt max 1–2 korta övergångar om outline kräver det.
- Om category="pets": skriv så att även vuxna ler – charm, hjärta och liten humor.
- Svenska; inga tomma fält.
- Svara ENBART med json.
`;

// Hjältebeskrivning
function heroDescriptor({ category, name, age, traits }) {
  if ((category||"kids") === "pets") {
    return `HJÄLTE: ett husdjur (t.ex. katt/hund) vid namn ${name||"Nova"}; egenskaper: ${(traits||"nyfiken, lekfull")}.`;
  }
  const a = parseInt(age||6,10);
  return `HJÄLTE: ett barn vid namn ${name||"Nova"} (${a} år), egenskaper: ${(traits||"modig, omtänksam")}.`;
}

// ---------------- Plan & Prompt helpers ----------------
function normalizePlan(pages){
  const out=[]; pages.forEach((p,i)=>{
    const order = [ "EW","M","CU","W" ];
    const t = order[i % order.length];
    const lens = {EW:28,W:35,M:50,CU:85}[t] || 35;
    const size = {EW:30,W:45,M:60,CU:80}[t] || 60;
    out.push({ page:p.page, shot_type:t, lens_mm:lens, subject_size_percent:size });
  });
  return { plan: out };
}
function shotLine(f={}) {
  const map={EW:"extra wide",W:"wide",M:"medium",CU:"close-up"};
  return `${map[f.shot_type||"M"]} shot, ~${f.subject_size_percent||60}% subject, ≈${f.lens_mm||35}mm`;
}
function buildSeriesContext(story){
  const pages = story?.book?.pages || [];
  const locs = [];
  const beats = pages.map(p=>{
    const key = (p.scene || p.text || "").replace(/\s+/g," ").trim();
    const lkey = key.toLowerCase().match(/(strand|skog|kök|sovrum|park|hav|stad|skola|gård|sjö|berg)/)?.[1] || "plats";
    if (!locs.includes(lkey)) locs.push(lkey);
    return `p${p.page}: ${key}`;
  });
  return [
    `SERIES CONTEXT — title: ${story?.book?.title || "Sagobok"}`,
    `locations: ${locs.join(", ")}`,
    `beats: ${beats.join(" | ")}`
  ].join("\n");
}
function buildFramePrompt({ style, story, page, pageCount, frame, characterName }){
  const series = buildSeriesContext(story);
  const pg = page;
  const styleLine = styleHint(style);
  return [
    series,
    `This is page ${pg.page} of ${pageCount}.`,
    `Render in ${styleLine}. No text or speech bubbles.`,
    `Square composition (1:1), comfortable headroom, keep limbs fully in frame.`,
    `Keep the same hero (${characterName}) from reference. Adapt pose, camera, and lighting freely.`,
    pg.time_of_day ? `Time of day: ${pg.time_of_day}.` : "",
    pg.weather ? `Weather: ${pg.weather}.` : "",
    `SCENE: ${pg.scene || pg.text || ""}`,
    `FRAMING: ${shotLine(frame)}.`,
    `VARIETY: each page unique yet coherent.`
  ].filter(Boolean).join("\n");
}

function characterCardPrompt({ style, bible, traits }){
  const mc=bible?.main_character||{};
  const name=mc.name||"Nova";
  const phys=mc.physique||traits||"fluffy gray cat with curious eyes";
  return [
    `Character reference in ${styleHint(style)}.`,
    `One hero only, full body, neutral background.`,
    `Hero: ${name}, ${phys}. No text.`
  ].join(" ");
}

// ---------------- Cloudflare Images helpers ----------------
function dataUrlToBlob(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  const mime = m[1]; const b64 = m[2];
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
  return { blob: new Blob([u8], { type: mime }), mime };
}
function cfImagesDeliveryURL(env, image_id, variant) {
  const hash = env.CF_IMAGES_ACCOUNT_HASH;
  if (!hash) return null;
  const v = variant || env.CF_IMAGES_VARIANT || "public";
  return `https://imagedelivery.net/${hash}/${image_id}/${v}`;
}
async function uploadOneToCFImages(env, { data_url, id }) {
  const miss = [];
  if (!env.IMAGES_API_TOKEN) miss.push("IMAGES_API_TOKEN");
  if (!env.CF_ACCOUNT_ID) miss.push("CF_ACCOUNT_ID");
  if (miss.length) throw new Error("Cloudflare Images env missing: " + miss.join(", "));

  const file = dataUrlToBlob(data_url);
  if (!file) throw new Error("Bad data_url");

  const form = new FormData();
  form.append("file", file.blob, id || `page-${Date.now()}.png`);

  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`, {
    method: "POST",
    headers: { "authorization": `Bearer ${env.IMAGES_API_TOKEN}` },
    body: form
  });
  const j = await r.json().catch(()=> ({}));
  if (!r.ok || !j.success) throw new Error(`CF Images ${r.status} ${JSON.stringify(j)}`);
  const image_id = j?.result?.id;
  const url = cfImagesDeliveryURL(env, image_id);
  return { image_id, url };
}


// ---------------- PDF helpers ----------------
const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;
const PT_PER_MM   = PT_PER_INCH / MM_PER_INCH;
const TRIMS = { square210: { w_mm: 210, h_mm: 210, default_bleed_mm: 3 } };
function mmToPt(mm){ return mm * PT_PER_MM; }
function fontSpecForReadingAge(ra=6){
  if (ra <= 5)  return { size: 22, leading: 1.35 };
  if (ra <= 8)  return { size: 18, leading: 1.35 };
  if (ra <= 12) return { size: 16, leading: 1.30 };
  return { size: 16, leading: 1.30 };
}
// Ersätt pickLayoutForText med en enkel längd-baserad
function pickLayoutForText(text=""){
  const len = (text||"").length;
  if (len <= 180) return "image_focus";      // stor bild, kort text
  if (len <= 320) return "balanced";         // bild + text balanserat
  return "text_heavy";                        // större textpanel
}

function drawWatermark(page, text = "FÖRHANDSVISNING", color = rgb(0.2,0.2,0.2)) {
  const { width, height } = page.getSize();
  const fontSize = Math.min(width, height) * 0.08;
  const angleRad = Math.atan2(height, width);
  const angleDeg = (angleRad * 180) / Math.PI;
  page.drawText(text, { x: width*0.1, y: height*0.3, size: fontSize, color, opacity: 0.12, rotate: degrees(angleDeg) });
}
function drawWrappedText(page, text, x, yTop, maxWidth, font, fontSize, lineHeight){
  const words = String(text||"").split(/\s+/);
  let line = "", cursorY = yTop; const lines = [];
  for (const w of words) {
    const test = line ? (line+" "+w) : w;
    const testWidth = font.widthOfTextAtSize(test, fontSize);
    if (testWidth <= maxWidth) line = test;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  for (const ln of lines) {
    page.drawText(ln, { x, y: cursorY, size: fontSize, font, color: rgb(0.1,0.1,0.1) });
    cursorY -= lineHeight;
  }
  return cursorY;
}

// Hämta bytes prioriterat: image_id → url → data_url
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
      const m = row.data_url.match(/^data:([^;]+);base64,(.+)$/i);
      if (!m) return null;
      const b64 = m[2]; const bin = atob(b64);
      const u8 = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      return u8;
    }
    return null;
  } catch { return null; }
}

async function embedImage(pdfDoc, bytes){
  if (!bytes) return null;
  try { return await pdfDoc.embedPng(bytes); } catch {}
  try { return await pdfDoc.embedJpg(bytes); } catch {}
  return null;
}

async function buildPdf({ story, images, mode = "preview", trim = "square210", bleed_mm, watermark_text }, env) {
  const trimSpec = TRIMS[trim] || TRIMS.square210;
  const bleed = mode === "print" ? (Number.isFinite(bleed_mm) ? bleed_mm : trimSpec.default_bleed_mm) : 0;

  const trimWpt = mmToPt(trimSpec.w_mm);
  const trimHpt = mmToPt(trimSpec.h_mm);
  const pageW = trimWpt + mmToPt(bleed * 2);
  const pageH = trimHpt + mmToPt(bleed * 2);
  const contentX = mmToPt(bleed);
  const contentY = mmToPt(bleed);

  const pdfDoc = await PDFDocument.create();
  const fontBody = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontTitle = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pages = story?.book?.pages || [];
  const readingAge = story?.book?.reading_age || 6;
  const { size: bodySize, leading } = fontSpecForReadingAge(readingAge);
  const lineHeight = bodySize * leading;

  const title = story?.book?.title || "Min bok";
  const heroName = story?.book?.bible?.main_character?.name || "";
  const theme = story?.book?.theme || "";

  const imgByPage = new Map();
  (images || []).forEach(row => {
    if (row?.page && (row.image_id || row.url || row.data_url)) imgByPage.set(row.page, row);
  });

  // Cover
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const margin = mmToPt(18);
    const titleSize = Math.min(trimWpt, trimHpt) * 0.07;
    const subSize = titleSize * 0.45;

    const coverSrc = imgByPage.get(1);
    if (coverSrc) {
      const bytes = await getImageBytes(env, coverSrc);
      const coverImg = await embedImage(pdfDoc, bytes);
      if (coverImg) {
        const iw = coverImg.width, ih = coverImg.height;
        const panelSize = Math.min(trimWpt - margin * 2, trimHpt - margin * 3);
        const scale = Math.min(panelSize / iw, panelSize / ih);
        const w = iw * scale, h = ih * scale;
        const cx = contentX + (trimWpt - w) / 2;
        const cy = contentY + (trimHpt - h) / 2 - mmToPt(8);
        page.drawImage(coverImg, { x: cx, y: cy, width: w, height: h });
      }
    }

    const tWidth = fontTitle.widthOfTextAtSize(title, titleSize);
    page.drawText(title, { x: contentX + (trimWpt - tWidth) / 2, y: contentY + trimHpt - margin - titleSize, size: titleSize, font: fontTitle, color: rgb(0.1, 0.1, 0.1) });

    const sub = theme ? `${theme}` : (heroName ? `Med ${heroName}` : "");
    if (sub) {
      const sWidth = fontBody.widthOfTextAtSize(sub, subSize);
      page.drawText(sub, { x: contentX + (trimWpt - sWidth) / 2, y: contentY + trimHpt - margin - titleSize - subSize - mmToPt(3), size: subSize, font: fontBody, color: rgb(0.25, 0.25, 0.25) });
    }

    if (mode === "preview") drawWatermark(page, watermark_text || "FÖRHANDSVISNING");
  } catch (e) {
    log("PDF COVER ERROR:", e?.message);
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Omslag kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: fontBody, color: rgb(0.8, 0.1, 0.1) });
  }

  // Inside pages
// ---------------- Inside pages (kvadratisk layout) ----------------
for (const p of pages) {
  try {
    const page = pdfDoc.addPage([pageW, pageH]);

    // Inre marginaler
    const inner = mmToPt(14);
    const textPad = mmToPt(8);

    // Kvadratisk bildruta uppe på sidan
    // – höjd ~55–62% av trimsidan beroende på textmängd
    const layout = pickLayoutForText(p.text || "");
    const imgBoxSide =
      layout === "image_focus" ? (trimHpt * 0.62) :
      layout === "balanced"    ? (trimHpt * 0.58) :
                                 (trimHpt * 0.52);

    const imgBoxSize = Math.min(imgBoxSide, trimWpt - inner*2); // kvadrat
    const imgBoxX = contentX + (trimWpt - imgBoxSize) / 2;
    const imgBoxY = contentY + trimHpt - inner - imgBoxSize;

    // Bild (contain i kvadratisk ruta – aldrig utanför)
    const src = imgByPage.get(p.page);
    let imgObj = null;
    if (src) {
      const bytes = await getImageBytes(env, src);
      imgObj = await embedImage(pdfDoc, bytes);
    }

    if (imgObj) {
      const iw = imgObj.width, ih = imgObj.height;
      // contain i kvadratisk ruta
      const scale = Math.min(imgBoxSize / iw, imgBoxSize / ih);
      const w = iw * scale, h = ih * scale;
      const x = imgBoxX + (imgBoxSize - w) / 2;
      const y = imgBoxY + (imgBoxSize - h) / 2;
      page.drawImage(imgObj, { x, y, width: w, height: h });
    }

    // Textpanel under bilden
    const textTop = imgBoxY - mmToPt(10);
    const panelTop = textTop;
    const panelBot = contentY + inner;
    const panelH = Math.max(panelTop - panelBot, mmToPt(30));
    const panelW = trimWpt - inner*2;
    const panelX = contentX + inner;
    const panelY = panelBot;

    // lätt vit platta för läsbarhet (lämna ren i print)
    page.drawRectangle({
      x: panelX, y: panelY, width: panelW, height: panelH,
      color: rgb(1,1,1)
    });

    // text – lite tätare leading än omslaget
    const { size: bodySize, leading } = fontSpecForReadingAge(readingAge);
    const lineH = bodySize * 1.33;

    const textMaxW = panelW - textPad*2;
    const textX = panelX + textPad;
    const textTopY = panelY + panelH - textPad - bodySize;

    drawWrappedText(page, p.text || "", textX, textTopY, textMaxW, fontBody, bodySize, lineH);

    if (mode === "preview") drawWatermark(page, watermark_text || "FÖRHANDSVISNING");
  } catch (e) {
    log("PDF PAGE ERROR p=", p?.page, e?.message);
    const fallback = pdfDoc.addPage([pageW, pageH]);
    fallback.drawText(`Sida ${p?.page || "?"}: kunde inte rendera.`, {
      x: mmToPt(15), y: mmToPt(15), size: 12, font: fontBody, color: rgb(0.8, 0.1, 0.1)
    });
    if (mode === "preview") drawWatermark(fallback, watermark_text || "FÖRHANDSVISNING");
  }
}


  // Back cover
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const margin = mmToPt(18);
    const blurb = story?.book?.lesson ? `Lärdom: ${story.book.lesson}` : `En berättelse skapad med BokPiloten.`;

    page.drawText("Baksida", { x: contentX + margin, y: contentY + trimHpt - margin - 18, size: 18, font: fontTitle, color: rgb(0.1, 0.1, 0.1) });
    const fontBodySize = 12;
    const lineH = fontBodySize * 1.4;
    drawWrappedText(page, blurb, contentX + margin, contentY + trimHpt - margin - 18 - lineH, trimWpt - margin * 2, fontBody, fontBodySize, lineH);
    if (mode === "preview") drawWatermark(page, watermark_text || "FÖRHANDSVISNING");
  } catch (e) {
    log("PDF BACK COVER ERROR:", e?.message);
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Baksidan kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: fontBody, color: rgb(0.8, 0.1, 0.1) });
  }

  return await pdfDoc.save();
}

async function handlePdfRequest(req, env) {
  const body = await req.json();
  const { story, images, mode, trim, bleed_mm, watermark_text } = body || {};
  if (!story?.book) return err("Missing story", 400);
  if (!Array.isArray(images) || images.length === 0) return err("Missing images[]", 400);

  // Validera [{page, image_id}|{page, url}|{page, data_url}]
  for (const row of images) {
    if (!Number.isFinite(row?.page)) return err("images[].page missing", 400);
    if (!(row.image_id || row.url || row.data_url)) return err("images[] row must include image_id or url or data_url", 400);
  }

  const pdfBytes = await buildPdf({
    story,
    images,
    mode: mode === "print" ? "print" : "preview",
    trim: trim || "square210",
    bleed_mm,
    watermark_text: watermark_text || (mode === "preview" ? "FÖRHANDSVISNING" : null),
  }, env);

  const headers = new Headers({
    "content-type": "application/pdf",
    "cache-control": mode === "preview" ? "no-store" : "public, max-age=31536000, immutable",
        "content-disposition": `inline; filename="bokpiloten-${Date.now()}.pdf"`,
    ...CORS
  });
  return new Response(pdfBytes, { status: 200, headers });
}

// ---------------- Images: bulk upload -> Cloudflare Images ------------------
async function handleUploadRequest(req, env) {
  try {
    const body = await req.json().catch(() => ({}));
    // Stöd både {items:[{page,data_url,id?},...]} och single {page,data_url,id?}
    const items = Array.isArray(body?.items)
      ? body.items
      : (body?.data_url ? [body] : []);

    if (!items.length) return err("Body must include items[] or {page,data_url}", 400);

    const uploads = [];
    for (const it of items) {
      if (!Number.isFinite(it?.page)) {
        uploads.push({ page: it?.page ?? null, error: "missing page" });
        continue;
      }
      if (typeof it?.data_url !== "string" || !it.data_url.startsWith("data:image/")) {
        uploads.push({ page: it.page, error: "invalid data_url" });
        continue;
      }
      try {
        const u = await uploadOneToCFImages(env, { data_url: it.data_url, id: it.id });
        uploads.push({ page: it.page, image_id: u.image_id, url: u.url });
      } catch (e) {
        uploads.push({ page: it.page, error: String(e?.message || e) });
      }
    }
    return ok({ uploads });
  } catch (e) {
    return err(e?.message || "Upload failed", 500);
  }
}
// ============================================================================
// API
// ============================================================================
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Health
    if (req.method === "GET" && url.pathname === "/") {
      return ok({ ok: true, ts: Date.now() });
    }

    // --- DEBUG: visa att env-variablerna är bundna (TA BORT i prod om du vill)
    if (req.method === "GET" && url.pathname === "/api/images/env") {
      return ok({
        has: {
          CF_ACCOUNT_ID: !!env.CF_ACCOUNT_ID,
          IMAGES_API_TOKEN: !!env.IMAGES_API_TOKEN,
          CF_IMAGES_ACCOUNT_HASH: !!env.CF_IMAGES_ACCOUNT_HASH,
          CF_IMAGES_VARIANT: !!env.CF_IMAGES_VARIANT,
          API_KEY: !!env.API_KEY,
          GEMINI_API_KEY: !!env.GEMINI_API_KEY,
        }
      });
    }

    // ---------------- STORY (outline -> pages)  [v13 orörd] ----------------
    if (req.method === "POST" && url.pathname === "/api/story") {
      try {
        const body = await req.json();
        const { name, age, pages, category, style, theme, traits, reading_age } = body || {};

        const targetAge = Number.isFinite(parseInt(reading_age, 10))
          ? parseInt(reading_age, 10)
          : ((category || "kids") === "pets" ? 8 : parseInt(age || 6, 10));

        const outlineUser = `
${heroDescriptor({ category, name, age, traits })}
Kategori: ${category || "kids"}.
Läsålder: ${targetAge}.
Önskat tema/poäng (om angivet): ${theme || "vänskap"}.
Antal sidor: ${pages || 12}.
Returnera enbart json.
`.trim();

        const outline = await openaiJSON(env, OUTLINE_SYS, outlineUser);

        const storyUser = `
OUTLINE:
${JSON.stringify(outline)}
${heroDescriptor({ category, name, age, traits })}
Läsålder: ${targetAge}. Sidor: ${pages || 12}. Stil: ${style || "cartoon"}. Kategori: ${category || "kids"}.
Boken ska ha tydlig lärdom (lesson) kopplad till temat.
Följ temat NOGA: håll platser/handlingar huvudsakligen inom tematisk ram.
Returnera enbart json.
`.trim();

        const story = await openaiJSON(env, STORY_SYS, storyUser);
        const plan  = normalizePlan(story?.book?.pages || []);
        return ok({ story, plan, previewVisible: 4 });
      } catch (e) {
        log("story error", e?.message);
        return err(e.message || "Story failed", 500);
      }
    }

    // ---------------- REF-IMAGE  [v13 orörd] ----------------
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
      } catch (e) {
        log("ref-image error", e?.message);
        return err("Ref generation failed", 500);
      }
    }

    // ---------------- IMAGES (generate pages) [v13 orörd] -------------------
    if (req.method === "POST" && url.pathname === "/api/images") {
      try {
        const { style="cartoon", ref_image_b64, story, plan, concurrency=4 } = await req.json();
        const pages = story?.book?.pages || [];
        if (!pages.length) return err("No pages", 400);
        if (!ref_image_b64) return err("Missing reference image", 400);

        const frames = plan?.plan || [];
        const pageCount = pages.length;
        const heroName = story?.book?.bible?.main_character?.name || "Hjälten";

        const jobs = pages.map(pg => {
          const f = frames.find(x => x.page === pg.page) || {};
          const prompt = buildFramePrompt({ style, story, page: pg, pageCount, frame: f, characterName: heroName });
          return { page: pg.page, prompt };
        });

        const out = [];
        const CONC = Math.min(Math.max(parseInt(concurrency || 3, 10), 1), 8);
        let idx = 0;
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
        out.sort((a, b) => (a.page || 0) - (b.page || 0));
        return ok({ images: out });
      } catch (e) {
        log("images error", e?.message);
        return err(e.message || "Images failed", 500);
      }
    }

    // ---------------- IMAGES: upload to CF Images (NY) ----------------------
    if (req.method === "POST" && url.pathname === "/api/images/upload") {
      try {
        const body = await req.json().catch(() => ({}));
        const items = Array.isArray(body?.items)
          ? body.items
          : (body?.data_url ? [body] : []);
        if (!items.length) return err("Body must include items[] or {page,data_url}", 400);

        const uploads = [];
        for (const it of items) {
          if (!Number.isFinite(it?.page)) { uploads.push({ page: it?.page ?? null, error: "missing page" }); continue; }
          if (typeof it?.data_url !== "string" || !it.data_url.startsWith("data:image/")) { uploads.push({ page: it.page, error: "invalid data_url" }); continue; }
          try {
            const u = await uploadOneToCFImages(env, { data_url: it.data_url, id: it.id });
            uploads.push({ page: it.page, image_id: u.image_id, url: u.url });
          } catch (e) {
            uploads.push({ page: it.page, error: String(e?.message || e) });
          }
        }
        return ok({ uploads });
      } catch (e) {
        return err(e?.message || "Upload failed", 500);
      }
    }

    // ---------------- REGENERATE single (v13 orörd) -------------------------
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
      } catch (e) {
        log("regen error", e?.message);
        return err(e.message || "Regenerate failed", 500);
      }
    }

    // ---------------- PDF build (din v13-PDF+) ------------------------------
    if (req.method === "POST" && url.pathname === "/api/pdf") {
      try {
        return await handlePdfRequest(req, env);
      } catch (e) {
        return err(e?.message || "PDF failed", 500);
      }
    }

    // 404
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8", ...CORS }
    });
  }
};
