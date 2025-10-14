// ============================================================================
// BokPiloten – Worker v17 (Cloudflare bundle-ready)
// - Importera pdf-lib från npm (bundlas av Wrangler)
// - /api/story, /api/ref-image, /api/images, /api/image/regenerate, /api/pdf
// ============================================================================

import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";



// ---------------------------- CONSTS / HELPERS ------------------------------
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
};
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  ...CORS_HEADERS,
};

const ok  = (data, init={}) => new Response(JSON.stringify(data), { status: init.status || 200, headers: JSON_HEADERS });
const err = (msg, code=400, extra={}) => ok({ error: msg, ...extra }, { status: code });
const log = (...a) => { try { console.log(...a); } catch {} };

// --------------------------- MODEL CHOICES ----------------------------------
const OPENAI_MODEL = "gpt-4o-mini";

// ------------------------ OPENAI JSON HELPER --------------------------------
async function openaiJSON(env, system, user) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "authorization": `Bearer ${env.API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.6,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status} ${await r.text().catch(()=> "")}`);
  const j = await r.json();
  return JSON.parse(j?.choices?.[0]?.message?.content || "{}");
}

// --------------------------- GEMINI IMAGE -----------------------------------
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
  if (item.prev_frame_b64)    parts.push({ inlineData: { mimeType: "image/png", data: item.prev_frame_b64 } });
  (item.refs_b64 || []).forEach(r => { if (r?.b64) parts.push({ inlineData: { mimeType: r.mime || "image/png", data: r.b64 } }); });
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

// --------------------------- STYLE HINTS ------------------------------------
function styleHint(style="cartoon"){
  const s=(style||"cartoon").toLowerCase();
  if (s==="storybook") return "storybook watercolor, soft edges, paper texture, warm and cozy";
  if (s==="pixar")     return "stylized 3D animated film still (not photographic): enlarged eyes, simplified forms, clean gradients, soft subsurface scattering, gentle rim light, shallow depth of field, expressive face rigs";
  if (s==="comic")     return "bold comic style, inked lines, flat colors, dynamic action framing, no speech balloons";
  if (s==="painting")  return "soft painterly illustration, visible brushwork, warm lighting, gentle textures";
  return "expressive 2D cartoon: thick-and-thin outlines, cel shading, squash-and-stretch poses, vibrant cheerful palette";
}

// ------------------------ OUTLINE & STORY SYSTEMS ---------------------------
const OUTLINE_SYS = `
Du ska skriva en svensk dispositions-json ("json") för en bilderbok om en HJÄLTE (typ anges av användaren).
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
- Tydligt mål, riktiga hinder, vändpunkt, lösning och varm payoff kopplad till "motif".
- Håll dig NOGA till användarens tema som ram (plats/aktivitet); undvik sidospår som inte stödjer temat.
- Anpassa språk/meningslängd till reading_age.
- Svara ENBART med json.
`;

const STORY_SYS = `
Du får en outline för en svensk bilderbok. Skriv nu boken som "json" enligt:
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
Regler:
- 12–20 sidor; 2–4 meningar/sida.
- Starta i hjältes drivkraft, bygg hinder, vändpunkt, lösning och avsluta med payoff kopplad till "lesson".
- "scene" ska vara konkret (plats + vad hjälten gör) och stödja temat.
- Om category="pets": skriv så att även vuxna ler – charm, hjärta, lätt humor.
- Svenska; inga tomma fält. Svara ENBART med json.
`;

// ----------------------------- STORY HELPERS --------------------------------
function heroDescriptor({ category, name, age, traits }){
  if (category === "kids") return `HJÄLTE: ett barn som heter ${name||"Nova"} (${parseInt(age||6,10)} år), kännetecken: ${traits||"nyfiken, modig"}.`;
  return `HJÄLTE: ett husdjur som heter ${name||"Nova"} (${parseInt(age||6,10)} år), kännetecken: ${traits||"lekfull, snäll"}.`;
}
function normalizePlan(pages){
  const out=[];
  pages.forEach((p,i)=>{
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
  const beats = pages.slice(0,12).map(p=>`p${p.page}: ${(p.scene||p.text||"").replace(/\s+/g," ").trim()}`);
  return [`SERIES CONTEXT — title: ${story?.book?.title || "Sagobok"}`, `beats: ${beats.join(" | ")}`].join("\n");
}
function buildFramePrompt({ style, story, page, pageCount, frame, characterName }){
  const series = buildSeriesContext(story);
  const pg = page;
  const styleLine = styleHint(style);
  const actingHint = (String(style).toLowerCase()==="pixar" || String(style).toLowerCase()==="cartoon")
    ? "Expressive acting: tydlig mimik, kroppsspråk, dynamiska poser." : "";
  return [
    series,
    `This is page ${pg.page} of ${pageCount}.`,
    `Render in ${styleLine}. No on-screen text or speech bubbles.`,
    `Keep the same hero (${characterName}) from the reference image; adapt pose, camera and lighting freely.`,
    actingHint,
    pg.time_of_day ? `Time of day: ${pg.time_of_day}.` : "",
    pg.weather ? `Weather: ${pg.weather}.` : "",
    `SCENE: ${pg.scene || pg.text || ""}`,
    `FRAMING: ${shotLine(frame)}.`,
    `VARIETY: make this page visually distinct yet coherent.`
  ].filter(Boolean).join("\n");
}
function characterCardPrompt({ style, bible, traits, category }){
  const mc=bible?.main_character||{};
  const name=mc.name||"Nova";
  const phys=mc.physique||traits||(category==="kids" ? "child with casual outfit" : "fluffy gray cat with curious eyes");
  const who = (category==="kids") ? "one child only" : "one pet only";
  return [
    `Character reference in ${styleHint(style)}.`,
    `${who}, full-body, 3/4 view, neutral gray background.`,
    `Hero: ${name}, ${phys}. No text.`
  ].join(" ");
}

// ============================== PDF HELPERS =================================
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
function pickLayoutForText(text=""){
  const len = (text||"").length;
  if (len <= 180) return "image_top";
  if (len <= 280) return "text_top";
  return "full_bleed_panel";
}
function drawWatermark(page, text = "FÖRHANDSVISNING", color = rgb(0.2, 0.2, 0.2)) {
  const { width, height } = page.getSize();
  const fontSize = Math.min(width, height) * 0.08;
  const angleRad = Math.atan2(height, width);              // diagonalt
  const angleDeg = (angleRad * 180) / Math.PI;

  page.drawText(text, {
    x: width * 0.1,
    y: height * 0.3,
    size: fontSize,
    color,
    opacity: 0.12,
    rotate: degrees(angleDeg)                               // <- RÄTT sättet
  });
}
async function handlePdfRequest(req) {
  try {
    const body = await req.json();
    const { story, images, mode, trim, bleed_mm, watermark_text } = body || {};
    if (!story?.book) return err("Missing story", 400);
    if (!Array.isArray(images)) return err("Missing images[]", 400);

    const pdfBytes = await buildPdf({
      story, images,
      mode: mode === "print" ? "print" : "preview",
      trim: trim || "square210",
      bleed_mm,
      watermark_text: watermark_text || (mode === "preview" ? "FÖRHANDSVISNING" : null),
    });

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "cache-control": mode === "preview" ? "no-store" : "public, max-age=31536000, immutable",
        "content-disposition": `inline; filename="bokpiloten-${Date.now()}.pdf"`,
        "access-control-allow-origin": "*"    // CORS för direktvisning i webbläsaren
      }
    });
  } catch (e) {
    console.error("PDF ERROR:", e?.stack || e);
    return err(e?.message || "PDF failed", 500);
  }
}

async function embedImage(pdfDoc, imageUrlOrDataUrl){
  if (!imageUrlOrDataUrl) return null;
  try{
    let bytes;
    if (imageUrlOrDataUrl.startsWith("data:image/")) {
      const b64 = imageUrlOrDataUrl.split(",")[1] || "";
const binary = atob(b64);
bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      const r = await fetch(imageUrlOrDataUrl);
      bytes = new Uint8Array(await r.arrayBuffer());
    }
    try { return await pdfDoc.embedPng(bytes); } catch {}
    try { return await pdfDoc.embedJpg(bytes); } catch {}
    return null;
  }catch { return null; }
}
function drawWrappedText(page, text, x, yTop, maxWidth, font, fontSize, lineHeight){
  const words = String(text||"").split(/\s+/);
  let line = "", cursorY = yTop; const lines = [];
  for (const w of words) {
    const test = line ? (line+" "+w) : w;
    const testWidth = font.widthOfTextAtSize(test, fontSize);
    if (testWidth <= maxWidth) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  for (const ln of lines) {
    page.drawText(ln, { x, y: cursorY, size: fontSize, font, color: rgb(0.1,0.1,0.1) });
    cursorY -= lineHeight;
  }
  return cursorY;
}
async function buildPdf({ story, images, mode = "preview", trim = "square210", bleed_mm, watermark_text }) {
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

  // Map images by page
  const imgByPage = new Map();
  (images || []).forEach(row => {
    if (row?.page && row?.image_url) imgByPage.set(row.page, row.image_url);
  });

  // ---------------- Cover ----------------
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const margin = mmToPt(18);
    const titleSize = Math.min(trimWpt, trimHpt) * 0.07;
    const subSize = titleSize * 0.45;

    // Cover image = page 1 image if available
    const coverImgUrl = imgByPage.get(1);
    const coverImg = await embedImage(pdfDoc, coverImgUrl);
    if (coverImg) {
      const iw = coverImg.width, ih = coverImg.height;
      const panelSize = Math.min(trimWpt - margin * 2, trimHpt - margin * 3);
      const scale = Math.min(panelSize / iw, panelSize / ih);
      const w = iw * scale, h = ih * scale;
      const cx = contentX + (trimWpt - w) / 2;
      const cy = contentY + (trimHpt - h) / 2 - mmToPt(8);
      page.drawImage(coverImg, { x: cx, y: cy, width: w, height: h });
    }

    const tWidth = fontTitle.widthOfTextAtSize(title, titleSize);
    page.drawText(title, {
      x: contentX + (trimWpt - tWidth) / 2,
      y: contentY + trimHpt - margin - titleSize,
      size: titleSize, font: fontTitle, color: rgb(0.1, 0.1, 0.1)
    });

    const sub = theme ? `${theme}` : (heroName ? `Med ${heroName}` : "");
    if (sub) {
      const sWidth = fontBody.widthOfTextAtSize(sub, subSize);
      page.drawText(sub, {
        x: contentX + (trimWpt - sWidth) / 2,
        y: contentY + trimHpt - margin - titleSize - subSize - mmToPt(3),
        size: subSize, font: fontBody, color: rgb(0.25, 0.25, 0.25)
      });
    }

    if (mode === "preview") drawWatermark(page, watermark_text || "FÖRHANDSVISNING");
  } catch (e) {
    console.error("PDF COVER ERROR:", e?.stack || e);
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Omslag kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: fontBody, color: rgb(0.8, 0.1, 0.1) });
  }

  // ---------------- Inside pages ----------------
  for (const p of pages) {
    try {
      const page = pdfDoc.addPage([pageW, pageH]);
      const imgUrl = imgByPage.get(p.page);
      const layout = pickLayoutForText(p.text || "");
      const innerMargin = mmToPt(15);

      const imgObj = await embedImage(pdfDoc, imgUrl);

      if (layout === "image_top") {
        const imgAreaH = trimHpt * 0.66;
        if (imgObj) {
          const iw = imgObj.width, ih = imgObj.height;
          const maxW = trimWpt - innerMargin * 2;
          const maxH = imgAreaH - innerMargin * 1.2;
          const scale = Math.min(maxW / iw, maxH / ih);
          const w = iw * scale, h = ih * scale;
          const x = contentX + innerMargin + (maxW - w) / 2;
          const y = contentY + trimHpt - innerMargin - h;
          page.drawImage(imgObj, { x, y, width: w, height: h });
        }
        const textMaxW = trimWpt - innerMargin * 2;
        const textX = contentX + innerMargin;
        const textTopY = contentY + (trimHpt * 0.33);
        drawWrappedText(page, p.text || "", textX, textTopY, textMaxW, fontBody, bodySize, lineHeight);

      } else if (layout === "text_top") {
        const textMaxW = trimWpt - innerMargin * 2;
        const textX = contentX + innerMargin;
        const textTopY = contentY + trimHpt - innerMargin - bodySize;
        const afterY = drawWrappedText(page, p.text || "", textX, textTopY, textMaxW, fontBody, bodySize, lineHeight);

        if (imgObj) {
          const iw = imgObj.width, ih = imgObj.height;
          const maxW = textMaxW;
          const maxH = (afterY - (contentY + innerMargin)) - mmToPt(6);
          if (maxH > mmToPt(20)) {
            const scale = Math.min(maxW / iw, maxH / ih);
            const w = iw * scale, h = ih * scale;
            const x = textX + (maxW - w) / 2;
            const y = contentY + innerMargin;
            page.drawImage(imgObj, { x, y, width: w, height: h });
          }
        }

      } else {
        // full_bleed_panel
        if (imgObj) {
          const iw = imgObj.width, ih = imgObj.height;
          const maxW = trimWpt, maxH = trimHpt;
          const scale = Math.max(maxW / iw, maxH / ih); // cover
          const w = iw * scale, h = ih * scale;
          const x = contentX + (trimWpt - w) / 2;
          const y = contentY + (trimHpt - h) / 2;
          page.drawImage(imgObj, { x, y, width: w, height: h });
        }
        // text panel (utan opacity för stabilitet)
        const panelH = Math.max(mmToPt(24), bodySize * 1.3 * 2.2);
        const pad = mmToPt(8);
        const panelX = contentX;
        const panelY = contentY + mmToPt(10);
        const panelW = trimWpt;

        page.drawRectangle({ x: panelX, y: panelY, width: panelW, height: panelH, color: rgb(1, 1, 1) });
        const textMaxW = panelW - pad * 2;
        const textX = panelX + pad;
        const textTopY = panelY + panelH - pad - bodySize;
        drawWrappedText(page, p.text || "", textX, textTopY, textMaxW, fontBody, bodySize, bodySize * 1.3);
      }

      if (mode === "preview") drawWatermark(page, watermark_text || "FÖRHANDSVISNING");
    } catch (e) {
      console.error("PDF PAGE ERROR p=", p?.page, e?.stack || e);
      const fallback = pdfDoc.addPage([pageW, pageH]);
      fallback.drawText(`Sida ${p?.page || "?"}: kunde inte rendera.`, {
        x: mmToPt(15), y: mmToPt(15),
        size: 12, font: fontBody, color: rgb(0.8, 0.1, 0.1)
      });
      if (mode === "preview") drawWatermark(fallback, watermark_text || "FÖRHANDSVISNING");
    }
  }

  // ---------------- Back cover ----------------
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const margin = mmToPt(18);
    const blurb = story?.book?.lesson
      ? `Lärdom: ${story.book.lesson}`
      : `En berättelse skapad med BokPiloten.`;

    page.drawText("Baksida", {
      x: contentX + margin, y: contentY + trimHpt - margin - 18,
      size: 18, font: fontTitle, color: rgb(0.1, 0.1, 0.1)
    });

    const fontBodySize = 12;
    const lineH = fontBodySize * 1.4;
    drawWrappedText(
      page,
      blurb,
      contentX + margin,
      contentY + trimHpt - margin - 18 - lineH,
      trimWpt - margin * 2,
      fontBody,
      fontBodySize,
      lineH
    );

    if (mode === "preview") drawWatermark(page, watermark_text || "FÖRHANDSVISNING");
  } catch (e) {
    console.error("PDF BACK COVER ERROR:", e?.stack || e);
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Baksidan kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: fontBody, color: rgb(0.8, 0.1, 0.1) });
  }

  return await pdfDoc.save();
}

// =============================== API ========================================
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (req.method === "GET" && url.pathname === "/") return ok({ ok: true, ts: Date.now() });

    // STORY
    if (req.method === "POST" && url.pathname === "/api/story") {
      try {
        const body = await req.json();
        const { name, age, pages, category, style, theme, traits, reading_age } = body || {};
        const targetAge = Number.isFinite(parseInt(reading_age,10)) ? parseInt(reading_age,10) : parseInt(age||6,10);

        const outlineUser = `
${heroDescriptor({ category, name, age: targetAge, traits })}
Tema: "${theme || ""}".
Läsålder: ${targetAge}. Svara ENBART med json.
`.trim();
        const outline = await openaiJSON(env, OUTLINE_SYS, outlineUser);

        const storyUser = `
OUTLINE:
${JSON.stringify(outline)}
${heroDescriptor({ category, name, age: targetAge, traits })}
Läsålder: ${targetAge}. Sidor: ${pages||12}. Stil: ${style||"cartoon"}. Kategori: ${category||"kids"}.
Boken ska ha tydlig lärdom (lesson) kopplad till temat. Följ temat noga.
Svara ENBART med json.
`.trim();
        const story = await openaiJSON(env, STORY_SYS, storyUser);
        const plan  = normalizePlan(story?.book?.pages || []);
        return ok({ story, plan, previewVisible: 4 });
      } catch (e) { log("story error", e?.message); return err(e.message||"Story failed", 500); }
    }

    // REF-IMAGE
    if (req.method === "POST" && url.pathname === "/api/ref-image") {
      try{
        const { style="cartoon", photo_b64, bible, traits="", category="pets" } = await req.json();
        if (photo_b64) {
          const b64 = String(photo_b64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
          return ok({ ref_image_b64: b64 });
        }
        const prompt = characterCardPrompt({ style, bible, traits, category });
        const g = await geminiImage(env, { prompt }, 70000, 2);
        if (!g?.b64) return ok({ ref_image_b64: null });
        return ok({ ref_image_b64: g.b64 });
      }catch(e){ log("ref-image error", e?.message); return err("Ref generation failed", 500); }
    }

    // IMAGES
    if (req.method === "POST" && url.pathname === "/api/images") {
      try{
        const { style="cartoon", ref_image_b64, story, plan, concurrency=4 } = await req.json();
        const pages = story?.book?.pages || [];
        if (!pages.length) return err("No pages", 400);
        if (!ref_image_b64) return err("Missing reference image", 400);
        const frames = (plan?.plan || []);
        const pageCount = pages.length;
        const heroName = story?.book?.bible?.main_character?.name || "Hjälten";

        const jobs = pages.map(pg => {
          const f = frames.find(x => x.page === pg.page) || {};
          const prompt = buildFramePrompt({ style, story, page: pg, pageCount, frame: f, characterName: heroName });
          return { page: pg.page, prompt };
        });

        const out = [];
        const CONC = Math.min(Math.max(parseInt(concurrency||3,10),1),8);
        let idx = 0;
        async function worker(){
          while (idx < jobs.length) {
            const i = idx++; const item = jobs[i];
            try{
              const g = await geminiImage(env, { prompt: item.prompt, character_ref_b64: ref_image_b64 }, 75000, 3);
              out.push({ page: item.page, image_url: g.image_url, provider: g.provider || "google" });
            }catch(e){ out.push({ page: item.page, error: String(e?.message||e) }); }
          }
        }
        await Promise.all(Array.from({length: CONC}, worker));
        out.sort((a,b)=> (a.page||0)-(b.page||0));
        return ok({ images: out });
      }catch(e){ log("images error", e?.message); return err(e.message||"Images failed", 500); }
    }

    // REGENERATE
    if (req.method === "POST" && url.pathname === "/api/image/regenerate") {
      try{
        const { style="cartoon", ref_image_b64, page_text, scene_text, frame, story } = await req.json();
        if (!ref_image_b64) return err("Missing reference image", 400);

        const fakeStory = story || { book:{ pages:[{page:1,scene:scene_text,text:page_text}] } };
        const pg = { page: 1, scene: scene_text, text: page_text, time_of_day: frame?.time_of_day, weather: frame?.weather };
        const f  = { shot_type: frame?.shot_type || "M", lens_mm: frame?.lens_mm || 50, subject_size_percent: frame?.subject_size_percent || 60 };

        const prompt = buildFramePrompt({
          style, story: fakeStory, page: pg, pageCount: 1, frame: f,
          characterName: (fakeStory.book?.bible?.main_character?.name || "Hjälten")
        });

        const g = await geminiImage(env, { prompt, character_ref_b64: ref_image_b64 }, 75000, 3);
        return ok({ image_url: g.image_url, provider: g.provider || "google" });
      }catch(e){ log("regen error", e?.message); return err(e.message||"Regenerate failed", 500); }
    }

    // PDF
    if (req.method === "POST" && url.pathname === "/api/pdf") {
      try { return await handlePdfRequest(req); }
      catch (e) { return err(e?.message || "PDF failed", 500); }
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    }});
  }
};
