// ============================================================================
// BokPiloten – Worker v22 (streaming images + gratis cache för PDF)
// - /api/images: streamar NDJSON (en rad per färdig bild) → inga QUIC idle timeouts
// - /cache/:sid/:page.png: PUT data:URL → GET liten URL (för PDF-bygget)
// - /api/pdf: tar [{page, url}] (små requestar), bäddar in med cache-first
// - Alltid CORS, även vid fel
// ============================================================================

import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

// ---------------------------- CORS utils ------------------------------------
const BASE_CORS = {
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
  "access-control-expose-headers": "Content-Disposition",
};
function withCors(resp, req) {
  const h = new Headers(resp?.headers || {});
  const origin = req?.headers?.get?.("Origin") || "*";
  if (!h.has("access-control-allow-origin")) h.set("access-control-allow-origin", origin);
  for (const [k,v] of Object.entries(BASE_CORS)) if (!h.has(k)) h.set(k,v);
  if (!h.has("vary")) h.set("vary","Origin");
  return new Response(resp.body, { status: resp.status, headers: h });
}
const ok  = (data, code=200) => new Response(JSON.stringify(data), {
  status: code, headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store", ...BASE_CORS, "access-control-allow-origin":"*" }
});
const err = (msg, code=400, extra={}) => ok({ error: msg, ...extra }, code);

// --------------------------- Models & prompts --------------------------------
const OPENAI_MODEL = "gpt-4o-mini";

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

// Kortare timeout + få försök för att hålla total väggtid nere
async function geminiImage(env, item, timeoutMs=45000, attempts=2) {
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
    }catch(e){ clearTimeout(t); last=e; await new Promise(r=>setTimeout(r, 160*i)); }
  }
  throw last || new Error("Gemini failed");
}

function styleHint(style="cartoon"){
  const s=(style||"cartoon").toLowerCase();
  if (s==="storybook") return "storybook watercolor, soft edges, paper texture, warm and cozy";
  if (s==="pixar")     return "stylized 3D animated film still (not photographic): enlarged eyes, simplified forms, clean gradients, soft subsurface scattering, gentle rim light, shallow depth of field, expressive face rigs";
  if (s==="comic")     return "bold comic style, inked lines, flat colors, dynamic action framing, no speech balloons";
  if (s==="painting")  return "soft painterly illustration, visible brushwork, warm lighting, gentle textures";
  return "expressive 2D cartoon: thick-and-thin outlines, cel shading, squash-and-stretch poses, vibrant cheerful palette";
}

const OUTLINE_SYS = `
Du ska skriva en svensk dispositions-json ("json") för en bilderbok om en HJÄLTE (typ anges av användaren).
Returnera exakt:{
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
- Håll dig NOGA till användarens tema; undvik sidospår.
- Anpassa språk till reading_age. Svara ENBART med json.
`;

const STORY_SYS = `
Du får en outline för en svensk bilderbok. Skriv nu boken som "json" enligt:
{ "book":{
  "title": string,
  "reading_age": number,
  "style": "cartoon"|"pixar"|"storybook"|"comic"|"painting",
  "category": "kids"|"pets",
  "bible":{ "main_character": { "name": string, "age": number, "physique": string, "identity_keys": string[] }, "wardrobe": string[], "palette": string[], "world": string, "tone": string },
  "theme": string,
  "lesson": string,
  "pages":[ { "page": number, "text": string, "scene": string, "time_of_day": "day"|"golden_hour"|"evening"|"night", "weather":"clear"|"cloudy"|"rain"|"snow" } ]
}}
Regler:
- 12–20 sidor; 2–4 meningar/sida. Svenska.
- Tydlig drivkraft → hinder → vändpunkt → lösning → payoff kopplad till lesson.
- "scene" konkret och stödjer temat. Svara ENBART med json.
`;

function heroDescriptor({ category, name, age, traits }){
  if (category === "kids") return `HJÄLTE: ett barn som heter ${name||"Nova"} (${parseInt(age||6,10)} år), kännetecken: ${traits||"nyfiken, modig"}.`;
  return `HJÄLTE: ett husdjur som heter ${name||"Nova"} (${parseInt(age||6,10)} år), kännetecken: ${traits||"lekfull, snäll"}.`;
}
function normalizePlan(pages){
  const out=[]; pages.forEach((p,i)=>{ const order=["EW","M","CU","W"]; const t=order[i%order.length];
    const lens={EW:28,W:35,M:50,CU:85}[t]||35; const size={EW:30,W:45,M:60,CU:80}[t]||60;
    out.push({ page:p.page, shot_type:t, lens_mm:lens, subject_size_percent:size }); });
  return { plan: out };
}
function shotLine(f={}){ const map={EW:"extra wide",W:"wide",M:"medium",CU:"close-up"}; return `${map[f.shot_type||"M"]} shot, ~${f.subject_size_percent||60}% subject, ≈${f.lens_mm||35}mm`; }
function buildSeriesContext(story){
  const pages = story?.book?.pages || [];
  const beats = pages.slice(0,12).map(p=>`p${p.page}: ${(p.scene||p.text||"").replace(/\s+/g," ").trim()}`);
  return [`SERIES CONTEXT — title: ${story?.book?.title || "Sagobok"}`, `beats: ${beats.join(" | ")}`].join("\n");
}
function buildFramePrompt({ style, story, page, pageCount, frame, characterName }){
  const series = buildSeriesContext(story);
  const styleLine = styleHint(style);
  const actingHint = (String(style).toLowerCase()==="pixar" || String(style).toLowerCase()==="cartoon")
    ? "Expressive acting: tydlig mimik, kroppsspråk, dynamiska poser." : "";
  return [
    series,
    `This is page ${page.page} of ${pageCount}.`,
    `Render in ${styleLine}. No on-screen text or speech bubbles.`,
    `Keep the same hero (${characterName}) from the reference; adapt pose, camera and lighting.`,
    actingHint,
    page.time_of_day ? `Time of day: ${page.time_of_day}.` : "",
    page.weather ? `Weather: ${page.weather}.` : "",
    `SCENE: ${page.scene || page.text || ""}`,
    `FRAMING: ${shotLine(frame)}.`,
    `VARIETY: make this page visually distinct yet coherent.`
  ].filter(Boolean).join("\n");
}

// ============================== PDF helpers =================================
const PT_PER_MM = 72/25.4;
const TRIMS = { square210: { w_mm: 210, h_mm: 210, default_bleed_mm: 3 } };
const mmToPt = (mm)=> mm * PT_PER_MM;

function fontSpecForReadingAge(ra=6){
  if (ra <= 5)  return { size: 22, leading: 1.35 };
  if (ra <= 8)  return { size: 18, leading: 1.35 };
  return { size: 16, leading: 1.30 };
}

function drawWatermark(page, text = "FÖRHANDSVISNING", color = rgb(0.2, 0.2, 0.2)) {
  const { width, height } = page.getSize();
  const fontSize = Math.min(width, height) * 0.08;
  const angleRad = Math.atan2(height, width);
  const angleDeg = (angleRad * 180) / Math.PI;
  page.drawText(text, { x: width*0.1, y: height*0.3, size: fontSize, color, opacity: 0.12, rotate: degrees(angleDeg) });
}

// --- Cache API: lagra bilder (bytes) via PUT data:URL -> GET liten URL ---
function dataUrlToBytes(dataUrl) {
  if (!dataUrl?.startsWith("data:")) return null;
  const [, meta, b64] = dataUrl.match(/^data:([^;]+);base64,(.+)$/) || [];
  if (!b64) return null;
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: meta || "application/octet-stream" };
}
async function handleCachePut(req, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  const sid   = parts[1]; const file = parts[2] || ""; const page = (file.split(".")[0] || "1");
  if (!sid || !page) return err("Bad cache path", 400);
  const j = await req.json().catch(()=> ({}));
  const d = dataUrlToBytes(j.data_url);
  if (!d) return err("Missing/invalid data_url", 400);
  const key = new Request(url.toString(), { method: "GET" });
  const res = new Response(d.bytes, { headers: { "content-type": d.mime || "image/png", "cache-control": "public, max-age=31536000, immutable", ...BASE_CORS, "access-control-allow-origin":"*" } });
  await caches.default.put(key, res.clone());
  return ok({ ok:true, url: url.toString(), sid, page: Number(page) });
}
async function handleCacheGet(_req, url) {
  const key = new Request(url.toString(), { method: "GET" });
  const hit = await caches.default.match(key);
  if (hit) return new Response(hit.body, { status: 200, headers: hit.headers });
  return new Response("Not found", { status: 404, headers: { ...BASE_CORS, "access-control-allow-origin":"*" } });
}

async function fetchImageBytesCacheFirst(urlStr) {
  try {
    const req = new Request(urlStr, { method: "GET" });
    const cached = await caches.default.match(req);
    if (cached) return new Uint8Array(await cached.arrayBuffer());
  } catch {}
  try {
    const r = await fetch(urlStr);
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch { return null; }
}
async function embedImage(pdfDoc, imageUrlOrDataUrl) {
  if (!imageUrlOrDataUrl) return null;
  if (imageUrlOrDataUrl.startsWith("data:image/")) {
    const d = dataUrlToBytes(imageUrlOrDataUrl);
    if (!d) return null;
    try { return await pdfDoc.embedPng(d.bytes); } catch {}
    try { return await pdfDoc.embedJpg(d.bytes); } catch {}
    return null;
  }
  const bytes = await fetchImageBytesCacheFirst(imageUrlOrDataUrl);
  if (!bytes) return null;
  try { return await pdfDoc.embedPng(bytes); } catch {}
  try { return await pdfDoc.embedJpg(bytes); } catch {}
  return null;
}
function drawWrappedText(page, text, x, yTop, maxW, font, fontSize, lineHeight){
  const words = String(text||"").split(/\s+/); let line="", y=yTop; const lines=[];
  for (const w of words){ const test=line?line+" "+w:w; const wpx=font.widthOfTextAtSize(test,fontSize);
    if (wpx<=maxW) line=test; else { if (line) lines.push(line); line=w; } }
  if (line) lines.push(line);
  for (const ln of lines){ page.drawText(ln,{x,y,size:fontSize,font,color:rgb(0.1,0.1,0.1)}); y-=lineHeight; }
  return y;
}
async function buildPdf({ story, images, mode="preview", trim="square210", bleed_mm, watermark_text }) {
  const trimSpec = TRIMS[trim] || TRIMS.square210;
  const bleed = mode === "print" ? (Number.isFinite(bleed_mm) ? bleed_mm : trimSpec.default_bleed_mm) : 0;
  const trimW = mmToPt(trimSpec.w_mm), trimH = mmToPt(trimSpec.h_mm);
  const pageW = trimW + mmToPt(bleed*2), pageH = trimH + mmToPt(bleed*2);
  const contentX = mmToPt(bleed), contentY = mmToPt(bleed);

  const pdf = await PDFDocument.create();
  const fontBody = await pdf.embedFont(StandardFonts.Helvetica);
  const fontTitle = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pages = story?.book?.pages || [];
  const readingAge = story?.book?.reading_age || 6;
  const { size: bodySize, leading } = fontSpecForReadingAge(readingAge);
  const lineH = bodySize * leading;

  const title = story?.book?.title || "Min bok";
  const heroName = story?.book?.bible?.main_character?.name || "";
  const theme = story?.book?.theme || "";

  const imgByPage = new Map();
  (images||[]).forEach(r => { const u = r?.url || r?.image_url; if (r?.page && typeof u==="string") imgByPage.set(r.page, u); });

  // Cover
  try {
    const page = pdf.addPage([pageW,pageH]);
    const margin = mmToPt(18);
    const titleSize = Math.min(trimW, trimH) * 0.07;
    const subSize = titleSize * 0.45;

    const coverUrl = imgByPage.get(1);
    const coverImg = await embedImage(pdf, coverUrl);
    if (coverImg) {
      const iw=coverImg.width, ih=coverImg.height;
      const panel = Math.min(trimW - margin*2, trimH - margin*3);
      const s = Math.min(panel/iw, panel/ih);
      const w=iw*s, h=ih*s, x=contentX+(trimW-w)/2, y=contentY+(trimH-h)/2 - mmToPt(8);
      page.drawImage(coverImg, { x, y, width:w, height:h });
    }
    const tWidth = fontTitle.widthOfTextAtSize(title, titleSize);
    page.drawText(title, { x: contentX+(trimW-tWidth)/2, y: contentY+trimH - margin - titleSize, size:titleSize, font:fontTitle, color:rgb(0.1,0.1,0.1) });
    const sub = theme ? `${theme}` : (heroName ? `Med ${heroName}` : "");
    if (sub) {
      const sWidth = fontBody.widthOfTextAtSize(sub, subSize);
      page.drawText(sub, { x: contentX+(trimW-sWidth)/2, y: contentY+trimH - margin - titleSize - subSize - mmToPt(3), size:subSize, font:fontBody, color:rgb(0.25,0.25,0.25) });
    }
    if (mode==="preview") drawWatermark(page, watermark_text || "FÖRHANDSVISNING");
  } catch (e) {
    const page = pdf.addPage([pageW,pageH]);
    page.drawText("Omslag kunde inte renderas.", { x:mmToPt(15), y:mmToPt(15), size:12, font:fontBody, color:rgb(0.8,0.1,0.1) });
  }

  // Inre sidor
  for (const p of pages) {
    const page = pdf.addPage([pageW,pageH]);
    const imgUrl = imgByPage.get(p.page);
    const innerMargin = mmToPt(15);
    const text = p.text || "";
    const len = text.length;
    const layout = len<=180 ? "image_top" : len<=280 ? "text_top" : "full_bleed_panel";
    try {
      const img = await embedImage(pdf, imgUrl);
      if (layout==="image_top") {
        const imgAreaH = trimH*0.66;
        if (img) {
          const iw=img.width, ih=img.height;
          const maxW=trimW-innerMargin*2, maxH=imgAreaH-innerMargin*1.2;
          const s=Math.min(maxW/iw, maxH/ih);
          const w=iw*s, h=ih*s, x=contentX+innerMargin+(maxW-w)/2, y=contentY+trimH-innerMargin-h;
          page.drawImage(img, { x, y, width:w, height:h });
        }
        const textMaxW = trimW - innerMargin*2;
        const textX = contentX + innerMargin;
        const textTopY = contentY + (trimH * 0.33);
        drawWrappedText(page, text, textX, textTopY, textMaxW, fontBody, bodySize, lineH);
      } else if (layout==="text_top") {
        const textMaxW = trimW - innerMargin*2;
        const textX = contentX + innerMargin;
        const textTopY = contentY + trimH - innerMargin - bodySize;
        const afterY = drawWrappedText(page, text, textX, textTopY, textMaxW, fontBody, bodySize, lineH);
        if (img) {
          const iw=img.width, ih=img.height;
          const maxW=textMaxW; const maxH = (afterY - (contentY+innerMargin)) - mmToPt(6);
          if (maxH > mmToPt(20)) {
            const s=Math.min(maxW/iw, maxH/ih); const w=iw*s, h=ih*s;
            const x=textX + (maxW-w)/2, y=contentY+innerMargin;
            page.drawImage(img, { x, y, width:w, height:h });
          }
        }
      } else {
        if (img) {
          const iw=img.width, ih=img.height;
          const s=Math.max(trimW/iw, trimH/ih);
          const w=iw*s, h=ih*s, x=contentX+(trimW-w)/2, y=contentY+(trimH-h)/2;
          page.drawImage(img, { x, y, width:w, height:h });
        }
        const panelH = Math.max(mmToPt(24), bodySize*1.3*2.2);
        const pad = mmToPt(8);
        const panelX = contentX, panelY = contentY + mmToPt(10), panelW = trimW;
        page.drawRectangle({ x:panelX, y:panelY, width:panelW, height:panelH, color:rgb(1,1,1) });
        const textMaxW = panelW - pad*2, textX = panelX + pad, textTopY = panelY + panelH - pad - bodySize;
        drawWrappedText(page, text, textX, textTopY, textMaxW, fontBody, bodySize, bodySize*1.3);
      }
      if (mode==="preview") drawWatermark(page, watermark_text || "FÖRHANDSVISNING");
    } catch {
      page.drawText(`Sida ${p?.page||"?"}: kunde inte rendera.`, { x:mmToPt(15), y:mmToPt(15), size:12, font:fontBody, color:rgb(0.8,0.1,0.1) });
      if (mode==="preview") drawWatermark(page, watermark_text || "FÖRHANDSVISNING");
    }
  }

  // Baksida
  const back = pdf.addPage([pageW,pageH]);
  const margin = mmToPt(18);
  const blurb = story?.book?.lesson ? `Lärdom: ${story.book.lesson}` : `En berättelse skapad med BokPiloten.`;
  back.drawText("Baksida", { x: contentX+margin, y: contentY+trimH - margin - 18, size:18, font:fontTitle, color:rgb(0.1,0.1,0.1) });
  drawWrappedText(back, blurb, contentX+margin, contentY+trimH - margin - 18 - line2, trimW - margin*2, await pdf.embedFont(StandardFonts.Helvetica), bodySize, line2);
  if (mode==="preview") drawWatermark(back, "FÖRHANDSVISNING");

  return await pdf.save();
}

// =============================== API ========================================
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Preflight
    if (req.method === "OPTIONS") {
      const origin = req.headers.get("Origin") || "*";
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, ...BASE_CORS, "vary":"Origin, Access-Control-Request-Method, Access-Control-Request-Headers" } });
    }

    try {
      // Health
      if (req.method === "GET" && url.pathname === "/") {
        return withCors(ok({ ok:true, ts: Date.now() }), req);
      }

      // Cache endpoints
      if (url.pathname.startsWith("/cache/") && req.method === "PUT") return withCors(await handleCachePut(req, url), req);
      if (url.pathname.startsWith("/cache/") && req.method === "GET")  return withCors(await handleCacheGet(req, url), req);

      // STORY
      if (req.method === "POST" && url.pathname === "/api/story") {
        try {
          const body = await req.json();
          const { name, age, pages, category, style, theme, traits, reading_age } = body || {};
          const targetAge = Number.isFinite(parseInt(reading_age,10)) ? parseInt(reading_age,10) : parseInt(age||6,10);

          const outlineUser = `${heroDescriptor({ category, name, age: targetAge, traits })}\nTema: "${theme || ""}".\nLäsålder: ${targetAge}. Svara ENBART med json.`;
          const outline = await openaiJSON(env, OUTLINE_SYS, outlineUser);

          const storyUser = `OUTLINE:\n${JSON.stringify(outline)}\n${heroDescriptor({ category, name, age: targetAge, traits })}\nLäsålder: ${targetAge}. Sidor: ${pages||12}. Stil: ${style||"cartoon"}. Kategori: ${category||"kids"}.\nBoken ska ha tydlig lärdom (lesson) kopplad till temat. Svara ENBART med json.`;
          const story = await openaiJSON(env, STORY_SYS, storyUser);
          const plan  = normalizePlan(story?.book?.pages || []);
          return withCors(ok({ story, plan, previewVisible: 4 }), req);
        } catch (e) {
          return withCors(err(e?.message||"Story failed", 500), req);
        }
      }

      // REF-IMAGE
      if (req.method === "POST" && url.pathname === "/api/ref-image") {
        try{
          const { style="cartoon", photo_b64, bible, traits="", category="pets" } = await req.json();
          if (photo_b64) {
            const b64 = String(photo_b64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
            return withCors(ok({ ref_image_b64: b64 }), req);
          }
          const prompt = characterCardPrompt({ style, bible, traits, category });
          const g = await geminiImage(env, { prompt }, 45000, 2);
          if (!g?.b64) return withCors(ok({ ref_image_b64: null }), req);
          return withCors(ok({ ref_image_b64: g.b64 }), req);
        }catch(e){
          return withCors(err("Ref generation failed", 500), req);
        }
      }

      // IMAGES (STREAMING NDJSON)
      if (req.method === "POST" && url.pathname === "/api/images") {
        // Streama tillbaka en rad JSON per färdig bild
        const { style="cartoon", ref_image_b64, story, plan, concurrency=3 } = await req.json();
        if (!story?.book?.pages?.length) return withCors(err("No pages", 400), req);
        if (!ref_image_b64) return withCors(err("Missing reference image", 400), req);

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const enc = new TextEncoder();

        // Hjälpfunktion att skriva en NDJSON-rad + flush
        const writeLine = async (obj) => writer.write(enc.encode(JSON.stringify(obj) + "\n"));

        // Svara omedelbart med en stream så kopplingen hålls levande
        const resp = new Response(readable, {
          status: 200,
          headers: {
            "content-type": "application/x-ndjson; charset=utf-8",
            "cache-control": "no-store",
            ...BASE_CORS,
            "access-control-allow-origin":"*"
          }
        });

        // Kör genereringen parallellt i samma request, men skicka resultat löpande
        const allPages = story.book.pages;
        const frames = (plan?.plan || []);
        const pageCount = allPages.length;
        const heroName = story?.book?.bible?.main_character?.name || "Hjälten";

        (async () => {
          try {
            await writeLine({ status:"started", total: pageCount });

            // Enkel pool
            const jobs = allPages.map(pg => {
              const f = frames.find(x => x.page === pg.page) || {};
              const prompt = buildFramePrompt({ style, story, page: pg, pageCount, frame: f, characterName: heroName });
              return { page: pg.page, prompt };
            });

            let idx = 0;
            let completed = 0;
            const CONC = Math.min(Math.max(parseInt(concurrency||3,10),1),6);

            async function worker(){
              while (idx < jobs.length) {
                const i = idx++; const item = jobs[i];
                try{
                  const g = await geminiImage(env, { prompt: item.prompt, character_ref_b64: ref_image_b64 }, 45000, 2);
                  completed++;
                  await writeLine({ page: item.page, image_url: g.image_url, provider: g.provider || "google", progress: { completed, total: pageCount } });
                }catch(e){
                  completed++;
                  await writeLine({ page: item.page, error: String(e?.message||e), progress: { completed, total: pageCount } });
                }
              }
            }
            await Promise.all(Array.from({length: CONC}, worker));

            await writeLine({ status:"done", total: pageCount });
          } catch (e) {
            await writeLine({ status:"error", message: String(e?.message||e) });
          } finally {
            await writer.close();
          }
        })();

        return withCors(resp, req);
      }

      // PDF
      if (req.method === "POST" && url.pathname === "/api/pdf") {
        try {
          const body = await req.json();
          const { story, images, mode, trim, bleed_mm, watermark_text } = body || {};
          if (!story?.book) return withCors(err("Missing story", 400), req);
          if (!Array.isArray(images)) return withCors(err("Missing images[]", 400), req);
          const fixed = images.map(r => ({ page: r.page, url: r.url || r.image_url }));
          const pdfBytes = await buildPdf({
            story,
            images: fixed,
            mode: mode==="print" ? "print" : "preview",
            trim: trim || "square210",
            bleed_mm,
            watermark_text: watermark_text || (mode==="preview" ? "FÖRHANDSVISNING" : null),
          });
          return withCors(new Response(pdfBytes, {
            status: 200,
            headers: {
              "content-type": "application/pdf",
              "content-disposition": `inline; filename="bokpiloten-${Date.now()}.pdf"`,
              "cache-control": mode==="preview" ? "no-store" : "public, max-age=31536000, immutable",
              ...BASE_CORS,
              "access-control-allow-origin":"*"
            }
          }), req);
        } catch (e) {
          return withCors(err(e?.message || "PDF failed", 500), req);
        }
      }

      // 404
      return withCors(new Response(JSON.stringify({ error: "Not found" }), {
        status: 404, headers: { "content-type":"application/json; charset=utf-8" }
      }), req);

    } catch (e) {
      return withCors(err("Server error", 500), req);
    }
  }
};
