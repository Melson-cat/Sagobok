// ============================================================================
// BokPiloten – Worker v28 "Smart Wardrobe (Kids Only) + Pet Anatomy Guard + Cover Fallback"
// Endpoints: story, ref-image, images, image/regenerate, images/upload, cover, pdf, diag
// Env: API_KEY, GEMINI_API_KEY, IMAGES_API_TOKEN, CF_ACCOUNT_ID,
//      CF_IMAGES_ACCOUNT_HASH, CF_IMAGES_VARIANT, FONT_BASE_URL
// ============================================================================
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

/* ------------------------------ Globals ------------------------------ */
const OPENAI_MODEL = "gpt-4o-mini";

/* ------------------------------- CORS -------------------------------- */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
  "access-control-expose-headers": "Content-Disposition, X-Request-Id",
  vary: "Origin",
};
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  ...CORS,
};
const withCORS = (resp) => {
  const h = new Headers(resp.headers || {});
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status || 200, headers: h });
};
const ok = (data, init = {}) =>
  withCORS(
    new Response(JSON.stringify(data), {
      status: init.status || 200,
      headers: new Headers({ ...JSON_HEADERS, ...(init.headers || {}) }),
    }),
  );
const err = (message, code = 500, extra = {}) =>
  ok({ error: String(message || "error"), ...extra }, { status: code });

/* -------------------------- Trace / Diag log ------------------------- */
const traceStart = () => [];
const tr = (trace, step, extra = {}) =>
  trace && trace.push({ t: new Date().toISOString(), step, ...extra });

/* ----------------------- Units / Grid / Fonts ------------------------ */
const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;
const PT_PER_MM = PT_PER_INCH / MM_PER_INCH;
const mmToPt = (mm) => mm * PT_PER_MM;

const TRIMS = { square210: { w_mm: 210, h_mm: 210, default_bleed_mm: 3 } };
const GRID = { outer_mm: 10, gap_mm: 8, pad_mm: 12, text_min_mm: 30, text_max_mm: 58 };
const TEXT_SCALE = 1.18;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function fontSpecForReadingAge(ra = 6) {
  if (ra <= 5) return { size: 22, leading: 1.36 };
  if (ra <= 8) return { size: 18, leading: 1.36 };
  if (ra <= 12) return { size: 16, leading: 1.34 };
  return { size: 16, leading: 1.34 };
}

/* ------------------------- HTTP helpers ------------------------------ */
async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url} ${r.status} ${JSON.stringify(j)}`);
  return j;
}

/* --------------------- OpenAI JSON-only helper ----------------------- */
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

/* --------------------------- Gemini image ---------------------------- */
function findGeminiImagePart(json) {
  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts || cand?.content?.[0]?.parts || [];
  let p = parts.find(
    (x) => x?.inlineData?.mimeType?.startsWith("image/") && x?.inlineData?.data,
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
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" +
    encodeURIComponent(key);

  const parts = [];
  if (item.character_ref_b64)
    parts.push({ inlineData: { mimeType: "image/png", data: item.character_ref_b64 } });
  if (Array.isArray(item.style_refs_b64)) {
    for (const b64 of item.style_refs_b64.slice(0, 3))
      if (typeof b64 === "string" && b64.length > 64)
        parts.push({ inlineData: { mimeType: "image/png", data: b64 } });
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
          generationConfig: { responseModalities: ["IMAGE"], temperature: 0.25, topP: 0.7 },
        }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`Gemini ${r.status} ${await r.text().catch(() => "")}`);
      const j = await r.json();
      const got = findGeminiImagePart(j);
      if (got?.b64 && got?.mime)
        return { image_url: `data:${got.mime};base64,${got.b64}`, provider: "google", b64: got.b64 };
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

/* ------------------------------ Styles ------------------------------- */
function styleHint(style = "cartoon") {
  const s = (style || "cartoon").toLowerCase();
  if (s === "storybook") return "storybook watercolor, soft edges, paper texture, warm and cozy";
  if (s === "pixar") return "stylized 3D animated film still (not photographic): enlarged eyes, simplified forms, clean gradients";
  if (s === "comic") return "bold comic style, inked lines, flat colors";
  if (s === "painting") return "soft painterly illustration, visible brushwork";
  return "expressive 2D cartoon: thick-and-thin outlines, cel shading, vibrant palette";
}

function styleGuard(style = "cartoon") {
  const s = (style || "").toLowerCase();
  switch (s) {
    case "pixar":
      return [
        "STYLE: stylized 3D animated film still (clean gradients, soft global illumination).",
        "Do NOT use watercolor, inked lines, flat 2D shading, or comic outlines.",
        "Not photorealistic, not live-action."
      ].join(" ");
    case "storybook":
      return [
        "STYLE: storybook watercolor illustration, soft edges, paper texture, gentle grain.",
        "Do NOT render as 3D/Pixar or photorealistic CGI.",
        "No hard cel-shaded comic inking."
      ].join(" ");
    case "comic":
      return [
        "STYLE: bold comic inked lines with flat colors.",
        "Do NOT render as watercolor or 3D."
      ].join(" ");
    case "painting":
      return [
        "STYLE: painterly illustration with visible brushwork.",
        "Do NOT render as 3D or cel-shaded comic."
      ].join(" ");
    default:
      return [
        "STYLE: expressive 2D cartoon with cel shading.",
        "Do NOT render as 3D Pixar or photorealistic."
      ].join(" ");
  }
}

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
HÅRDA REGLER:
- **EXAKT 14 sidor**. Page-numrering måste vara **1..14** utan luckor eller dubbletter.
- **3–5 meningar** per sida, på **svenska**.
- **Konkreta scener** i vald huvudmiljö; undvik abstrakta formuleringar.
- Titeln ska vara säljbar. Fyll "tagline" och "back_blurb" (1–3 meningar).
- Returnera **enbart giltig JSON** i ovan format.
`;
function heroDescriptor({ category, name, age, traits }) {
  if ((category || "kids") === "pets")
    return `HJÄLTE: ett husdjur vid namn ${name || "Nova"}; egenskaper: ${traits || "nyfiken, lekfull"}.`;
  const a = parseInt(age || 6, 10);
  return `HJÄLTE: ett barn vid namn ${name || "Nova"} (${a} år), egenskaper: ${traits || "modig, omtänksam"}.`;
}
function normalizePlan(pages) {
  const out = [];
  const order = ["EW", "M", "CU", "W"];
  pages.forEach((p, i) => {
    const t = order[i % order.length];
    const lens = { EW: 28, W: 35, M: 50, CU: 85 }[t] || 35;
    const size = { EW: 30, W: 45, M: 60, CU: 80 }[t] || 60;
    out.push({ page: p.page, shot_type: t, lens_mm: lens, subject_size_percent: size });
  });
  return { plan: out };
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
function shotLine(f = {}) {
  const map = { EW: "extra wide", W: "wide", M: "medium", CU: "close-up" };
  return `${map[f.shot_type || "M"]} shot, ~${f.subject_size_percent || 60}% subject, ≈${f.lens_mm || 35}mm`;
}

/* ---------------------- Coherence + Wardrobe helpers ---------------------- */
function makeCoherenceCode(story) {
  const t = String(story?.book?.title || "sagobok");
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return (h.toString(36) + "000000").slice(0, 6).toUpperCase();
}

/** Single-color wardrobe for kids only. Pets: return "" (omit). */
function deriveWardrobeSignature(story) {
  const cat = (story?.book?.category || "kids").toLowerCase();
  if (cat === "pets") return "";

  const wb = story?.book?.bible || {};
  const hintArr = Array.isArray(wb?.wardrobe) ? wb.wardrobe : [];
  const hinted = hintArr.join(", ").trim();
  if (hinted) return hinted; // om du redan matar in engelska här, låt vara

  const palette = (wb?.palette || []).map((s) => s.toLowerCase()).filter(Boolean);
  const colors = ["blue","red","green","yellow","purple","turquoise"];
  const idx = parseInt(makeCoherenceCode(story), 36) % colors.length;
  const base = (palette[0] || colors[idx]);
  const accent = (palette[1] || "white");

  const name = (wb?.main_character?.name || "").toLowerCase();
  const seemsGirl = /a$|ia$|na$|emma|olivia|ella|elin|sofia|lisa|anna/.test(name);

  return seemsGirl
    ? `a ${base} dress with subtle ${accent} details (keep exactly the same outfit and base color on all pages)`
    : `a ${base} sweater and ${accent} pants (keep exactly the same outfit and base color on all pages)`;
}


function buildFramePrompt({ style, story, page, pageCount, frame, characterName, wardrobe_signature, coherence_code }) {
  const sGuard = styleGuard(style);
  const isPet  = (story?.book?.category || "kids").toLowerCase() === "pets";
  const coh    = coherence_code || makeCoherenceCode(story);
  const age    = story?.book?.bible?.main_character?.age || 5;

  const wardrobeLine = !isPet && wardrobe_signature
    ? `Kläder: ${wardrobe_signature}. Hjälten har alltid samma kläder och färger genom hela berättelsen. Ändra aldrig klädtyp eller färg i någon bild.`
    : "";

  const identityLines = [
    `Använd exakt samma huvudkaraktär som på referensbilden (${characterName}).`,
    `Bevara ansiktsstruktur (ögon/näsa/mun-placering), frisyr och hårfärg.`,
    `Ålder ≈ ${age} (barnproportioner: större huvud-till-kropp).`,
    `Ändra aldrig hårfärg eller hårlängd. Ingen sminkning. Gör inte om till tonåring eller vuxen.`
  ].join(" ");

  const consistency = [
    `Detta är sida ${page.page} av ${pageCount}.`,
    `Håll strikt samma STIL (se STYLE) i varje bild; inga stilbyten mellan 2D/3D.`,
    `Variera kameravinkel och uttryck försiktigt för att undvika upprepning, men behåll identiteten.`
  ].join(" ");

  const salt = "UNIQUE_PAGE:" + page.page + "-" + ((crypto?.randomUUID?.() || Date.now()).toString().slice(-8));

  return [
    // STYLE
    sGuard,
    // IDENTITET & KLÄDER
    identityLines,
    wardrobeLine,
    // KONTINUITET
    consistency,
    `COHERENCE_CODE:${coh}`,
    // FORMAT
    `Format: kvadrat (1:1); undvik att kapa lemmar ofrivilligt.`,
    // SCEN
    page.time_of_day ? `Tid på dygnet: ${page.time_of_day}.` : "",
    page.weather    ? `Väder: ${page.weather}.` : "",
    `SCEN: ${page.scene || page.text || ""}`,
    `BILDVINKEL: ${shotLine(frame)}.`,
    // REPEAT-SKYDD
    `ÅTERANVÄND INTE exakt samma bildkomposition som tidigare.`,
    salt
  ].filter(Boolean).join("\n");
}



function characterCardPrompt({ style, bible, traits }) {
  const mc   = bible?.main_character || {};
  const name = mc.name || "Nova";
  const phys = mc.physique || traits || "liten, lekfull";
  return [
    styleGuard(style),
    "En (1) hjälte, helkropp, neutral bakgrund. Detta är kanonisk referens för ALLA bilder.",
    `Hjälte: ${name}, ${phys}.`,
    "Bevara ansiktsstruktur, hårfärg och hårlängd. Barnproportioner om barnet är ungt.",
    "Ingen text eller logotyper."
  ].join("\n");
}



/** Cover prompt – no wardrobe for pets, soft guard for identity */
function buildCoverPrompt({ style, story, characterName, wardrobe_signature, coherence_code }) {
  const sGuard = styleGuard(style);
  const theme = story?.book?.theme || "";
  const isPet = (story?.book?.category || "kids").toLowerCase() === "pets";
  const wardrobeLine = !isPet && wardrobe_signature
    ? `WARDROBE_SIGNATURE: ${wardrobe_signature}. Keep wardrobe consistent with interior pages.`
    : "Keep identity consistent with interior pages.";
  const coh = coherence_code || makeCoherenceCode(story);

  return [
    sGuard,
    "BOOK COVER ILLUSTRATION (front cover).",
    "Square composition (1:1). No text or logos.",
    wardrobeLine,
    `COHERENCE_CODE:${coh}`,
    `Focus on the main hero (${characterName}) from the reference; perfect identity consistency.`,
    theme ? `Theme cue: ${theme}.` : "",
  ].filter(Boolean).join("\n");
}

/* ---------------------- Cloudflare Images utils ---------------------- */
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
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`,
    { method: "POST", headers: { authorization: `Bearer ${env.IMAGES_API_TOKEN}` }, body: form },
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(`CF Images ${r.status} ${JSON.stringify(j)}`);
  const image_id = j?.result?.id;
  const url = cfImagesDeliveryURL(env, image_id);
  return { image_id, url };
}

/* --------------------------- Image helpers --------------------------- */
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
      const r1 = await fetch(pickUrl, {
        cf: { cacheTtl: 1200, cacheEverything: true, image: { format: "jpeg", quality: 90 } },
      });
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
    if (row?.image_url?.startsWith?.("data:image/")) {
      const m2 = row.image_url.match(/^data:([^;]+);base64,(.+)$/i);
      if (m2) {
        const bin2 = atob(m2[2]);
        const u82 = new Uint8Array(bin2.length);
        for (let i = 0; i < bin2.length; i++) u82[i] = bin2.charCodeAt(i);
        return u82;
      }
    }
    return null;
  } catch {
    return null;
  }
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

/* ------------------------- Text draw helpers ------------------------- */
function drawWatermark(page, text = "FÖRHANDSVISNING", color = rgb(0.5, 0.5, 0.5)) {
  const { width, height } = page.getSize();
  const fontSize = Math.min(width, height) * 0.15;
  const angleDeg = (Math.atan2(height, width) * 180) / Math.PI;
  page.drawText(String(text ?? ""), {
    x: width * 0.06,
    y: height * 0.18,
    size: fontSize,
    color,
    opacity: 0.07,
    rotate: degrees(angleDeg),
  });
}

// robust ord/tecken-wrapping
function drawWrappedCenterColor(
  page, text, centerX, centerY, maxW, maxH, font,
  baseSize, baseLeading, minSize = 12, color = rgb(0.08, 0.08, 0.08), align = "center",
) {
  const safe = String(text ?? "");
  for (let size = baseSize; size >= minSize; size--) {
    const lineH = size * baseLeading;
    const words = safe.split(/\s+/);
    const lines = [];
    let line = "";

    const pushLine = (t) => { if (t == null || t === "") return; lines.push(t); };

    for (const w of words) {
      if (font.widthOfTextAtSize(w, size) > maxW) {
        if (line) { pushLine(line); line = ""; }
        let cur = "";
        for (const ch of w.split("")) {
          const test = cur + ch;
          if (font.widthOfTextAtSize(test, size) <= maxW) cur = test;
          else { pushLine(cur); cur = ch; }
        }
        if (cur) pushLine(cur);
        continue;
      }
      const t = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(t, size) <= maxW) line = t;
      else { pushLine(line); line = w; }
    }
    if (line) pushLine(line);

    const blockH = lines.length * lineH;
    if (blockH <= maxH) {
      let y = centerY + blockH / 2 - lineH;
      for (const ln of lines) {
        const w = font.widthOfTextAtSize(ln, size);
        const x = align === "center" ? centerX - w / 2 : align === "right" ? centerX + maxW / 2 - w : centerX - maxW / 2;
        page.drawText(ln, { x, y, size, font, color });
        y -= lineH;
      }
      return { size, lines };
    }
  }
  return { size: minSize, lines: [] };
}

/* ----------------------------- Vine (fill) --------------------------- */
function drawVineSafe(page, centerX, y, widthPt, color = rgb(0.25,0.32,0.55), stroke = 2.4) {
  const baseW = 360;
  const scale = widthPt / baseW;
  const x = centerX - widthPt/2;

  if (typeof page.drawSvgPath === "function") {
    const path = "M 0 0 C 30 14, 60 -14, 90 0 C 120 14, 150 -14, 180 0 C 210 14, 240 -14, 270 0 C 300 14, 330 -14, 360 0";
    page.drawSvgPath(path, { x, y, scale, borderColor: color, borderWidth: stroke, opacity: 0.95, lineCap: "round", lineJoin: "round" });
    page.drawSvgPath("M 0 0 C 30 14, 60 -14, 90 0", {
      x, y: y + 0.9, scale, borderColor: rgb(1,1,1), borderWidth: 0.6, opacity: 0.18, lineCap: "round"
    });
    return;
  }

  const segments = 180, amp = 10, freq = Math.PI*4;
  let px = x, py = y;
  for (let i=1;i<=segments;i++){
    const t=i/segments, X=x+t*widthPt, Y=y+Math.sin(t*freq)*amp;
    page.drawLine({ start:{x:px,y:py}, end:{x:X,y:Y}, thickness: stroke, color, lineCap:"round" });
    px=X; py=Y;
  }
}

function drawHeart(page, cx, y, sizePt, color = rgb(0.58, 0.30, 0.80)) {
  const s = sizePt / 100;
  const path = [
    "M 50 30","C 50 20, 40 10, 30 10","C 15 10, 10 25, 10 30","C 10 50, 30 65, 50 85",
    "C 70 65, 90 50, 90 30","C 90 25, 85 10, 70 10","C 60 10, 50 20, 50 30","Z"
  ].join(" ");
  if (typeof page.drawSvgPath === "function") {
    page.drawSvgPath(path, { x: cx - 50*s, y: y - 30*s, scale: s, color, borderColor: color, opacity: 0.9 });
  } else {
    page.drawEllipse({ x: cx - sizePt*0.18, y, xScale: sizePt*0.18, yScale: sizePt*0.16, color });
    page.drawEllipse({ x: cx + sizePt*0.18, y, xScale: sizePt*0.18, yScale: sizePt*0.16, color });
    page.drawRectangle({ x: cx - sizePt*0.18, y: y - sizePt*0.35, width: sizePt*0.36, height: sizePt*0.35, color, opacity: 0.98, rotate: degrees(45) });
  }
}

/* ------------------------- Fonts embedding --------------------------- */
async function fetchBytes(trace, url) {
  tr(trace, "font:fetch", { url });
  const r = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
  tr(trace, "font:fetch:done", {
    url,
    status: r.status,
    ct: r.headers.get("content-type"),
    cl: r.headers.get("content-length"),
  });
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  tr(trace, "font:bytes", { url, bytes: bytes.length });
  return bytes;
}
async function embedCustomFont(trace, pdfDoc, url) {
  try { if (typeof pdfDoc.registerFontkit === "function") pdfDoc.registerFontkit(fontkit); } catch {}
  const bytes = await fetchBytes(trace, url);
  const font = await pdfDoc.embedFont(bytes, { subset: true });
  tr(trace, "font:embedded", { url });
  return font;
}
async function getFontOrFallback(trace, pdfDoc, label, urls, standardName) {
  for (const url of urls) {
    try { return await embedCustomFont(trace, pdfDoc, url); }
    catch (e) { tr(trace, "font:embed-error", { url, error: String(e?.message || e) }); }
  }
  tr(trace, "font:fallback", { label, standard: standardName });
  return await pdfDoc.embedFont(standardName);
}

/* ---------------------------- Build PDF ------------------------------ */
async function buildPdf({ story, images, mode = "preview", trim = "square210", bleed_mm, watermark_text }, env, trace) {
  tr(trace, "pdf:start");
  const trimSpec = TRIMS[trim] || TRIMS.square210;
  const bleed = mode === "print" ? (Number.isFinite(bleed_mm) ? bleed_mm : trimSpec.default_bleed_mm) : 0;

  const trimWpt = mmToPt(trimSpec.w_mm);
  const trimHpt = mmToPt(trimSpec.h_mm);
  const pageW = trimWpt + mmToPt(bleed * 2);
  const pageH = trimHpt + mmToPt(bleed * 2);
  const contentX = mmToPt(bleed);
  const contentY = mmToPt(bleed);

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  tr(trace, "pdf:doc-created");

  const helv      = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold  = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helvIt    = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const base = (env.FONT_BASE_URL || "https://sagobok.pages.dev/fonts").replace(/\/+$/, "");
  const NUN_R  = [`${base}/Nunito-Regular.ttf`];
  const NUN_SB = [`${base}/Nunito-Semibold.ttf`];
  const nunito     = await getFontOrFallback(trace, pdfDoc, "nunito", NUN_R,  StandardFonts.TimesRoman);
  const nunitoSemi = await getFontOrFallback(trace, pdfDoc, "nunitoSemi", NUN_SB, StandardFonts.Helvetica);
  tr(trace, "pdf:fonts-ready");

  const readingAge = story?.book?.reading_age || 6;
  const { size: baseTextSize, leading: baseLeading } = fontSpecForReadingAge(readingAge);

  const title = String(story?.book?.title ?? "Min bok");
  const subtitle =
    String(
      story?.book?.tagline ??
      (story?.book?.bible?.main_character?.name ? `Med ${story.book.bible.main_character.name}` : "") ??
      ""
    );
  const blurb =
    String(
      story?.book?.back_blurb ??
      (story?.book?.lesson ? `Lärdom: ${story.book.lesson}.` : "En berättelse skapad med BokPiloten.") ??
      ""
    );
  const pagesStory = [...(story?.book?.pages || [])];

  // Indexera inkomna bilder
  let coverSrc = images?.find((x) => x?.kind === "cover" || x?.page === 0) || null;
  const imgByPage = new Map();
  (images || []).forEach((row) => {
    if (Number.isFinite(row?.page) && row.page > 0 && (row.image_id || row.url || row.image_url || row.data_url)) {
      imgByPage.set(row.page, row);
    }
  });

  // Normalisera 14 scener
  function mapTo14ScenePages() {
    const want = 14;
    if (pagesStory.length === want) return pagesStory;
    if (pagesStory.length > want) return pagesStory.slice(0, want);
    const out = [...pagesStory];
    while (out.length < want)
      out.push(pagesStory[pagesStory.length - 1] || { page: out.length + 1, text: "", scene: "" });
    return out;
  }
  const scenePages = mapTo14ScenePages();
  tr(trace, "pdf:scene-pages", { count: scenePages.length });

  /* -------- FRONT COVER -------- */
  try {
    const coverPage = pdfDoc.addPage([pageW, pageH]);
    if (!coverSrc) coverSrc = imgByPage.get(1) || null;

    if (coverSrc) {
      const bytes = await getImageBytes(env, coverSrc);
      const coverImg = await embedImage(pdfDoc, bytes);
      if (coverImg) drawImageCover(coverPage, coverImg, 0, 0, pageW, pageH);
    } else {
      coverPage.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.94,0.96,1) });
    }

    const safeInset = mmToPt(GRID.outer_mm + 2);
    const tw  = trimWpt - safeInset * 2;
    const cx  = contentX + trimWpt / 2;
    const topCenterY0 = contentY + trimHpt - mmToPt(GRID.outer_mm + 16);

    const measure = (txt, font, baseSize, leading, minSize, maxW, maxH) => {
      const s = String(txt ?? "");
      for (let size = baseSize; size >= minSize; size--) {
        const lineH = size * leading;
        const words = s.split(/\s+/);
        const lines = [];
        let line = "";
        for (const w of words) {
          const t = line ? line + " " + w : w;
          if (font.widthOfTextAtSize(t, size) <= maxW) line = t;
          else { if (line) lines.push(line); line = w; }
        }
        if (line) lines.push(line);
        const blockH = lines.length * lineH;
        if (blockH <= maxH) return { size, lineH, lines, blockH };
      }
      return { size: 12, lineH: 12 * 1.1, lines: [], blockH: 0 };
    };

    const titleM = measure(title, nunitoSemi, Math.min(trimWpt, trimHpt) * 0.16, 1.08, 22, tw, mmToPt(32));
    const subtitleSize = Math.max(14, (titleM.size * 0.48) | 0);
    const subM = subtitle ? measure(subtitle, nunito, subtitleSize, 1.12, 12, tw, mmToPt(18)) : { blockH: 0 };

    const padY = mmToPt(4), padX = mmToPt(6), gap = mmToPt(4);
    const badgeH = titleM.blockH + (subtitle ? (gap + subM.blockH) : 0) + padY * 2;
    const badgeY = topCenterY0 - badgeH / 2;

    coverPage.drawRectangle({
      x: contentX + safeInset - padX, y: badgeY, width: tw + padX * 2, height: badgeH,
      color: rgb(1,1,1), opacity: 0.25,
    });

    {
      let y = badgeY + badgeH - padY - titleM.lineH / 2;
      for (const ln of titleM.lines) {
        const w = nunitoSemi.widthOfTextAtSize(ln, titleM.size);
        coverPage.drawText(ln, { x: cx - w / 2, y, size: titleM.size, font: nunitoSemi, color: rgb(0.05,0.05,0.05) });
        y -= titleM.lineH;
      }
    }

    if (subtitle) {
      const subCenterY = badgeY + padY + subM.blockH / 2;
      let y = subCenterY + subM.blockH / 2 - subM.lineH;
      for (const ln of subM.lines) {
        const w = nunito.widthOfTextAtSize(ln, subtitleSize);
        coverPage.drawText(ln, { x: cx - w / 2, y, size: subtitleSize, font: nunito, color: rgb(0.12,0.12,0.12) });
        y -= subM.lineH;
      }
    }

    if (mode === "preview" && watermark_text) drawWatermark(coverPage, watermark_text);
  } catch (e) {
    tr(trace, "cover:error", { error: String(e?.message || e) });
    const p = pdfDoc.addPage([pageW, pageH]);
    p.drawText("Omslag kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) });
  }

  /* -------- 14 uppslag: bild vänster, text höger + vine -------- */
  const outer = mmToPt(GRID.outer_mm);
  for (let i = 0; i < 14; i++) {
    const scene = scenePages[i] || {};
    const mainText = String(scene.text || "").trim();

    // Vänster: bild
    const left = pdfDoc.addPage([pageW, pageH]);
    left.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(1, 1, 1) });
    try {
      const src = imgByPage.get(scene.page);
      let imgObj = null;
      if (src) {
        const bytes = await getImageBytes(env, src);
        imgObj = await embedImage(pdfDoc, bytes);
      }
      if (imgObj) drawImageCover(left, imgObj, 0, 0, pageW, pageH);
      else left.drawText("Bild saknas", { x: contentX + mmToPt(4), y: contentY + mmToPt(6), size: 12, font: nunito, color: rgb(0.8, 0.1, 0.1) });
    } catch (e) {
      tr(trace, "page:image:error", { page: scene?.page, error: String(e?.message || e) });
      left.drawText("Bildfel", { x: contentX + mmToPt(4), y: contentY + mmToPt(6), size: 12, font: nunito, color: rgb(0.8, 0.1, 0.1) });
    }
    if (mode === "preview" && watermark_text) drawWatermark(left, watermark_text);

    // Höger: text
    const right = pdfDoc.addPage([pageW, pageH]);
    right.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.96, 0.98, 1) });

    const cx = contentX + trimWpt / 2, cy = contentY + trimHpt / 2 + mmToPt(6);
    drawWrappedCenterColor(
      right, mainText, cx, cy, trimWpt * 0.76, trimHpt * 0.46, nunito,
      Math.round(baseTextSize * TEXT_SCALE), baseLeading, 12, rgb(0.08, 0.08, 0.1), "center"
    );

    // Sidnummer
    const pageNum = 2 + i * 2 + 1;
    const pn = String(pageNum);
    const pnW = nunito.widthOfTextAtSize(pn, 10);
    right.drawText(pn, { x: contentX + trimWpt - outer - pnW, y: contentY + mmToPt(6), size: 10, font: nunito, color: rgb(0.35, 0.35, 0.45) });

    if (mode === "preview" && watermark_text) drawWatermark(right, watermark_text);
    drawVineSafe(right, cx, contentY + trimHpt * 0.36, trimWpt * 0.80, rgb(0.25,0.32,0.55), 2.4);
  }

  /* -------- [30] SLUT -------- */
  {
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.96, 0.98, 1) });

    const cx = contentX + trimWpt / 2;
    const topY = contentY + trimHpt * 0.58;

    drawWrappedCenterColor(
      page,
      "Snipp snapp snut – så var sagan slut!",
      cx, topY,
      trimWpt * 0.76, mmToPt(30),
      nunito, 22, 1.22, 14, rgb(0.1,0.1,0.12), "center"
    );

    drawHeart(page, cx, contentY + trimHpt * 0.38, mmToPt(14), rgb(0.50, 0.36, 0.82));

    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  }

  /* -------- [31] BACK COVER -------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const bg = rgb(0.58, 0.54, 0.86);
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: bg });
    const centerX = contentX + trimWpt / 2;
    const centerY = contentY + trimHpt / 2;
    drawWrappedCenterColor(page, blurb, centerX, centerY, trimWpt * 0.72, trimHpt * 0.36, nunito, 14, 1.42, 12, rgb(1,1,1), "center");
    if (mode === "preview" && watermark_text) drawWatermark(page, watermark_text);
  } catch (e) {
    tr(trace, "back:error", { error: String(e?.message || e) });
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawText("Baksidan kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8, 0.1, 0.1) });
  }

  const bytes = await pdfDoc.save();
  tr(trace, "pdf:done", { bytes: bytes.length });
  return bytes;
}

/* ------------------------- Upload handler ---------------------------- */
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
  } catch (e) {
    return err(e?.message || "Upload failed", 500);
  }
}

/* --------------------------- /api/pdf -------------------------------- */
async function handlePdfRequest(req, env) {
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") === "1";
  const trace = traceStart();

  const reqId = req.headers.get("cf-ray") || crypto.randomUUID();
  tr(trace, "req:start", { method: req.method, path: url.pathname, reqId });
  tr(trace, "pdf:entry");

  const body = await req.json().catch(() => ({}));
  const { story, images, mode = "preview", trim = "square210", bleed_mm, watermark_text } = body || {};
  if (!story || !Array.isArray(story?.book?.pages)) {
    return new Response(JSON.stringify({ error: "Missing story" }), {
      status: 400,
      headers: { ...JSON_HEADERS, "x-request-id": reqId },
    });
  }

  try {
    const bytes = await buildPdf({ story, images: images || [], mode, trim, bleed_mm, watermark_text }, env, trace);
    const filename =
      (String(story?.book?.title || "BokPiloten").replace(/[^\wåäöÅÄÖ\-]+/g, "_")) +
      (mode === "print" ? "_PRINT.pdf" : "_PREVIEW.pdf");
    const headers = new Headers({
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="${filename}"`,
      "x-request-id": reqId,
      ...CORS,
    });
    return new Response(bytes, { status: 200, headers });
  } catch (e) {
    tr(trace, "pdf:build-error", { error: String(e?.message || e) });
    const body = debug
      ? JSON.stringify({ error: e?.message || String(e), trace }, null, 2)
      : JSON.stringify({ error: "PDF failed" });
    return new Response(body, { status: 500, headers: { "content-type": "application/json", "x-request-id": reqId, ...CORS } });
  }
}

/* --------------------------- /api/diag ------------------------------- */
async function handleDiagRequest(_req, env) {
  const base = (env.FONT_BASE_URL || "https://sagobok.pages.dev/fonts").replace(/\/+$/, "");
  const candidates = [`${base}/Nunito-Regular.ttf`, `${base}/Nunito-Semibold.ttf`];
  const checks = [];
  for (const u of candidates) {
    try {
      const r = await fetch(u, { method: "HEAD" });
      checks.push({ url: u, status: r.status, ct: r.headers.get("content-type"), cl: r.headers.get("content-length") });
    } catch (e) {
      checks.push({ url: u, error: String(e?.message || e) });
    }
  }
  return ok({ font_base: base, has_fontkit: !!fontkit, checks });
}

/* --------------------------- Story endpoints ------------------------- */
export default {
  async fetch(req, env) {
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const url = new URL(req.url);

      // Health
      if (req.method === "GET" && url.pathname === "/") return ok({ ok: true, ts: Date.now() });

      // Diag
      if (req.method === "GET" && url.pathname === "/api/diag") return handleDiagRequest(req, env);

      // Story
      if (req.method === "POST" && url.pathname === "/api/story") {
        try {
          const body = await req.json().catch(() => ({}));
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
Läsålder: ${targetAge}. **Sidor: 14**. Stil: ${style || "cartoon"}. Kategori: ${category || "kids"}.
Boken ska ha tydlig lärdom (lesson) kopplad till temat.
Returnera enbart JSON i exakt det efterfrågade formatet.`.trim();

          const story = await openaiJSON(env, STORY_SYS, storyUser);
                    const plan = normalizePlan(story?.book?.pages || []);
          const coherence_code = makeCoherenceCode(story);
          const wardrobe_signature = deriveWardrobeSignature(story);
          return ok({ outline, story, plan, coherence_code, wardrobe_signature });
        } catch (e) {
          return err(e?.message || "Story generation failed", 500);
        }
      }

 // Ref image (v27-kompatibel, enkel prompt, platt payload)
if (req.method === "POST" && url.pathname === "/api/ref-image") {
  try {
    const { style = "cartoon", photo_b64, bible, traits = "" } = await req.json().catch(() => ({}));

    // Client-supplied photo wins
    if (photo_b64) {
      const b64 = String(photo_b64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
      if (b64.length > 64) return ok({ ref_image_b64: b64, provider: "client" });
      return err("Provided photo_b64 looked invalid", 400);
    }

    // Minimal, robust prompt – exakt som v27
    const prompt = characterCardPrompt({ style, bible, traits });

    // Anropa Gemini utan extra parts
    const g = await geminiImage(env, { prompt }, 70000, 2);
    if (g?.b64) return ok({ ref_image_b64: g.b64, provider: g.provider || "google" });

    // Tillbaka-kompatibelt svar (frontend hanterar null)
    return ok({ ref_image_b64: null });
  } catch (e) {
    return err(e?.message || "Ref generation failed", 500);
  }
}

// Generate interior images (plural endpoint expected by frontend)
if (req.method === "POST" && url.pathname === "/api/images") {
  try {
    const {
      style = "cartoon",
      ref_image_b64,
      story,
      plan,
      concurrency = 4,
      pages_subset,
      style_refs_b64,
      coherence_code,
      guidance, // optional
    } = await req.json().catch(() => ({}));

    const allPages = story?.book?.pages || [];
    const pagesArr = Array.isArray(pages_subset) && pages_subset.length
      ? allPages.filter((p) => pages_subset.includes(p.page))
      : allPages;

    if (!pagesArr.length) return err("No pages", 400);
    if (!ref_image_b64)  return err("Missing reference image", 400);

    const frames = plan?.plan || [];
    const pageCount = pagesArr.length;
    const heroName = story?.book?.bible?.main_character?.name || "Hjälten";

    const jobs = pagesArr.map((pg) => {
      const f = frames.find((x) => x.page === pg.page) || {};
      const prompt = buildFramePrompt({
        style,
        story,
        page: pg,
        pageCount,
        frame: f,
        characterName: heroName,
        wardrobe_signature: deriveWardrobeSignature(story),
        coherence_code: coherence_code || makeCoherenceCode(story),
      });
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
          const payload = {
            prompt: item.prompt,
            character_ref_b64: ref_image_b64,
          };
          if (Array.isArray(style_refs_b64) && style_refs_b64.length) payload.style_refs_b64 = style_refs_b64;
          if (coherence_code) payload.coherence_code = coherence_code;
          if (guidance) payload.guidance = guidance;

          const g = await geminiImage(env, payload, 75000, 3);
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
    return err(e?.message || "Images generation failed", 500);
  }
}



      // Regenerate single image
      if (req.method === "POST" && url.pathname === "/api/image/regenerate") {
        try {
          const body = await req.json().catch(() => ({}));
          const { story, page, character_ref_b64 } = body || {};
          if (!story?.book?.pages) return err("Missing story.pages", 400);
          const target = story.book.pages.find((p) => p.page === page);
          if (!target) return err(`Page ${page} not found`, 404);

          const frame = normalizePlan(story.book.pages).plan.find((f) => f.page === page);
          const coherence_code = makeCoherenceCode(story);
          const wardrobe_signature = deriveWardrobeSignature(story);

          const prompt = buildFramePrompt({
            style: story.book.style,
            story,
            page: target,
            pageCount: story.book.pages.length,
            frame,
            characterName: story.book.bible.main_character.name,
            wardrobe_signature,
            coherence_code,
          });

          const img = await geminiImage(env, {
            prompt,
            character_ref_b64,
            guidance: styleHint(story.book.style),
            coherence_code,
          });
          return ok({ page, prompt, ...img });
        } catch (e) {
          return err(e?.message || "Image regeneration failed");
        }
      }

      // Cover generation
      if (req.method === "POST" && url.pathname === "/api/cover") {
        try {
          const body = await req.json().catch(() => ({}));
          const { story, character_ref_b64 } = body || {};
          if (!story?.book) return err("Missing story", 400);

          const coherence_code = makeCoherenceCode(story);
          const wardrobe_signature = deriveWardrobeSignature(story);
          const prompt = buildCoverPrompt({
            style: story.book.style,
            story,
            characterName: story.book.bible.main_character.name,
            wardrobe_signature,
            coherence_code,
          });

          const img = await geminiImage(env, {
            prompt,
            character_ref_b64,
            guidance: styleHint(story.book.style),
            coherence_code,
          });

          if (!img?.image_url) {
            // fallback
            const fb = await geminiImage(env, {
              prompt: prompt + "\nFallback: bright joyful storybook cover, focus on main character smiling.",
            }).catch(() => null);
            if (fb?.image_url) return ok({ ...fb, prompt, fallback: true });
            return err("Cover generation failed", 500);
          }

          return ok({ ...img, prompt });
        } catch (e) {
          return err(e?.message || "Cover generation failed");
        }
      }

      // Uploads
      if (req.method === "POST" && url.pathname === "/api/images/upload") {
        return handleUploadRequest(req, env);
      }

      // PDF build
      if (req.method === "POST" && url.pathname === "/api/pdf") {
        return handlePdfRequest(req, env);
      }

      // Not found
      return new Response("Not found", { status: 404, headers: CORS });
    } catch (e) {
      return err(e?.message || "Unhandled error");
    }
  },
};


