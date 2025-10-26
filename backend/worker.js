// ============================================================================
// BokPiloten – Worker v21 "Fonts+Vine Fix"
// Endpoints: story, ref-image, images, image/regenerate, images/upload, pdf
// Requires env: API_KEY, GEMINI_API_KEY, IMAGES_API_TOKEN, CF_ACCOUNT_ID,
//               CF_IMAGES_ACCOUNT_HASH, (CF_IMAGES_VARIANT), FONT_BASE_URL
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
const err = (msg, code = 400, extra = {}) =>
  ok({ error: msg, ...extra }, { status: code });
const withCORS = (resp) => {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
};
const log = (...a) => { try { console.log(...a); } catch {} };
const OPENAI_MODEL = "gpt-4o-mini";

/* ----------------- dekor/marginaler/text-tweak -------------------------- */
const ICON_BOTTOM_MM = 10;        // säkrare avstånd från trim (upp från 6–8)
const TEXT_SCALE = 1.10;          // ca 10% större brödtext
const VINE_OPACITY = 0.22;

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
  if (!r.ok) throw new Error(`OpenAI ${r.status} ${await r.text().catch(() => "")}`);
  const j = await r.json();
  return JSON.parse(j?.choices?.[0]?.message?.content || "{}");
}

/* --------------------------- Gemini (image) ---------------------------- */
function findGeminiImagePart(json) {
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts || cand?.content?.[0]?.parts || [];
  let p = parts.find((x) => x?.inlineData?.mimeType?.startsWith("image/") && x?.inlineData?.data);
  if (p) return { mime: p.inlineData.mimeType, b64: p.inlineData.data };
  p = parts.find((x) => typeof x?.text === "string" && x.text.startsWith("data:image/"));
  if (p) {
    const m = p.text.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
    if (m) return { mime: m[1], b64: m[2] };
  }
  p = parts.find((x) => typeof x?.text === "string" && /^https?:\/\//.test(x.text));
  if (p) return { url: p.text };
  return null;
}
async function geminiImage(env, item, timeoutMs = 75000, attempts = 3) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(key)}`;
  const parts = [];
  if (item.character_ref_b64) parts.push({ inlineData: { mimeType: "image/png", data: item.character_ref_b64 } });
  if (Array.isArray(item.style_refs_b64)) {
    for (const b64 of item.style_refs_b64.slice(0, 3)) {
      if (typeof b64 === "string" && b64.length > 64) {
        parts.push({ inlineData: { mimeType: "image/png", data: b64 } });
      }
    }
  }
  if (item.guidance) parts.push({ text: item.guidance });
  if (item.coherence_code) parts.push({ text: `COHERENCE_CODE:${item.coherence_code}` });
  parts.push({ text: item.prompt });

  let last;
  for (let i = 1; i <= attempts; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort("timeout"), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseModalities: ["IMAGE"], temperature: 0.35, topP: 0.9 },
        }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Gemini ${r.status} ${await r.text().catch(() => "")}`);
      const j = await r.json();
      const got = findGeminiImagePart(j);
      if (got?.b64 && got?.mime) return { image_url: `data:${got.mime};base64,${got.b64}`, provider: "google", b64: got.b64 };
      if (got?.url) return { image_url: got.url, provider: "google" };
      throw new Error("No image in response");
    } catch (e) {
      clearTimeout(t);
      last = e;
      await new Promise((r) => setTimeout(r, 250 * i));
    }
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
  if ((category || "kids") === "pets") return `HJÄLTE: ett husdjur vid namn ${name || "Nova"}; egenskaper: ${traits || "nyfiken, lekfull"}.`;
  const a = parseInt(age || 6, 10);
  return `HJÄLTE: ett barn vid namn ${name || "Nova"} (${a} år), egenskaper: ${traits || "modig, omtänksam"}.`;
}

/* --------------------------- Frame prompts ----------------------------- */
function normalizePlan(pages) {
  const out = [];
  pages.forEach((p, i) => {
    const order = ["EW", "M", "CU", "W"];
    const t = order[i % order.length];
    const lens = { EW: 28, W: 35, M: 50, CU: 85 }[t] || 35;
    const size = { EW: 30, W: 45, M: 60, CU: 80 }[t] || 60;
    out.push({ page: p.page, shot_type: t, lens_mm: lens, subject_size_percent: size });
  });
  return { plan: out };
}
function shotLine(f = {}) {
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
  return [
    `SERIES CONTEXT — title: ${story?.book?.title || "Sagobok"}`,
    `locations: ${locs.join(", ")}`,
    `beats: ${beats.join(" | ")}`,
  ].join("\n");
}
function buildFramePrompt({ style, story, page, pageCount, frame, characterName }) {
  const series = buildSeriesContext(story);
  const styleLine = styleHint(style);
  return [
    series,
    `This is page ${page.page} of ${pageCount}.`,
    `Render in ${styleLine}. No text or speech bubbles.`,
    `Square composition (1:1), keep limbs fully in frame.`,
    `Keep the same hero (${characterName}) from reference. Adapt pose, camera, lighting.`,
    page.time_of_day ? `Time of day: ${page.time_of_day}.` : "",
    page.weather ? `Weather: ${page.weather}.` : "",
    `SCENE: ${page.scene || page.text || ""}`,
    `FRAMING: ${shotLine(frame)}.`,
    `VARIETY: each page unique yet coherent.`,
  ].filter(Boolean).join("\n");
}
function characterCardPrompt({ style, bible, traits }) {
  const mc = bible?.main_character || {};
  const name = mc.name || "Nova";
  const phys = mc.physique || traits || "fluffy gray cat with curious eyes";
  return [`Character reference in ${styleHint(style)}.`,`One hero only, full body, neutral background.`,`Hero: ${name}, ${phys}. No text.`].join(" ");
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
  const m = dataUrl?.match?.(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  const mime = m[1], b64 = m[2];
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return { blob: new Blob([u8], { type: mime }), mime };
}
function cfImagesDeliveryURL(env, image_id, variant, forceFormat = "jpeg") {
  const hash = env.CF_IMAGES_ACCOUNT_HASH;
  if (!hash) return null;
  const v = variant || env.CF_IMAGES_VARIANT || "public";
  const base = `https://imagedelivery.net/${hash}/${image_id}/${v}`;
  return forceFormat ? `${base}?format=${encodeURIComponent(forceFormat)}` : base;
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
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`, { method: "POST", headers: { authorization: `Bearer ${env.IMAGES_API_TOKEN}` }, body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`CF Images ${r.status} ${JSON.stringify(j)}`);
  const image_id = j?.result?.id;
  const url = cfImagesDeliveryURL(env, image_id);
  return { image_id, url };
}

/* ---------------------------- PDF helpers ------------------------------ */
const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;
const PT_PER_MM = PT_PER_INCH / MM_PER_INCH;
const TRIMS = { square210: { w_mm: 210, h_mm: 210, default_bleed_mm: 3 } };
const GRID = { outer_mm: 10, gap_mm: 8, pad_mm: 12, text_min_mm: 30, text_max_mm: 58 };

function mmToPt(mm) { return mm * PT_PER_MM; }

function fontSpecForReadingAge(ra = 6) {
  if (ra <= 5) return { size: 22, leading: 1.36 };
  if (ra <= 8) return { size: 18, leading: 1.36 };
  if (ra <= 12) return { size: 16, leading: 1.34 };
  return { size: 16, leading: 1.34 };
}

// Bädda in TTF: först dina Pages-filer, sedan Google Fonts, sedan system-fallbacks
async function tryEmbedTtfList(pdfDoc, urls) {
  for (const url of urls) {
    try {
      const r = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
      if (!r.ok) continue;
      const bytes = new Uint8Array(await r.arrayBuffer());
      const f = await pdfDoc.embedFont(bytes, { subset: true });
      return f;
    } catch {}
  }
  return null;
}

/* ---- Watermark ---- */
function drawWatermark(page, text = "FÖRHANDSVISNING", color = rgb(0.5, 0.5, 0.5)) {
  const { width, height } = page.getSize();
  const fontSize = Math.min(width, height) * 0.15;
  const angleDeg = (Math.atan2(height, width) * 180) / Math.PI;
  page.drawText(text, { x: width * 0.06, y: height * 0.18, size: fontSize, color, opacity: 0.07, rotate: degrees(angleDeg) });
}

/* ---- Title outline ---- */
function drawTextWithOutline(page, text, x, y, size, font, opts = {}) {
  const { fill = rgb(1, 1, 1), outline = rgb(0, 0, 0), shadow = true, shadowOpacity = 0.25, outlineScale = 0.06 } = opts;
  const d = Math.max(0.8, size * outlineScale);
  if (shadow) page.drawText(text, { x: x + d * 0.6, y: y - d * 0.6, size, font, color: rgb(0, 0, 0), opacity: shadowOpacity });
  const offs = [[d,0],[-d,0],[0,d],[0,-d],[d,d],[d,-d],[-d,d],[-d,-d]];
  for (const [ox, oy] of offs) page.drawText(text, { x: x + ox, y: y + oy, size, font, color: outline });
  page.drawText(text, { x, y, size, font, color: fill });
}

/* ---- Centered paragraph on colored page ---- */
function drawWrappedCenterColor(page, text, centerX, centerY, maxW, maxH, font, baseSize, baseLeading, minSize = 12, color = rgb(0.08,0.08,0.08), align = "center") {
  for (let size = baseSize; size >= minSize; size--) {
    const lineH = size * baseLeading;
    const words = String(text || "").split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(t, size) <= maxW) line = t;
      else { if (line) lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    const blockH = lines.length * lineH;
    if (blockH <= maxH) {
      let y = centerY + (blockH / 2) - lineH;
      for (const ln of lines) {
        const w = font.widthOfTextAtSize(ln, size);
        const x = align === "center" ? centerX - w / 2 : align === "right" ? centerX + maxW/2 - w : centerX - maxW/2;
        page.drawText(ln, { x, y, size, font, color });
        y -= lineH;
      }
      return { size, lines };
    }
  }
  return { size: minSize, lines: [] };
}

/* ---- Simple icons (SVG paths) ---- */
function drawIconStar(page, x, y, s, color, opacity = 0.35) {
  const path = "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";
  page.drawSvgPath(path, { x: x - (s/2), y: y - (s/2), scale: s/24, color, opacity });
}
function drawIconHeart(page, x, y, s, color, opacity = 0.35) {
  const path = "M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z";
  page.drawSvgPath(path, { x: x - (s/2), y: y - (s/2), scale: s/24, color, opacity });
}

/* ---- Image helpers ---- */
async function getImageBytes(env, row) {
  try {
    // A) Cloudflare Images by ID (fast, format coerced)
    if (row.image_id) {
      const url = cfImagesDeliveryURL(env, row.image_id, undefined, "jpeg");
      if (url) {
        const r = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
        if (r.ok) return new Uint8Array(await r.arrayBuffer());
      }
    }
    // B) Original URL
    const pickUrl = row.url || row.image_url;
    if (pickUrl && /^https?:\/\//i.test(pickUrl)) {
      // 1) As-is
      const r0 = await fetch(pickUrl, { cf: { cacheTtl: 1200, cacheEverything: true } });
      if (r0.ok) return new Uint8Array(await r0.arrayBuffer());
      // 2) CF image transcode to JPEG
      const r1 = await fetch(pickUrl, { cf: { cacheTtl: 1200, cacheEverything: true, image: { format: "jpeg", quality: 90 } } });
      if (r1.ok) return new Uint8Array(await r1.arrayBuffer());
    }
    // C) Data URL
    if (row.data_url?.startsWith?.("data:image/")) {
      const m = row.data_url.match(/^data:([^;]+);base64,(.+)$/i);
      if (m) {
        const bin = atob(m[2]);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        return u8;
      }
    }
    return null;
  } catch { return null; }
}
async function embedImage(pdfDoc, bytes) {
  if (!bytes) return null;
  try { return await pdfDoc.embedPng(bytes); } catch {}
  try { return await pdfDoc.embedJpg(bytes); } catch {}
  return null;
}
function drawImageCover(page, img, boxX, boxY, boxW, boxH) {
  const iw = img.width, ih = img.height;
  const scale = Math.max(boxW / iw, boxH / ih);
  const w = iw * scale, h = ih * scale;
  const x = boxX + (boxW - w) / 2;
  const y = boxY + (boxH - h) / 2;
  page.drawImage(img, { x, y, width: w, height: h });
}
function drawVine(page, centerX, y, widthPt, color = rgb(0.4,0.45,0.55), opacity = VINE_OPACITY) {
  const path = `
    M 0 0
    C 30 14, 60 -14, 90 0
    C 120 14, 150 -14, 180 0
    C 210 14, 240 -14, 270 0
    C 300 14, 330 -14, 360 0
    M 60 0 c 6 8, 10 12, 12 18 c -8 -2, -12 -6, -18 -12 z
    M 300 0 c -6 -8, -10 -12, -12 -18 c 8 2, 12 6, 18 12 z
  `;
  const baseW = 360;
  const scale = widthPt / baseW;
  page.drawSvgPath(path, { x: centerX - widthPt/2, y, scale, color, opacity });
}

/* --------------------------- Build PDF (32 sidor) ---------------------- */
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

  // -------- FONTS (egna filer först, sedan Google, sedan standard) --------
  const FONT_BASE = (env.FONT_BASE_URL || "https://sagobok.pages.dev").replace(/\/+$/, "");
  const baloo = (await tryEmbedTtfList(pdfDoc, [
      `${FONT_BASE}/fonts/Baloo-bold.ttf`,
      "https://raw.githubusercontent.com/google/fonts/main/ofl/baloo2/Baloo2-Bold.ttf",
    ])) || (await pdfDoc.embedFont(StandardFonts.HelveticaBold));
  const nunito = (await tryEmbedTtfList(pdfDoc, [
      `${FONT_BASE}/fonts/Nunito-regular.ttf`,
      "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito-Regular.ttf",
    ])) || (await pdfDoc.embedFont(StandardFonts.TimesRoman));
  const nunitoSemi = (await tryEmbedTtfList(pdfDoc, [
      `${FONT_BASE}/fonts/Nunito-semibold.ttf`,
      "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito-SemiBold.ttf",
    ])) || (await pdfDoc.embedFont(StandardFonts.Helvetica));

  const readingAge = story?.book?.reading_age || 6;
  const { size: baseTextSize, leading: baseLeading } = fontSpecForReadingAge(readingAge);
  const title = story?.book?.title || "Min bok";
  const subtitle = story?.book?.tagline || (story?.book?.bible?.main_character?.name ? `Med ${story.book.bible.main_character.name}` : "");
  const blurb = story?.book?.back_blurb || (story?.book?.lesson ? `Lärdom: ${story.book.lesson}.` : "En berättelse skapad med BokPiloten.");
  const pagesStory = [...(story?.book?.pages || [])];

  // Indexera bilder
  let coverSrc = images?.find((x) => x?.kind === "cover" || x?.page === 0) || null;
  const imgByPage = new Map();
  (images || []).forEach((row) => {
    if (Number.isFinite(row?.page) && row.page > 0 && (row.image_id || row.url || row.image_url || row.data_url)) {
      imgByPage.set(row.page, row);
    }
  });

  function mapTo14ScenePages() {
    const want = 14;
    if (pagesStory.length === want) return pagesStory;
    if (pagesStory.length > want) return pagesStory.slice(0, want);
    const out = [...pagesStory];
    while (out.length < want) out.push(pagesStory[pagesStory.length - 1]);
    return out;
  }
  const scenePages = mapTo14ScenePages();

  /* ------- FRONT COVER ------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const safeInset = mmToPt(GRID.outer_mm + 2);
    const tx = contentX + safeInset;
    const tw = trimWpt - safeInset * 2;

    if (!coverSrc) coverSrc = imgByPage.get(scenePages?.[0]?.page || 1) || null;
    if (coverSrc) {
      const bytes = await getImageBytes(env, coverSrc);
      const coverImg = await embedImage(pdfDoc, bytes);
      if (coverImg) drawImageCover(page, coverImg, 0, 0, pageW, pageH);
    }

    // diskret toppgradient för läsbar titel
    for (let i = 0; i < 8; i++) {
      const t = (8 - i) / 8;
      page.drawRectangle({
        x: contentX,
        y: contentY + trimHpt - mmToPt(20) + (mmToPt(20)/8)*i,
        width: trimWpt,
        height: mmToPt(20)/8,
        color: rgb(0,0,0),
        opacity: 0.22 * t
      });
    }

    // shrink-to-fit 1–2 rader
    function shrinkToFit(text, font, maxSize, minSize, maxWidth, maxLines) {
      for (let s = maxSize; s >= minSize; s--) {
        const words = text.split(/\s+/);
        const lines = [];
        let line = "";
        for (const w of words) {
          const t = line ? line + " " + w : w;
          if (font.widthOfTextAtSize(t, s) <= maxWidth) line = t; else { if (line) lines.push(line); line = w; }
        }
        if (line) lines.push(line);
        if (lines.length <= maxLines && lines.every(l => font.widthOfTextAtSize(l, s) <= maxWidth)) return { size: s, lines };
      }
      return { size: minSize, lines: [text] };
    }
    const maxTitle = Math.min(trimWpt, trimHpt) * 0.16;
    const minTitle = 28;
    const fitT = shrinkToFit(title, baloo, maxTitle, minTitle, tw, 2);
    const titleLH = fitT.size * 1.08;
    const fitS = subtitle ? shrinkToFit(subtitle, nunitoSemi, Math.max(14, fitT.size * 0.46), 12, tw, 2) : null;
    const subLH = fitS ? fitS.size * 1.12 : 0;
    const blockH = fitT.lines.length * titleLH + (fitS ? (mmToPt(4) + fitS.lines.length * subLH) : 0);
    let y = contentY + trimHpt - mmToPt(GRID.outer_mm + 6) - blockH;

    for (const ln of fitT.lines) {
      const w = baloo.widthOfTextAtSize(ln, fitT.size);
      const x = tx + (tw - w) / 2;
      drawTextWithOutline(page, ln, x, y, fitT.size, baloo);
      y += titleLH;
    }
    if (fitS) {
      y += mmToPt(4);
      for (const ln of fitS.lines) {
        const w = nunitoSemi.widthOfTextAtSize(ln, fitS.size);
        const x = tx + (tw - w) / 2;
        drawTextWithOutline(page, ln, x, y, fitS.size, nunitoSemi, { outlineScale: 0.045, shadowOpacity: 0.2 });
        y += subLH;
      }
    }
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  } catch (e) {
    log("COVER ERR", e?.message);
    const p = pdfDoc.addPage([pageW, pageH]);
    p.drawText("Omslag kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: StandardFonts.Helvetica, color: rgb(0.8,0.1,0.1) });
  }

  /* ------- [1] TITELBLAD ------- */
  {
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.96,0.98,1) });
    const cx = contentX + trimWpt / 2, cy = contentY + trimHpt * 0.62;
    const fit = drawWrappedCenterColor(page, title, cx, cy, trimWpt*0.76, trimHpt*0.22, baloo, Math.min(trimWpt, trimHpt)*0.12, 1.08, 20, rgb(0.1,0.1,0.1));
    if (subtitle) {
      drawWrappedCenterColor(page, subtitle, cx, cy - (fit.size*fit.lines.length*1.08) - mmToPt(6), trimWpt*0.7, trimHpt*0.12, nunitoSemi, Math.max(14, fit.size*0.5), 1.12, 12, rgb(0.15,0.15,0.15));
    }
    drawIconStar(page, cx, contentY + mmToPt(ICON_BOTTOM_MM), mmToPt(14), rgb(0.1,0.2,0.4), 0.25);
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  }

  /* ------- 14 UPPslag (bild vänster, text höger) ------- */
  const outer = mmToPt(GRID.outer_mm);
  for (let i = 0; i < 14; i++) {
    const scene = scenePages[i] || {};
    const text = String(scene.text || "").trim();

    // Bildsida (vänster)
    const leftImgPage = pdfDoc.addPage([pageW, pageH]);
    leftImgPage.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(1,1,1) });
    try {
      const src = imgByPage.get(scene.page);
      let imgObj = null;
      if (src) {
        const bytes = await getImageBytes(env, src);
        imgObj = await embedImage(pdfDoc, bytes);
      }
      if (imgObj) {
        drawImageCover(leftImgPage, imgObj, 0, 0, pageW, pageH);
      } else {
        leftImgPage.drawText("Bild saknas", { x: contentX + mmToPt(4), y: contentY + mmToPt(6), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) });
      }
    } catch (e) {
      log("IMG PAGE ERR", i+1, e?.message);
      leftImgPage.drawText("Bildfel", { x: contentX + mmToPt(4), y: contentY + mmToPt(6), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) });
    }
    if (mode === "preview" && watermark_text) drawWatermark(leftImgPage, watermark_text);

    // Textsida (höger)
    const rightTextPage = pdfDoc.addPage([pageW, pageH]);
    rightTextPage.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.96,0.98,1) });

    // Centrerad text
    const cx = contentX + trimWpt/2;
    const cy = contentY + trimHpt/2 + mmToPt(6);
    drawWrappedCenterColor(
      rightTextPage,
      text,
      cx,
      cy,
      trimWpt*0.76,
      trimHpt*0.46,
      nunito,
      Math.round(baseTextSize * TEXT_SCALE),
      baseLeading,
      12,
      rgb(0.08,0.08,0.1),
      "center"
    );

    // Dekor: hjärta + VINE (nu i rätt scope per sida)
    drawIconHeart(rightTextPage, cx, contentY + mmToPt(ICON_BOTTOM_MM), mmToPt(18), rgb(0.2,0.25,0.5), 0.25);
    const vineWidth = trimWpt * 0.50;
    const vineY     = contentY + trimHpt * 0.28;
    drawVine(rightTextPage, cx, vineY, vineWidth, rgb(0.35,0.4,0.55), VINE_OPACITY);

    // diskret sidnummer
    const pageNum = 2 + i*2 + 1;
    const pn = String(pageNum);
    const pnW = nunito.widthOfTextAtSize(pn, 10);
    rightTextPage.drawText(pn, { x: contentX + trimWpt - outer - pnW, y: contentY + mmToPt(6), size: 10, font: nunito, color: rgb(0.35,0.35,0.45) });

    if (mode === "preview" && watermark_text) drawWatermark(rightTextPage, watermark_text);
  }

  /* ------- [30] SLUT-sida ------- */
  {
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.96,0.98,1) });
    const cx = contentX + trimWpt/2, cy = contentY + trimHpt/2;
    drawWrappedCenterColor(page, "SLUT", cx, cy, trimWpt*0.5, trimHpt*0.2, baloo, Math.min(trimWpt,trimHpt)*0.12, 1.06, 24, rgb(0.1,0.1,0.1));
    drawIconStar(page, cx, contentY + mmToPt(ICON_BOTTOM_MM), mmToPt(14), rgb(0.1,0.2,0.4), 0.25);
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  }

  /* ------- [31] BACK COVER ------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const bg = rgb(0.58, 0.54, 0.86); // mjuk lila
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: bg });
    const centerX = contentX + trimWpt / 2;
    const centerY = contentY + trimHpt / 2;
    drawWrappedCenterColor(page, blurb, centerX, centerY, trimWpt * 0.72, trimHpt * 0.36, nunito, 14, 1.42, 12, rgb(1,1,1), "center");
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  } catch (e) {
    log("BACK ERR:", e?.message);
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Baksidan kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) });
  }

  return await pdfDoc.save();
}

/* ----------------------- Upload handler (CF) ---------------------------- */
async function handleUploadRequest(req, env) {
  try {
    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : body?.data_url ? [body] : [];
    if (!items.length) return err("Body must include items[] or {page|kind,data_url}", 400);

    const uploads = [];
    for (const it of items) {
      const hasIdentity = Number.isFinite(it?.page) || it?.kind === "cover";
      if (!hasIdentity) { uploads.push({ page: it?.page ?? null, error: "missing page/kind" }); continue; }
      if (typeof it?.data_url !== "string" || !it.data_url.startsWith("data:image/")) {
        uploads.push({ page: it.page ?? it.kind, error: "invalid data_url" });
        continue;
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
  } catch (e) {
    return err(e?.message || "Upload failed", 500);
  }
}

/* -------------------------- PDF handler -------------------------------- */
async function handlePdfRequest(req, env, { previewInline = false } = {}) {
  const body = await req.json().catch(() => ({}));
  const { story, images, mode = "print", trim = "square210", bleed_mm, watermark_text } = body || {};
  if (!story || !Array.isArray(story?.book?.pages)) {
    return new Response(JSON.stringify({ error: "Missing story" }), { status: 400, headers: JSONH });
  }

  const bytes = await buildPdf({ story, images: images || [], mode, trim, bleed_mm, watermark_text }, env);
  const filename = (story?.book?.title || "BokPiloten").replace(/[^\wåäöÅÄÖ\-]+/g, "_") + (mode === "print" ? "_PRINT.pdf" : "_PREVIEW.pdf");

  const headers = new Headers({
    "content-type": "application/pdf",
    "content-length": String(bytes.length),
    "content-disposition": `${previewInline ? "inline" : "attachment"}; filename="${filename}"`,
    ...CORS,
  });
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
          const targetAge = Number.isFinite(parseInt(reading_age, 10))
            ? parseInt(reading_age, 10)
            : (category || "kids") === "pets"
            ? 8
            : parseInt(age || 6, 10);

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
Returnera enbart json.`.trim();

          const story = await openaiJSON(env, STORY_SYS, storyUser);
          const plan = normalizePlan(story?.book?.pages || []);
          return ok({ story, plan, previewVisible: 4 });
        } catch (e) {
          return err(e?.message || "Story failed", 500);
        }
      }

      // Ref image
      if (req.method === "POST" && url.pathname === "/api/ref-image") {
        try {
          const { style = "cartoon", photo_b64, bible, traits = "" } = await req.json();
          if (photo_b64) {
            const b64 = String(photo_b64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
            return ok({ ref_image_b64: b64 });
          }
          const prompt = characterCardPrompt({ style, bible, traits });
          const g = await geminiImage(env, { prompt }, 70000, 2);
          if (g?.b64) return ok({ ref_image_b64: g.b64 });
          return ok({ ref_image_b64: null });
        } catch (e) {
          return err(e?.message || "Ref generation failed", 500);
        }
      }

      // Images (batch-capable)
      if (req.method === "POST" && url.pathname === "/api/images") {
        try {
          const { style = "cartoon", ref_image_b64, story, plan, concurrency = 4, pages_subset, style_refs_b64, coherence_code } = await req.json();
          const allPages = story?.book?.pages || [];
          const pages = Array.isArray(pages_subset) && pages_subset.length ? allPages.filter(p => pages_subset.includes(p.page)) : allPages;
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
              const i = idx++;
              const item = jobs[i];
              try {
                const g = await geminiImage(env, { prompt: item.prompt, character_ref_b64: ref_image_b64, style_refs_b64, coherence_code }, 75000, 3);
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
          return err(e?.message || "Images failed", 500);
        }
      }

      // Single regenerate
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
        } catch (e) {
          return err(e?.message || "Regenerate failed", 500);
        }
      }

      // Cover-only (optional)
      if (req.method === "POST" && url.pathname === "/api/cover") {
        try {
          const { style = "cartoon", ref_image_b64, story } = await req.json();
          const characterName = story?.book?.bible?.main_character?.name || "Hjälten";
          const prompt = buildCoverPrompt({ style, story, characterName });
          const g = await geminiImage(env, { prompt, character_ref_b64: ref_image_b64 }, 75000, 2);
          return ok({ image_url: g.image_url, provider: g.provider || "google" });
        } catch (e) {
          return err(e?.message || "Cover failed", 500);
        }
      }

      // Upload to CF Images
      if (req.method === "POST" && url.pathname === "/api/images/upload") {
        const resp = await handleUploadRequest(req, env);
        return withCORS(resp);
      }

      // Build PDF
      if (req.method === "POST" && url.pathname === "/api/pdf") {
        try {
          const resp = await handlePdfRequest(req, env, { previewInline: true });
          return withCORS(resp);
        } catch (e) {
          return err(e?.message || "PDF failed", 500);
        }
      }

      // Not found
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: JSONH });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: JSONH });
    }
  },
};
