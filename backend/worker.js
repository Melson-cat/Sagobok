// ============================================================================
// BokPiloten – Worker v22 "Robust Logs + Fonts/Vine"
// Endpoints: story, ref-image, images, image/regenerate, images/upload, cover, pdf, diag
// Requires env: API_KEY, GEMINI_API_KEY, IMAGES_API_TOKEN, CF_ACCOUNT_ID,
//               CF_IMAGES_ACCOUNT_HASH, (CF_IMAGES_VARIANT), FONT_BASE_URL
// ============================================================================

import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";

/* --------------------------------- CORS --------------------------------- */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
  "access-control-expose-headers": "Content-Disposition, X-Request-Id",
  "vary": "Origin",
};
const JSONH = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  ...CORS,
};
const ok = (data, init = {}, trace = [], reqId = "") => {
  const body = (init?.debugBody ? JSON.stringify({ ...data, trace }) : JSON.stringify(data));
  const headers = { ...JSONH, ...(init.headers || {}) };
  if (reqId) headers["x-request-id"] = reqId;
  return new Response(body, { status: init.status || 200, headers });
};
const err = (msg, code = 400, extra = {}, trace = [], reqId = "", debugBody = true) =>
  ok({ error: msg, ...extra }, { status: code, debugBody }, trace, reqId);
const withCORS = (resp, reqId = "", extraH = {}) => {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  if (reqId) h.set("x-request-id", reqId);
  for (const [k, v] of Object.entries(extraH || {})) h.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: h });
};
const log = (...a) => { try { console.log(...a); } catch {} };

/* ------------------------------- Helpers -------------------------------- */
const OPENAI_MODEL = "gpt-4o-mini";
const id = () => Math.random().toString(16).slice(2) + Date.now().toString(36);
const now = () => new Date().toISOString();
const safeError = (e) => {
  try {
    if (!e) return "Unknown error";
    if (typeof e === "string") return e;
    if (e?.message) return String(e.message);
    return JSON.stringify(e);
  } catch { return "Unstringifiable error"; }
};

/* --------------------------- OpenAI (JSON) ----------------------------- */
async function openaiJSON(env, system, user, trace) {
  trace.push({ t: now(), step: "openaiJSON:start" });
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
  const text = await r.text().catch(()=>"");
  if (!r.ok) {
    trace.push({ t: now(), step: "openaiJSON:http-error", status: r.status, body: text?.slice(0, 1000) });
    throw new Error(`OpenAI ${r.status}`);
  }
  const j = JSON.parse(text || "{}");
  const content = j?.choices?.[0]?.message?.content || "{}";
  trace.push({ t: now(), step: "openaiJSON:ok" });
  return JSON.parse(content);
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
async function geminiImage(env, item, timeoutMs = 75000, attempts = 3, trace = []) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(key)}`;
  const parts = [];
  if (item.character_ref_b64) parts.push({ inlineData: { mimeType: "image/png", data: item.character_ref_b64 } });
  if (Array.isArray(item.style_refs_b64)) {
    for (const b64 of item.style_refs_b64.slice(0, 3)) {
      if (typeof b64 === "string" && b64.length > 64) parts.push({ inlineData: { mimeType: "image/png", data: b64 } });
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
      trace.push({ t: now(), step: "geminiImage:try", try: i });
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE"], temperature: 0.35, topP: 0.9 } }),
        signal: ctl.signal
      });
      clearTimeout(t);
      const text = await r.text().catch(()=>"");
      if (!r.ok) { trace.push({ t: now(), step: "geminiImage:http-error", status: r.status, body: text?.slice(0, 400) }); throw new Error(`Gemini ${r.status}`); }
      const j = JSON.parse(text || "{}");
      const got = findGeminiImagePart(j);
      if (got?.b64 && got?.mime) { trace.push({ t: now(), step: "geminiImage:ok-b64" }); return { image_url: `data:${got.mime};base64,${got.b64}`, provider: "google", b64: got.b64 }; }
      if (got?.url) { trace.push({ t: now(), step: "geminiImage:ok-url" }); return { image_url: got.url, provider: "google" }; }
      throw new Error("No image in response");
    } catch (e) {
      clearTimeout(t);
      last = e;
      trace.push({ t: now(), step: "geminiImage:catch", error: safeError(e) });
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
  return [`SERIES CONTEXT — title: ${story?.book?.title || "Sagobok"}`, `locations: ${locs.join(", ")}`, `beats: ${beats.join(" | ")}`].join("\n");
}
function buildFramePrompt({ style, story, page, pageCount, frame, characterName }) {
  const series = buildSeriesContext(story);
  const styleLine = styleHint(style);
  return [series, `This is page ${page.page} of ${pageCount}.`, `Render in ${styleLine}. No text or speech bubbles.`, `Square composition (1:1), keep limbs fully in frame.`, `Keep the same hero (${characterName}) from reference. Adapt pose, camera, lighting.`, page.time_of_day ? `Time of day: ${page.time_of_day}.` : "", page.weather ? `Weather: ${page.weather}.` : "", `SCENE: ${page.scene || page.text || ""}`, `FRAMING: ${shotLine(frame)}.`, `VARIETY: each page unique yet coherent.`].filter(Boolean).join("\n");
}
function characterCardPrompt({ style, bible, traits }) {
  const mc = bible?.main_character || {};
  const name = mc.name || "Nova";
  const phys = mc.physique || traits || "fluffy gray cat with curious eyes";
  return [`Character reference in ${styleHint(style)}.`, `One hero only, full body, neutral background.`, `Hero: ${name}, ${phys}. No text.`].join(" ");
}
function buildCoverPrompt({ style, story, characterName }) {
  const styleLine = styleHint(style);
  const theme = story?.book?.theme || "";
  return [`BOOK COVER ILLUSTRATION (front cover), ${styleLine}.`, `Square composition (1:1). No text or logos.`, `Focus on the main hero (${characterName}) from the reference; perfect identity consistency.`, theme ? `Theme cue: ${theme}.` : ""].filter(Boolean).join("\n");
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
const TEXT_SCALE = 1.18;
const ICON_BOTTOM_MM = 10;

function mmToPt(mm) { return mm * PT_PER_MM; }
function fontSpecForReadingAge(ra = 6) {
  if (ra <= 5) return { size: 22, leading: 1.36 };
  if (ra <= 8) return { size: 18, leading: 1.36 };
  if (ra <= 12) return { size: 16, leading: 1.34 };
  return { size: 16, leading: 1.34 };
}

/* -------- Fonts: robust fetch+log ---------- */
async function fetchTtfWithMeta(url, trace) {
  const r = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
  const ct = r.headers.get("content-type") || "";
  const cl = r.headers.get("content-length") || "";
  trace.push({ t: now(), step: "font:fetch", url, status: r.status, ct, cl });
  if (!r.ok) return null;
  if (!/font|octet-stream|binary|application\/x-font-ttf/i.test(ct)) {
    // Vissa Pages svarar "font/ttf" (bra). Om tom CT: vi provar ändå.
  }
  try {
    const bytes = new Uint8Array(await r.arrayBuffer());
    trace.push({ t: now(), step: "font:bytes", url, bytes: bytes.length });
    return bytes;
  } catch (e) {
    trace.push({ t: now(), step: "font:bytes-error", url, error: safeError(e) });
    return null;
  }
}
async function tryEmbedFont(pdfDoc, urls, trace) {
  for (const u of urls) {
    try {
      const bytes = await fetchTtfWithMeta(u, trace);
      if (!bytes) continue;
      const f = await pdfDoc.embedFont(bytes, { subset: true });
      trace.push({ t: now(), step: "font:embedded", url: u });
      return f;
    } catch (e) {
      trace.push({ t: now(), step: "font:embed-error", url: u, error: safeError(e) });
    }
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

/* ---- Centered paragraph ---- */
function drawWrappedCenterColor(page, text, centerX, centerY, maxW, maxH, font, baseSize, baseLeading, minSize = 12, color = rgb(0.08,0.08,0.08), align = "center") {
  for (let size = baseSize; size >= minSize; size--) {
    const lineH = size * baseLeading;
    const words = String(text || "").split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(t, size) <= maxW) line = t; else { if (line) lines.push(line); line = w; }
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

/* ---- Simple icons ---- */
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
    if (row?.image_id) {
      const url = cfImagesDeliveryURL(env, row.image_id, undefined, "jpeg");
      if (url) {
        const r = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } });
        if (r.ok) return new Uint8Array(await r.arrayBuffer());
      }
    }
    const pickUrl = row?.url || row?.image_url;
    if (pickUrl && /^https?:\/\//i.test(pickUrl)) {
      const r0 = await fetch(pickUrl, { cf: { cacheTtl: 1200, cacheEverything: true } });
      if (r0.ok) return new Uint8Array(await r0.arrayBuffer());
      const r1 = await fetch(pickUrl, { cf: { cacheTtl: 1200, cacheEverything: true, image: { format: "jpeg", quality: 90 } } });
      if (r1.ok) return new Uint8Array(await r1.arrayBuffer());
    }
    if (row?.data_url?.startsWith?.("data:image/")) {
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

/* ---- Vine ---- */
function drawVine(page, centerX, y, widthPt, color = rgb(0.4,0.45,0.55), opacity = 0.25) {
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

/* --------------------------- Build PDF (32s) --------------------------- */
async function buildPdf({ story, images, mode = "print", trim = "square210", bleed_mm, watermark_text }, env, trace, reqId) {
  trace.push({ t: now(), step: "pdf:start", reqId });

  const trimSpec = TRIMS[trim] || TRIMS.square210;
  const bleed = mode === "print" ? (Number.isFinite(bleed_mm) ? bleed_mm : trimSpec.default_bleed_mm) : 0;

  const trimWpt = mmToPt(trimSpec.w_mm);
  const trimHpt = mmToPt(trimSpec.h_mm);
  const pageW = trimWpt + mmToPt(bleed * 2);
  const pageH = trimHpt + mmToPt(bleed * 2);
  const contentX = mmToPt(bleed);
  const contentY = mmToPt(bleed);

  const pdfDoc = await PDFDocument.create();
  trace.push({ t: now(), step: "pdf:doc-created" });

  // Fonts (Pages -> CDN -> Standard)
  const base = String(env.FONT_BASE_URL || "").replace(/\/+$/,"");
  const baloo = await tryEmbedFont(pdfDoc, [
    `${base}/Baloo-bold.ttf`,
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/baloo2/Baloo2-Bold.ttf",
  ], trace) || await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const nunito = await tryEmbedFont(pdfDoc, [
    `${base}/Nunito-Regular.ttf`,
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nunito/Nunito-Regular.ttf",
  ], trace) || await pdfDoc.embedFont(StandardFonts.TimesRoman);

  const nunitoSemi = await tryEmbedFont(pdfDoc, [
    `${base}/Nunito-Semibold.ttf`,
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nunito/Nunito-SemiBold.ttf",
  ], trace) || await pdfDoc.embedFont(StandardFonts.Helvetica);

  trace.push({ t: now(), step: "pdf:fonts-ready" });

  const readingAge = story?.book?.reading_age || 6;
  const { size: baseTextSize, leading: baseLeading } = fontSpecForReadingAge(readingAge);
  const title = story?.book?.title || "Min bok";
  const subtitle = story?.book?.tagline || (story?.book?.bible?.main_character?.name ? `Med ${story.book.bible.main_character.name}` : "");
  const blurb = story?.book?.back_blurb || (story?.book?.lesson ? `Lärdom: ${story.book.lesson}.` : "En berättelse skapad med BokPiloten.");
  const pagesStory = [...(story?.book?.pages || [])];

  if (!pagesStory.length) { trace.push({ t: now(), step: "pdf:no-pages" }); throw new Error("Story saknar pages[]"); }

  // Indexera bilder
  let coverSrc = images?.find((x) => x?.kind === "cover" || x?.page === 0) || null;
  const imgByPage = new Map();
  (images || []).forEach((row) => {
    if (Number.isFinite(row?.page) && row.page > 0 && (row.image_id || row.url || row.image_url || row.data_url)) {
      imgByPage.set(row.page, row);
    }
  });

  // 14 scener
  function mapTo14ScenePages() {
    const want = 14;
    if (pagesStory.length === want) return pagesStory;
    if (pagesStory.length > want) return pagesStory.slice(0, want);
    const out = [...pagesStory];
    while (out.length < want) out.push(pagesStory[pagesStory.length - 1]);
    return out;
  }
  const scenePages = mapTo14ScenePages();
  trace.push({ t: now(), step: "pdf:scene-pages", count: scenePages.length });

  /* ------- FRONT COVER ------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    if (!coverSrc) coverSrc = imgByPage.get(scenePages?.[0]?.page || 1) || null;
    if (coverSrc) {
      const bytes = await getImageBytes(env, coverSrc);
      const coverImg = await embedImage(pdfDoc, bytes);
      if (coverImg) drawImageCover(page, coverImg, 0, 0, pageW, pageH);
    } else {
      page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.94,0.96,1) });
    }

    const safeInset = mmToPt(GRID.outer_mm + 2);
    const tx = contentX + safeInset;
    const tw = trimWpt - safeInset * 2;

    function shrinkToFit(text, font, maxSize, minSize, maxWidth, maxLines) {
      for (let s = maxSize; s >= minSize; s--) {
        const words = String(text).split(/\s+/);
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

    // toppbar
    const steps = 8, h = mmToPt(20);
    for (let i = 0; i < steps; i++) {
      const t = (steps - i) / steps;
      page.drawRectangle({ x: contentX, y: contentY + trimHpt - h + (h/steps)*i, width: trimWpt, height: h/steps, color: rgb(0,0,0), opacity: 0.22 * t });
    }

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
    trace.push({ t: now(), step: "pdf:cover-error", error: safeError(e) });
    const p = pdfDoc.addPage([pageW, pageH]);
    p.drawText("Omslag kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) });
  }

  /* ------- [1] TITELBLAD ------- */
  {
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.96,0.98,1) });
    const cx = contentX + trimWpt / 2, cy = contentY + trimHpt * 0.62;
    const fit = drawWrappedCenterColor(page, title, cx, cy, trimWpt*0.76, trimHpt*0.22, baloo, Math.min(trimWpt, trimHpt)*0.12, 1.08, 20, rgb(0.1,0.1,0.1));
    if (subtitle) drawWrappedCenterColor(page, subtitle, cx, cy - (fit.size*fit.lines.length*1.08) - mmToPt(6), trimWpt*0.7, trimHpt*0.12, nunitoSemi, Math.max(14, fit.size*0.5), 1.12, 12, rgb(0.15,0.15,0.15));
    drawIconStar(page, cx, contentY + mmToPt(ICON_BOTTOM_MM), mmToPt(14), rgb(0.1,0.2,0.4), 0.25);
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  }

  /* ------- 14 uppslag ------- */
  const outer = mmToPt(GRID.outer_mm);
  for (let i = 0; i < 14; i++) {
    const scene = scenePages[i] || {};
    const text = String(scene.text || "").trim();

    // Bild (vänster)
    const left = pdfDoc.addPage([pageW, pageH]);
    left.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(1,1,1) });
    try {
      const src = imgByPage.get(scene.page);
      let imgObj = null;
      if (src) {
        const bytes = await getImageBytes(env, src);
        imgObj = await embedImage(pdfDoc, bytes);
      }
      if (imgObj) drawImageCover(left, imgObj, 0, 0, pageW, pageH);
      else left.drawText("Bild saknas", { x: contentX + mmToPt(4), y: contentY + mmToPt(6), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) });
    } catch (e) {
      trace.push({ t: now(), step: "pdf:left-img-error", page: scene.page, error: safeError(e) });
      left.drawText("Bildfel", { x: contentX + mmToPt(4), y: contentY + mmToPt(6), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) });
    }
    if (mode === "preview" && watermark_text) drawWatermark(left, watermark_text);

    // Text (höger)
    const right = pdfDoc.addPage([pageW, pageH]);
    right.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.96,0.98,1) });
    const cx = contentX + trimWpt/2, cy = contentY + trimHpt/2 + mmToPt(6);
    drawWrappedCenterColor(right, text, cx, cy, trimWpt*0.76, trimHpt*0.46, nunito, Math.round(baseTextSize * TEXT_SCALE), baseLeading, 12, rgb(0.08,0.08,0.1), "center");
    // Vine
    const vineWidth = trimWpt * 0.50;
    const vineY     = contentY + trimHpt * 0.28;
    drawVine(right, cx, vineY, vineWidth, rgb(0.35,0.4,0.55), 0.22);
    // Dekor + sidnr
    drawIconHeart(right, cx, contentY + mmToPt(ICON_BOTTOM_MM), mmToPt(18), rgb(0.2,0.25,0.5), 0.25);
    const pageNum = 2 + i*2 + 1;
    const pn = String(pageNum);
    const pnW = nunito.widthOfTextAtSize(pn, 10);
    right.drawText(pn, { x: contentX + trimWpt - outer - pnW, y: contentY + mmToPt(6), size: 10, font: nunito, color: rgb(0.35,0.35,0.45) });
    if (mode === "preview" && watermark_text) drawWatermark(right, watermark_text);
  }

  /* ------- SLUT ------- */
  {
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.96,0.98,1) });
    const cx = contentX + trimWpt/2, cy = contentY + trimHpt/2;
    drawWrappedCenterColor(page, "SLUT", cx, cy, trimWpt*0.5, trimHpt*0.2, baloo, Math.min(trimWpt,trimHpt)*0.12, 1.06, 24, rgb(0.1,0.1,0.1));
    drawIconStar(page, cx, contentY + mmToPt(ICON_BOTTOM_MM), mmToPt(14), rgb(0.1,0.2,0.4), 0.25);
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  }

  /* ------- BACK COVER ------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const bg = rgb(0.58, 0.54, 0.86);
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: bg });
    const centerX = contentX + trimWpt / 2;
    const centerY = contentY + trimHpt / 2;
    drawWrappedCenterColor(page, blurb, centerX, centerY, trimWpt * 0.72, trimHpt * 0.36, nunito, 14, 1.42, 12, rgb(1,1,1), "center");
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  } catch (e) {
    trace.push({ t: now(), step: "pdf:back-error", error: safeError(e) });
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Baksidan kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) });
  }

  const bytes = await pdfDoc.save();
  trace.push({ t: now(), step: "pdf:done", bytes: bytes?.length || 0 });
  return bytes;
}

/* ----------------------- Upload handler (CF) ---------------------------- */
async function handleUploadRequest(req, env, trace, reqId) {
  try {
    const body = await req.json().catch(() => ({}));
    const items = Array.isArray(body?.items) ? body.items : body?.data_url ? [body] : [];
    if (!items.length) return err("Body must include items[] or {page|kind,data_url}", 400, {}, trace, reqId);

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
        uploads.push({ page: it.page ?? it.kind, error: safeError(e) });
      }
    }
    return ok({ uploads }, {}, trace, reqId);
  } catch (e) {
    return err(safeError(e), 500, {}, trace, reqId);
  }
}

/* --------------------------- API Handlers ------------------------------- */
async function handlePdfRequest(req, env, { previewInline = false } = {}, trace, reqId, debugBody) {
  const body = await req.json().catch(() => ({}));
  const { story, images, mode = "print", trim = "square210", bleed_mm, watermark_text } = body || {};
  if (!story || !Array.isArray(story?.book?.pages)) return err("Missing story", 400, {}, trace, reqId, debugBody);

  try {
    const bytes = await buildPdf({ story, images: images || [], mode, trim, bleed_mm, watermark_text }, env, trace, reqId);
    const filename = (story?.book?.title || "BokPiloten").replace(/[^\wåäöÅÄÖ\-]+/g, "_") + (mode === "print" ? "_PRINT.pdf" : "_PREVIEW.pdf");
    const headers = new Headers({ "content-type": "application/pdf", "content-length": String(bytes.length), "content-disposition": `${previewInline ? "inline" : "attachment"}; filename="${filename}"`, ...CORS, "x-request-id": reqId });
    return new Response(bytes, { status: 200, headers });
  } catch (e) {
    trace.push({ t: now(), step: "pdf:build-error", error: safeError(e) });
    return err(safeError(e), 500, {}, trace, reqId, debugBody);
  }
}

async function handleDiag(env, trace, reqId) {
  const base = String(env.FONT_BASE_URL || "").replace(/\/+$/,"");
  const targets = base ? [
    `${base}/Baloo-bold.ttf`,
    `${base}/Nunito-Regular.ttf`,
    `${base}/Nunito-Semibold.ttf`,
  ] : [];
  const cdn = [
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/baloo2/Baloo2-Bold.ttf",
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nunito/Nunito-Regular.ttf",
    "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/nunito/Nunito-SemiBold.ttf",
  ];
  const checks = [];
  for (const u of [...targets, ...cdn]) {
    try {
      const r = await fetch(u, { method: "HEAD" });
      checks.push({ url: u, status: r.status, ct: r.headers.get("content-type") || null, cl: r.headers.get("content-length") || null });
    } catch (e) {
      checks.push({ url: u, error: safeError(e) });
    }
  }
  return ok({ font_base: base || null, checks }, {}, trace, reqId);
}

/* -------------------------------- API ---------------------------------- */
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const trace = [];
    const reqId = id();
    const url = new URL(req.url);
    const debug = url.searchParams.get("debug") === "1"; // ?debug=1 => inkluderar trace i JSON-fel

    try {
      trace.push({ t: now(), step: "req:start", method: req.method, path: url.pathname, reqId });

      // Health
      if (req.method === "GET" && url.pathname === "/") return ok({ ok: true, ts: Date.now() }, {}, trace, reqId);

      // Diag
      if (req.method === "GET" && url.pathname === "/api/diag") {
        const resp = await handleDiag(env, trace, reqId);
        return withCORS(resp, reqId);
      }

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

          const outline = await openaiJSON(env, OUTLINE_SYS, outlineUser, trace);

          const storyUser = `
OUTLINE:
${JSON.stringify(outline)}
${heroDescriptor({ category, name, age, traits })}
Läsålder: ${targetAge}. Sidor: ${pages || 12}. Stil: ${style || "cartoon"}. Kategori: ${category || "kids"}.
Boken ska ha tydlig lärdom (lesson) kopplad till temat.
Returnera enbart json.`.trim();

          const story = await openaiJSON(env, STORY_SYS, storyUser, trace);
          const plan = normalizePlan(story?.book?.pages || []);
          return withCORS(ok({ story, plan, previewVisible: 4 }, {}, trace, reqId), reqId);
        } catch (e) {
          return withCORS(err(safeError(e), 500, {}, trace, reqId, debug), reqId);
        }
      }

      // Ref image
      if (req.method === "POST" && url.pathname === "/api/ref-image") {
        try {
          const { style = "cartoon", photo_b64, bible, traits = "" } = await req.json();
          if (photo_b64) {
            const b64 = String(photo_b64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
            return withCORS(ok({ ref_image_b64: b64 }, {}, trace, reqId), reqId);
          }
          const prompt = characterCardPrompt({ style, bible, traits });
          const g = await geminiImage(env, { prompt }, 70000, 2, trace);
          return withCORS(ok({ ref_image_b64: g?.b64 || null }, {}, trace, reqId), reqId);
        } catch (e) {
          return withCORS(err(safeError(e), 500, {}, trace, reqId, debug), reqId);
        }
      }

      // Generate interior images
      if (req.method === "POST" && url.pathname === "/api/images") {
        try {
          const { style = "cartoon", ref_image_b64, story, plan, concurrency = 4, pages_subset, style_refs_b64, coherence_code } = await req.json();
          const allPages = story?.book?.pages || [];
          const pages = Array.isArray(pages_subset) && pages_subset.length ? allPages.filter(p => pages_subset.includes(p.page)) : allPages;
          if (!pages.length) return withCORS(err("No pages", 400, {}, trace, reqId, debug), reqId);
          if (!ref_image_b64) return withCORS(err("Missing reference image", 400, {}, trace, reqId, debug), reqId);

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
                const g = await geminiImage(env, { prompt: item.prompt, character_ref_b64: ref_image_b64, style_refs_b64, coherence_code }, 75000, 3, trace);
                out.push({ page: item.page, image_url: g.image_url, provider: g.provider || "google" });
              } catch (e) {
                out.push({ page: item.page, error: safeError(e) });
              }
            }
          }
          await Promise.all(Array.from({ length: CONC }, worker));
          out.sort((a, b) => (a.page || 0) - (b.page || 0));
          return withCORS(ok({ images: out }, {}, trace, reqId), reqId);
        } catch (e) {
          return withCORS(err(safeError(e), 500, {}, trace, reqId, debug), reqId);
        }
      }

      // Regenerate one
      if (req.method === "POST" && url.pathname === "/api/image/regenerate") {
        try {
          const { style = "cartoon", ref_image_b64, page_text, scene_text, frame, story } = await req.json();
          if (!ref_image_b64) return withCORS(err("Missing reference image", 400, {}, trace, reqId, debug), reqId);
          const fakeStory = story || { book: { pages: [{ page: 1, scene: scene_text, text: page_text }] } };
          const pg = { page: 1, scene: scene_text, text: page_text };
          const f = { shot_type: frame?.shot_type || "M", lens_mm: frame?.lens_mm || 50, subject_size_percent: frame?.subject_size_percent || 60 };
          const prompt = buildFramePrompt({ style, story: fakeStory, page: pg, pageCount: 1, frame: f, characterName: (fakeStory.book?.bible?.main_character?.name || "Hjälten") });
          const g = await geminiImage(env, { prompt, character_ref_b64: ref_image_b64 }, 75000, 3, trace);
          return withCORS(ok({ image_url: g.image_url, provider: g.provider || "google" }, {}, trace, reqId), reqId);
        } catch (e) {
          return withCORS(err(safeError(e), 500, {}, trace, reqId, debug), reqId);
        }
      }

      // Cover
      if (req.method === "POST" && url.pathname === "/api/cover") {
        try {
          const { style = "cartoon", ref_image_b64, story } = await req.json();
          const characterName = story?.book?.bible?.main_character?.name || "Hjälten";
          const prompt = buildCoverPrompt({ style, story, characterName });
          const g = await geminiImage(env, { prompt, character_ref_b64: ref_image_b64 }, 75000, 2, trace);
          return withCORS(ok({ image_url: g.image_url, provider: g.provider || "google" }, {}, trace, reqId), reqId);
        } catch (e) {
          return withCORS(err(safeError(e), 500, {}, trace, reqId, debug), reqId);
        }
      }

      // Upload -> CF Images
      if (req.method === "POST" && url.pathname === "/api/images/upload") {
        const resp = await handleUploadRequest(req, env, trace, reqId);
        return withCORS(resp, reqId);
      }

      // Build PDF
      if (req.method === "POST" && url.pathname === "/api/pdf") {
        try {
          const resp = await handlePdfRequest(req, env, { previewInline: true }, trace, reqId, debug);
          return withCORS(resp, reqId);
        } catch (e) {
          return withCORS(err(safeError(e), 500, {}, trace, reqId, debug), reqId);
        }
      }

      return withCORS(new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: JSONH }), reqId);
    } catch (e) {
      log("FATAL", safeError(e), { reqId });
      return withCORS(new Response(JSON.stringify({ error: safeError(e) }), { status: 500, headers: JSONH }), reqId);
    }
  },
};
