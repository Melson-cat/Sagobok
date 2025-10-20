// ============================================================================
// BokPiloten – Worker v13
// Outline → Story med röd tråd + kategori-agnostisk hjälte + läsålder
// Global text-kontekst per sida (ingen bild-kedjning) + uttrycksfull cartoon
// Endpoints: /api/story, /api/ref-image, /api/images, /api/image/regenerate
// ============================================================================

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
};
const JSONH = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS };
const OPENAI_MODEL = "gpt-4o-mini";

const ok  = (data, init={}) => new Response(JSON.stringify(data), { status: init.status || 200, headers: JSONH, ...init });
const err = (msg, code=400, extra={}) => ok({ error: msg, ...extra }, { status: code });
const log = (...a) => { try { console.log(...a); } catch {} };

// ---------------- OpenAI JSON (story) ----------------
async function openaiJSON(env, system, user) {
  // Säkerställ 'json' i messages för response_format: json_object
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

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["IMAGE"], temperature: 0.35, topP: 0.9 }
  };

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

// ============================================================================
// API
// ============================================================================
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET" && url.pathname === "/") return ok({ ok: true, ts: Date.now() });

    // STORY (outline → pages)
    if (req.method === "POST" && url.pathname === "/api/story") {
      try {
        const body = await req.json();
        const { name, age, pages, category, style, theme, traits, reading_age } = body || {};
        // Läsålder: använd explicit reading_age om finns; annars kids→age, pets→8 (lite “familj”)
        const targetAge = Number.isFinite(parseInt(reading_age,10))
          ? parseInt(reading_age,10)
          : ((category||"kids")==="pets" ? 8 : parseInt(age||6,10));

        // 1) Outline
        const outlineUser = `
${heroDescriptor({ category, name, age, traits })}
Kategori: ${category||"kids"}.
Läsålder: ${targetAge}.
Önskat tema/poäng (om angivet): ${theme || "vänskap"}.
Antal sidor: ${pages || 12}.
Returnera enbart json.
`.trim();

        const outline = await openaiJSON(env, OUTLINE_SYS, outlineUser);

        // 2) Book från outline
       const storyUser = `
OUTLINE:
${JSON.stringify(outline)}
${heroDescriptor({ category, name, age, traits })}
Läsålder: ${targetAge}. Sidor: ${pages||12}. Stil: ${style||"cartoon"}. Kategori: ${category||"kids"}.
Boken ska ha tydlig lärdom (lesson) kopplad till temat.
Följ temat NOGA: håll platser/handlingar huvudsakligen inom tematisk ram.
Returnera enbart json.
`.trim();


        const story = await openaiJSON(env, STORY_SYS, storyUser);
        const plan  = normalizePlan(story?.book?.pages || []);
        return ok({ story, plan, previewVisible: 4 });
      } catch (e) { log("story error", e?.message); return err(e.message||"Story failed", 500); }
    }

    // REF-IMAGE
    if (req.method === "POST" && url.pathname === "/api/ref-image") {
      try{
        const { style="cartoon", photo_b64, bible, traits="" } = await req.json();
        if (photo_b64) {
          const b64 = String(photo_b64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
          return ok({ ref_image_b64: b64 });
        }
        const prompt = characterCardPrompt({ style, bible, traits });
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

        const frames = plan?.plan || [];
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
              out.push({ page: item.page, image_url: g.image_url, provider: g.provider||"google" });
            }catch(e){ out.push({ page: item.page, error: String(e?.message||e) }); }
          }
        }
        await Promise.all(Array.from({length: CONC}, worker));
        out.sort((a,b)=>(a.page||0)-(b.page||0));
        return ok({ images: out });
      }catch(e){ log("images error", e?.message); return err(e.message||"Images failed", 500); }
    }

    // REGENERATE
    if (req.method === "POST" && url.pathname === "/api/image/regenerate") {
      try{
        const { style="cartoon", ref_image_b64, page_text, scene_text, frame, story } = await req.json();
        if (!ref_image_b64) return err("Missing reference image", 400);
        const fakeStory = story || { book:{ pages:[{page:1,scene:scene_text,text:page_text}] } };
        const pg = { page: 1, scene: scene_text, text: page_text };
        const f  = { shot_type: frame?.shot_type||"M", lens_mm: frame?.lens_mm||50, subject_size_percent: frame?.subject_size_percent||60 };
        const prompt = buildFramePrompt({ style, story: fakeStory, page: pg, pageCount: 1, frame: f, characterName: (fakeStory.book?.bible?.main_character?.name || "Hjälten") });
        const g = await geminiImage(env, { prompt, character_ref_b64: ref_image_b64 }, 75000, 3);
        return ok({ image_url: g.image_url, provider: g.provider||"google" });
      }catch(e){ log("regen error", e?.message); return err(e.message||"Regenerate failed", 500); }
    }

    return err("Not found", 404);
  }
};
