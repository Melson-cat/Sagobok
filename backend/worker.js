// ============================================================================
// BokPiloten – Worker v19 "PrintLayout Precision +" (tryck först + robust preview)
// Endpoints: story, ref-image, images, image/regenerate, images/upload, pdf
// Requires env: API_KEY, GEMINI_API_KEY, IMAGES_API_TOKEN, CF_ACCOUNT_ID,
//               CF_IMAGES_ACCOUNT_HASH, (CF_IMAGES_VARIANT)
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
const log = (...a) => {
  try {
    console.log(...a);
  } catch {}
};
const OPENAI_MODEL = "gpt-4o-mini";

/* --------------------------- OpenAI (JSON) ----------------------------- */
async function openaiJSON(env, system, user) {
  const sys = system.toLowerCase().includes("json")
    ? system
    : system + "\nSvara endast som giltig json.";
  const usr = user.toLowerCase().includes("json")
    ? user
    : user + "\n(returnera bara json)";
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.6,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr },
      ],
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
  let p = parts.find(
    (x) => x?.inlineData?.mimeType?.startsWith("image/") && x?.inlineData?.data
  );
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(
    key
  )}`;
  const parts = [];
  if (item.character_ref_b64)
    parts.push({
      inlineData: { mimeType: "image/png", data: item.character_ref_b64 },
    });
  if (item.guidance) parts.push({ text: item.guidance });
  parts.push({ text: item.prompt });
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseModalities: ["IMAGE"],
      temperature: 0.35,
      topP: 0.9,
    },
  };

  let last;
  for (let i = 1; i <= attempts; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort("timeout"), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Gemini ${r.status} ${await r.text().catch(() => "")}`);
      const j = await r.json();
      const got = findGeminiImagePart(j);
      if (got?.b64 && got?.mime)
        return {
          image_url: `data:${got.mime};base64,${got.b64}`,
          provider: "google",
          b64: got.b64,
        };
      if (got?.url) return { image_url: got.url, provider: "google" };
      throw new Error("No image in response");
    } catch (e) {
      clearTimeout(t);
      last = e;
      await new Promise((r) => setTimeout(r, 180 * i));
    }
  }
  throw last || new Error("Gemini failed");
}

/* ----------------------------- Style ---------------------------------- */
function styleHint(style = "cartoon") {
  const s = (style || "cartoon").toLowerCase();
  if (s === "storybook")
    return "storybook watercolor, soft edges, paper texture, warm and cozy";
  if (s === "pixar")
    return "stylized 3D animated film still (not photographic): enlarged eyes, simplified forms, clean gradients";
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
  if ((category || "kids") === "pets")
    return `HJÄLTE: ett husdjur vid namn ${name || "Nova"}; egenskaper: ${
      traits || "nyfiken, lekfull"
    }.`;
  const a = parseInt(age || 6, 10);
  return `HJÄLTE: ett barn vid namn ${name || "Nova"} (${a} år), egenskaper: ${
    traits || "modig, omtänksam"
  }.`;
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
  return `${map[f.shot_type || "M"]} shot, ~${f.subject_size_percent || 60}% subject, ≈${
    f.lens_mm || 35
  }mm`;
}
function buildSeriesContext(story) {
  const pages = story?.book?.pages || [];
  const locs = [];
  const beats = pages.map((p) => {
    const key = (p.scene || p.text || "").replace(/\s+/g, " ").trim();
    const lkey =
      key.toLowerCase().match(/(strand|skog|kök|sovrum|park|hav|stad|skola|gård|sjö|berg)/)?.[1] ||
      "plats";
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
  const pg = page;
  const styleLine = styleHint(style);
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
  ]
    .filter(Boolean)
    .join("\n");
}
function characterCardPrompt({ style, bible, traits }) {
  const mc = bible?.main_character || {};
  const name = mc.name || "Nova";
  const phys = mc.physique || traits || "fluffy gray cat with curious eyes";
  return [
    `Character reference in ${styleHint(style)}.`,
    `One hero only, full body, neutral background.`,
    `Hero: ${name}, ${phys}. No text.`,
  ].join(" ");
}
function buildCoverPrompt({ style, story, characterName }) {
  const styleLine = styleHint(style);
  const theme = story?.book?.theme || "";
  return [
    `BOOK COVER ILLUSTRATION (front cover), ${styleLine}.`,
    `Square composition (1:1). No text or logos.`,
    `Focus on the main hero (${characterName}) from the reference; perfect identity consistency.`,
    theme ? `Theme cue: ${theme}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/* ----------------------- Cloudflare Images ----------------------------- */
function dataUrlToBlob(dataUrl) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  const mime = m[1];
  const b64 = m[2];
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
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
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`,
    { method: "POST", headers: { authorization: `Bearer ${env.IMAGES_API_TOKEN}` }, body: form }
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`CF Images ${r.status} ${JSON.stringify(j)}`);
  const image_id = j?.result?.id;
  const url = cfImagesDeliveryURL(env, image_id);
  return { image_id, url };
}

/* ---------------------------- PDF helpers ------------------------------ */
// Dimensions
const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;
const PT_PER_MM = PT_PER_INCH / MM_PER_INCH;

// Trim + bleed (PRINT-FIRST)
const TRIMS = { square210: { w_mm: 210, h_mm: 210, default_bleed_mm: 3 } };
function mmToPt(mm) {
  return mm * PT_PER_MM;
}
function fontSpecForReadingAge(ra = 6) {
  if (ra <= 5) return { size: 22, leading: 1.34 };
  if (ra <= 8) return { size: 18, leading: 1.34 };
  if (ra <= 12) return { size: 16, leading: 1.32 };
  return { size: 16, leading: 1.32 };
}

// Try to embed webfonts (Baloo 2 / Nunito)
async function tryEmbedTtf(pdfDoc, url) {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    return await pdfDoc.embedFont(bytes, { subset: true });
  } catch {
    return null;
  }
}

/* ---- Text utilities: outline, shadow, pill, gradient, shrink-to-fit ---- */
function drawWatermark(page, text = "FÖRHANDSVISNING", color = rgb(0.4, 0.4, 0.4)) {
  const { width, height } = page.getSize();
  const fontSize = Math.min(width, height) * 0.09;
  const angleRad = Math.atan2(height, width);
  const angleDeg = (angleRad * 180) / Math.PI;
  page.drawText(text, {
    x: width * 0.08,
    y: height * 0.28,
    size: fontSize,
    color,
    opacity: 0.08,
    rotate: degrees(angleDeg),
  });
}

function drawTextWithOutline(page, text, x, y, size, font, opts = {}) {
  const {
    fill = rgb(1, 1, 1),
    outline = rgb(0, 0, 0),
    shadow = true,
    shadowOpacity = 0.25,
    outlineScale = 0.05, // % av font size
  } = opts;
  const d = Math.max(0.75, size * outlineScale);

  // shadow
  if (shadow) {
    page.drawText(text, { x: x + d * 0.6, y: y - d * 0.6, size, font, color: rgb(0, 0, 0), opacity: shadowOpacity });
  }

  // 8-direction outline
  const offs = [
    [ d,  0],[ -d, 0],[0,  d],[0, -d],
    [ d,  d],[ d, -d],[-d, d],[-d, -d],
  ];
  for (const [ox, oy] of offs) {
    page.drawText(text, { x: x + ox, y: y + oy, size, font, color: outline });
  }
  // fill
  page.drawText(text, { x, y, size, font, color: fill });
}

function drawMultilineWithOutline(page, lines, boxX, boxY, boxW, lineH, size, font, align="center") {
  let y = boxY + (lines.length - 1) * lineH;
  for (const ln of lines) {
    const w = font.widthOfTextAtSize(ln, size);
    const x = align === "center" ? boxX + (boxW - w) / 2 : align === "right" ? boxX + (boxW - w) : boxX;
    drawTextWithOutline(page, ln, x, y, size, font);
    y -= lineH;
  }
}

function drawPillBackground(page, boxX, boxY, boxW, boxH, radius, opacity=0.18) {
  // enkel rundad rektangel genom fyra kvartscirklar (approx via rectangles)
  page.drawRectangle({ x: boxX, y: boxY, width: boxW, height: boxH, color: rgb(0,0,0), opacity });
}

function drawTopGradientBar(page, x, y, w, h) {
  // pdf-lib saknar gradient — vi fuskar med 8 tunna rektanglar med olika opacitet
  const steps = 8;
  for (let i=0;i<steps;i++){
    const t = (steps - i)/steps; // 1..0
    page.drawRectangle({
      x, y: y + (h/steps)*i, width: w, height: h/steps,
      color: rgb(0,0,0),
      opacity: 0.22 * t
    });
  }
}

function shrinkToFitLines(text, font, maxSize, minSize, maxWidth, maxLines) {
  // prova 1 rad, sedan 2 rader (om tillåtet) – minska storlek tills det passar
  function fits(lines, size) {
    return lines.every(l => font.widthOfTextAtSize(l, size) <= maxWidth);
  }
  // 1-line
  for (let s = maxSize; s >= minSize; s -= 1) {
    if (font.widthOfTextAtSize(text, s) <= maxWidth) {
      return { size: s, lines: [text] };
    }
  }
  if (maxLines <= 1) return { size: minSize, lines: [text] };

  // 2-lines greedy split
  const words = text.split(/\s+/);
  for (let s = maxSize; s >= minSize; s -= 1) {
    // hitta bästa brytning
    let best = null;
    for (let i=1;i<words.length;i++){
      const l1 = words.slice(0,i).join(" ");
      const l2 = words.slice(i).join(" ");
      const w1 = font.widthOfTextAtSize(l1, s);
      const w2 = font.widthOfTextAtSize(l2, s);
      const ok = w1 <= maxWidth && w2 <= maxWidth;
      if (ok) {
        const diff = Math.abs(w1 - w2);
        if (!best || diff < best.diff) best = { lines:[l1,l2], diff };
      }
    }
    if (best) return { size: s, lines: best.lines };
  }
  // fallback: hård brytning med minSize
  const mid = Math.ceil(words.length/2);
  return { size: minSize, lines: [words.slice(0,mid).join(" "), words.slice(mid).join(" ")] };
}

function drawWrappedTextFit(
  page, text, boxX, boxY, boxW, boxH, font, baseSize, baseLeading, minSize=12, align="center"
) {
  // shrink-to-fit height
  for (let size = baseSize; size >= minSize; size -= 1) {
    const lineH = size * baseLeading;
    const words = String(text || "").split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      const testW = font.widthOfTextAtSize(test, size);
      if (testW <= boxW) line = test;
      else { if (line) lines.push(line); line = w; }
    }
    if (line) lines.push(line);
    const totalH = lines.length * lineH;
    if (totalH <= boxH) {
      let y = boxY + boxH - lineH;
      for (const ln of lines) {
        const w = font.widthOfTextAtSize(ln, size);
        const x = align === "center" ? boxX + (boxW - w) / 2 : align === "right" ? boxX + (boxW - w) : boxX;
        page.drawText(ln, { x, y, size, font, color: rgb(0.1,0.1,0.1) });
        y -= lineH;
      }
      return { size, lines };
    }
  }
  // truncate fallback
  const size = minSize, lineH = size * baseLeading;
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    const testW = font.widthOfTextAtSize(test, size);
    if (testW <= boxW) line = test;
    else { if (line) lines.push(line); line = w; }
    if ((lines.length + 1) * lineH >= boxH) break;
  }
  if (line && lines.length * lineH < boxH) lines.push(line + " …");
  let y = boxY + boxH - lineH;
  for (const ln of lines) {
    const w = font.widthOfTextAtSize(ln, size);
    const x = align === "center" ? boxX + (boxW - w) / 2 : align === "right" ? boxX + (boxW - w) : boxX;
    page.drawText(ln, { x, y, size, font, color: rgb(0.1,0.1,0.1) });
    y -= lineH;
  }
  return { size, lines, truncated: true };
}

/* ---- Image helpers ---- */
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
      const b64 = m[2];
      const bin = atob(b64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    return null;
  } catch {
    return null;
  }
}
async function embedImage(pdfDoc, bytes) {
  if (!bytes) return null;
  try {
    return await pdfDoc.embedPng(bytes);
  } catch {}
  try {
    return await pdfDoc.embedJpg(bytes);
  } catch {}
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
function drawImageContain(page, img, boxX, boxY, boxW, boxH) {
  const iw = img.width, ih = img.height;
  const scale = Math.min(boxW / iw, boxH / ih);
  const w = iw * scale, h = ih * scale;
  const x = boxX + (boxW - w) / 2;
  const y = boxY + (boxH - h) / 2;
  page.drawImage(img, { x, y, width: w, height: h });
}

/* ---- Print grid (mm) ---- */
const GRID = {
  outer_mm: 10, // säker marginal
  gap_mm: 8,    // bild↔text
  pad_mm: 10,   // textpadding
  text_min_mm: 30,
  text_max_mm: 58,
};

/* --------------------------- Build PDF --------------------------------- */
async function buildPdf(
  { story, images, mode = "print", trim = "square210", bleed_mm, watermark_text, text_over_image = true },
  env
) {
  const trimSpec = TRIMS[trim] || TRIMS.square210;
  const bleed = mode === "print"
    ? Number.isFinite(bleed_mm) ? bleed_mm : trimSpec.default_bleed_mm
    : 0;

  // Sida inkl bleed
  const trimWpt = mmToPt(trimSpec.w_mm);
  const trimHpt = mmToPt(trimSpec.h_mm);
  const pageW = trimWpt + mmToPt(bleed * 2);
  const pageH = trimHpt + mmToPt(bleed * 2);
  const contentX = mmToPt(bleed);
  const contentY = mmToPt(bleed);

  const pdfDoc = await PDFDocument.create();

  // Typsnitt
  const baloo =
    (await tryEmbedTtf(pdfDoc, "https://raw.githubusercontent.com/google/fonts/main/ofl/baloo2/Baloo2-Bold.ttf"))
    || (await pdfDoc.embedFont(StandardFonts.HelveticaBold));
  const nunito =
    (await tryEmbedTtf(pdfDoc, "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito-Regular.ttf"))
    || (await pdfDoc.embedFont(StandardFonts.TimesRoman));
  const nunitoSemi =
    (await tryEmbedTtf(pdfDoc, "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito-SemiBold.ttf"))
    || (await pdfDoc.embedFont(StandardFonts.Helvetica));

  const pages = story?.book?.pages || [];
  const readingAge = story?.book?.reading_age || 6;

  const title = story?.book?.title || "Min bok";
  const heroName = story?.book?.bible?.main_character?.name || "";
  const theme = story?.book?.theme || "";

  // Indexera bilder
  let coverSrc = images?.find((x) => x?.kind === "cover" || x?.page === 0) || null;
  const imgByPage = new Map();
  (images || []).forEach((row) => {
    if (Number.isFinite(row?.page) && row.page > 0 && (row.image_id || row.url || row.data_url))
      imgByPage.set(row.page, row);
  });

  /* ------- FRONT COVER (full bleed + shrink-to-fit title) ------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);

    if (!coverSrc) coverSrc = imgByPage.get(1) || null;

    if (coverSrc) {
      const bytes = await getImageBytes(env, coverSrc);
      const coverImg = await embedImage(pdfDoc, bytes);
      if (coverImg) drawImageCover(page, coverImg, 0, 0, pageW, pageH);
    }

    // Säker zon
    const safeInset = mmToPt(GRID.outer_mm + 2);
    const tx = contentX + safeInset;
    const tw = trimWpt - safeInset * 2;

    // Gradient bakom titelområde (övre 28% av sidan)
    const barH = trimHpt * 0.28;
    drawTopGradientBar(page, contentX, contentY + trimHpt - barH, trimWpt, barH);

    // Titel shrink-to-fit, upp till 2 rader
    const maxTitle = Math.min(trimWpt, trimHpt) * 0.13;
    const minTitle = 28;
    const titleFit = shrinkToFitLines(title, baloo, maxTitle, minTitle, tw, 2);
    const titleLineH = titleFit.size * 1.08;

    const subtitle = theme ? `${theme}` : heroName ? `Med ${heroName}` : "";
    const maxSub = Math.max(14, titleFit.size * 0.42);
    const subFit = subtitle
      ? shrinkToFitLines(subtitle, nunitoSemi, maxSub, 12, tw, 2)
      : null;
    const subLineH = subFit ? subFit.size * 1.15 : 0;

    // Total höjd
    const blockH =
      titleFit.lines.length * titleLineH + (subFit ? subFit.lines.length * subLineH + mmToPt(4) : 0);
    let cy = contentY + trimHpt - safeInset - blockH; // topp-ankrad inom säker zon

    // Rita titel med outline
    drawMultilineWithOutline(page, titleFit.lines, tx, cy, tw, titleLineH, titleFit.size, baloo);
    cy += titleFit.lines.length * titleLineH + mmToPt(4);

    if (subFit) {
      drawMultilineWithOutline(page, subFit.lines, tx, cy, tw, subLineH, subFit.size, nunitoSemi);
    }

    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  } catch (e) {
    log("COVER ERR:", e?.message);
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Omslag kunde inte renderas.", {
      x: mmToPt(15),
      y: mmToPt(15),
      size: 12,
      font: nunito,
      color: rgb(0.8, 0.1, 0.1),
    });
  }

  /* ------- INTERIOR PAGES ------- */
  for (const p of pages) {
    try {
      const page = pdfDoc.addPage([pageW, pageH]);

      const outer = mmToPt(GRID.outer_mm);
      const gap = mmToPt(GRID.gap_mm);
      const pad = mmToPt(GRID.pad_mm);
      const textMin = mmToPt(GRID.text_min_mm);
      const textMax = mmToPt(GRID.text_max_mm);

      const { size: baseSize } = fontSpecForReadingAge(readingAge);
      const tlen = (p.text || "").trim().length;

      // panelhöjd (när text under bild)
      let panelH =
        tlen <= 140 ? textMin : tlen <= 320 ? Math.min((textMin + textMax) / 1.2, textMax) : textMax;

      // Bild-kvadrat i safe area
      const usableH = trimHpt - outer * 2 - (text_over_image ? 0 : (gap + panelH));
      const imgSide = Math.max(Math.min(trimWpt - outer * 2, usableH), mmToPt(90));
      const imgBoxW = imgSide, imgBoxH = imgSide;
      const imgBoxX = contentX + (trimWpt - imgBoxW) / 2;
      const imgBoxY = contentY + trimHpt - outer - imgBoxH;

      // Bild
      const src = imgByPage.get(p.page);
      let imgObj = null;
      if (src) {
        const bytes = await getImageBytes(env, src);
        imgObj = await embedImage(pdfDoc, bytes);
      }
      if (imgObj) drawImageCover(page, imgObj, imgBoxX, imgBoxY, imgBoxW, imgBoxH);

      if (text_over_image) {
        // Text över bild (vit + outline + svag pill)
        const maxW = imgBoxW * 0.9;
        const size = baseSize;
        const lineH = size * 1.35;

        // grov radbrytning
        const words = (p.text || "").split(/\s+/);
        const lines = [];
        let line = "";
        for (const w of words) {
          const t = line ? line + " " + w : w;
          if (nunito.widthOfTextAtSize(t, size) <= maxW) line = t;
          else { if (line) lines.push(line); line = w; }
        }
        if (line) lines.push(line);

        const textH = lines.length * lineH;
        const boxW = maxW + mmToPt(8);
        const boxH = textH + mmToPt(8);
        const boxX = imgBoxX + (imgBoxW - boxW) / 2;
        const boxY = imgBoxY + mmToPt(8); // lite upp från nederkant

        drawPillBackground(page, boxX, boxY, boxW, boxH, mmToPt(6), 0.15);
        drawMultilineWithOutline(page, lines, boxX + mmToPt(4), boxY + mmToPt(4), maxW, lineH, size, nunito);
      } else {
        // Text under bilden (tryckvänligt)
        const panelW = trimWpt - outer * 2;
        const panelX = contentX + outer;
        const panelY = imgBoxY - gap - panelH;
        const textBoxW = panelW - pad * 2;
        const textBoxH = panelH - pad * 2;
        const textX = panelX + pad;
        const textY = panelY + pad;

        drawWrappedTextFit(page, p.text || "", textX, textY, textBoxW, textBoxH, nunito, baseSize, 1.35, 12, "center");
      }

      if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
    } catch (e) {
      log("PAGE ERR p=", p?.page, e?.message);
      const fallback = pdfDoc.addPage([pageW, pageH]);
      fallback.drawText(`Sida ${p?.page || "?"}: kunde inte rendera.`, {
        x: mmToPt(15),
        y: mmToPt(15),
        size: 12,
        font: nunito,
        color: rgb(0.8, 0.1, 0.1),
      });
      if (mode === "preview" && watermark_text) drawWatermark(fallback, watermark_text);
    }
  }

  /* ------- BACK COVER ------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const outer = mmToPt(GRID.outer_mm);

    if (mode === "preview") {
      page.drawRectangle({
        x: contentX,
        y: contentY,
        width: trimWpt,
        height: trimHpt,
        color: rgb(0.98, 0.98, 0.98),
      });
    }

    const blurb = story?.book?.lesson
      ? `Lärdom: ${story.book.lesson}`
      : `En berättelse skapad med BokPiloten.`;
    const head = "Om boken";
    const headSize = 18;
    const bodySize = 12;
    const lh = bodySize * 1.4;

    const startX = contentX + outer;
    let cursorY = contentY + trimHpt - outer - headSize;
    page.drawText(head, { x: startX, y: cursorY, size: headSize, font: baloo, color: rgb(0.1, 0.1, 0.1) });
    cursorY -= headSize + mmToPt(4);

    const words = blurb.split(/\s+/);
    let line = "";
    const maxW = trimWpt - outer * 2;
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (nunito.widthOfTextAtSize(test, bodySize) <= maxW) line = test;
      else {
        page.drawText(line, { x: startX, y: cursorY, size: bodySize, font: nunito, color: rgb(0.1, 0.1, 0.1) });
        cursorY -= lh;
        line = w;
      }
    }
    if (line) page.drawText(line, { x: startX, y: cursorY, size: bodySize, font: nunito, color: rgb(0.1, 0.1, 0.1) });

    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  } catch (e) {
    log("BACK ERR:", e?.message);
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Baksidan kunde inte renderas.", {
      x: mmToPt(15),
      y: mmToPt(15),
      size: 12,
      font: nunito,
      color: rgb(0.8, 0.1, 0.1),
    });
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
      if (!hasIdentity) {
        uploads.push({ page: it?.page ?? null, error: "missing page/kind" });
        continue;
      }
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
  const { story, images, mode = "print", trim = "square210", bleed_mm, watermark_text, text_over_image } = body || {};
  if (!story || !Array.isArray(story?.book?.pages)) {
    return new Response(JSON.stringify({ error: "Missing story" }), { status: 400, headers: JSONH });
  }

  const bytes = await buildPdf(
    { story, images: images || [], mode, trim, bleed_mm, watermark_text, text_over_image: text_over_image !== false },

    env
  );
  const filename =
    (story?.book?.title || "BokPiloten").replace(/[^\wåäöÅÄÖ\-]+/g, "_") +
    (mode === "print" ? "_PRINT.pdf" : "_PREVIEW.pdf");

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

      // Generate interior images
      if (req.method === "POST" && url.pathname === "/api/images") {
        try {
          const { style = "cartoon", ref_image_b64, story, plan, concurrency = 4 } = await req.json();
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
              const i = idx++;
              const item = jobs[i];
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
          return err(e?.message || "Images failed", 500);
        }
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
        } catch (e) {
          return err(e?.message || "Regenerate failed", 500);
        }
      }

      // Optional: cover-only generation
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

      // Upload images to Cloudflare Images
      if (req.method === "POST" && url.pathname === "/api/images/upload") {
        const resp = await handleUploadRequest(req, env);
        return withCORS(resp);
      }

      // Build PDF (print-first)
      if (req.method === "POST" && url.pathname === "/api/pdf") {
        try {
          const resp = await handlePdfRequest(req, env, { previewInline: true });
          return withCORS(resp);
        } catch (e) {
          return err(e?.message || "PDF failed", 500);
        }
      }

      // Not found
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: JSONH,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), {
        status: 500,
        headers: JSONH,
      });
    }
  },
};
