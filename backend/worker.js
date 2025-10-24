// ============================================================================
// BokPiloten – Worker v20 "30-blad inlaga (uppslag: bild vänster / text höger)"
// Endpoints: story, ref-image, cover, images, image/regenerate, images/upload, pdf, gelato/order, gelato/webhook
// Requires env: API_KEY, GEMINI_API_KEY, IMAGES_API_TOKEN, CF_ACCOUNT_ID,
//               CF_IMAGES_ACCOUNT_HASH, (CF_IMAGES_VARIANT),
//               GELATO_API_KEY (för beställningar),
//               PUBLIC_BASE_URL (om du vill exponera R2-filer),
//               R2_BUCKET (Cloudflare R2 binding – optional)
// ----------------------------------------------------------------------------
// PRODUKTFORMAT:
// • Hårdpärm 20×20 cm (210×210 mm i filer), bleed 3 mm
// • "30 blad" = 30 enkelsidor i inlagan mellan pärmarna
// • Struktur: [FRAMSIDa] + (1) TITELBLAD (singel) + 14 uppslag (bild vänster, text höger)
//             + (1) SLUT-sida (singel) + [BAKSIDA]
//   => Inlaga = 30 sidor: 1 (titel) + 28 (14*2) + 1 (slut)
//   => Totalt PDF-sidantal = 32 (inkl. framsida + baksida)
// ============================================================================

import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

/* -------------------------------- CORS ---------------------------------- */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
  "access-control-expose-headers": "Content-Disposition",
  "vary": "Origin",
};
const JSONH = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  ...CORS,
};
const ok = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { ...JSONH, ...(init.headers || {}) },
  });
const err = (msg, code = 400, extra = {}) => ok({ error: msg, ...extra }, { status: code });
const withCORS = (resp) => {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
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
      messages: [ { role: "system", content: sys }, { role: "user", content: usr } ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status} ${await r.text().catch(() => "")}`);
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
  if (p) {
    const m = p.text.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (m) return { mime: m[1], b64: m[2] };
  }
  p = parts.find(x => typeof x?.text === "string" && /^https?:\/\//.test(x.text));
  if (p) return { url: p.text };
  return null;
}
async function geminiImage(env, item, timeoutMs = 75000, attempts = 3) {
  const key = env.GEMINI_API_KEY; if (!key) throw new Error("GEMINI_API_KEY missing");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(key)}`;
  const parts = [];
  if (item.character_ref_b64) parts.push({ inlineData: { mimeType: "image/png", data: item.character_ref_b64 } });
  if (item.guidance) parts.push({ text: item.guidance });
  parts.push({ text: item.prompt });
  const body = { contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"], temperature: 0.35, topP: 0.9 } };
  let last;
  for (let i=1;i<=attempts;i++) {
    const ctl = new AbortController(); const t = setTimeout(()=>ctl.abort("timeout"), timeoutMs);
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Gemini ${r.status} ${await r.text().catch(()=>"")}`);
      const j = await r.json();
      const got = findGeminiImagePart(j);
      if (got?.b64 && got?.mime) return { image_url: `data:${got.mime};base64,${got.b64}`, provider: "google", b64: got.b64 };
      if (got?.url) return { image_url: got.url, provider: "google" };
      throw new Error("No image in response");
    } catch (e) { clearTimeout(t); last = e; await new Promise(r=>setTimeout(r, 180*i)); }
  }
  throw last || new Error("Gemini failed");
}

/* ----------------------------- Style ---------------------------------- */
function styleHint(style = "cartoon") {
  const s = (style || "cartoon").toLowerCase();
  if (s === "storybook") return "storybook watercolor, soft edges, paper texture, warm and cozy";
  if (s === "pixar") return "stylized 3D animated film still (not photographic): enlarged eyes, simplified forms, clean gradients";
  if (s === "comic") return "bold comic style, inked lines, flat colors";
  if (s === "painting") return "soft painterly illustration, visible brushwork";
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
+ { "book":{
 "title": string,
  "tagline": string,
 "back_blurb": string,
 "reading_age": number,
 "style": "cartoon"|"pixar"|"storybook"|"comic"|"painting",
  "category": "kids"|"pets",
  "bible":{"main_character": { "name": string, "age": number, "physique": string, "identity_keys": string[] },
           "wardrobe": string[], "palette": string[], "world": string, "tone": string},
  "theme": string,"lesson": string,
  "pages":[{ "page": number, "text": string, "scene": string, "time_of_day": "day"|"golden_hour"|"evening"|"night","weather":"clear"|"cloudy"|"rain"|"snow"}]
 }}
Hårda regler: 12–20 sidor, 2–4 meningar/sida. Konkreta scener i huvudmiljö. Svenskt språk. Endast JSON.
 Titeln ska vara säljbar. Fyll "tagline" och "back_blurb" (1–3 meningar).
`;
function heroDescriptor({ category, name, age, traits }) {
  if ((category || "kids") === "pets")
    return `HJÄLTE: ett husdjur vid namn ${name || "Nova"}; egenskaper: ${traits || "nyfiken, lekfull"}.`;
  const a = parseInt(age || 6, 10);
  return `HJÄLTE: ett barn vid namn ${name || "Nova"} (${a} år), egenskaper: ${traits || "modig, omtänksam"}.`;
}

/* --------------------------- Frame prompts ----------------------------- */
function normalizePlan(pages) {
  const out = [];
  pages.forEach((p, i) => {
    const order = ["EW","M","CU","W"]; const t = order[i % order.length];
    const lens = { EW: 28, W: 35, M: 50, CU: 85 }[t] || 35;
    const size = { EW: 30, W: 45, M: 60, CU: 80 }[t] || 60;
    out.push({ page: p.page, shot_type: t, lens_mm: lens, subject_size_percent: size });
  });
  return { plan: out };
}
function shotLine(f={}) {
  const map = { EW: "extra wide", W: "wide", M: "medium", CU: "close-up" };
  return `${map[f.shot_type || "M"]} shot, ~${f.subject_size_percent || 60}% subject, ≈${f.lens_mm || 35}mm`;
}
function buildSeriesContext(story) {
  const pages = story?.book?.pages || [];
  const locs = [];
  const beats = pages.map((p) => {
    const key = (p.scene || p.text || "").replace(/\s+/g, " ").trim();
    const lkey = key.toLowerCase().match(/(strand|skog|kök|sovrum|park|hav|stad|skola|gård|sjö|berg)/)?.[1] || "plats";
    if (!locs.includes(lkey)) locs.push(lkey);
    return `p${p.page}: ${key}`;
  });
  return [ `SERIES CONTEXT — title: ${story?.book?.title || "Sagobok"}`, `locations: ${locs.join(", ")}`, `beats: ${beats.join(" | ")}` ].join("\n");
}
function buildFramePrompt({ style, story, page, pageCount, frame, characterName }) {
  const series = buildSeriesContext(story);
  const pg = page; const styleLine = styleHint(style);
  return [
    series,
    `This is page ${pg.page} of ${pageCount}.`,
    `Render in ${styleLine}. No text or speech bubbles.`,
    `Square composition (1:1), keep limbs fully in frame.`,
    `Keep the same hero (${characterName}) from reference. Adapt pose, camera, lighting.`,
    pg.time_of_day ? `Time of day: ${pg.time_of_day}.` : "",
    pg.weather ? `Weather: ${pg.weather}.` : "",
    `SCENE: ${pg.scene || pg.text || ""}`,
    `FRAMING: ${shotLine(frame)}.`,
    `VARIETY: each page unique yet coherent.`,
  ].filter(Boolean).join("\n");
}
function characterCardPrompt({ style, bible, traits }) {
  const mc = bible?.main_character || {}; const name = mc.name || "Nova";
  const phys = mc.physique || traits || "fluffy gray cat with curious eyes";
  return [ `Character reference in ${styleHint(style)}.`, `One hero only, full body, neutral background.`, `Hero: ${name}, ${phys}. No text.` ].join(" ");
}
function buildCoverPrompt({ style, story, characterName }) {
  const styleLine = styleHint(style);
  const theme = story?.book?.theme || "";
  return [
    `BOOK COVER ILLUSTRATION (front cover), ${styleLine}.`,
    `Square composition (1:1). No text or logos.`,
    `Focus on the main hero (${characterName}) from the reference; perfect identity consistency.`,
    theme ? `Theme cue: ${theme}.` : "",
  ].filter(Boolean).join("\n");
}

/* ----------------------- Cloudflare Images ----------------------------- */
function dataUrlToBlob(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i); if (!m) return null;
  const mime = m[1]; const b64 = m[2];
  const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
  return { blob: new Blob([u8], { type: mime }), mime };
}
function cfImagesDeliveryURL(env, image_id, variant, forceFormat = "jpeg") {
  const hash = env.CF_IMAGES_ACCOUNT_HASH; if (!hash) return null;
  const v = variant || env.CF_IMAGES_VARIANT || "public";
  const base = `https://imagedelivery.net/${hash}/${image_id}/${v}`;
  return forceFormat ? `${base}?format=${encodeURIComponent(forceFormat)}` : base;
}
async function uploadOneToCFImages(env, { data_url, id }) {
  const miss = []; if (!env.IMAGES_API_TOKEN) miss.push("IMAGES_API_TOKEN"); if (!env.CF_ACCOUNT_ID) miss.push("CF_ACCOUNT_ID");
  if (miss.length) throw new Error("Cloudflare Images env missing: " + miss.join(", "));
  const file = dataUrlToBlob(data_url); if (!file) throw new Error("Bad data_url");
  const form = new FormData(); form.append("file", file.blob, id || `page-${Date.now()}.png`);
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`, {
    method: "POST", headers: { authorization: `Bearer ${env.IMAGES_API_TOKEN}` }, body: form
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`CF Images ${r.status} ${JSON.stringify(j)}`);
  const image_id = j?.result?.id; const url = cfImagesDeliveryURL(env, image_id);
  return { image_id, url };
}

/* ---------------------------- PDF helpers ------------------------------ */
const MM_PER_INCH = 25.4; const PT_PER_INCH = 72; const PT_PER_MM = PT_PER_INCH / MM_PER_INCH;
const TRIMS = { square210: { w_mm: 210, h_mm: 210, default_bleed_mm: 3 } };
function mmToPt(mm) { return mm * PT_PER_MM; }
function fontSpecForReadingAge(ra = 6) {
  if (ra <= 5) return { size: 22, leading: 1.34 };
  if (ra <= 8) return { size: 18, leading: 1.34 };
  if (ra <= 12) return { size: 16, leading: 1.32 };
  return { size: 16, leading: 1.32 };
}
async function tryEmbedTtf(pdfDoc, url) {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) return null; const bytes = new Uint8Array(await r.arrayBuffer());
    return await pdfDoc.embedFont(bytes, { subset: true });
  } catch { return null; }
}

// Watermark
function drawWatermark(page, text = "FÖRHANDSVISNING", color = rgb(0.4, 0.4, 0.4)) {
  const { width, height } = page.getSize();
  const fontSize = Math.min(width, height) * 0.09;
  const angleRad = Math.atan2(height, width); const angleDeg = (angleRad * 180) / Math.PI;
  page.drawText(text, { x: width * 0.08, y: height * 0.28, size: fontSize, color, opacity: 0.08, rotate: degrees(angleDeg) });
}

// Sidnumrering + bakgrunder
function pageNumberStamp(page, num, font) {
  if (!Number.isFinite(num)) return;
  const { width } = page.getSize(); const txt = String(num); const size = 10; const w = font.widthOfTextAtSize(txt, size);
  page.drawText(txt, { x: (width - w) / 2, y: 12, size, font, color: rgb(0.25,0.25,0.32) });
}
function pastelBg(page) {
  page.drawRectangle({ x: 0, y: 0, width: page.getSize().width, height: page.getSize().height, color: rgb(0.96, 0.98, 1.00) });
}

// Text helpers
function shrinkToFitLines(text, font, maxSize, minSize, maxWidth, maxLines) {
  function fits(lines, size) { return lines.every(l => font.widthOfTextAtSize(l, size) <= maxWidth); }
  for (let s = maxSize; s >= minSize; s -= 1) { if (font.widthOfTextAtSize(text, s) <= maxWidth) return { size: s, lines: [text] }; }
  if (maxLines <= 1) return { size: minSize, lines: [text] };
  const words = text.split(/\s+/);
  for (let s = maxSize; s >= minSize; s -= 1) {
    let best = null; for (let i=1;i<words.length;i++){
      const l1 = words.slice(0,i).join(" "); const l2 = words.slice(i).join(" ");
      const w1 = font.widthOfTextAtSize(l1, s); const w2 = font.widthOfTextAtSize(l2, s);
      const ok = w1 <= maxWidth && w2 <= maxWidth; if (ok) { const diff = Math.abs(w1 - w2); if (!best || diff < best.diff) best = { lines:[l1,l2], diff }; }
    }
    if (best) return { size: s, lines: best.lines };
  }
  const mid = Math.ceil(words.length/2);
  return { size: minSize, lines: [words.slice(0,mid).join(" "), words.slice(mid).join(" ")] };
}
function drawMultilineWithOutline(page, lines, boxX, boxY, boxW, lineH, size, font) {
  let y = boxY + (lines.length - 1) * lineH;
  for (const ln of lines) {
    const w = font.widthOfTextAtSize(ln, size);
    const x = boxX + (boxW - w) / 2;
    // enkel outline/slag
    const d = Math.max(0.75, size*0.05);
    page.drawText(ln, { x: x + d*0.6, y: y - d*0.6, size, font, color: rgb(0,0,0), opacity: 0.25 });
    const offs = [[ d,0],[-d,0],[0,d],[0,-d],[ d,d],[ d,-d],[-d,d],[-d,-d]];
    for (const [ox,oy] of offs) page.drawText(ln, { x: x+ox, y: y+oy, size, font, color: rgb(0,0,0) });
    page.drawText(ln, { x, y, size, font, color: rgb(1,1,1) });
    y -= lineH;
  }
}
function drawWrappedTextFit(page, text, boxX, boxY, boxW, boxH, font, baseSize, baseLeading, minSize=12, align="center") {
  for (let size = baseSize; size >= minSize; size -= 1) {
    const lineH = size * baseLeading; const words = String(text||"").split(/\s+/); const lines=[]; let line="";
    for (const w of words) { const test = line ? line+" "+w : w; const testW = font.widthOfTextAtSize(test, size);
      if (testW <= boxW) line = test; else { if (line) lines.push(line); line = w; } }
    if (line) lines.push(line); const totalH = lines.length*lineH; if (totalH <= boxH) {
      let y = boxY + boxH - lineH; for (const ln of lines) { const w = font.widthOfTextAtSize(ln, size);
        const x = align === "center" ? boxX + (boxW - w) / 2 : align === "right" ? boxX + (boxW - w) : boxX;
        page.drawText(ln, { x, y, size, font, color: rgb(0.1,0.1,0.1) }); y -= lineH; }
      return { size, lines };
    }
  }
  const size = minSize, lineH = size * baseLeading; const words = String(text||"").split(/\s+/); const lines=[]; let line="";
  for (const w of words) { const test = line ? line+" "+w : w; const testW = font.widthOfTextAtSize(test, size);
    if (testW <= boxW) line = test; else { if (line) lines.push(line); line = w; }
    if ((lines.length + 1) * lineH >= boxH) break; }
  if (line && lines.length * lineH < boxH) lines.push(line + " …");
  let y = boxY + boxH - lineH; for (const ln of lines) { const w = font.widthOfTextAtSize(ln, size);
    const x = align === "center" ? boxX + (boxW - w) / 2 : align === "right" ? boxX + (boxW - w) : boxX;
    page.drawText(ln, { x, y, size, font, color: rgb(0.1,0.1,0.1) }); y -= lineH; }
  return { size, lines, truncated: true };
}

// Image helpers
async function getImageBytes(env, row) {
  try {
    if (row.image_id) {
      const url = cfImagesDeliveryURL(env, row.image_id, undefined, "jpeg"); if (!url) return null;
      const r = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } }); if (!r.ok) return null; return new Uint8Array(await r.arrayBuffer());
    }
    const pickUrl = row.url || row.image_url;
    if (pickUrl && /^https?:\/\//i.test(pickUrl)) {
      const isCFI = /imagedelivery\.net/i.test(pickUrl);
      const forced = isCFI ? (pickUrl.includes("?") ? pickUrl + "&format=jpeg" : pickUrl + "?format=jpeg") : pickUrl;
      const r = await fetch(forced, { cf: { cacheTtl: 3600, cacheEverything: true, image: { format: "jpeg", quality: 90 } } });
      if (!r.ok) return null; return new Uint8Array(await r.arrayBuffer());
    }
    if (row.data_url && row.data_url.startsWith("data:image/")) {
      const m = row.data_url.match(/^data:([^;]+);base64,(.+)$/i); if (!m) return null;
      const b64 = m[2]; const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    return null;
  } catch { return null; }
}
async function embedImage(pdfDoc, bytes) { if (!bytes) return null; try { return await pdfDoc.embedPng(bytes); } catch {} try { return await pdfDoc.embedJpg(bytes); } catch {} return null; }
function drawImageCover(page, img, boxX, boxY, boxW, boxH) {
  const iw = img.width, ih = img.height; const scale = Math.max(boxW/iw, boxH/ih); const w = iw*scale, h = ih*scale;
  const x = boxX + (boxW - w) / 2; const y = boxY + (boxH - h) / 2; page.drawImage(img, { x, y, width: w, height: h });
}
function drawImageContain(page, img, boxX, boxY, boxW, boxH) {
  const iw = img.width, ih = img.height; const scale = Math.min(boxW/iw, boxH/ih); const w = iw*scale, h = ih*scale;
  const x = boxX + (boxW - w) / 2; const y = boxY + (boxH - h) / 2; page.drawImage(img, { x, y, width: w, height: h });
}

// Layout grid (mm)
const GRID = { outer_mm: 10, gap_mm: 8, pad_mm: 10, text_min_mm: 30, text_max_mm: 58 };

/* --------------------------- Build PDF --------------------------------- */
async function buildPdf(
  { story, images, mode = "print", trim = "square210", bleed_mm, watermark_text },
  env
) {
  const trimSpec = TRIMS[trim] || TRIMS.square210;
  const bleed = mode === "print" ? (Number.isFinite(bleed_mm) ? bleed_mm : trimSpec.default_bleed_mm) : 0;

  const trimWpt = mmToPt(trimSpec.w_mm);
  const trimHpt = mmToPt(trimSpec.h_mm);
  const pageW = trimWpt + mmToPt(bleed * 2);
  const pageH = trimHpt + mmToPt(bleed * 2);
  const contentX = mmToPt(bleed);
  const contentY = mmToPt(bleed);

  const pdfDoc = await PDFDocument.create();

  // Fonts
  const baloo = (await tryEmbedTtf(pdfDoc, "https://raw.githubusercontent.com/google/fonts/main/ofl/baloo2/Baloo2-Bold.ttf")) || (await pdfDoc.embedFont(StandardFonts.HelveticaBold));
  const nunito = (await tryEmbedTtf(pdfDoc, "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito-Regular.ttf")) || (await pdfDoc.embedFont(StandardFonts.TimesRoman));
  const nunitoSemi = (await tryEmbedTtf(pdfDoc, "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito-SemiBold.ttf")) || (await pdfDoc.embedFont(StandardFonts.Helvetica));

  const pages = story?.book?.pages || [];
  const readingAge = story?.book?.reading_age || 6;
  const title = story?.book?.title || "Min bok";
  const heroName = story?.book?.bible?.main_character?.name || "";

  // Indexera bilder
  let coverSrc = images?.find((x) => x?.kind === "cover" || x?.page === 0) || null;
  const imgByPage = new Map();
  (images || []).forEach((row) => {
    if (Number.isFinite(row?.page) && row.page > 0 && (row.image_id || row.url || row.image_url || row.data_url)) {
      imgByPage.set(row.page, row);
    }
  });

  // ===== 1) FRAMSIDAN =====
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    if (!coverSrc) coverSrc = imgByPage.get(1) || null; // fallback
    if (coverSrc) {
      const bytes = await getImageBytes(env, coverSrc);
      const coverImg = await embedImage(pdfDoc, bytes);
      if (coverImg) drawImageCover(page, coverImg, 0, 0, pageW, pageH);
    }
    // Titel och tagline på framsidan (shrink-to-fit + outline), valfritt
    const safeInset = mmToPt(GRID.outer_mm + 2);
    const tx = contentX + safeInset; const tw = trimWpt - safeInset * 2;
    const maxTitle = Math.min(trimWpt, trimHpt) * 0.13; const minTitle = 28;
    const titleFit = shrinkToFitLines(title, baloo, maxTitle, minTitle, tw, 2);
    const titleLineH = titleFit.size * 1.08; let cy = contentY + trimHpt - safeInset - (titleFit.lines.length * titleLineH);
    drawMultilineWithOutline(page, titleFit.lines, tx, cy, tw, titleLineH, titleFit.size, baloo);
    const subtitle = story?.book?.tagline || (heroName ? `Med ${heroName}` : "");
    if (subtitle) {
      const maxSub = Math.max(14, titleFit.size * 0.42);
      const subFit = shrinkToFitLines(subtitle, nunitoSemi, maxSub, 12, tw, 2);
      const subLH = subFit.size * 1.15; cy += titleFit.lines.length * titleLineH + mmToPt(4);
      drawMultilineWithOutline(page, subFit.lines, tx, cy, tw, subLH, subFit.size, nunitoSemi);
    }
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  } catch (e) { log("COVER ERR:", e?.message); const page = pdfDoc.addPage([pageW, pageH]); page.drawText("Omslag kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) }); }

  // ===== 2) INLAGA (30 enkelsidor) =====
  // Struktur: (1) Titel-singel + 14 uppslag (bild vänster, text höger) + (1) Slut-singel
  const INLAGA_TOTAL = 30; // exakt 30 sidor mellan pärmar
  const SPREADS = 14;      // 14 uppslag => 28 sidor

  // A) TITELBLAD (singel)
  try {
    const t = pdfDoc.addPage([pageW, pageH]); pastelBg(t);
    const safeX = contentX + mmToPt(GRID.outer_mm);
    const safeY = contentY + mmToPt(GRID.outer_mm);
    const safeW = trimWpt - mmToPt(GRID.outer_mm)*2; const safeH = trimHpt - mmToPt(GRID.outer_mm)*2;
    const tw = safeW * 0.86; const tx = contentX + (trimWpt - tw)/2; const ty = safeY + safeH*0.56;
    const maxTitle = Math.min(trimWpt, trimHpt) * 0.12; const minTitle = 24;
    const titleFit = shrinkToFitLines(title, baloo, maxTitle, minTitle, tw, 2);
    const titleLH = titleFit.size * 1.08; drawMultilineWithOutline(t, titleFit.lines, tx, ty, tw, titleLH, titleFit.size, baloo);
    const sub = story?.book?.tagline || ""; if (sub) {
      const subFit = shrinkToFitLines(sub, nunitoSemi, Math.max(16, titleFit.size*0.48), 12, tw, 2);
      const subLH = subFit.size*1.15; const subY = ty + titleFit.lines.length*titleLH + mmToPt(4);
      drawMultilineWithOutline(t, subFit.lines, tx, subY, tw, subLH, subFit.size, nunitoSemi);
    }
    if (mode === "preview" && watermark_text) drawWatermark(t, watermark_text);
  } catch (e) { const f = pdfDoc.addPage([pageW, pageH]); f.drawText("Titelblad: fel.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) }); }

  // Fördela story-sidor till exakt 14 uppslag (använd de 14 första sidorna)
  const storyPages = (pages || []).slice(0, SPREADS);

  // B) 14 UPPslag: Bild vänster (helsida), Text höger (pastell bakgrund)
  const outer = mmToPt(GRID.outer_mm), pad = mmToPt(GRID.pad_mm);
  const textBoxW = (trimWpt - outer*2) - pad*2; const textBoxH = (trimHpt - outer*2) - pad*2;
  const textX = contentX + outer + pad; const textY = contentY + outer + pad;
  const { size: baseSize } = fontSpecForReadingAge(readingAge);

  for (const p of storyPages) {
    // VÄNSTER: Bild helsida
    try {
      const left = pdfDoc.addPage([pageW, pageH]); // ingen sidnumrering för inlaga
      const src = imgByPage.get(p.page); let imgObj = null;
      if (src) { const bytes = await getImageBytes(env, src); imgObj = await embedImage(pdfDoc, bytes); }
      if (imgObj) drawImageCover(left, imgObj, 0, 0, pageW, pageH);
      else left.drawText("Bild saknas", { x: mmToPt(20), y: mmToPt(20), size: 14, font: nunito, color: rgb(0.8,0.1,0.1) });
      if (mode === "preview" && watermark_text) drawWatermark(left, watermark_text);
    } catch (e) { const f = pdfDoc.addPage([pageW, pageH]); f.drawText(`Uppslag (bild) p${p?.page||"?"}: fel.`, { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) }); }

    // HÖGER: Text på pastell
    try {
      const right = pdfDoc.addPage([pageW, pageH]); pastelBg(right);
      drawWrappedTextFit(right, p.text || "", textX, textY, textBoxW, textBoxH, nunito, baseSize, 1.35, 12, "center");
      if (mode === "preview" && watermark_text) drawWatermark(right, watermark_text);
    } catch (e) { const f = pdfDoc.addPage([pageW, pageH]); f.drawText(`Uppslag (text) p${p?.page||"?"}: fel.`, { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) }); }
  }

  // C) SLUT-sida (singel)
  try {
    const end = pdfDoc.addPage([pageW, pageH]); pastelBg(end);
    const safeW = trimWpt - mmToPt(GRID.outer_mm)*2;
    const tw = Math.min(safeW*0.7, mmToPt(120)); const tx = contentX + (trimWpt - tw)/2;
    const ty = contentY + trimHpt/2 - mmToPt(6);
    const endText = "SLUT";
    const endFit = shrinkToFitLines(endText, baloo, 48, 20, tw, 1);
    const lh = endFit.size*1.08; drawMultilineWithOutline(end, endFit.lines, tx, ty, tw, lh, endFit.size, baloo);
    if (mode === "preview" && watermark_text) drawWatermark(end, watermark_text);
  } catch (e) { const f = pdfDoc.addPage([pageW, pageH]); f.drawText("Slut-sida: fel.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) }); }

  // ===== 3) BAKSIDA =====
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const bg = rgb(0.58, 0.54, 0.86); // mjuk lila
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: bg });
    const blurb = story?.book?.back_blurb || (story?.book?.lesson ? `Lärdom: ${story.book.lesson}.` : `En berättelse skapad med BokPiloten.`);
    const centerX = contentX + trimWpt / 2; const centerY = contentY + trimHpt / 2;
    const maxW = trimWpt * 0.72; const maxH = trimHpt * 0.36;
    const bodySize = 14; const leading = 1.42;
    // centrera vit text
    // använder drawWrappedTextFit men med vit färg kräver egen variant – snabb lösning: rita mörk text med alpha-rektangel? Vi gör enkel vit via pdf-lib drawText direkt
    // Förenklad vit text-center:
    function drawCenteredWhiteParagraph(page, text, maxW, maxH, centerX, centerY) {
      const words = String(text||"").split(/\s+/); let size = bodySize; let lines=[]; let ok=false;
      for (size=bodySize; size>=12; size--) {
        const lineH = size*leading; lines=[]; let line="";
        for (const w of words) { const t = line ? line+" "+w : w; const wpx = nunito.widthOfTextAtSize(t, size); if (wpx <= maxW) line = t; else { if (line) lines.push(line); line = w; } }
        if (line) lines.push(line);
        if (lines.length*lineH <= maxH) { ok=true; break; }
      }
      const lineH = size*leading; let y = centerY + (lines.length*lineH)/2 - lineH;
      for (const ln of lines) { const w = nunito.widthOfTextAtSize(ln, size); const x = centerX - w/2; page.drawText(ln, { x, y, size, font: nunito, color: rgb(1,1,1) }); y -= lineH; }
    }
    drawCenteredWhiteParagraph(page, blurb, maxW, maxH, centerX, centerY);
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  } catch (e) { log("BACK ERR:", e?.message); const page = pdfDoc.addPage([pageW, pageH]); page.drawText("Baksidan kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) }); }

  return await pdfDoc.save();
}

/* ----------------------- R2 upload (optional) -------------------------- */
async function putPdfToR2(env, bytes, key) {
  if (!env.R2_BUCKET) return null;
  try {
    const obj = await env.R2_BUCKET.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
    if (!obj) return null;
    const base = env.PUBLIC_BASE_URL || "";
    return base ? `${base.replace(/\/+$/,'')}/${key}` : null;
  } catch { return null; }
}

/* ----------------------- Upload handler (CF Images) -------------------- */
async function handleUploadRequest(req, env) {
  try {
    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : body?.data_url ? [body] : [];
    if (!items.length) return err("Body must include items[] or {page|kind,data_url}", 400);
    const uploads = [];
    for (const it of items) {
      const hasIdentity = Number.isFinite(it?.page) || it?.kind === "cover";
      if (!hasIdentity) { uploads.push({ page: it?.page ?? null, error: "missing page/kind" }); continue; }
      if (typeof it?.data_url !== "string" || !it.data_url.startsWith("data:image/")) { uploads.push({ page: it.page ?? it.kind, error: "invalid data_url" }); continue; }
      try {
        const idHint = it.kind === "cover" ? "cover" : `page-${it.page}`;
        const u = await uploadOneToCFImages(env, { data_url: it.data_url, id: idHint });
        uploads.push({ page: it.page ?? 0, kind: it.kind, image_id: u.image_id, url: u.url });
      } catch (e) { uploads.push({ page: it.page ?? it.kind, error: String(e?.message || e) }); }
    }
    return ok({ uploads });
  } catch (e) { return err(e?.message || "Upload failed", 500); }
}

/* -------------------------- PDF handler -------------------------------- */
async function handlePdfRequest(req, env, { previewInline = false } = {}) {
  const body = await req.json().catch(() => ({}));
  const { story, images, mode = "print", trim = "square210", bleed_mm, watermark_text } = body || {};
  if (!story || !Array.isArray(story?.book?.pages)) return new Response(JSON.stringify({ error: "Missing story" }), { status: 400, headers: JSONH });
  const bytes = await buildPdf({ story, images: images || [], mode, trim, bleed_mm, watermark_text }, env);
  const filename = (story?.book?.title || "BokPiloten").replace(/[^\wåäöÅÄÖ\-]+/g, "_") + (mode === "print" ? "_PRINT.pdf" : "_PREVIEW.pdf");
  const headers = new Headers({ "content-type": "application/pdf", "content-length": String(bytes.length), "content-disposition": `${previewInline ? "inline" : "attachment"}; filename="${filename}"`, ...CORS });
  return new Response(bytes, { status: 200, headers });
}

/* -------------------------------- API ---------------------------------- */
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      const url = new URL(req.url);

      // Health
      if (req.method === "GET" && url.pathname === "/") return ok({ ok: true, ts: Date.now() });

      // Story
      if (req.method === "POST" && url.pathname === "/api/story") {
        try {
          const body = await req.json();
          const { name, age, pages, category, style, theme, traits, reading_age } = body || {};
          const targetAge = Number.isFinite(parseInt(reading_age, 10)) ? parseInt(reading_age, 10) : (category || "kids") === "pets" ? 8 : parseInt(age || 6, 10);
          const outlineUser = `\n${heroDescriptor({ category, name, age, traits })}\nKategori: ${category || "kids"}.\nLäsålder: ${targetAge}.\nÖnskat tema/poäng (om angivet): ${theme || "vänskap"}.\nAntal sidor: ${pages || 12}.\nReturnera enbart json.`.trim();
          const outline = await openaiJSON(env, OUTLINE_SYS, outlineUser);
          const storyUser = `\nOUTLINE:\n${JSON.stringify(outline)}\n${heroDescriptor({ category, name, age, traits })}\nLäsålder: ${targetAge}. Sidor: ${pages || 12}. Stil: ${style || "cartoon"}. Kategori: ${category || "kids"}.\nBoken ska ha tydlig lärdom (lesson) kopplad till temat.\nReturnera enbart json.`.trim();
          const story = await openaiJSON(env, STORY_SYS, storyUser);
          const plan = normalizePlan(story?.book?.pages || []);
          return ok({ story, plan, previewVisible: 4 });
        } catch (e) { return err(e?.message || "Story failed", 500); }
      }

      // Ref image
      if (req.method === "POST" && url.pathname === "/api/ref-image") {
        try {
          const { style = "cartoon", photo_b64, bible, traits = "" } = await req.json();
          if (photo_b64) { const b64 = String(photo_b64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ""); return ok({ ref_image_b64: b64 }); }
          const prompt = characterCardPrompt({ style, bible, traits });
          const g = await geminiImage(env, { prompt }, 70000, 2);
          if (g?.b64) return ok({ ref_image_b64: g.b64 });
          return ok({ ref_image_b64: null });
        } catch (e) { return err(e?.message || "Ref generation failed", 500); }
      }

      // Cover-only generation (säkerställer rätt stil på omslaget)
      if (req.method === "POST" && url.pathname === "/api/cover") {
        try {
          const { style = "cartoon", ref_image_b64, story } = await req.json();
          const characterName = story?.book?.bible?.main_character?.name || "Hjälten";
          const prompt = buildCoverPrompt({ style, story, characterName });
          const g = await geminiImage(env, { prompt, character_ref_b64: ref_image_b64 }, 75000, 2);
          return ok({ image_url: g.image_url, provider: g.provider || "google" });
        } catch (e) { return err(e?.message || "Cover failed", 500); }
      }

      // Generate interior images
      if (req.method === "POST" && url.pathname === "/api/images") {
        try {
          const { style = "cartoon", ref_image_b64, story, plan, concurrency = 4 } = await req.json();
          const pages = story?.book?.pages || []; if (!pages.length) return err("No pages", 400);
          if (!ref_image_b64) return err("Missing reference image", 400);
          const frames = plan?.plan || []; const pageCount = pages.length;
          const heroName = story?.book?.bible?.main_character?.name || "Hjälten";
          const jobs = pages.map(pg => {
            const f = frames.find(x => x.page === pg.page) || {};
            const prompt = buildFramePrompt({ style, story, page: pg, pageCount, frame: f, characterName: heroName });
            return { page: pg.page, prompt };
          });
          const out = []; const CONC = Math.min(Math.max(parseInt(concurrency || 3, 10), 1), 8); let idx = 0;
          async function worker(){ while (idx < jobs.length) { const i = idx++; const item = jobs[i]; try {
            const g = await geminiImage(env, { prompt: item.prompt, character_ref_b64: ref_image_b64 }, 75000, 3);
            out.push({ page: item.page, image_url: g.image_url, provider: g.provider || "google" });
          } catch (e) { out.push({ page: item.page, error: String(e?.message || e) }); } } }
          await Promise.all(Array.from({ length: CONC }, worker)); out.sort((a,b)=>(a.page||0)-(b.page||0));
          return ok({ images: out });
        } catch (e) { return err(e?.message || "Images failed", 500); }
      }

      // Regenerate a single page
      if (req.method === "POST" && url.pathname === "/api/image/regenerate") {
        try {
          const { style = "cartoon", ref_image_b64, page_text, scene_text, frame, story } = await req.json();
          if (!ref_image_b64) return err("Missing reference image", 400);
          const fakeStory = story || { book: { pages: [{ page: 1, scene: scene_text, text: page_text }] } };
          const pg = { page: 1, scene: scene_text, text: page_text };
          const f = { shot_type: frame?.shot_type || "M", lens_mm: frame?.lens_mm || 50, subject_size_percent: frame?.subject_size_percent || 60 };
          const prompt = buildFramePrompt({ style, story: fakeStory, page: pg, pageCount: 1, frame: f, characterName: (fakeStory.book?.bible?.main_character?.name || "Hjälten") });
          const g = await geminiImage(env, { prompt, character_ref_b64: ref_image_b64 }, 75000, 3);
          return ok({ image_url: g.image_url, provider: g.provider || "google" });
        } catch (e) { return err(e?.message || "Regenerate failed", 500); }
      }

      // Upload images to Cloudflare Images
      if (req.method === "POST" && url.pathname === "/api/images/upload") {
        const resp = await handleUploadRequest(req, env); return withCORS(resp);
      }

      // Build PDF (print-first). OBS: denna genererar 32 PDF-sidor totalt: 1 omslag + 30 inlaga + 1 baksida
      if (req.method === "POST" && url.pathname === "/api/pdf") {
        try { const resp = await handlePdfRequest(req, env, { previewInline: true }); return withCORS(resp); }
        catch (e) { return err(e?.message || "PDF failed", 500); }
      }

      // GELATO: skapa order från PDF
      if (req.method === "POST" && url.pathname === "/api/gelato/order") {
        try {
          const body = await req.json().catch(()=> ({}));
          const { pdf_bytes_b64, pdf_url, filename = "book.pdf", shippingAddress = { firstName: "Förnamn", lastName: "Efternamn", addressLine1: "Gata 1", city: "Örebro", zip: "70342", country: "SE" }, size = "20x20cm", pages = 30, coverType = "hardcover", quantity = 1 } = body || {};
          if (!env.GELATO_API_KEY) return err("GELATO_API_KEY missing", 500);
          let finalPdfUrl = pdf_url || null;
          if (!finalPdfUrl && pdf_bytes_b64) {
            const bin = Uint8Array.from(atob(pdf_bytes_b64), c=>c.charCodeAt(0));
            const key = `books/${Date.now()}_${filename.replace(/[^\w.\-]/g,"_")}`;
            finalPdfUrl = await putPdfToR2(env, bin, key);
          }
          if (!finalPdfUrl) return err("No pdf_url or pdf_bytes_b64 provided (or R2 upload failed)", 400);
          const gelatoResp = await fetch("https://api.gelato.com/v4/orders", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.GELATO_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ orderType: "external", items: [{ productUid: "photo-book-hardcover", quantity, files: [{ url: finalPdfUrl }], attributes: { size, pages, coverType } }], shippingAddress })
          });
          const j = await gelatoResp.json().catch(()=> ({}));
          if (!gelatoResp.ok) return err(`Gelato ${gelatoResp.status}`, gelatoResp.status, { details: j });
          return ok({ ok: true, order: j });
        } catch (e) { return err(e?.message || "Gelato order failed", 500); }
      }

      // Webhook (status från Gelato)
      if (req.method === "POST" && url.pathname === "/api/gelato/webhook") {
        try { const payload = await req.json().catch(()=> ({})); log("Gelato webhook:", JSON.stringify(payload).slice(0,2000)); return ok({ ok: true }); }
        catch (e) { return err("Webhook error", 500); }
      }

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: JSONH });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: JSONH });
    }
  },
};
