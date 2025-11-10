// ============================================================================
// BokPiloten – Worker v29 
// Endpoints: 
// ============================================================================
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";



// Stripe minimal client (fetch-baserad)

async function stripe(env, path, init = {}) {
  const method = (init.method || "POST").toUpperCase();
  const headers = { "authorization": `Bearer ${env.STRIPE_SECRET_KEY}` };

  let body = init.body;
  if (method === "GET" || method === "HEAD") {
    body = undefined; // ⬅️ kritiskt: ingen body för GET/HEAD
  } else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    if (typeof body !== "string") body = ""; // tillåt tom
  }

  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers,
    body,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `Stripe ${r.status}`);
  return j;
}


const GELATO_TTL = 30 * 24 * 60 * 60; // 30 dagar, tryckt bok tar längre tid än PDF

async function kvPutGelato(env, id, data) {
  await env.ORDERS.put(`gelato:${id}`, JSON.stringify(data), { expirationTtl: GELATO_TTL });
}
async function kvGetGelato(env, id) {
  return await env.ORDERS.get(`gelato:${id}`, { type: "json" });
}


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

// URL-encode body för Stripe (application/x-www-form-urlencoded)
function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}


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

async function gelatoGetCoverDimensions(env, productUid, pageCount) {
  if (!productUid) throw new Error("Missing productUid");
  if (!Number.isFinite(pageCount)) throw new Error("Missing/invalid pageCount");
  const u = new URL(`${GELATO_BASE.product}/products/${encodeURIComponent(productUid)}/cover-dimensions`);
  u.searchParams.set("pageCount", String(pageCount));
  return gelatoFetch(u.toString(), env); // använder redan X-API-KEY headers
}

/* ------------------------- HTTP helpers ------------------------------ */
async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url} ${r.status} ${JSON.stringify(j)}`);
  return j;
}

/* ------------------------- KV helpers (orders) ------------------------ */
const ORDER_TTL = 7 * 24 * 60 * 60; // 7 dagar

function newOrder(draft) {
  const id = crypto.randomUUID();
  const now = Date.now();
  return { id, status: "draft", created_at: now, updated_at: now, draft: draft ?? null };
}

async function kvPutOrder(env, order) {
  await env.ORDERS.put(`order:${order.id}`, JSON.stringify(order), { expirationTtl: ORDER_TTL });
}

async function kvGetOrder(env, id) {
  if (!id) return null;
  return await env.ORDERS.get(`order:${id}`, { type: "json" });
}

async function kvUpdateStatus(env, id, status, patch = {}) {
  const cur = await kvGetOrder(env, id);
  if (!cur) return null;
  const next = { ...cur, status, updated_at: Date.now(), ...patch };
  await kvPutOrder(env, next);
  return next;
}

// Mappar Gelatos orderId → din order.id (för webhook-lookup)
async function kvIndexGelatoOrder(env, gelatoId, orderId, ttlSec = 60*24*60*60) {
  if (!gelatoId || !orderId) return;
  await env.ORDERS.put(`GELATO_IDX:${gelatoId}`, orderId, { expirationTtl: ttlSec });
}


// --- Session → Order mapping (för snabb lookup från success-sida) ---
async function kvMapSessionToOrder(env, session_id, order_id, ttlSec = 24 * 60 * 60) {
  // 24h räcker – success-sidan ropas direkt efter betalning
  await env.ORDERS.put(`session:${session_id}`, order_id, { expirationTtl: ttlSec });
}
async function kvGetOrderFromSession(env, session_id) {
  if (!session_id) return null;
  return await env.ORDERS.get(`session:${session_id}`);
}

// Slå på/uppdatera filer på ordern och bumpa status → "ready" om redan betald
async function kvAttachFiles(env, order_id, files) {
  const cur = await kvGetOrder(env, order_id);
  if (!cur) throw new Error("Order not found");
  const next = {
    ...cur,
    files: { ...(cur.files || {}), ...files },
    updated_at: Date.now(),
    status: cur.status === "paid" ? "ready" : cur.status,
  };
  await kvPutOrder(env, next);
  return next;
}

/* ------------------------------ Gelato helpers ------------------------------ */
const GELATO_BASE = {
  order:   "https://order.gelatoapis.com/v4",
  product: "https://product.gelatoapis.com/v3",
  ship:    "https://shipment.gelatoapis.com/v1",
};

function gelatoHeaders(env) {
  return {
    "content-type": "application/json",
    "X-API-KEY": env.GELATO_API_KEY,
  };
}

async function gelatoFetch(url, env, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { ...gelatoHeaders(env), ...(init.headers || {}) },
  });
  const txt = await r.text();        // <-- ta alltid texten
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }

  if (!r.ok) {
    // <-- Behåll hela Gelatos valideringsfältsfel om de finns
    const msg = data?.message || data?.error || data?.errors || data?.raw || `HTTP ${r.status}`;
    throw new Error(`Gelato ${r.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return data;
}

/** Hämtar shipment methods (valfritt filtrera på land). */
async function gelatoGetShipmentMethods(env, country) {
  const url = new URL(`${GELATO_BASE.ship}/shipment-methods`);
  if (country) url.searchParams.set("country", country);
  return gelatoFetch(url.toString(), env);
}

/** Hämtar prislista för ett produktUid (valfritt pageCount/country/currency). */
async function gelatoGetPrices(env, productUid, { country, currency, pageCount } = {}) {
  const url = new URL(`${GELATO_BASE.product}/products/${encodeURIComponent(productUid)}/prices`);
  if (country)   url.searchParams.set("country", country);
  if (currency)  url.searchParams.set("currency", currency);
  if (pageCount) url.searchParams.set("pageCount", String(pageCount));
  return gelatoFetch(url.toString(), env);
}

async function gelatoCreateOrder(env, { order, shipment, customer }) {
  if (!env.GELATO_API_KEY) throw new Error("Missing GELATO_API_KEY");
  const productUid = env.GELATO_PRODUCT_UID;
  if (!productUid) throw new Error("Missing GELATO_PRODUCT_UID");
  if (!order?.id) throw new Error("Missing order.id");

  // ✅ Idempotens: om det redan finns en Gelato-order, returnera den
  if (order?.files?.gelato_order_id) {
    return {
      gelato: { id: order.files.gelato_order_id, status: order.files.gelato_status || "created" },
      order,
    };
  }

  if (!order?.files?.interior_url) throw new Error("Order missing interior_url");
  if (!order?.files?.cover_url) throw new Error("Order missing cover_url");

  // Filer för fotobok: inlaga + omslag
  const files = [
  { type: "INTERIOR", url: order.files.interior_url },
  { type: "COVER",    url: order.files.cover_url },
];


  const pageCount = order?.draft?.story?.book?.pages?.length || null;

  // Hämta fraktmetod om inte given
  let shipmentMethodUid = shipment?.shipmentMethodUid;
  if (!shipmentMethodUid) {
    const meth = await gelatoGetShipmentMethods(env, shipment?.country || env.GELATO_DEFAULT_COUNTRY || "SE");
    const pick = meth?.shipmentMethods?.find(m => m.type === "normal") || meth?.shipmentMethods?.[0];
    shipmentMethodUid = pick?.shipmentMethodUid || "normal";
  }

  // ✅ Respektera DRY RUN
  const orderType = env.GELATO_DRY_RUN ? "draft" : "order";

 // anta att du redan räknat total pageCount korrekt, t.ex. 14 inlaga + 2 (titel+slut) + 2 (covers) = 18
const payload = {
  orderType, // "draft" i test, "order" i skarpt
  orderReferenceId: order.id,
  customerReferenceId: customer?.id || "guest",
  currency: env.GELATO_DEFAULT_CURRENCY || "SEK",
  items: [
    {
      itemReferenceId: `item-${order.id}`,
      productUid,
      quantity: 1,
      files,                        // [{type:"default", url:...}, {type:"cover", url:...}]
      attributes: { pageCount }     // ✅ RÄTT plats
      // ❌ INTE: pageCount på denna nivå
    }
  ],
  shipmentMethodUid,               // låt backend välja om frontend inte skickar något
  shippingAddress: {
    companyName:  customer?.companyName || "",
    firstName:    customer?.firstName || "Kund",
    lastName:     customer?.lastName  || "BokPiloten",
    addressLine1: shipment?.addressLine1 || "Adress 1",
    addressLine2: shipment?.addressLine2 || "",
    state:        shipment?.state || "",
    city:         shipment?.city  || "Örebro",
    postCode:     shipment?.postCode || "70000",
    country:      shipment?.country  || env.GELATO_DEFAULT_COUNTRY || "SE",
    email:        customer?.email || "no-reply@example.com",
    phone:        customer?.phone || "000000000",
  }
};

  const data = await gelatoFetch(`${GELATO_BASE.order}/orders`, env, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  // Spara Gelato-id och status
  const saved = await kvAttachFiles(env, order.id, {
    gelato_order_id: data?.id || data?.orderId || null,
    gelato_status:   data?.status || "created",
  });

  // Reverse-index för webhook: GELATO_IDX:{gelatoId} -> order.id (60 dagar)
  const gelatoId = data?.id || data?.orderId;
  if (gelatoId) {
    await kvIndexGelatoOrder(env, gelatoId, saved.id, 60*24*60*60);
  }

  return { gelato: data, order: saved };
}


async function buildWrapCoverPdfFromDims(env, story, images, dims) {
  const W = mmToPt(dims.wraparoundInsideSize.width);
  const H = mmToPt(dims.wraparoundInsideSize.height);

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([W, H]);

  // Hjälpare: rita bild i en mm-box (cover-fit)
  async function drawInto(box, srcRow) {
    if (!srcRow || !box) return;
    const bytes = await getImageBytes(env, srcRow);
    const img = await embedImage(pdf, bytes);
    if (!img) return;

    const bx = mmToPt(box.left);
    const by = mmToPt(box.top);
    const bw = mmToPt(box.width);
    const bh = mmToPt(box.height);

    const scale = Math.max(bw / img.width, bh / img.height);
    const w = img.width * scale, h = img.height * scale;
    const x = bx + (bw - w) / 2;
    const y = H - by - bh + (bh - h) / 2; // från topp-vänster (mm) till PDF-lib (nederkant-vänster)

    page.drawImage(img, { x, y, width: w, height: h });
  }

  // Källor
  const coverSrc = images?.find(x => x.kind === "cover") || images?.find(x => x.page === 1) || null;
  // Back: ta en annan sida om möjligt så baksidan inte blir identisk
  const backSrc  = images?.find(x => x.page === 2) || images?.find(x => x.page === (story?.book?.pages?.at(-1)?.page)) || coverSrc;

  // Målytor
  const front = dims.contentFrontSize;
  const back  = dims.contentBackSize;
  const spine = dims.spineSize;

  await drawInto(front, coverSrc);
  await drawInto(back,  backSrc);

  // Enkel ryggrad (färg). Titel kan vi lägga till senare.
  if (spine?.width && spine?.height) {
    const sx = mmToPt(spine.left);
    const sy = H - mmToPt(spine.top) - mmToPt(spine.height);
    const sw = mmToPt(spine.width);
    const sh = mmToPt(spine.height);
    page.drawRectangle({ x: sx, y: sy, width: sw, height: sh, color: rgb(0.5, 0.36, 0.82) });
  }

  return await pdf.save();
}

/* --------------------- Stripe Webhook verifiering --------------------- */
// Verifiera Stripe-signatur (v1) i Cloudflare Workers
async function verifyStripeSignature(rawPayload, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(",").map(s => {
      const [k, v] = s.split("=");
      return [k.trim(), v];
    })
  );
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  // tidsfönster
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > toleranceSec) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );

  const signedPayload = `${ts}.${rawPayload}`;
  const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const hex = [...new Uint8Array(sigBytes)].map(b => b.toString(16).padStart(2,"0")).join("");

  // timing-safe jämförelse
  if (hex.length !== v1.length) return false;
  let ok = 0;
  for (let i = 0; i < hex.length; i++) ok |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return ok === 0;
}

async function handleStripeWebhook(req, env) {
  // 1) Läs rå payload (måste vara text) och verifiera signatur
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  const reqId = req.headers.get("cf-ray") || crypto.randomUUID();

  try {
    const valid = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      return new Response(JSON.stringify({ ok:false, error:"Invalid signature", reqId }), {
        status: 400, headers: { ...CORS, "content-type":"application/json" }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error:"Signature check failed", detail:String(e?.message||e), reqId }), {
      status: 400, headers: { ...CORS, "content-type":"application/json" }
    });
  }

  // 2) Parsning
  let event;
  try { event = JSON.parse(raw); }
  catch {
    return new Response(JSON.stringify({ ok:false, error:"Bad JSON", reqId }), {
      status: 400, headers: { ...CORS, "content-type":"application/json" }
    });
  }

  // 3) Idempotens: undvik dubbelbearbetning av samma event
  const evtId = event?.id || "";
  if (!evtId) {
    return new Response(JSON.stringify({ ok:false, error:"Missing event id", reqId }), {
      status: 400, headers: { ...CORS, "content-type":"application/json" }
    });
  }
  const idemKey = `stripe_evt:${evtId}`;
  const already = await env.ORDERS.get(idemKey);
  if (already) {
    return new Response(JSON.stringify({ ok:true, dedup:true, reqId }), {
      status: 200, headers: { ...CORS, "content-type":"application/json" }
    });
  }
  await env.ORDERS.put(idemKey, "1", { expirationTtl: 3600 });

  // 4) Händelsehantering
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        const orderId = session?.metadata?.order_id || session?.id;
        if (!orderId) throw new Error("No order_id on session");

        // ✅ Endast markera betald + spara basinfo
        const exist = await kvGetOrder(env, orderId);
        const patch = {
          status: "paid",
          paid_at: Date.now(),
          stripe_session_id: session?.id,
          amount_total: session?.amount_total ?? null,
          currency: session?.currency ?? null,
          email: session?.customer_details?.email ?? exist?.customer_email ?? null,
          kind: (session?.metadata?.kind || exist?.kind || null),
        };
        if (exist) {
          await kvUpdateStatus(env, orderId, "paid", patch);
        } else {
          await kvPutOrder(env, { id: orderId, created_at: Date.now(), updated_at: Date.now(), ...patch });
        }

        // ❌ INTE: bygga PDF eller skapa Gelato här
        // Success-sidan ansvarar nu för:
        // 1) /api/pdf/build-and-attach (om filer saknas)
        // 2) /api/gelato/create (med användarens fraktval)
        break;
      }

      default:
        // tyst logik – men svara 200 så Stripe inte spammar
        break;
    }

    return new Response(JSON.stringify({ ok:true, type:event.type, reqId }), {
      status: 200, headers: { ...CORS, "content-type":"application/json" }
    });
  } catch (e) {
    // Viktigt: returnera 200 vid icke-kritiska fel så Stripe inte loopar.
    return new Response(JSON.stringify({
      ok:false, error:"Webhook handler error", detail:String(e?.message || e), type:event?.type, reqId
    }), {
      status: 200, headers: { ...CORS, "content-type":"application/json" }
    });
  }
}



// ---------- R2 helpers (PDF) ----------
async function r2PutPublic(env, key, bytes, contentType = "application/pdf") {
  if (!env.PDF_BUCKET) throw new Error("PDF_BUCKET not bound");
  if (!env.PDF_PUBLIC_BASE) throw new Error("PDF_PUBLIC_BASE missing");

  await env.PDF_BUCKET.put(key, bytes, {
    httpMetadata: { contentType }
  });

  // Ta bort ev. avslutande slash och felaktigt "/pdf-bucket" i env
  const base0 = String(env.PDF_PUBLIC_BASE).replace(/\/+$/, "");
  const base  = base0.replace(/\/pdf-bucket$/i, "");

  return `${base}/${encodeURIComponent(key)}`;
}


// ---------- PDF split helpers ----------
async function buildFinalInteriorPdf(env, story, images) {
  // Bygg "full" PDF först med din befintliga motor (print-läge och bleed om du vill)
  const fullBytes = await buildPdf({ story, images, mode: "print" }, env, null);
  const src = await PDFDocument.load(fullBytes);
  const out = await PDFDocument.create();

  const total = src.getPageCount();
  // Din nuvarande buildPdf-order:
  // 0: front cover
  // 1: title page
  // 2..(2+28-1): 14× (bild vänster + text höger) => 28 sidor
  // 30: "slut"-sida
  // 31: back cover
  // => interior = sidor 1..(total-2) (dvs ALLT utom första (omslag) och sista (baksida))
  const first = 1;
  const last = total - 2;
  if (last <= first) throw new Error("PDF structure unexpected for interior split");

  const pages = await out.copyPages(src, Array.from({ length: last - first + 1 }, (_, i) => i + first));
  pages.forEach(p => out.addPage(p));
  return await out.save();
}

async function buildFinalCoverPdf(env, story, images) {
  const productUid = env.GELATO_PRODUCT_UID;
  // Inkludera alla inlagesidor + ev. titelsida + slutsida + (front/back) om din inlaga räknas så.
  // Gelato kräver "all pages in the product, including front and back cover".
  // Du har: 14 bildsidor + titelsida + slutsida = 16 inner + 2 cover = 18 totalt.
  // Justera om din struktur avviker.
  const innerCount = (story?.book?.pages?.length || 0) + 2; // + titelsida + slutsida
  const pageCount = innerCount + 2; // + front/back cover

  if (productUid && pageCount > 0) {
    try {
      const dims = await gelatoGetCoverDimensions(env, productUid, pageCount);
      // Om wrap-dimensioner finns enligt Gelato – kör wrap
      if (dims?.wraparoundInsideSize && dims?.contentFrontSize && dims?.contentBackSize) {
        return await buildWrapCoverPdfFromDims(env, story, images, dims);
      }
    } catch {
      // fall back nedan
    }
  }

  // Fallback: enkel framsida från din befintliga full-PDF
  const fullBytes = await buildPdf({ story, images, mode: "print" }, env, null);
  const src = await PDFDocument.load(fullBytes);
  const out = await PDFDocument.create();
  const [cover] = await out.copyPages(src, [0]);
  out.addPage(cover);
  return await out.save();
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
function isContextTooLong(errText = "") {
  const s = String(errText || "").toLowerCase();
  return s.includes("context") || s.includes("too long") || s.includes("exceeded") || s.includes("413");
}

function reducePrompt(p, keepLines = 8) {
  if (!p || typeof p !== "string") return p;
  const lines = p.split(/\r?\n/).filter(Boolean);
  return lines.slice(0, keepLines).join("\n");
}

async function geminiImage(env, item, timeoutMs = 75000, attempts = 3) {
  const key = env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY missing");
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=" +
    encodeURIComponent(key);

  // Build the "full" parts once
  const baseParts = [];
  if (item.character_ref_b64)
    baseParts.push({ inlineData: { mimeType: "image/png", data: item.character_ref_b64 } });

  if (item.prev_b64)
    baseParts.push({ inlineData: { mimeType: "image/png", data: item.prev_b64 } });

  if (Array.isArray(item.style_refs_b64)) {
    for (const b64 of item.style_refs_b64.slice(0, 3)) {
      if (typeof b64 === "string" && b64.length > 64)
        baseParts.push({ inlineData: { mimeType: "image/png", data: b64 } });
    }
  }

  if (item.guidance) baseParts.push({ text: item.guidance });
  if (item.coherence_code) baseParts.push({ text: `COHERENCE_CODE:${item.coherence_code}` });
  baseParts.push({ text: item.prompt });

  let last;

  // Progressive backoffs per attempt (only triggered if 500/context issue)
  function partsForStage(stage) {
    // stage 0: full
    if (stage === 0) return baseParts;

    // stage 1: drop style refs + shorten prompt
    if (stage === 1) {
      const parts = [];
      for (const p of baseParts) {
        if (p.inlineData && p.inlineData.data === item.prev_b64) parts.push(p); // keep prev
        else if (p.inlineData && p.inlineData.data === item.character_ref_b64) parts.push(p); // keep char ref
        else if (p.text?.startsWith("COHERENCE_CODE:")) parts.push(p); // keep code
        else if (typeof p.text === "string" && p.text === item.guidance) continue; // drop guidance
        else if (typeof p.text === "string" && p.text === item.prompt)
          parts.push({ text: reducePrompt(item.prompt, 8) }); // shorter prompt
        // style_refs_b64 are implicitly dropped by not copying them
      }
      return parts;
    }

    // stage 2: drop prev_b64 (last resort) + keep very short prompt
    if (stage === 2) {
      const parts = [];
      if (item.character_ref_b64)
        parts.push({ inlineData: { mimeType: "image/png", data: item.character_ref_b64 } });
      if (item.coherence_code) parts.push({ text: `COHERENCE_CODE:${item.coherence_code}` });
      parts.push({
        text: reducePrompt(
          (item.minPrompt /* optional hook */) ||
          `Same hero as reference. Same outfit and hair. Next frame of same movie. ${item.prompt || ""}`,
          6
        )
      });
      return parts;
    }

    // stage 3: minimal text only (very rare)
    return [
      { text: reducePrompt(`Same hero as reference. Keep outfit/hair identical. Next frame, not a copy.\n${item.prompt || ""}`, 5) }
    ];
  }

  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort("timeout"), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: partsForStage(i) }],
          generationConfig: { responseModalities: ["IMAGE"], temperature: 0.4, topP: 0.7 },
        }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        // Only escalate stage if it's a context/500-ish error; otherwise fail fast.
        if ((r.status === 500 || r.status === 413) || isContextTooLong(txt)) {
          last = new Error(`Gemini ${r.status} ${txt}`);
          continue; // try next stage
        }
        throw new Error(`Gemini ${r.status} ${txt}`);
      }

      const j = await r.json();
      const got = findGeminiImagePart(j);
      if (got?.b64 && got?.mime)
        return { image_url: `data:${got.mime};base64,${got.b64}`, provider: "google", b64: got.b64 };
      if (got?.url) return { image_url: got.url, provider: "google" };
      throw new Error("No image in response");
    } catch (e) {
      clearTimeout(t);
      last = e;
      // If it wasn't a context-ish error, or we’re at the last attempt, wait a bit then continue/throw
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
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
        
      ].join(" ");
        
  }
}

const OUTLINE_SYS = `
Skriv en engagerande, fantasifull disposition ("outline") för en bilderbok om hjälten som användaren beskriver.

Returnera exakt:
{
  "outline": {
    "logline": string,
    "theme": string,
    "reading_age": number,
    "tone": string,
    "motif": string,
    "chapters": [
      {"title": string, "summary": string}
    ]
  }
}

Regler:
- Hjälten är den typ användaren anger (barn eller husdjur).
- Historien ska ha tydlig början, mitt och slut – men du får välja struktur fritt.
- Skapa naturliga vändpunkter och känslomässiga ögonblick.
- Låt lärdomen framträda i handlingen, inte i texten.
- Endast giltig JSON.
`;

const STORY_SYS = `
Du är en svensk barnboksförfattare som får en outline för en svensk bildbok. Skriv en intressant, engagerande och fin bok enligt:
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
 "pages":[{
   "page": number,
   "text": string,            // SV: 2–4 meningar
   "scene": string,           // SV: kort visuell händelse (MILJÖ + ACTION)
   "scene_en": string,        // EN: idiomatisk, 2–3 meningar, rik visuell instruktion
   "location": string,        // t.ex. "gata", "sovrum", "park", "kök"
   "time_of_day": "day"|"golden_hour"|"evening"|"night",
   "weather":"clear"|"cloudy"|"rain"|"snow"
 }]
}}
HÅRDA FORMATREGLER:
- EXAKT 14 sidor (page 1..14).
- 3–4 meningar per sida i "text" (svenska).
- "scene_en" ska vara kort, filmisk, levande och konkret (inte dialog).
- Varje sida måste vara visuellt distinkt.
- Varje sida måste vara en naturlig progression i story - undvik delmål, barriärer och att stanna för länge i samma scen. 

- Endast giltig JSON i exakt format ovan.
`;



function heroDescriptor({ category, name, age, traits }) {
  if ((category || "kids") === "pets")
    return `HJÄLTE: ett husdjur vid namn ${name || "Nova"}; egenskaper: ${traits || "nyfiken, lekfull"}.`;
  const a = parseInt(age || 6, 10);
  return `HJÄLTE: ett barn vid namn ${name || "Nova"} (${a} år), egenskaper: ${traits || "modig, omtänksam"}.`;
}

async function getCameraHints(env, story) {
  const pages = Array.isArray(story?.book?.pages) ? story.book.pages : [];
  if (!pages.length) return { shots: [] };

  const prompt = `
Du får en lista av sidors scener i en svensk bilderbok. Föreslå en kamera-/bildhint per sida
som hjälper en bild-AI variera kompositionen utan att byta stil/identitet.

Tillåtna hints (välj 1 per sida): "wide", "medium", "close-up", "low-angle", "high-angle", "over-the-shoulder".

Returnera EXAKT:
{ "shots": [ { "page": number, "shot": string } ] }

SCENER (sv + ev. eng):
${JSON.stringify(pages.map(p => ({
  page: p.page,
  scene: p.scene || "",
  scene_en: p.scene_en || "",
  location: p.location || "",
  time_of_day: p.time_of_day || "",
  weather: p.weather || ""
})))}
`.trim();

  // Svarar som JSON (vi har redan openaiJSON helper)
  try {
    const j = await openaiJSON(env,
      "Du är en filmspråkscoach. Returnera ENDAST giltig JSON i exakt efterfrågat format.",
      prompt
    );
    const shots = Array.isArray(j?.shots) ? j.shots : [];
    // Liten sanering
    const allowed = new Set(["wide","medium","close-up","low-angle","high-angle","over-the-shoulder"]);
    return { shots: shots.filter(x => Number.isFinite(x?.page) && allowed.has(String(x?.shot || "").toLowerCase())) };
  } catch {
    return { shots: [] };
  }
}

function normalizePlan(pages, shotsHints = []) {
  const out = [];
  const fallbackOrder = ["EW", "M", "CU", "W"]; // om inga hints
  const hintByPage = new Map(shotsHints.map(s => [s.page, String(s.shot).toLowerCase()]));

  function mapHintToFrame(hint) {
    switch (hint) {
      case "wide":                return { shot_type: "W",  lens_mm: 35, subject_size_percent: 35, camera_hint: "wide" };
      case "medium":              return { shot_type: "M",  lens_mm: 50, subject_size_percent: 60, camera_hint: "medium" };
      case "close-up":            return { shot_type: "CU", lens_mm: 85, subject_size_percent: 80, camera_hint: "close-up" };
      case "low-angle":           return { shot_type: "M",  lens_mm: 40, subject_size_percent: 60, camera_hint: "low-angle" };
      case "high-angle":          return { shot_type: "M",  lens_mm: 40, subject_size_percent: 60, camera_hint: "high-angle" };
      case "over-the-shoulder":   return { shot_type: "M",  lens_mm: 50, subject_size_percent: 55, camera_hint: "over-the-shoulder" };
      default:                    return null;
    }
  }

  pages.forEach((p, i) => {
    const hint = hintByPage.get(p.page);
    const mapped = hint ? mapHintToFrame(hint) : null;
    if (mapped) {
      out.push({ page: p.page, ...mapped });
    } else {
      const t = fallbackOrder[i % fallbackOrder.length];
      const lens = { EW: 28, W: 35, M: 50, CU: 85 }[t] || 35;
      const size = { EW: 30, W: 45, M: 60, CU: 80 }[t] || 60;
      out.push({ page: p.page, shot_type: t, lens_mm: lens, subject_size_percent: size });
    }
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
  ? `a ${base} dress with subtle ${accent} accents (keep the same outfit and base color on every page; do not redesign or recolor it)`
  : `a ${base} sweater and ${accent} pants (keep the same outfit and base color on every page; do not redesign or recolor them)`;

}


function buildFramePrompt({ style, story, page, pageCount, frame, characterName, wardrobe_signature, coherence_code }) {
  const sGuard = styleGuard(style);
  const isPet  = (story?.book?.category || "kids").toLowerCase() === "pets";
  const coh    = coherence_code || makeCoherenceCode(story);
  const age    = story?.book?.bible?.main_character?.age || 5;

  const wardrobeLine = !isPet && wardrobe_signature
    ? `Wardrobe: ${wardrobe_signature}. The hero always wears the same outfit and colors. Do NOT change garment type, color family, or pattern.`
    : "";

  const identityLines = [
    `Use the same hero as in the reference (${characterName}).`,
    `Age ≈ ${age}. Depict clear *child* anatomy.`,
    `Never depict the hero as a teen or adult. No makeup. Keep same hairstyle, color and length.`,
    `Hero must appear visibly in frame unless the SCENE_EN explicitly excludes them.`
  ].join(" ");

  const consistency = [
    `This is page ${page.page} of ${pageCount} in the same continuous story.`,
    `Keep STYLE and lighting consistent.`,
    `Maintain identical identity and outfit.`,
    `Do not reuse the same camera height/angle and composition as the previous page.`,
  ].join(" ");

  const cinematicContext = [
    `Each image is a *film frame* from the same movie.`,
    `Depict the *next moment* of the previous scene.`,
    `Background and lighting should evolve naturally with the story.`,
    `NEVER make an identical image, NEVER use the same exact angle.`
  ].join(" ");

  const salt = "UNIQUE_PAGE:" + page.page + "-" + ((crypto?.randomUUID?.() || Date.now()).toString().slice(-8));

  return [
    sGuard,
    identityLines,
    wardrobeLine,
    consistency,
    cinematicContext,
    `COHERENCE_CODE:${coh}`,
    `Format: square (1:1).`,
    page.time_of_day ? `Time of day: ${page.time_of_day}.` : "",
    page.weather ? `Weather: ${page.weather}.` : "",
    page.scene_en ? `SCENE_EN: ${page.scene_en}` : "",
    salt
  ].filter(Boolean).join("\n");
}





function buildCoverPrompt({ style, story, characterName, wardrobe_signature, coherence_code }) {
  const sGuard      = styleGuard(style);
  const theme       = story?.book?.theme || "";
  const coh         = coherence_code || makeCoherenceCode(story);
  const hero        = story?.book?.bible?.main_character || {};
  const age         = hero?.age || 5;
  const firstScene  = story?.book?.pages?.[0]?.scene_en || "";
  const category    = story?.book?.category || "kids";

  const hairMatch = (hero?.physique || "").match(/\b(blond|blonde|brown|black|dark|light|red|ginger)\b/i);
  const hairCue   = hairMatch ? ` Hair color: ${hairMatch[0].toLowerCase()}.` : "";

  // --- 🧒 Barnbok (default) ---
  if (category !== "pets") {
    return [
      sGuard,
      "BOOK COVER — Create a cinematic front cover that MATCHES the interior style and identity 1:1.",
      `Always include the main hero (${characterName}). Follow the reference EXACTLY: same face structure, hairstyle, hair length, and child proportions, age ≈ ${age}.${hairCue}`,
      "Do NOT change hair color/length. Do NOT age the hero into a teen/adult. No makeup.",
      wardrobe_signature
        ? `WARDROBE: ${wardrobe_signature}. Keep the identical outfit and base color; do not redesign or recolor.`
        : "Keep outfit/identity identical to the reference; do not redesign or recolor.",
      "Square (1:1). No text or logos.",
      firstScene ? `Background/environment should resemble: ${firstScene} (opening wide shot variant).` : "",
      "Imagine this as the opening shot of the same animated movie as the interior pages (same lighting/tone/palette).",
      `COHERENCE_CODE:${coh}`
    ].filter(Boolean).join("\n");
  }

  // --- 🐾 Husdjur ---
  return [
    sGuard,
    "BOOK COVER — Create a cinematic, cozy front cover that MATCHES the interior style and world 1:1.",
    `The protagonist is a pet (animal) named ${characterName}. Focus clearly on the animal; it should be the central figure of the scene.`,
    "Do NOT include human children or adults unless specifically part of the story.",
    "Keep the animal identical to the interior reference: same breed, fur color, proportions, and expression.",
    wardrobe_signature
      ? `WARDROBE / ACCESSORY (if applicable): ${wardrobe_signature}. Keep consistent with interiors.`
      : "",
    "Square (1:1). No text or logos.",
    firstScene ? `Environment hint: ${firstScene}` : "",
    "Mood: warm, soft light, heartwarming, inviting composition suitable for a storybook about animals.",
    `COHERENCE_CODE:${coh}`
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
  } catch (e) {
    tr(trace, "cover:error", { error: String(e?.message || e) });
    const p = pdfDoc.addPage([pageW, pageH]);
    p.drawText("Omslag kunde inte renderas.", { x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8,0.1,0.1) });
  }

  /* -------- TITELSIDA (efter omslag) -------- */
try {
  const titlePage = pdfDoc.addPage([pageW, pageH]);
  titlePage.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: rgb(0.98, 0.99, 1) });
  const cx = contentX + trimWpt / 2;
  const cy = contentY + trimHpt / 2 + mmToPt(4);

  const mainTitle = String(story?.book?.title || "Min Sagobok");
  const subLine = String(story?.book?.bible?.main_character?.name ? `av ${story.book.bible.main_character.name}` : "Skapad med BokPiloten");

  const mainSize = Math.min(trimWpt, trimHpt) * 0.08;
  const subSize  = mainSize * 0.45;

  // Titel
  const titleW = nunitoSemi.widthOfTextAtSize(mainTitle, mainSize);
  titlePage.drawText(mainTitle, {
    x: cx - titleW / 2,
    y: cy + mainSize * 0.4,
    size: mainSize,
    font: nunitoSemi,
    color: rgb(0.15, 0.15, 0.25)
  });

  // Underrad
  const subW = nunito.widthOfTextAtSize(subLine, subSize);
  const subY = cy - subSize * 1.4;
  titlePage.drawText(subLine, {
    x: cx - subW / 2,
    y: subY,
    size: subSize,
    font: nunito,
    color: rgb(0.35, 0.35, 0.45)
  });

  // 💜 HJÄRTA (matchar slut-sidan)
  const gap       = mmToPt(6);
  const heartSize = mmToPt(14);
  const heartY    = subY - heartSize - gap;
  drawHeart(titlePage, cx, heartY, heartSize, rgb(0.50, 0.36, 0.82));
} catch (e) {
  tr(trace, "titlepage:error", { error: String(e?.message || e) });
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

    // Vine dekor
    drawVineSafe(right, cx, contentY + trimHpt * 0.34, trimWpt * 0.80, rgb(0.25,0.32,0.55), 2.4);
  }

  /* -------- SLUT -------- */
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
  }

  /* -------- BACK COVER -------- */
  try {
    const page = pdfDoc.addPage([pageW, pageH]);
    const bg = rgb(0.58, 0.54, 0.86);
    page.drawRectangle({ x: contentX, y: contentY, width: trimWpt, height: trimHpt, color: bg });
    const centerX = contentX + trimWpt / 2;
    const centerY = contentY + trimHpt / 2;
    drawWrappedCenterColor(page, blurb, centerX, centerY, trimWpt * 0.72, trimHpt * 0.36, nunito, 14, 1.42, 12, rgb(1,1,1), "center");
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

async function handleBuildAndAttach(req, env) {
  try {
    const b = await req.json().catch(()=> ({}));
    const order_id = b?.order_id;
    if (!order_id) return err("Missing order_id", 400);

    // Hämta order, plocka draft som fallback
    const ord = await kvGetOrder(env, order_id);
    if (!ord) return err("Order not found", 404);

    const story  = b?.story  || ord?.draft?.story;
    const images = b?.images || ord?.draft?.images || [];
    if (!story?.book?.pages) return err("Missing story (neither body nor draft had it)", 400);

    // Bygg PDFs
    const interiorBytes = await buildFinalInteriorPdf(env, story, images);
    const coverBytes    = await buildFinalCoverPdf(env, story, images);
    const ts = Date.now();

    // Säker filnamnsbas (UNICODE-safe)
    const safeTitle = String(story?.book?.title || "bok")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}-]+/gu, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^_|_$/g, "");

    // Ladda upp till R2 (kräver att PDF_BUCKET + PDF_PUBLIC_BASE är satta)
    const interior_key = `${safeTitle}_${ts}_INTERIOR.pdf`;
    const cover_key    = `${safeTitle}_${ts}_COVER.pdf`;

    const interior_url = await r2PutPublic(env, interior_key, interiorBytes, "application/pdf");
    const cover_url    = await r2PutPublic(env, cover_key, coverBytes, "application/pdf");

    // Spara på ordern
    const updated = await kvAttachFiles(env, order_id, {
      interior_url, interior_key,
      cover_url,    cover_key,
    });

    return ok({
      order_id,
      files: {
        interior_url, interior_key,
        cover_url,    cover_key,
      },
      order: { id: updated.id, status: updated.status, files: updated.files },
    });
  } catch (e) {
    return err(e?.message || "build-and-attach failed", 500);
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

// === PRINTED CHECKOUT (Stripe) ===
async function handleCheckoutPrinted(req, env) {
  try {
    if (!env.ORDERS) return err("ORDERS KV not bound", 500, { where: "handleCheckoutPrinted" });
    if (!env.STRIPE_SECRET_KEY) return err("STRIPE_SECRET_KEY missing", 500, { where: "handleCheckoutPrinted" });

  const { price_id, customer_email, draft, order_id } = await req.json().catch(()=> ({}));

// ✅ Säkerställ att PRINTED använder rätt pris
const PRICE = price_id || env.STRIPE_PRICE_PRINTED;
if (!PRICE) {
  return err(
    "Missing printed price: pass `price_id` in body OR configure STRIPE_PRICE_PRINTED in ENV",
    400,
    { where: "handleCheckoutPrinted" }
  );
}


    // 1) Säkerställ order i KV
    let oid = order_id;
    if (oid) {
      const ex = await kvGetOrder(env, oid);
      if (!ex) {
        const o = newOrder(draft);
        o.id = oid;
        o.kind = "printed";
        await kvPutOrder(env, o);
      }
    } else {
      const o = newOrder(draft);
      o.kind = "printed";
      await kvPutOrder(env, o);
      oid = o.id;
    }

    // 2) Stripe checkout (metadata viktig!)
    const FRONTEND_ORIGIN = env.FRONTEND_ORIGIN || "https://example.com";
    const success = (env.SUCCESS_URL || `${FRONTEND_ORIGIN}/success.html`) + `?session_id={CHECKOUT_SESSION_ID}`;
    const cancel  = env.CANCEL_URL  || `${FRONTEND_ORIGIN}/`;

    const base = {
      mode: "payment",
      "line_items[0][price]": PRICE,
      "line_items[0][quantity]": 1,
      success_url: success,
      cancel_url: cancel,
      allow_promotion_codes: "true",
      // viktigt för att veta vad detta är i webhook + success
      "metadata[order_id]": oid,
      "metadata[kind]": "printed",
    };
    if (customer_email) base.customer_email = customer_email;

    const body = formEncode(base);

    let session;
    try {
      session = await stripe(env, "checkout/sessions", { body });
    } catch (e) {
      return err(e?.message || "Stripe checkout failed", 500, {
        where: "stripe.checkout.sessions (printed)",
      });
    }

    await kvUpdateStatus(env, oid, "pending", { stripe_session_id: session.id, kind: "printed", customer_email: customer_email || null });
    await kvMapSessionToOrder(env, session.id, oid);

    return ok({ url: session.url, id: session.id, order_id: oid });
  } catch (e) {
    return err(e?.message || "checkout printed failed", 500, { where: "handleCheckoutPrinted" });
  }
}

/* ====================== ORDERS (KV) ====================== */
async function handleOrdersDraft(req, env) {
  try {
    const body = await req.json().catch(() => ({}));
    const order = newOrder(body?.draft);
    await kvPutOrder(env, order);
    return ok({ order_id: order.id });
  } catch (e) { return err(e?.message || "order draft failed", 500); }
}
async function handleOrdersStatus(req, env) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const data = await kvGetOrder(env, id);
  if (!data) return err("Not found", 404);
  return ok(data);
}

/* ====================== CHECKOUT (Stripe) ====================== */
async function handleCheckoutPing(_req, env) {
  return ok({
    has_secret: !!env.STRIPE_SECRET_KEY,
    frontend_origin: env.FRONTEND_ORIGIN,
    success_url: env.SUCCESS_URL,
    cancel_url: env.CANCEL_URL,
  });
}
async function handleCheckoutPriceLookup(req, env) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return err("Missing id", 400, { where: "stripe.prices.get" });
    const p = await stripe(env, `prices/${encodeURIComponent(id)}`, { method: "GET" });
    return ok({
      id: p.id,
      currency: p.currency,
      active: p.active,
      product: typeof p.product === "string" ? p.product : p.product?.id,
      unit_amount: p.unit_amount,
    });
  } catch (e) { return err(e?.message || "price lookup failed", 500, { where: "stripe.prices.get" }); }
}
async function handleCheckoutPdf(req, env) {
  try {
    if (!env.ORDERS) return err("ORDERS KV not bound", 500, { where: "handleCheckoutPdf" });
    if (!env.STRIPE_SECRET_KEY) return err("STRIPE_SECRET_KEY missing", 500, { where: "handleCheckoutPdf" });

    const { price_id, customer_email, order_id, draft } = await req.json().catch(()=> ({}));
    if (!price_id) return err("Missing price_id", 400, { where: "handleCheckoutPdf" });

    let oid = order_id;
    if (oid) {
      const ex = await kvGetOrder(env, oid);
      if (!ex) { const o = newOrder(draft); o.id = oid; await kvPutOrder(env, o); }
    } else {
      const o = newOrder(draft); await kvPutOrder(env, o); oid = o.id;
    }

    const FRONTEND_ORIGIN = env.FRONTEND_ORIGIN || "https://example.com";
    const success = (env.SUCCESS_URL || `${FRONTEND_ORIGIN}/success.html`) + `?session_id={CHECKOUT_SESSION_ID}`;
    const cancel  = env.CANCEL_URL  || `${FRONTEND_ORIGIN}/`;

    const base = {
      mode: "payment",
      "line_items[0][price]": price_id,
      "line_items[0][quantity]": 1,
      success_url: success,
      cancel_url: cancel,
      allow_promotion_codes: "true",
      "metadata[order_id]": oid,
      "metadata[kind]": "pdf",
    };
    if (customer_email) base.customer_email = customer_email;

    const session = await stripe(env, "checkout/sessions", { body: formEncode(base) });
    await kvUpdateStatus(env, oid, "pending", { stripe_session_id: session.id });
    await kvMapSessionToOrder(env, session.id, oid);

    return ok({ url: session.url, id: session.id, order_id: oid });
  } catch (e) {
    return err(e?.message || "checkout create failed", 500, { where: "handleCheckoutPdf" });
  }
}
async function handleCheckoutVerify(req, env) {
  const url = new URL(req.url);
  const sid = url.searchParams.get("session_id");
  if (!sid) return err("Missing session_id", 400);
  const session = await stripe(env, `checkout/sessions/${encodeURIComponent(sid)}`, { method: "GET" });
  const paid = session.payment_status === "paid";
  const order_id = session.metadata?.order_id || null;
  return ok({ paid, order_id, amount_total: session.amount_total, currency: session.currency });
}
async function handleCheckoutOrderId(req, env) {
  try {
    const sid = new URL(req.url).searchParams.get("session_id");
    if (!sid) return err("Missing session_id", 400);
    const kvOid = await kvGetOrderFromSession(env, sid);
    if (kvOid) return ok({ order_id: kvOid, source: "kv" });
    const session = await stripe(env, `checkout/sessions/${encodeURIComponent(sid)}`, { method: "GET" });
    const order_id = session.metadata?.order_id || null;
    return ok({ order_id, source: "stripe" });
  } catch (e) { return err(e?.message || "order-id lookup failed", 500); }
}

/* ====================== STORY & IMAGES ====================== */
// Dessa använder dina befintliga helpers: openaiJSON, OUTLINE_SYS, STORY_SYS,
// heroDescriptor, getCameraHints, normalizePlan, makeCoherenceCode, deriveWardrobeSignature,
// characterCardPrompt, geminiImage, buildFramePrompt, styleHint, shotLine.
async function handleStory(req, env) {
  try {
    const body = await req.json().catch(() => ({}));
    const { name, age, pages, category, style, theme, traits, reading_age } = body || {};
    const targetAge = Number.isFinite(parseInt(reading_age, 10))
      ? parseInt(reading_age, 10)
      : (category || "kids") === "pets" ? 8 : parseInt(age || 6, 10);

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
Skriv en engagerande, händelserik saga som är rolig att läsa högt.
Variera miljöer och visuella ögonblick mellan varje sida.
${heroDescriptor({ category, name, age, traits })}
Läsålder: ${targetAge}. **Sidor: 14**. Stil: ${style || "cartoon"}. Kategori: ${category || "kids"}.
Returnera enbart JSON i exakt formatet.
`.trim();

    const story = await openaiJSON(env, STORY_SYS, storyUser);

    // Fallback översättning till scene_en om saknas
    try {
      const pages = Array.isArray(story?.book?.pages) ? story.book.pages : [];
      const needs = pages.some(p => !p.scene_en || !String(p.scene_en).trim());
      if (needs && pages.length) {
        const toTranslate = pages.map(p => ({ page: p.page, sv: p.scene || p.text || "" }));
        const t = await openaiJSON(env,
          "Du är en saklig översättare. Returnera endast giltig JSON.",
          `Översätt följande scenangivelser till kort engelsk, visuell beskrivning (1–2 meningar, inga repliker).
Returnera exakt: { "items":[{"page":number,"scene_en":string}, ...] } och inget mer.
SVENSKA:
${JSON.stringify(toTranslate)}`
        );
        const map = new Map((t?.items || []).map(x => [x.page, x.scene_en]));
        story.book.pages = pages.map(p => ({ ...p, scene_en: p.scene_en || map.get(p.page) || "" }));
      }
    } catch {}

    const camHints = await getCameraHints(env, story);
    const plan = normalizePlan(story?.book?.pages || [], camHints.shots);
    const coherence_code = makeCoherenceCode(story);
    const wardrobe_signature = deriveWardrobeSignature(story);

    return ok({ outline, story, plan, coherence_code, wardrobe_signature });
  } catch (e) { return err(e?.message || "Story generation failed", 500); }

  function characterCardPrompt({ style = "cartoon", bible = {}, traits = "" }) {
  const m = bible?.main_character || {};
  const name = m.name || "Hero";
  const age = m.age || 6;
  const physique = m.physique || "child with friendly face";
  const wardrobe = Array.isArray(bible?.wardrobe) && bible.wardrobe.length
    ? bible.wardrobe.join(", ")
    : "";
  const palette = Array.isArray(bible?.palette) && bible.palette.length
    ? bible.palette.join(", ")
    : "";

  const guard = styleGuard(style);
  return [
    guard,
    `Create a single character reference card for a ${age} y/o child named ${name}.`,
    `Physique/identity cues: ${physique}.`,
    wardrobe ? `Wardrobe hint: ${wardrobe}.` : "",
    palette ? `Color palette hint: ${palette}.` : "",
    traits ? `Personality: ${traits}.` : "",
    "Square composition (1:1). Neutral, evenly lit. No text, no logos.",
    "This reference will be used for strict identity consistency across pages."
  ].filter(Boolean).join("\n");
}

}
async function handleRefImage(req, env) {
  try {
    const { style = "cartoon", photo_b64, bible, traits = "" } = await req.json().catch(() => ({}));
    if (photo_b64) {
      const b64 = String(photo_b64).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
      if (b64.length > 64) return ok({ ref_image_b64: b64, provider: "client" });
      return err("Provided photo_b64 looked invalid", 400);
    }
    const prompt = characterCardPrompt({ style, bible, traits });
    const g = await geminiImage(env, { prompt }, 70000, 2);
    if (g?.b64) return ok({ ref_image_b64: g.b64, provider: g.provider || "google" });
    return ok({ ref_image_b64: null });
  } catch (e) { return err(e?.message || "Ref generation failed", 500); }
}
async function handleImagesBatch(req, env) {
  try {
    const { style="cartoon", ref_image_b64, story, plan, concurrency=4, pages_subset, style_refs_b64, coherence_code, guidance } =
      await req.json().catch(() => ({}));
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
        style, story, page: pg, pageCount, frame: f,
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
            ...(Array.isArray(style_refs_b64)&&style_refs_b64.length ? {style_refs_b64} : {}),
            ...(coherence_code ? {coherence_code} : {}),
            ...(guidance ? {guidance} : {}),
          };
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
  } catch (e) { return err(e?.message || "Images generation failed", 500); }
}
async function handleImagesNext(req, env) {
  // exakt din tidigare /api/images/next (se din v27/v29 kod) – här inklistrad:
  try {
    const { style="cartoon", story, plan, page, ref_image_b64, prev_b64, coherence_code, style_refs_b64 } =
      await req.json().catch(() => ({}));
    if (!story?.book?.pages) return err("Missing story.pages", 400);
    const pg = story.book.pages.find(p => p.page === page);
    if (!pg) return err(`Page ${page} not found`, 404);
    if (!ref_image_b64) return err("Missing ref_image_b64", 400);

    const frames = (plan?.plan || []);
    const frame  = frames.find(f => f.page === page) || {};
    const pageCount = story.book.pages.length;
    const heroName  = story.book.bible?.main_character?.name || "Hero";
    const sceneEN = pg.scene_en || pg.scene || pg.text || "";

    const continuation = [
      "This illustration continues directly from the previous scene.",
      "Use the previous image only as a visual guide for style, lighting, and character identity.",
      "Do not replicate it exactly — imagine this as the same story world seen from a new camera angle or moment.",
      "Keep the main character fully consistent (face, hair, hairstyle/length, outfit and its base color, proportions).",
      "Preserve the overall tone and lighting continuity inspired by the previous scene.",
      "Now illustrate this new scene based on the description below:"
    ].join(" ");

    const prompt = [
      styleGuard(style),
      `Use the exact same main character as in the reference (${heroName}). Keep hair color and length identical. Do not change age/proportions. Do not add extra limbs.`,
      deriveWardrobeSignature(story)
        ? `WARDROBE: ${deriveWardrobeSignature(story)}. Keep outfit and base color identical on every page.`
        : "",
      `This is page ${pg.page} of ${pageCount}. Keep the same global style across all pages.`,
      `COHERENCE_CODE:${coherence_code || makeCoherenceCode(story)}`,
      continuation,
      `SCENE (EN): ${sceneEN}`,
      `SHOT: ${shotLine(frame)}.`,
      "Square composition (1:1).",
      "DO NOT reuse the exact same pose/composition from the previous image."
    ].filter(Boolean).join("\n");

    const payload = {
      prompt,
      character_ref_b64: ref_image_b64,
      prev_b64,
      coherence_code: coherence_code || makeCoherenceCode(story),
      ...(Array.isArray(style_refs_b64)&&style_refs_b64.length ? {style_refs_b64} : {}),
    };
    const g = await geminiImage(env, payload, 75000, 3);
    if (!g?.image_url) return err("No image from Gemini", 502);
    return ok({ page, image_url: g.image_url, provider: g.provider || "google", prompt });
  } catch (e) { return err(e?.message || "images/next failed", 500); }
}
async function handleImageRegenerate(req, env) {
  try {
    const { story, page, character_ref_b64 } = await req.json().catch(() => ({}));
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
  } catch (e) { return err(e?.message || "Image regeneration failed"); }
}
async function handleCover(req, env) {
  try {
    const { story, style = "storybook", character_ref_b64, prev_image_b64 } = await req.json().catch(() => ({}));
    if (!story?.book) return err("Missing story", 400);
    if (!character_ref_b64) return err("Missing character_ref_b64", 400);

    const coherence_code = makeCoherenceCode(story);
    const wardrobe_signature = deriveWardrobeSignature(story);
    const effectiveStyle = style || story.book.style || "cartoon";

    const prompt = buildCoverPrompt({
      style: effectiveStyle,
      story,
      characterName: story.book.bible?.main_character?.name || "Hero",
      wardrobe_signature,
      coherence_code,
    });

    const g = await geminiImage(env, {
      prompt,
      character_ref_b64,
      prev_b64: prev_image_b64 || null,
      coherence_code,
      guidance: styleHint(effectiveStyle),
    }, 75000, 3);

    let data_url = null;
    if (g?.b64) data_url = `data:image/png;base64,${g.b64}`;
    else if (g?.image_url) data_url = g.image_url;
    else if (g?.data_url) data_url = g.data_url;
    if (!data_url) return err("Cover generation failed (no image data)", 500);

    return ok({ cover_b64: g.b64 || null, data_url, image_url: g.image_url || null, provider: g.provider || "google", prompt });
  } catch (e) { return err(e?.message || "Cover generation failed", 500); }
}

/* ====================== PDF URL-varianter ====================== */
async function handlePdfInteriorUrl(req, env) {
  try {
    const { story, images } = await req.json().catch(() => ({}));
    if (!story?.book?.pages) return err("Missing story", 400);
    const bytes = await buildFinalInteriorPdf(env, story, images || []);
    const ts = Date.now();
    const safeTitle = String(story?.book?.title || "bok").replace(/[^\wåäöÅÄÖ\-]+/g, "_");
    const key = `${safeTitle}_${ts}_INTERIOR.pdf`;
    const url = await r2PutPublic(env, key, bytes);
    return ok({ url, key });
  } catch (e) { return err(e?.message || "interior-url failed", 500); }
}
async function handlePdfCoverUrl(req, env) {
  try {
    const { story, images } = await req.json().catch(() => ({}));
    if (!story?.book?.pages) return err("Missing story", 400);
    const bytes = await buildFinalCoverPdf(env, story, images || []);
    const ts = Date.now();
    const title = story?.book?.title ?? "bok";
    const safeTitle = String(title).normalize("NFKD").replace(/[^\p{L}\p{N}-]+/gu, "_").replace(/_{2,}/g, "_").replace(/^_|_$/g, "");
    const key = `${safeTitle}_${ts}_COVER.pdf`;
    const url = await r2PutPublic(env, key, bytes);
    return ok({ url, key });
  } catch (e) { return err(e?.message || "cover-url failed", 500); }
}

/* ====================== GELATO (router-alias) ====================== */
async function handleGelatoShipmentMethods(req, env) {
  try {
    const country = new URL(req.url).searchParams.get("country") || env.GELATO_DEFAULT_COUNTRY || "SE";
    const data = await gelatoGetShipmentMethods(env, country);
    return ok(data);
  } catch (e) { return err(e?.message || "gelato shipment-methods failed", 500); }
}
async function handleGelatoPrices(req, env) {
  try {
    const productUid = env.GELATO_PRODUCT_UID;
    if (!productUid) return err("Missing GELATO_PRODUCT_UID", 400);
    const url = new URL(req.url);
    const country  = url.searchParams.get("country")  || env.GELATO_DEFAULT_COUNTRY || "SE";
    const currency = url.searchParams.get("currency") || env.GELATO_DEFAULT_CURRENCY || "SEK";
    const pageCount = url.searchParams.get("pageCount");
    const prices = await gelatoGetPrices(env, productUid, {
      country, currency, pageCount: pageCount ? Number(pageCount) : undefined,
    });
    return ok(prices);
  } catch (e) { return err(e?.message || "gelato prices failed", 500); }
}
async function handleGelatoCoverDimensions(req, env) {
  try {
    const productUid = env.GELATO_PRODUCT_UID;
    const url = new URL(req.url);
    const pageCount = Number(url.searchParams.get("pageCount"));
    const dims = await gelatoGetCoverDimensions(env, productUid, pageCount);
    return ok(dims);
  } catch (e) { return err(e?.message || "gelato cover-dimensions failed", 500); }
}
async function handleGelatoCreate(req, env) {
  try {
    const body = await req.json().catch(()=> ({}));
    const order_id = body?.order_id;
    if (!order_id) return err("Missing order_id", 400);

    const ord = await kvGetOrder(env, order_id);
    if (!ord) return err("Order not found", 404);
    if (!ord?.files?.interior_url || !ord?.files?.cover_url) {
      return err("Order is missing R2 files; run build-and-attach first", 400);
    }
    const result = await gelatoCreateOrder(env, { order: ord, shipment: body?.shipment || {}, customer: body?.customer || {} });
    return ok(result);
} catch (e) {
  return err(e?.message || "gelato create failed", 500, { where:"gelato.create" });
}

}

async function handleGelatoWebhook(req, env) {
  try {
    const evt = await req.json().catch(()=> ({}));
    const gelatoOrderId = evt?.orderId || evt?.id || evt?.data?.orderId;
    const status = evt?.status || evt?.data?.status || evt?.eventType;
    let orderId = null;
    if (gelatoOrderId) orderId = await env.ORDERS.get(`GELATO_IDX:${gelatoOrderId}`);
    if (orderId) await kvAttachFiles(env, orderId, { gelato_status: status });
    return ok({ received: true });
  } catch (e) { return err(e?.message || "webhook error", 500); }
}


export default {
  async fetch(req, env) {
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const url = new URL(req.url);

      // --- Health & Diag ---
      if (req.method === "GET" && url.pathname === "/") return ok({ ok:true, ts:Date.now() });
      if (req.method === "GET" && url.pathname === "/api/diag") return handleDiagRequest(req, env);

      // --- Orders (KV) ---
      if (req.method === "POST" && url.pathname === "/api/orders/draft")  return handleOrdersDraft(req, env);
      if (req.method === "GET"  && url.pathname === "/api/orders/status") return handleOrdersStatus(req, env);

      // --- Checkout (Stripe) ---
      if (req.method === "GET"  && url.pathname === "/api/checkout/ping")      return handleCheckoutPing(req, env);
      if (req.method === "GET"  && url.pathname === "/api/checkout/price")     return handleCheckoutPriceLookup(req, env);
      if (req.method === "POST" && url.pathname === "/api/checkout/pdf")       return handleCheckoutPdf(req, env);
      if (req.method === "POST" && url.pathname === "/api/checkout/printed")   return handleCheckoutPrinted(req, env); // ← ENDA printed
      if (req.method === "GET"  && url.pathname === "/api/checkout/verify")    return handleCheckoutVerify(req, env);
      if (req.method === "GET"  && url.pathname === "/api/checkout/order-id")  return handleCheckoutOrderId(req, env);
      if (req.method === "POST" && url.pathname === "/api/stripe/webhook")     return handleStripeWebhook(req, env);

      // --- Story & Images ---
      if (req.method === "POST" && url.pathname === "/api/story")             return handleStory(req, env);
      if (req.method === "POST" && url.pathname === "/api/ref-image")         return handleRefImage(req, env);
      if (req.method === "POST" && url.pathname === "/api/images")            return handleImagesBatch(req, env);
      if (req.method === "POST" && url.pathname === "/api/images/next")       return handleImagesNext(req, env);
      if (req.method === "POST" && url.pathname === "/api/image/regenerate")  return handleImageRegenerate(req, env);
      if (req.method === "POST" && url.pathname === "/api/cover")             return handleCover(req, env);

      // --- PDF build & storage ---
      if (req.method === "POST" && url.pathname === "/api/images/upload")       return handleUploadRequest(req, env);
      if (req.method === "POST" && url.pathname === "/api/pdf")                 return handlePdfRequest(req, env); // preview/final i en fil
      if (req.method === "POST" && url.pathname === "/api/pdf/interior-url")    return handlePdfInteriorUrl(req, env);
      if (req.method === "POST" && url.pathname === "/api/pdf/cover-url")       return handlePdfCoverUrl(req, env);
      if (req.method === "POST" && url.pathname === "/api/pdf/build-and-attach")return handleBuildAndAttach(req, env);

      // --- Gelato ---
      if (req.method === "GET"  && url.pathname === "/api/gelato/shipment-methods") return handleGelatoShipmentMethods(req, env);
      if (req.method === "GET"  && url.pathname === "/api/gelato/prices")            return handleGelatoPrices(req, env);
      if (req.method === "GET"  && url.pathname === "/api/gelato/cover-dimensions")  return handleGelatoCoverDimensions(req, env);
      if (req.method === "POST" && url.pathname === "/api/gelato/create")            return handleGelatoCreate(req, env);
      if (req.method === "POST" && url.pathname === "/api/gelato/webhook")           return handleGelatoWebhook(req, env);

      // --- 404 ---
      return new Response("Not found", { status: 404, headers: CORS });
    } catch (e) {
      return err(e?.message || "Unhandled error");
    }
  },
};
