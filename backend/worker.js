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



export const DEFAULT_BLEED_MM = 3;



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

const TRIMS = { square200: { w_mm: 200, h_mm: 200, default_bleed_mm: 3 } };
const GRID = { outer_mm: 10, gap_mm: 8, pad_mm: 12, text_min_mm: 30, text_max_mm: 58 };
const TEXT_SCALE = 0.95;
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



async function handleOrderGet(req, env) {
  const { searchParams } = new URL(req.url);
  const order_id = searchParams.get("order_id") || searchParams.get("id");
  if (!order_id) return err("Missing order_id", 400);

  const ord = await kvGetOrder(env, order_id);
  if (!ord) return err("Order not found", 404);

  return ok({ order: ord });
}



async function handlePdfCountByUrl(req) {
  const { url } = await req.json().catch(()=> ({}));
  if (!url) return err("Missing url", 400);
  const r = await fetch(url, { cf:{ cacheTtl: 300, cacheEverything:true }});
  if (!r.ok) return err(`Fetch ${r.status}`, 502);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const doc = await PDFDocument.load(bytes);
  return ok({ pages: doc.getPageCount() });
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

// Hjälpare: formatera belopp från Stripe (öre) till "49,00 SEK"
function formatAmount(amount_total, currency) {
  if (amount_total == null) return "-";
  const v = (amount_total / 100).toFixed(2).replace(".", ",");
  return `${v} ${(currency || "SEK").toUpperCase()}`;
}

// Hjälpare: bygg HTML-kvitto beroende på kind
function buildReceiptHtml({ name, kind, amountLabel, orderId, successUrl }) {
  const safeName = name || "vän";
  const kindLabel = kind === "print" ? "Tryckt bok" : "PDF-bok";

  const downloadParagraph =
    kind === "print"
      ? `
        <p>
          Vi har tagit emot din beställning av en tryckt bok.<br/>
          Du kan följa din beställning och fylla i/uppdatera leveransuppgifter via kvittosidan:
          <br/>
          <a href="${successUrl}">${successUrl}</a>
        </p>
      `
      : `
        <p>
          Vi skapar nu din digitala bok. Du kan ladda ner den direkt via kvittosidan:
          <br/>
          <a href="${successUrl}">${successUrl}</a>
        </p>
      `;

  return `
    <p>Hej ${safeName}!</p>

    <p>Tack för att du beställde en bok från Sagostugan.</p>

    <p>
      <strong>Typ av beställning:</strong> ${kindLabel}<br/>
      <strong>Belopp:</strong> ${amountLabel}<br/>
      <strong>Order-ID:</strong> ${orderId}
    </p>

    ${downloadParagraph}

    <p>Varma hälsningar,<br/>Sagostugan</p>
  `;
}

function buildReceiptEmail({ kind, amount, currency, orderId, customerName, successUrl }) {
  const niceKind = kind === "print" ? "Tryckt bok" : "PDF-bok";
  const amountStr = amount != null ? (amount / 100).toFixed(2).replace(".", ",") : "";
  const currencyStr = (currency || "SEK").toUpperCase();
  const name = customerName || "vän";

  const subject =
    kind === "print"
      ? "Tack för din bokbeställning – Sagostugan"
      : "Din digitala sagobok är på väg – Sagostugan";

  const text = [
    `Hej ${name}!`,
    "",
    `Tack för att du beställde en bok från Sagostugan.`,
    "",
    `Typ av beställning: ${niceKind}`,
    amountStr ? `Belopp: ${amountStr} ${currencyStr}` : "",
    `Order-ID: ${orderId}`,
    "",
    kind === "print"
      ? "Vi skapar nu din tryckta bok. Du kan följa din beställning via kvittosidan:"
      : "Vi skapar nu din digitala bok. Du kan ladda ner den direkt via kvittosidan:",
    successUrl,
    "",
    "Varma hälsningar,",
    "Sagostugan"
  ]
    .filter(Boolean)
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="sv">
  <head>
    <meta charset="UTF-8" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:#f7f5ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#f7f5ff;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;padding:24px 20px;box-shadow:0 8px 24px rgba(0,0,0,0.06);">
            <tr>
              <td align="center" style="padding-bottom:12px;">
                <div style="font-size:28px;font-weight:700;color:#4b3c88;">Sagostugan</div>
                <div style="font-size:13px;color:#8a7fb8;margin-top:4px;">små sagor, stora minnen</div>
              </td>
            </tr>

            <tr>
              <td style="padding:8px 4px 16px 4px;font-size:15px;color:#1e1730;line-height:1.6;">
                <p style="margin:0 0 12px 0;">Hej ${name}!</p>
                <p style="margin:0 0 12px 0;">
                  Tack för att du beställde en bok från <strong>Sagostugan</strong>.
                </p>

                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:12px 0 16px 0;background:#f6f3ff;border-radius:12px;padding:12px 14px;font-size:14px;">
                  <tr>
                    <td style="padding:4px 0;"><strong>Typ av beställning:</strong></td>
                    <td style="padding:4px 0;">${niceKind}</td>
                  </tr>
                  ${
                    amountStr
                      ? `<tr>
                    <td style="padding:4px 0;"><strong>Belopp:</strong></td>
                    <td style="padding:4px 0;">${amountStr} ${currencyStr}</td>
                  </tr>`
                      : ""
                  }
                  <tr>
                    <td style="padding:4px 0;"><strong>Order-ID:</strong></td>
                    <td style="padding:4px 0;">${orderId}</td>
                  </tr>
                </table>

                ${
                  kind === "print"
                    ? `<p style="margin:0 0 10px 0;">
                      Vi börjar nu skapa din <strong>tryckta bok</strong>. När den är klar skickar vi ett nytt mejl med uppdaterad status.
                    </p>`
                    : `<p style="margin:0 0 10px 0;">
                      Vi skapar nu din <strong>digitala bok</strong>. Du kan ladda ner den direkt via kvittosidan.
                    </p>`
                }

                <p style="margin:0 0 18px 0;">
                  <a href="${successUrl}" style="display:inline-block;padding:10px 18px;background:#4b3c88;color:#ffffff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:600;">
                    Öppna kvittosida
                  </a>
                </p>

                <p style="margin:0 0 12px 0;font-size:13px;color:#6c658a;">
                  Om knappen inte fungerar kan du kopiera och klistra in länken i din webbläsare:<br />
                  <span style="word-break:break-all;font-size:12px;color:#4b3c88;">${successUrl}</span>
                </p>

                <p style="margin:14px 0 0 0;font-size:14px;">
                  Varma hälsningar,<br/>
                  <strong>Sagostugan</strong>
                </p>
              </td>
            </tr>

            <tr>
              <td align="center" style="padding-top:10px;font-size:11px;color:#a39ac7;">
                Detta mejl skickades automatiskt. Svara gärna om du har några frågor.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}



// Hjälpare: skicka kvitto-mail via Resend
async function sendReceiptEmail(env, { email, name, kind, amount_total, currency, orderId, successUrl }) {
  if (!email) {
    console.log("sendReceiptEmail: ingen e-post, skippar.");
    return;
  }

  // Bygg subject + text + html via vår helper
  const { subject, text, html } = buildReceiptEmail({
    kind,
    amount: amount_total,
    currency,
    orderId,
    customerName: name,
    successUrl,
  });

  const from = env.EMAIL_FROM || "Sagostugan <no-reply@sagostugan.se>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: email,
        subject,
        html,
        text, // bra att skicka med plain text också
      }),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("Resend error:", res.status, t);
    }
  } catch (err) {
    console.error("sendReceiptEmail exception:", err);
  }
}


async function handleStripeWebhook(req, env) {
  // 1) Läs rå payload (måste vara text) och verifiera signatur
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  const reqId = req.headers.get("cf-ray") || crypto.randomUUID();

  try {
    const valid = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid signature", reqId }), {
        status: 400,
        headers: { ...CORS, "content-type": "application/json" }
      });
    }
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: "Signature check failed",
      detail: String(e?.message || e),
      reqId
    }), {
      status: 400,
      headers: { ...CORS, "content-type": "application/json" }
    });
  }

  // 2) Parsning
  let event;
  try { event = JSON.parse(raw); }
  catch {
    return new Response(JSON.stringify({ ok: false, error: "Bad JSON", reqId }), {
      status: 400,
      headers: { ...CORS, "content-type": "application/json" }
    });
  }

  // 3) Idempotens: undvik dubbelbearbetning av samma event
  const evtId = event?.id || "";
  if (!evtId) {
    return new Response(JSON.stringify({ ok: false, error: "Missing event id", reqId }), {
      status: 400,
      headers: { ...CORS, "content-type": "application/json" }
    });
  }
  const idemKey = `stripe_evt:${evtId}`;
  const already = await env.ORDERS.get(idemKey);
  if (already) {
    return new Response(JSON.stringify({ ok: true, dedup: true, reqId }), {
      status: 200,
      headers: { ...CORS, "content-type": "application/json" }
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

        const exist = await kvGetOrder(env, orderId);

        const email =
          session?.customer_details?.email ||
          exist?.customer_email ||
          session?.metadata?.customer_email ||
          null;

        const name =
          session?.customer_details?.name ||
          exist?.customer_name ||
          session?.metadata?.customer_name ||
          null;

        const kind =
          (session?.metadata?.kind || exist?.kind || "pdf"); // "pdf" eller "print" t.ex.

        const patch = {
          status: "paid",
          paid_at: Date.now(),
          stripe_session_id: session?.id,
          amount_total: session?.amount_total ?? exist?.amount_total ?? null,
          currency: session?.currency ?? exist?.currency ?? "SEK",
          email,
          customer_email: email, // om du använder detta fält i KV
          customer_name: name,
          kind,
        };

        if (exist) {
          await kvUpdateStatus(env, orderId, "paid", patch);
        } else {
          await kvPutOrder(env, {
            id: orderId,
            created_at: Date.now(),
            updated_at: Date.now(),
            ...patch
          });
        }

        // 🔔 Skicka kvitto-mail (PDF eller tryckt beroende på kind)
        const successUrl = `${env.SUCCESS_URL}?session_id=${encodeURIComponent(session.id)}`;

        await sendReceiptEmail(env, {
          email,
          name,
          kind,
          amount_total: patch.amount_total,
          currency: patch.currency,
          orderId,
          successUrl
        });

        break;
      }

      default:
        // Tyst loggik – men svara 200 så Stripe inte spammar
        break;
    }

    return new Response(JSON.stringify({ ok: true, type: event.type, reqId }), {
      status: 200,
      headers: { ...CORS, "content-type": "application/json" }
    });
  } catch (e) {
    // Viktigt: returnera 200 vid icke-kritiska fel så Stripe inte loopar.
    return new Response(JSON.stringify({
      ok: false,
      error: "Webhook handler error",
      detail: String(e?.message || e),
      type: event?.type,
      reqId
    }), {
      status: 200,
      headers: { ...CORS, "content-type": "application/json" }
    });
  }
}



function addBlankPages(pdfDoc, howMany, pageW, pageH) {
  for (let i = 0; i < howMany; i++) pdfDoc.addPage([pageW, pageH]);
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

// ---------- Title / pages helpers ----------
function safeTitleFrom(story) {
  const raw = String(story?.book?.title || "bok");
  // Normalisera till säkert filnamn
  return raw
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\- ]+/gu, "_")  // behåll bokstäver/siffror/streck/mellanslag
    .replace(/\s+/g, "_")                 // mellanslag -> underscore
    .replace(/_{2,}/g, "_")               // komprimera __
    .replace(/^_+|_+$/g, "")              // trimma _
    || "bok";
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
async function geminiImage(env, item, timeoutMs = 70000, attempts = 3) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const PRO_MODEL   = "gemini-3-pro-image-preview";
  const FLASH_MODEL = "gemini-2.5-flash-image";

  const baseIsFlash  = item && item.model === "flash";
  let currentModelId = baseIsFlash ? FLASH_MODEL : PRO_MODEL;

  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    // --- Bygg parts FÖR VARJE FÖRSÖK (så vi kan ändra prompten mellan attempts) ---
    const parts = [];

    if (item.prompt) parts.push({ text: item.prompt });

    if (item.image_b64) {
      const mime = item.image_mime || "image/png";
      parts.push({ inlineData: { mimeType: mime, data: item.image_b64 } });
    }

    if (Array.isArray(item.character_refs_b64)) {
      for (const ref of item.character_refs_b64) {
        parts.push({ inlineData: { mimeType: "image/png", data: ref } });
      }
    } else if (item.character_ref_b64) {
      parts.push({
        inlineData: { mimeType: "image/png", data: item.character_ref_b64 },
      });
    }

    if (item.prev_b64) {
      parts.push({ inlineData: { mimeType: "image/png", data: item.prev_b64 } });
    }

    if (Array.isArray(item.prev_images_b64)) {
      for (const b64 of item.prev_images_b64) {
        if (b64) parts.push({ inlineData: { mimeType: "image/png", data: b64 } });
      }
    }

    if (Array.isArray(item.style_refs_b64)) {
      for (const b64 of item.style_refs_b64) {
        if (b64) parts.push({ inlineData: { mimeType: "image/png", data: b64 } });
      }
    }

    if (item.coherence_code)
      parts.push({ text: `COHERENCE_CODE:${item.coherence_code}` });
    if (item.guidance) parts.push({ text: item.guidance });

    const generationConfig = {
      temperature: 0.55,
      topP: 0.7,
    };

    const body = {
      contents: [{ role: "user", parts }],
      generationConfig,
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${currentModelId}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        }
      );

      clearTimeout(t);

      const txt = await res.text();
      if (!res.ok) {
        // 429/5xx -> försök igen, ev. model switch
        if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
          throw new Error(`Gemini ${res.status}: ${txt || "retryable error"}`);
        }

        // 4xx (utom 429) -> kasta direkt
        throw new Error(`Gemini ${res.status}: ${txt}`);
      }

      let data = null;
      try {
        data = txt ? JSON.parse(txt) : null;
      } catch {
        throw new Error("Gemini: invalid JSON in response");
      }

      const part = findGeminiImagePart(data);
      if (!part) throw new Error("No image data in response");

      const b64 = part.b64 || null;
      const image_url =
        part.url || (b64 ? `data:${part.mime || "image/png"};base64,${b64}` : null);

      if (!image_url) throw new Error("No image URL or base64 from Gemini");

      return {
        b64,
        image_url,
        provider:
          currentModelId === PRO_MODEL ? "google-pro" : "google-flash",
      };
    } catch (e) {
      clearTimeout(t);
      const msg = String(e?.message || e);
      lastError = e;
      console.warn(
        `[Gemini] Attempt ${i + 1} with ${currentModelId} failed: ${msg}`
      );

      // 🔻 Om kontext/length-problem -> korta prompten inför nästa försök
      if (i < attempts - 1 && item.prompt && isContextTooLong(msg)) {
        console.warn("[Gemini] Context too long – reducing prompt and retrying");
        item.prompt = reducePrompt(item.prompt, 10);
      }

      // 🔁 Fallback: om vi inte började på Flash och vi är på Pro, byt till FLASH
      if (i < attempts - 1 && !baseIsFlash && currentModelId === PRO_MODEL) {
        console.warn(
          "[Gemini] Pro failed or timed out – switching to FLASH fallback for next attempt"
        );
        currentModelId = FLASH_MODEL;
      }

      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  throw lastError || new Error("Gemini failed");
}




/* ------------------------------ Styles ------------------------------- */
function styleHint(style = "cartoon") {
  const s = (style || "cartoon").toLowerCase();
  if (s === "storybook") return "storybook watercolor, paper texture, gentle grain, warm and cozy";
  if (s === "pixar") return "stylized 3D animated pixar film still (not photographic). Happy and expressive characters.";
  if (s === "comic") return "bold comic style, inked lines, flat colors";
  if (s === "painting") return "soft painterly illustration, visible brushwork";
  return "expressive 2D cartoon: thick-and-thin outlines, cel shading, vibrant palette, happy and expressive characters, NO 3D!";
}

function styleGuard(style = "cartoon") {
  const s = (style || "").toLowerCase();
  switch (s) {
    case "pixar":
      return [
        "STYLE: stylized 3D animated pixar film still. Happy and expressive characters.",
        "Do NOT use watercolor, inked lines, flat 2D shading, or comic outlines.",
      ].join(" ");
    case "storybook":
      return [
        "STYLE: storybook watercolor illustration, paper texture, gentle grain, warm and cozy.",
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
        "STYLE: expressive 2D cartoon with cel shading, vibrant colors, happy and expressive characters.",
        
      ].join(" ");
        
  }
}

const OUTLINE_SYS = `
Du är en barnboksförfattare, som hjälper till att skapa en disposition ("outline") för en svensk bilderbok.

Du får i user-meddelandet:
- Hjältens typ (barn eller husdjur)
- Namn, ålder (om barn), och det övergripande temat för boken.

DIN UPPGIFT:
Skapa en engagerande outline för en bilderbok.

RETURNERA EXAKT:
{
  "outline": {
    "logline": string,
    "theme": string,
    "reading_age": number,
    "tone": string,
    "motif": string,
    "category": "kids" | "pets",
    "hero": {
      "name": string,
      "kind": "child" | "pet",
      "species": string | null,        // t.ex. "cat", "dog" eller null för barn
      "age": number | null
    },
    "chapters": [
      {
        "title": string,
        "summary": string
      }
    ]
  }
}

REGLER:
- "category" ska matcha den kategori du får i prompten ("kids" eller "pets").
- Om category = "kids":
  - hero.kind = "child"
  - hero.species = null
  - hero.age = barnets ungefärliga ålder (t.ex. 5, 6, 7).
- Om category = "pets":
  - hero.kind = "pet"
  - hero.species = ett enkelt engelskt ord, t.ex. "cat", "dog", "rabbit".
  - hero.age kan vara null eller uppskattad (om det passar).
- Storyn ska vara engagerande, händelserik och utgå ifrån det önskade temat.
- Dispositionen ska gå att utveckla till ca 16 sidor i en bilderbok.
- Endast giltig JSON, inga kommentarer eller extra text.
`;

const STORY_SYS = `
Du är ett kreativt team bestående av en FÖRFATTARE och en REGISSÖR som producerar en illustrerad barnbok.

INPUT: En outline (handling).

===========================
 FÖRFATTAREN – DITT UPPDRAG
===========================

• Skriv en engagerande saga på svenska.
• Exakt 16 sidor (pages 1–16).
• Varje sida: 5-7 meningar i fältet "text".
• Bygg berättelsen utifrån bokens tema och lärdom.
• Max 2 sidor i samma miljö/scenografi.
• Hjälten ska förekomma på nästan alla sidor (några få etableringsbilder är okej).


===========================
 REGISSÖREN – DITT UPPDRAG
===========================

• Skapa en visuell plan (“bible”) och detaljerade bildinstruktioner för varje sida.
• Se till att varje sida är visuellt distinkt (ny vinkel, tydlig rörelse i scenen).

• "wardrobe" i bible MÅSTE vara en detaljerad, komma-separerad VISUELL beskrivning på engelska av hjälten:
  - DÅLIGT: "Nice clothes suitable for winter."
  - BRA: "Red wool knitted sweater, blue denim jeans, yellow rubber boots, red beanie hat."
  - Denna sträng används direkt som prompt till bild-AI:n. Var konkret och konsekvent.

• "scene_en" ska vara:
   – filmisk, konkret, levande  
   – beskriva VISUELLA element: miljö, ljus, stämning, handling, kroppsspråk  
   – börja med hjälten i fokus (t.ex. "The little child Nova..." eller "The grey cat Lina...")  
   – FÅR INTE beskriva hjältes ansikte, hårfärg, ögonfärg eller kroppstyp (det styrs av referensbilden).

  Exempel (BRA):  
  "The little child Nova runs along a narrow forest path, fallen leaves swirling around their boots as warm evening light filters through the trees."

  Exempel (DÅLIGT – UNDVIK):  
  "A blonde girl with blue eyes stands in the forest."  // Beskriver utseende → förbjudet

• Fältet "camera" i varje sida ska vara EN enkel kamera-hint, vald ur denna lista:
   "wide", "medium", "close-up", "low-angle", "high-angle", "over-the-shoulder".
  (Ingen annan text i "camera".)

• "action_visual" ska kort beskriva den EXAKTA fysiska handling som bilden ska frysa:
  - Engelska, presens, 3–10 ord (t.ex. "jumping down from the windowsill",
    "hugging the dog tightly", "running towards the park gate").
  - Välj EN huvudhandling per sida, hämtad från sidans text.
  - Om texten innehåller flera små steg, välj det mest filmiska momentet som ska illustreras.

• För varje sida måste "scene_en" och "action_visual" hänga ihop:
  - Den FÖRSTA meningen i "scene_en" ska beskriva hjälten när hen utför just den handling
    som står i "action_visual".
  - Exempel:
      text:          "...han sträcker på sig och hoppar ner från fönsterbrädan."
      action_visual: "jumping down from the windowsill"
      scene_en:      "The cat Melson jumps down from the windowsill into the warm morning light,
                      tail raised high as dust motes dance in the sun."


• Om en birolls-karaktär förekommer på 3 eller fler sidor:
   – Lägg in den i "bible.secondary_characters" med namn, roll, relation till hjälten,
     fysik, igenkänningstecken (identity_keys) och typisk klädsel (wardrobe).
   – Se till att samma visuella detaljer (ansikte, kroppstyp, hår, färger, kläder) upprepas konsekvent i alla scener där karaktären förekommer.
• I varje sida där en birolls-karaktär är med ska "scene" och "scene_en" nämna dem vid namn och tydligt beskriva vad de GÖR och hur de syns i scenen,
  utan att ta bort fokus från hjälten.


===========================
   KATEGORI-REGLER (KRITISKT)
===========================

1) category = "kids"
   • Hjälten är ett mänskligt barn genom hela berättelsen.
   • I svenska scener: beskriv hjälten som "det lilla barnet [Namn]".
   • I scene_en: använd "the little child [Name]".
   • Ingen förvandling till djur, tonåring eller vuxen.

2) category = "pets"
   • Hjälten är ett husdjur genom hela berättelsen.
   • I svenska scener: använd art + namn (t.ex. "katten Lina").
   • I scene_en: använd art + namn (t.ex. "the cat Lina", "the little dog Max").
   • Ingen förvandling till människa.
   • FÖRBJUDET: Använd ALDRIG formuleringen "det lilla barnet" eller beskriv hjälten som ett barn.



===========================
   VISUELLA REGLER (ALLMÄNT)
===========================

• Varje sida ska innehålla:
   - "scene" (svenska, kort scenbeskrivning med hjälten först)
   - "scene_en" (engelsk, filmisk prompt med hjälten först – UTAN fysiskt utseende)
   - "camera" (EN av: "wide", "medium", "close-up", "low-angle", "high-angle", "over-the-shoulder")
   - "action_visual" (vad hjälten gör fysiskt i bilden)
   - "location"
   - "time_of_day" ("day" | "golden_hour" | "evening" | "night")
   - "weather" ("clear" | "cloudy" | "rain" | "snow")
• Hjälten ska synas tydligt i "scene_en" (första meningen ska börja med hjälten).
• Undvik dialog i prompts – beskriv endast det som syns.
• Scenerna och vinklarna ska skapa variation och rörelse framåt i berättelsen.
• Undvik att göra två helt identiska bildkompositioner; varje sida är ett nytt filmiskt ögonblick.


===========================
   JSON-STRUKTUR (OBLIGATORISKT)
===========================

{
  "book": {
    "title": string,
    "tagline": string,
    "back_blurb": string,
    "reading_age": number,
    "style": string,
    "category": "kids" | "pets",
    "bible": {
      "main_character": {
        "name": string,
        "age": number | null,
        "physique": string,
        "identity_keys": string[]
      },
      "secondary_characters": [
        {
          "name": string,
          "role": string,
          "relation_to_hero": string,
          "physique": string,
          "identity_keys": string[],
          "wardrobe": string
        }
      ],
      "wardrobe": string,               // Hjältens outfit – komma-separerad engelsk beskrivning.
      "palette": string[],
      "world": string,
      "tone": string
    },
    "theme": string,
    "lesson": string,
    "pages": [
      {
        "page": number,
        "text": string,
        "scene": string,
        "scene_en": string,
        "camera": string,
        "action_visual": string,
        "location": string,
        "time_of_day": "day" | "golden_hour" | "evening" | "night",
        "weather": "clear" | "cloudy" | "rain" | "snow"
      }
    ]
  }
}


===========================
   HÅRDA REGLER
===========================

• Exakt 16 sidor (pages 1–16).
• 5-7 meningar i "text" per sida.
• Varje sida ska vara visuellt unik (ny vinkel, ny eller utvecklad handling).
• "scene_en" ska alltid börja med hjälten i fokus och får INTE beskriva hjältes ansikte/hår/kroppstyp.
• "camera" måste vara en av: "wide", "medium", "close-up", "low-angle", "high-angle", "over-the-shoulder".
• Om en birolls-karaktär är återkommande (3+ sidor) måste den finnas i bible.secondary_characters och avbildas konsekvent.
• Inga meta-kommentarer, inga instruktioner till läsaren.
• Endast giltig JSON, inga extra fält utanför den specificerade strukturen.
• "category" ska matcha användarens val.
• Boken ska vara njutbar för både barn och vuxna.
• Om "category" = "pets" får du aldrig beskriva hjälten som ett barn i något fält (text, scene, scene_en).

`;


async function handleRefImage(req, env) {
  try {
    const {
      style = "cartoon",
      photo_b64,
      bible,
      traits = "",
      category,
    } = await req.json().catch(() => ({}));

    // 1) Plocka ut kundfoto som ren base64 + mime-type
    let barePhoto = null;
    let photoMime = null;

    if (photo_b64) {
      const m = String(photo_b64).match(
        /^data:(image\/[^;]+);base64,(.+)$/i
      );
      if (!m || m[2].length < 64) {
        return err("Invalid photo_b64", 400);
      }
      photoMime = m[1].toLowerCase();
      barePhoto = m[2];
    }

    if (!barePhoto) {
      return err("Missing photo_b64", 400);
    }

    // 2) Bygg ref-porträtt-prompt
    const prompt = buildRefPortraitPrompt({
      style,
      bible: bible || null,
      traits,
      hasPhoto: !!barePhoto,
      category,
    });

    console.log(
      "[REF] style:",
      style,
      "category:",
      category,
      "hasPhoto:",
      !!barePhoto
    );
    console.log("[REF] incoming user photo b64 length:", barePhoto.length);
    console.log("[REF] photo mime:", photoMime);
    console.log("[REF] prompt excerpt:", prompt.slice(0, 300));

    // 3) Anropa Gemini 2.5 Flash Image för ref-porträtt
    const g = await geminiImage(
      env,
      {
        prompt,
        model: "flash", // tvinga FLASH för ref-bild
        image_b64: barePhoto,
        image_mime: photoMime || "image/png",
        _debugTag: "ref",
      },
      70000,
      2
    );

    if (!g || !g.b64) {
      return err("Failed to generate reference image", 500);
    }

    // 4) För debugging: ladda upp ref-bilden till Cloudflare Images
    let cfImage = null;
    try {
      const data_url = `data:image/png;base64,${g.b64}`;
      cfImage = await uploadOneToCFImages(env, {
        data_url,
        id: `ref-${Date.now()}`,
      });
      console.log("[REF] CF Images upload ok:", cfImage.image_id, cfImage.url);
    } catch (e) {
      console.error("CF Image Upload Failed:", e?.message || e);
      // Viktigt: vi låter INTE detta krascha hela svaret
    }

    // 🔹 Viktigt: skicka ref_image_b64 så frontend blir nöjd
    return ok({
      ref_image_b64: g.b64,             // det script.js läser
      image_b64: g.b64,                 // ev. kompatibilitet
      image_url: g.image_url,           // data-url från Gemini
      provider: g.provider || "google",
      // Nya fält för dig att inspektera:
      cf_image_id: cfImage?.image_id || null,
      cf_image_url: cfImage?.url || null,
    });
  } catch (e) {
    return err(e?.message || "Ref image failed", 500);
  }
}




function heroDescriptor({ category, name, age, traits, petSpecies }) {
  const cat = (category || "kids").toLowerCase();

  if (cat === "pets") {
    const species = (petSpecies || "katt").trim().toLowerCase();
    return `HJÄLTE: ett ${species} vid namn ${name || "Nova"}; egenskaper: ${
      traits || "nyfiken, lekfull"
    }.`;
  }

  const a = parseInt(age || 6, 10);
  return `HJÄLTE: ett barn vid namn ${name || "Nova"} (${a} år), egenskaper: ${
    traits || "modig, omtänksam"
  }.`;
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
function buildFramePrompt({
  style,
  story,
  page,
  characterName,
  wardrobe_signature,
  coherence_code,
}) {
  const category = story?.book?.category || "kids";
  const isPet = category.toLowerCase() === "pets";

  const wardrobe = story?.book?.bible?.wardrobe
    ? (Array.isArray(story.book.bible.wardrobe)
        ? story.book.bible.wardrobe.join(", ")
        : story.book.bible.wardrobe)
    : wardrobe_signature || "consistent outfit";

  const age = story?.book?.bible?.main_character?.age || 5;
  const coh = coherence_code || makeCoherenceCode(story);

  // 1) INPUT GUIDE – flera bilder + text
  const inputGuide = [
    `*** INPUT GUIDE ***`,
    `You receive IMAGE 1, optionally IMAGE 2, and this text prompt.`,
    ``,
    `IMAGE 1: The "MASTER IDENTITY REFERENCE" for the main hero (visual truth).`,
    `IMAGE 2: Previous story frame from the SAME book.`,
    ``,
    `Use IMAGE 1 ONLY for the hero's physical appearance and clothing.`,
    `Use IMAGE 2 ONLY for story continuity (environment, lighting, mood, rough composition).`,
    ``,
    `TEXT (below): Description of the NEXT scene you must create.`,
  ].join("\n");

  // 2) FORMAT – för att undvika split-screen / collage
  const formatRules = [
    `*** COMPOSITION RULES (CRITICAL) ***`,
    `1. SINGLE IMAGE ONLY: Do NOT create a collage, grid, or split-screen.`,
    `2. FULL FRAME: The scene must fill the entire square canvas.`,
    `3. NO INSETS: Do not put the reference face in a corner or as a small overlay.`,
    `4. INTEGRATION: The hero must be IN the scene, interacting with the light, depth, and environment.`,
  ].join("\n");

  // 3) IDENTITY – hårt låst till IMAGE 1
  const identityLines = isPet
    ? [
        `*** 1. IDENTITY (Source: IMAGE 1) ***`,
        `Target: A pet animal named ${characterName}.`,
        `CRITICAL: You must match the animal in IMAGE 1 exactly. Do NOT let the art style override the appearance.`,
        `Match these traits with perfect accuracy:`,
        `- Species and breed.`,
        `- Fur color and pattern.`,
        `- Head and face shape.`,
        `- Eyes (shape, spacing, size, and color).`,
        `- Nose and mouth proportions.`,
        `- Body type and proportions (no extra limbs).`,
        ``,
        `ABSOLUTE RULE: If IMAGE 1 and any text description conflict,`,
        `→ IMAGE 1 is the ONLY source of truth for physical appearance.`,
      ]
    : [
        `*** 1. IDENTITY (Source: IMAGE 1) ***`,
        `Target: A child named ${characterName}, age approx ${age}.`,
        `CRITICAL: You must match the child in IMAGE 1 exactly. Do NOT let the chosen art style override the real appearance!`,
        ``,
        `ABSOLUTE RULE: If IMAGE 1 and any text description conflict,`,
        `→ IMAGE 1 is the ONLY source of truth for physical appearance.`,
      ];
  const identitySection = identityLines.join("\n");

  // 4) WARDROBE – lås kläder
  const wardrobeSection = [
    `*** 2. WARDROBE (Strict Text Rule) ***`,
    `The hero MUST wear the SAME outfit on every page.`,
    `Wardrobe description: ${wardrobe}.`,
    `Do NOT change garment type, main colors, or patterns.`,
    `If previous frames show clothing mistakes, IGNORE those mistakes and follow this wardrobe description instead.`,
  ].join("\n");

  // 5) CONTINUITY + ANTI-STAGNATION – hur tidigare bilder ska användas
  const continuitySection = [
    `*** 3. CONTINUITY vs NEW ACTION (Sources: IMAGE 2 and context) ***`,
    `IMAGE 2 shows what happened a moment ago in the story.`,
    ``,
    `KEEP from IMAGE 2:`,
    `- Environment style and recurring props.`,
    `- Global lighting and color mood.`,
    ``,
    `DISCARD from IMAGE 2:`,
    `- The exact pose of the hero.`,
    `- The exact camera angle and framing.`,
    ``,
    `CHANGE in the NEW frame:`,
    `- You MUST create a significantly different composition than IMAGE 2.`,
    `- Always move the story forward with a NEW moment in time.`,
  ].join("\n");

    const pages = Array.isArray(story?.book?.pages) ? story.book.pages : [];
  const idx = pages.findIndex((p) => p.page === page.page);
  let historySection = "";

  if (idx > 0) {
    const MAX_HISTORY_PAGES = 2; // 👈 alltid bara de 2 senaste
    const start = Math.max(0, idx - MAX_HISTORY_PAGES);
    const chunks = [];

    for (let i = start; i < idx; i++) {
      const p = pages[i];

      // Ta text, men begränsa mängden vi skickar
      const raw = p.scene_en || p.scene || p.text || "";
      if (!raw) continue;

      // 👇 Trunkera per sida (t.ex. ~280 tecken)
      const desc =
        raw.length > 280
          ? raw.slice(0, 280) + " …"
          : raw;

      chunks.push(`PAGE ${p.page}: ${desc}`);
    }

    if (chunks.length) {
      historySection = [
        `*** 3b. STORY SO FAR (last ${chunks.length} pages) ***`,
        ...chunks,
      ].join("\n");
    }
  }


  // 7) NY SCEN – den sida vi genererar
  const sceneBlock = [
    `*** 4. NEW SCENE SPECIFICATION (Current Page ${page.page}) ***`,
    page.scene_en
      ? `VISUAL DESCRIPTION (environment + action, NOT appearance changes): ${page.scene_en}`
      : "",
    page.action_visual
      ? `ACTION: ${page.action_visual}`
      : "ACTION: The hero is clearly doing something active in the scene.",
    page.camera
      ? `CAMERA HINT: ${page.camera}`
      : "CAMERA HINT: dynamic, cinematic framing.",
    page.location ? `LOCATION: ${page.location}` : "",
    page.time_of_day ? `TIME OF DAY: ${page.time_of_day}` : "",
    page.weather ? `WEATHER: ${page.weather}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // 8) MANDATORY ACTION – hård regel för bildmodellen
  const actionBlock = [
    `*** 4b. MANDATORY ACTION (Hard Constraint) ***`,
    `You MUST illustrate the exact physical action described for this page.`,
    `This section overrides ALL other instructions, including continuity from Image 2.`,
    ``,
    `Required action:`,
    `→ ${page.action_visual || page.scene_en || "The hero must perform a clear action visible in the scene."}`,
    ``,
    `STRICT RULES:`,
    `- Do NOT replace the required action with a neutral standing pose.`,
    `- Do NOT reinterpret the action in a symbolic way.`,
    `- Do NOT simply continue the motion from Image 2 if the new action is different.`,
    ``,
    `If the text says "jumping":`,
    `- The hero MUST be shown in mid-air. Not standing before/after.`,
    ``,
    `When combining with scene_en:`,
    `- The required action (above) is the PRIMARY TRUTH.`,
  ].join("\n");

  // 9) STIL + negativa constraints
  const styleSection = [
    `*** 5. STYLE & FORMAT ***`,
    `Art Style: ${styleGuard(style)}`,
    `Format: Square (1:1).`,
    `Do NOT add text, speech bubbles, or logos.`,
    `Avoid flat, boring compositions. Use depth, perspective, and lighting.`,
    ``,
    `NEGATIVE PROMPT:`,
    `- No off-model faces.`,
    `- No changes to hair color or hairstyle.`,
    `- No teen/adult anatomy for the child hero.`,
    `- No extra limbs, no duplicated hero.`,
  ].join("\n");

  return [
    inputGuide,
    formatRules,
    "---",
    identitySection,
    "",
    wardrobeSection,
    "",
    continuitySection,
    historySection ? "\n" + historySection : "",
    "",
    sceneBlock,
    "",
    actionBlock,
    "",
    styleSection,
    "",
    `COHERENCE_CODE: ${coh}`,
  ].join("\n");
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
async function buildPdf(
  {
    story,
    images,
    mode = "preview",
    trim = "square200",
    bleed_mm,
    watermark_text,
    deliverable = "digital",  // "digital" | "print"
  },
  env,
  trace
) {
  tr(trace, "pdf:start");
  const trimSpec = TRIMS[trim] || TRIMS.square200;
  const bleed =
    mode === "print"
      ? Number.isFinite(bleed_mm)
        ? bleed_mm
        : trimSpec.default_bleed_mm
      : 0;

  const trimWpt = mmToPt(trimSpec.w_mm);
  const trimHpt = mmToPt(trimSpec.h_mm);
  const pageW = trimWpt + mmToPt(bleed * 2);
  const pageH = trimHpt + mmToPt(bleed * 2);
  const contentX = mmToPt(bleed);
  const contentY = mmToPt(bleed);

  const isPrintDeliverable =
    String(deliverable || "digital").toLowerCase() === "print";

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  tr(trace, "pdf:doc-created");

  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helvIt = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const base = (env.FONT_BASE_URL || "https://sagobok.pages.dev/fonts").replace(
    /\/+$/,
    ""
  );
  const NUN_R = [`${base}/Nunito-Regular.ttf`];
  const NUN_SB = [`${base}/Nunito-Semibold.ttf`];
  const nunito = await getFontOrFallback(
    trace,
    pdfDoc,
    "nunito",
    NUN_R,
    StandardFonts.TimesRoman
  );
  const nunitoSemi = await getFontOrFallback(
    trace,
    pdfDoc,
    "nunitoSemi",
    NUN_SB,
    StandardFonts.Helvetica
  );
  tr(trace, "pdf:fonts-ready");

  const readingAge = story?.book?.reading_age || 6;
  const { size: baseTextSize, leading: baseLeading } =
    fontSpecForReadingAge(readingAge);

  const title = String(story?.book?.title ?? "Min bok");
  const subtitle = String(
    story?.book?.tagline ??
      (story?.book?.bible?.main_character?.name
        ? `Med ${story.book.bible.main_character.name}`
        : "") ??
      ""
  );
  const blurb = String(
    story?.book?.back_blurb ??
      (story?.book?.lesson
        ? `Lärdom: ${story.book.lesson}.`
        : "En berättelse skapad med BokPiloten.") ?? ""
  );
  const pagesStory = [...(story?.book?.pages || [])];

  // Indexera inkomna bilder
  let coverSrc =
    images?.find((x) => x?.kind === "cover" || x?.page === 0) || null;
  const imgByPage = new Map();
  (images || []).forEach((row) => {
    if (
      Number.isFinite(row?.page) &&
      row.page > 0 &&
      (row.image_id || row.url || row.image_url || row.data_url)
    ) {
      imgByPage.set(row.page, row);
    }
  });

  // Normalisera 16 scener
 function mapTo16ScenePages() {
  const want = 16;
  if (pagesStory.length === want) return pagesStory;
  if (pagesStory.length > want) return pagesStory.slice(0, want);
  const out = [...pagesStory];
  while (out.length < want) {
    out.push(
      pagesStory[pagesStory.length - 1] || {
        page: out.length + 1,
        text: "",
        scene: "",
      }
    );
  }
  return out;
}
const scenePages = mapTo16ScenePages();

  tr(trace, "pdf:scene-pages", { count: scenePages.length });

  /* ------- små helpers för omslag (återanvänds för print/digital) ---- */

  // Mäter textblock för title/subtitle
  function measureBlock(txt, font, baseSize, leading, minSize, maxW, maxH) {
    const s = String(txt ?? "");
    for (let size = baseSize; size >= minSize; size--) {
      const lineH = size * leading;
      const words = s.split(/\s+/);
      const lines = [];
      let line = "";
      for (const w of words) {
        const t = line ? line + " " + w : w;
        if (font.widthOfTextAtSize(t, size) <= maxW) line = t;
        else {
          if (line) lines.push(line);
          line = w;
        }
      }
      if (line) lines.push(line);
      const blockH = lines.length * lineH;
      if (blockH <= maxH) return { size, lineH, lines, blockH };
    }
    return { size: 12, lineH: 12 * 1.1, lines: [], blockH: 0 };
  }

  function drawFrontCoverOn(page, baseX, baseY, boxW, boxH) {
    // Bakgrund (fallback om ingen bild)
    page.drawRectangle({
      x: baseX + contentX,
      y: baseY + contentY,
      width: trimWpt,
      height: trimHpt,
      color: rgb(0.94, 0.96, 1),
    });

    // Bild
    (async () => {
      // OBS: körs bara om vi lyckas fetcha
    })();

    // I praktiken ritar vi titelbadge osv direkt här, bilden ritas separat i try-blocket nedan.
  }

  /**
   * Renderar framsidan (titel + ev bild) i en given "halva".
   * halfX/halfY är basen för sidan (t.ex. 0 för digital, pageW för höger halva i spread).
   */
  // --- front stays same measureBlock(...) ---

async function renderFrontCover(page, halfX, halfY, boxW, boxH) {
  if (!coverSrc) coverSrc = imgByPage.get(1) || null;

  // Full-bleed fallback
  const bgLight = rgb(0.94, 0.96, 1);
  const safeInset = mmToPt(GRID.outer_mm + 2);

  // Image (cover/crop to fill)
  if (coverSrc) {
    try {
      const bytes = await getImageBytes(env, coverSrc);
      const coverImg = await embedImage(pdfDoc, bytes);
      if (coverImg) {
        // fills exactly the half box, centered – may crop slightly
        drawImageCover(page, coverImg, halfX, halfY, boxW, boxH);
      } else {
        page.drawRectangle({ x: halfX, y: halfY, width: boxW, height: boxH, color: bgLight });
      }
    } catch {
      page.drawRectangle({ x: halfX, y: halfY, width: boxW, height: boxH, color: bgLight });
    }
  } else {
    page.drawRectangle({ x: halfX, y: halfY, width: boxW, height: boxH, color: bgLight });
  }

    // Title badge (endast titel, ingen undertitel)
  const tw = boxW - safeInset * 2;
  const cx = halfX + boxW / 2;

  // Flytta ner lite mer än tidigare för att undvika kapning i tryck
  const topCenterY0 = halfY + boxH - mmToPt(GRID.outer_mm + 12);

  const titleM = measureBlock(
    title,
    nunitoSemi,
    Math.min(boxW, boxH) * 0.14, // lite mindre för mer marginal
    1.08,
    22,
    tw,
    mmToPt(32)
  );

  const padY = mmToPt(4), padX = mmToPt(6);
  const badgeH = titleM.blockH + padY * 2;
  const badgeY = topCenterY0 - badgeH / 2;

  page.drawRectangle({
    x: halfX + safeInset - padX,
    y: badgeY,
    width: tw + padX * 2,
    height: badgeH,
    color: rgb(1, 1, 1),
    opacity: 0.15,
  });

  // Titelrader
  {
    let y = badgeY + badgeH - padY - titleM.lineH / 2;
    for (const ln of titleM.lines) {
      const w = nunitoSemi.widthOfTextAtSize(ln, titleM.size);
      page.drawText(ln, {
        x: cx - w / 2,
        y,
        size: titleM.size,
        font: nunitoSemi,
        color: rgb(0.05, 0.05, 0.05),
      });
      y -= titleM.lineH;
    }
  }
}


async function renderBackCover(page, halfX, halfY, boxW, boxH) {
  // Full-bleed solid back in your purple
  const bg = rgb(0.58, 0.54, 0.86);
  page.drawRectangle({ x: halfX, y: halfY, width: boxW, height: boxH, color: bg });

  // Centered blurb box
  const centerX = halfX + boxW / 2;
  const centerY = halfY + boxH / 2;
  drawWrappedCenterColor(
    page,
    blurb,
    centerX,
    centerY,
    boxW * 0.72,
    boxH * 0.36,
    nunito,
    14,
    1.42,
    12,
    rgb(1, 1, 1),
    "center"
  );
}

/* -------- OMSLAG (PRINT) -------- */
try {
  if (isPrintDeliverable) {
    // Exact Gelato cover sheet size (includes back + spine + front)
    const COVER_W_MM = 458.0;
    const COVER_H_MM = 246.0;
    const coverWpt = mmToPt(COVER_W_MM);
    const coverHpt = mmToPt(COVER_H_MM);
    const halfWpt  = coverWpt / 2;

    const spreadPage = pdfDoc.addPage([coverWpt, coverHpt]);

    // Paint whole spread first (kills any black gutter/spine)
    const purple = rgb(0.58, 0.54, 0.86);
    spreadPage.drawRectangle({ x: 0, y: 0, width: coverWpt, height: coverHpt, color: purple });

    // Left = back, Right = front (each full-bleed to its half)
    await renderBackCover (spreadPage, 0,       0, halfWpt, coverHpt);
    await renderFrontCover(spreadPage, halfWpt, 0, halfWpt, coverHpt);

    // Safety: overpaint a 1pt spine strip in purple to hide any seam from viewers
    spreadPage.drawRectangle({ x: halfWpt - 0.5, y: 0, width: 1, height: coverHpt, color: purple });

  } else {
    // Digital preview unchanged
    const coverPage = pdfDoc.addPage([pageW, pageH]);
    await renderFrontCover(coverPage, 0, 0, pageW, pageH);
  }
} catch (e) {
  tr(trace, "cover:error", { error: String(e?.message || e) });
  const p = pdfDoc.addPage([pageW, pageH]);
  p.drawText("Omslag kunde inte renderas.", {
    x: mmToPt(15), y: mmToPt(15), size: 12, font: nunito, color: rgb(0.8, 0.1, 0.1),
  });
}


  /* -------- PRINT endpaper (blank sida direkt efter omslag) -------- */
  if (isPrintDeliverable) {
    // Helt tom sida 2 (insidan av omslaget)
    pdfDoc.addPage([pageW, pageH]);
  }

 /* -------- TITELSIDA (efter omslag) -------- */
try {
  const titlePage = pdfDoc.addPage([pageW, pageH]);
  titlePage.drawRectangle({
    x: contentX,
    y: contentY,
    width: trimWpt,
    height: trimHpt,
    color: rgb(0.98, 0.99, 1),
  });

  const cx = contentX + trimWpt / 2;
  const cy = contentY + trimHpt / 2 + mmToPt(4);

  // 🔁 Endast denna rad används som "titel"
  const mainTitle = "Skapad av Sagostugan, med kärlek";

  const mainSize = Math.min(trimWpt, trimHpt) * 0.06; // lite mindre så det känns mjukt

  const titleW = nunitoSemi.widthOfTextAtSize(mainTitle, mainSize);
  titlePage.drawText(mainTitle, {
    x: cx - titleW / 2,
    y: cy,                // mitt i
    size: mainSize,
    font: nunitoSemi,
    color: rgb(0.15, 0.15, 0.25),
  });

  // 💜 HJÄRTA (behåller)
  const gap = mmToPt(10);
  const heartSize = mmToPt(14);
  const heartY = cy - heartSize - gap;
  drawHeart(titlePage, cx, heartY, heartSize, rgb(0.5, 0.36, 0.82));
} catch (e) {
  tr(trace, "titlepage:error", { error: String(e?.message || e) });
}


  /* -------- 16 uppslag: bild vänster, text höger + vine -------- */
  const outer = mmToPt(GRID.outer_mm);
  for (let i = 0; i < 16; i++) {
    const scene = scenePages[i] || {};
    const mainText = String(scene.text || "").trim();

    // Vänster: bild
    const left = pdfDoc.addPage([pageW, pageH]);
    left.drawRectangle({
      x: contentX,
      y: contentY,
      width: trimWpt,
      height: trimHpt,
      color: rgb(1, 1, 1),
    });
    try {
      const src = imgByPage.get(scene.page);
      let imgObj = null;
      if (src) {
        const bytes = await getImageBytes(env, src);
        imgObj = await embedImage(pdfDoc, bytes);
      }
      if (imgObj) drawImageCover(left, imgObj, 0, 0, pageW, pageH);
      else
        left.drawText("Bild saknas", {
          x: contentX + mmToPt(4),
          y: contentY + mmToPt(6),
          size: 12,
          font: nunito,
          color: rgb(0.8, 0.1, 0.1),
        });
    } catch (e) {
      tr(trace, "page:image:error", {
        page: scene?.page,
        error: String(e?.message || e),
      });
      left.drawText("Bildfel", {
        x: contentX + mmToPt(4),
        y: contentY + mmToPt(6),
        size: 12,
        font: nunito,
        color: rgb(0.8, 0.1, 0.1),
      });
    }

    // Höger: text
    const right = pdfDoc.addPage([pageW, pageH]);
    right.drawRectangle({
      x: contentX,
      y: contentY,
      width: trimWpt,
      height: trimHpt,
      color: rgb(0.96, 0.98, 1),
    });

    const cx = contentX + trimWpt / 2,
      cy = contentY + trimHpt / 2 + mmToPt(6);
    drawWrappedCenterColor(
      right,
      mainText,
      cx,
      cy,
      trimWpt * 0.76,
      trimHpt * 0.60,
      nunito,
      Math.round(baseTextSize * TEXT_SCALE),
      baseLeading,
      12,
      rgb(0.08, 0.08, 0.1),
      "center"
    );

    // Sidnummer (behåller din nuvarande logik)
    const pageNum = 3 + i * 2 + 1;
    const pn = String(pageNum);
    const pnW = nunito.widthOfTextAtSize(pn, 10);
    right.drawText(pn, {
      x: contentX + trimWpt - outer - pnW,
      y: contentY + mmToPt(6),
      size: 10,
      font: nunito,
      color: rgb(0.35, 0.35, 0.45),
    });

  }

  /* -------- SLUT -------- */
  {
    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawRectangle({
      x: contentX,
      y: contentY,
      width: trimWpt,
      height: trimHpt,
      color: rgb(0.96, 0.98, 1),
    });

    const cx = contentX + trimWpt / 2;
    const topY = contentY + trimHpt * 0.58;

    drawWrappedCenterColor(
      page,
      "Snipp snapp snut – så var sagan slut!",
      cx,
      topY,
      trimWpt * 0.76,
      mmToPt(30),
      nunito,
      22,
      1.22,
      14,
      rgb(0.1, 0.1, 0.12),
      "center"
    );

    drawHeart(
      page,
      cx,
      contentY + trimHpt * 0.38,
      mmToPt(14),
      rgb(0.5, 0.36, 0.82)
    );
  }



  /* -------- PRINT endpaper (sista sidan blank) -------- */
  if (isPrintDeliverable) {
    pdfDoc.addPage([pageW, pageH]); // helt blank
  }

  /* -------- BACK COVER (endast för digital/preview) -------- */
  if (!isPrintDeliverable) {
    try {
      const page = pdfDoc.addPage([pageW, pageH]);
      await renderBackCover(page, 0, 0, pageW, pageH);
    } catch (e) {
      tr(trace, "back:error", { error: String(e?.message || e) });
    }
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
 const { story, images, mode = "preview", trim = "square200", bleed_mm, watermark_text, order_id, store_to_kv } = body || {};
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
async function handlePdfSingleUrl(req, env) {
  try {
    const payload = await req.json().catch(() => ({}));
    let {
      story, images, mode = "preview", trim = "square200",
      bleed_mm, deliverable = "digital", order_id,
    } = payload || {};

    // Hämta story från KV om bara order_id gavs
    if ((!story || !Array.isArray(story?.book?.pages)) && order_id) {
      const ord = await kvGetOrder(env, order_id);
      if (ord?.draft?.story && Array.isArray(ord.draft.story?.book?.pages)) {
        story  = ord.draft.story;
        images = images || ord.draft.images || ord.draft.image_rows || [];
      }
    }
    if (!story || !Array.isArray(story?.book?.pages)) {
      return err("Missing story.book.pages", 400, { has_order: !!order_id, has_draft: false });
    }

    const normDeliverable = String(deliverable || "digital").toLowerCase();
    const isPrint = normDeliverable === "print" || normDeliverable === "printed";

    // Bygg PDF
    const trace = traceStart();
    const bytes = await buildPdf(
      {
        story,
        images: images || [],
        mode: isPrint ? "print" : mode,
        trim,
        bleed_mm,
        deliverable: isPrint ? "print" : "digital",
      },
      env,
      trace
    );

    // Räkna verkliga sidor
    const doc           = await PDFDocument.load(bytes);
    const realPageCount = doc.getPageCount();

    // Spara filen publikt
    const ts        = Date.now();
    const safeTitle = safeTitleFrom(story);
    const suffix    = isPrint ? "_PRINT_BOOK.pdf" : "_BOOK.pdf";
    const key       = `${safeTitle}_${ts}${suffix}`;
    const url       = await r2PutPublic(env, key, bytes, "application/pdf");

    // 💡 REGEL: För PRINT sparar vi ALLTID page_count = 34 (hårdkodat).
    //          Verkligt sidantal sparas som pdf_page_count för diagnos/logg.
    const pageCountForGelato = isPrint ? 34 : realPageCount;

    if (order_id) {
      await kvAttachFiles(env, order_id, {
        single_pdf_url: url,
        single_pdf_key: key,
        page_count: pageCountForGelato,  // <- Gelato läser detta
        pdf_page_count: realPageCount,   // <- diagnostic
        deliverable: normDeliverable,
      });
    }

    return withCORS(ok({
      url,
      key,
      page_count: pageCountForGelato,
      pdf_page_count: realPageCount,
      deliverable: normDeliverable,
    }));
  } catch (e) {
    return withCORS(err(e?.message || "single-url failed", 500));
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
/* Helpers som redan finns i filen (används här):
   - ok, err
   - openaiJSON, OUTLINE_SYS, STORY_SYS
   - heroDescriptor, getCameraHints, normalizePlan
   - makeCoherenceCode, deriveWardrobeSignature
   - styleGuard, geminiImage
*/

/** Bygger prompt för en fristående referensbild (”character card”) */
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

function buildRefPortraitPrompt({ style, bible, traits, hasPhoto, category }) {
  const mc = bible?.main_character || {};
  const name = mc.name || "Nova";
  const age = mc.age ?? 6;
  const world = bible?.world || "a cozy, friendly children's story world";
  const tone = bible?.tone || "warm and playful";
  const ward = Array.isArray(bible?.wardrobe)
    ? bible.wardrobe.join(", ")
    : (bible?.wardrobe || "").trim();
  const palette = (bible?.palette || []).join(", ");

  const phys = mc.physique || "";
  const idKeys = Array.isArray(mc.identity_keys)
    ? mc.identity_keys.join(", ")
    : (mc.identity_keys || "");
  const cat = (category || bible?.category || "kids").toLowerCase();
  const looksLikePet = /\b(cat|dog|rabbit|hamster|kitten|puppy)\b/i.test(
    phys + " " + idKeys
  );

  const isPet = cat === "pets" || looksLikePet;

  const lines = [];

  if (isPet) {
    lines.push(
      "You are creating ONE single square portrait reference for the main PET hero of a children's picture book.",
      "The hero is a real pet (animal), not a human child."
    );
  } else {
    lines.push(
      "You are creating ONE single square portrait reference for the main CHILD hero of a children's picture book."
    );
  }

  lines.push(
    "",
    "OUTPUT:",
    "- Exactly one clean, centered character portrait.",
    "- No text, no logo, no borders.",
    "- Soft, book-friendly background."
  );

  if (hasPhoto) {
    lines.push(
      "",
      "You receive ONE INPUT PHOTO of the real hero. You MUST preserve the identity from that photo.",
      isPet
        ? "- Keep the same species, approximate breed, fur colors and patterns."
        : "- Keep the same child: face shape, eyes, nose, mouth, hair and proportions.",
      "- If any written description disagrees with the photo, ALWAYS follow the photo.",
      "- You may clean up lighting and background, but do NOT redesign the hero."
    );
  } else {
    lines.push(
      "",
      "No input photo is provided. Invent a consistent hero that fits the description."
    );
  }

  lines.push(
    "",
    "BOOK CONTEXT:",
    `- Name: ${name}`,
    !isPet ? `- Approx age: ${age}` : "",
    world ? `- World: ${world}` : "",
    tone ? `- Tone: ${tone}` : "",
    ward ? `- Wardrobe hint: ${ward}` : "",
    palette ? `- Color palette hints: ${palette}` : "",
    traits ? `- Personality traits: ${traits}` : ""
  );

  lines.push(
    "",
    `STYLE: ${styleHint(style)}`,
    "",
    "COMPOSITION:",
    "- Square aspect ratio (1:1).",
    "- Medium close-up or 3/4 view.",
    "- The hero is clearly visible and expressive.",
    "- Background is simple and soft, matching the book world."
  );

  return lines.filter(Boolean).join("\n");
}


async function handleStory(req, env) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      name,
      age,
      pages,        // kan ignoreras eller användas, men vi låser ändå till 16
      category,
      style,
      theme,
      traits,
      reading_age,
      extraCharacters = [],
      petSpecies = "",
    } = body || {};

    // Läsålder: explicit reading_age > annars från barnets ålder > pets default 8
    const parsedRA = parseInt(reading_age, 10);
    const targetAge = Number.isFinite(parsedRA)
      ? parsedRA
      : ((category || "kids") === "pets" ? 8 : parseInt(age || 6, 10));

    // 1) Bygg karaktärssträngar (MISSADES I DIN SNIPPET)
    const mainChar = heroDescriptor({ category, name, age, traits, petSpecies });

    const extrasText =
      Array.isArray(extraCharacters) && extraCharacters.length > 0
        ? [
            "BI-ROLLER (återkommande karaktärer):",
            ...extraCharacters.map((c) => {
              const role = c.role || "vän/familjemedlem";
              const t = c.traits || "";
              return `- ${c.name} (${role})${t ? ` – egenskaper: ${t}` : ""}`;
            }),
          ].join("\n")
        : "Inga tydligt definierade biroller angivna.";

    // 2) OUTLINE
    const speciesLine =
      (category || "kids") === "pets"
        ? `Djurslag: ${petSpecies || "katt"}.`
        : "";

    const outlineUser = `
${mainChar}
${extrasText}
Kategori: ${category || "kids"}.
${speciesLine}
Läsålder: ${targetAge}.
Önskat tema/poäng: ${theme || "vänskap"}.
Antal sidor (mål): 16.

Skapa en engagerande outline för en bilderbok.
Returnera ENDAST giltig JSON enligt OUTLINE-strukturen.
`.trim();

    const outline = await openaiJSON(env, OUTLINE_SYS, outlineUser);

    // 3) STORY
    const storyUser = `
OUTLINE:
${JSON.stringify(outline, null, 2)}

INSTRUKTIONER FÖR BOKEN:

1) Använd OUTLINE som grund, men gör berättelsen mer detaljerad, händelserik och filmisk.
2) Boken ska ha EXAKT 16 sidor (pages 1–16).
3) FÖRFATTAREN:
   - Skriv 5-7 meningar i "text" (svenska) per sida.
   - Bygg berättelsen utifrån OUTLINE.theme och den övergripande lärdomen.
4) REGISSÖREN:
   - Du MÅSTE definiera en "bible" i JSON-objektet.
   - I "bible.wardrobe": skriv en EXAKT, konsekvent outfit för hjälten på engelska.
   - Om biroller förekommer på flera sidor, beskriv dem tydligt i scenerna
     (utseende, ungefärlig klädsel, relation till hjälten) så att de kan ritas konsekvent.
   - Lägg INTE till nya JSON-fält – använd endast den givna JSON-strukturen.
   - Varje sida måste ha ifyllda fält: scene, scene_en, camera, action_visual, location,
     time_of_day, weather.
   - Variera kameravinklar ofta, men skriv dem direkt i "camera"-fältet per sida.

5) BI-ROLLER:
${extrasText}

6) KATEGORI:
   - category: ${category || "kids"}
   - Läsålder: ${targetAge}
   - Stil: ${style || "cartoon"}

Returnera ENDAST giltig JSON enligt STORY_SYS-strukturen (fält och typer).
Inga extra fält, inga kommentarer, ingen text utanför JSON.
`.trim();

    const story = await openaiJSON(env, STORY_SYS, storyUser);

    // 4) Efterarbete: Säkra kategori + fixa "det lilla barnet" för husdjur
    const cat = (category || "kids").toLowerCase();
    if (story?.book) {
      story.book.category = cat;

      if (cat === "pets") {
        const heroName =
          name ||
          (story.book.hero && story.book.hero.name) ||
          (story.book.main_character && story.book.main_character.name) ||
          "Melson";

        const species =
          (petSpecies ||
            (story.book.hero && story.book.hero.species) ||
            (story.book.main_character && story.book.main_character.species) ||
            "katten").toLowerCase();

        const reChild = /det lilla barnet/gi;

        if (Array.isArray(story.book.pages)) {
          for (const pg of story.book.pages) {
            if (!pg) continue;
            if (typeof pg.text === "string") {
              pg.text = pg.text.replace(reChild, `${species} ${heroName}`);
            }
            if (typeof pg.scene === "string") {
              pg.scene = pg.scene.replace(reChild, `${species} ${heroName}`);
            }
          }
        }
      }
    }

    // 5) Garderob
    const wardrobe_signature = story?.book?.bible?.wardrobe
      ? Array.isArray(story.book.bible.wardrobe)
        ? story.book.bible.wardrobe.join(", ")
        : story.book.bible.wardrobe
      : deriveWardrobeSignature(story);

    const coherence_code = makeCoherenceCode(story);

    // 6) Returnera
    return ok({
      outline,
      story,
      plan: { plan: [] },
      coherence_code,
      wardrobe_signature,
    });
  } catch (e) {
    return err(e?.message || "Story generation failed", 500);
  }
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
  try {
    const {
      style = "cartoon",
      story,
      page,
      ref_image_b64, // IMAGE 1 – referens (hjältens identitet)
      prev_b64,      // IMAGE 2 – senaste sida (om finns)
      coherence_code,
      style_refs_b64,
    } = await req.json().catch(() => ({}));

    // --- 0. Grundkoll ---
    if (!story?.book?.pages) return err("Missing story.pages", 400);
    if (!ref_image_b64)      return err("Missing ref_image_b64", 400);

    const pages = story.book.pages;
    const pg = pages.find((p) => p.page === page);
    if (!pg) return err(`Page ${page} not found`, 404);

    const heroName =
      story.book.bible?.main_character?.name || "Hero";

    // --- 1. Garderob (bibeln vinner, annars derivat) ---
    const bibleWardrobe = story.book.bible?.wardrobe
      ? Array.isArray(story.book.bible.wardrobe)
        ? story.book.bible.wardrobe.join(", ")
        : story.book.bible.wardrobe
      : null;

    const wardrobe = bibleWardrobe || deriveWardrobeSignature(story);

    // --- 2. Textuell kontext: föregående + senaste 3 sidor ---
    const idx = pages.findIndex((p) => p.page === page);
    const prevPg = idx > 0 ? pages[idx - 1] : null;
    const prevSceneEn =
      prevPg?.scene_en || prevPg?.scene || prevPg?.text || "";

    const contextStart = Math.max(0, idx - 3);
    const recentPages = pages.slice(contextStart, idx);

    const storyContextBlock = recentPages.length
      ? [
          "STORY SO FAR (previous pages):",
          ...recentPages.map((p) =>
            `- Page ${p.page}: ${(p.scene_en || p.scene || p.text || "")
              .replace(/\s+/g, " ")
              .trim()}`
          ),
        ].join("\n")
      : "";

    // --- 3. Bas-prompt (SCENE_EN + metadata) ---
    const basePrompt = buildFramePrompt({
      style,
      story,
      page: pg,
      characterName: heroName,
      wardrobe_signature: wardrobe,
      coherence_code,
    });

    // --- 4. Bildinstruktioner: exakt VAD bilderna betyder ---
    const imageRefLines = [
      "*** IMAGE REFERENCES ***",
      "IMAGE 1: Main hero identity (MASTER reference).",
      "- Use IMAGE 1 ONLY for hero's face, body, fur/skin, proportions, and clothing.",
      "- If text and IMAGE 1 conflict, IMAGE 1 wins for appearance.",
    ];

    if (prev_b64) {
      imageRefLines.push(
        "",
        "IMAGE 2: Previous story frame (environment + mood).",
        "- Use IMAGE 2 ONLY for environment style, lighting and general continuity.",
        "- DO NOT copy the exact pose or framing.",
        "- Create a NEW moment that continues the story."
      );
    }

    const imageRefsBlock = imageRefLines.join("\n");

    // --- 5. CONTINUATION-block ---
    const continuation = prevSceneEn
      ? [
          "*** CONTINUATION ***",
          `Previous action: "${prevSceneEn.replace(/\s+/g, " ").trim()}"`,
          "Now create the NEXT visual moment in the story.",
        ].join("\n")
      : [
          "*** CONTINUATION ***",
          "This is the first visible moment in the story. Start the visual narrative.",
        ].join("\n");

    // --- 6. Slutlig prompt: vad vi faktiskt skickar till Gemini ---
    const promptParts = [basePrompt, imageRefsBlock];
    if (storyContextBlock) promptParts.push(storyContextBlock);
    promptParts.push(continuation);

    const prompt = promptParts.join("\n\n");

    // (valfritt, bra för debug)
    console.log("[IMAGES/NEXT] prompt (truncated):", prompt.slice(0, 400));

    // --- 7. Payload till geminiImage (samma för Pro och Flash) ---
    const payload = {
      prompt,
      character_ref_b64: ref_image_b64,             // IMAGE 1
      prev_b64: prev_b64 || undefined,              // IMAGE 2 (om finns)
      coherence_code: coherence_code || makeCoherenceCode(story),
    };

    if (Array.isArray(style_refs_b64) && style_refs_b64.length) {
      payload.style_refs_b64 = style_refs_b64;
    }

    // Kortare timeout & färre försök för att minska risken att Workern dör
    const g = await geminiImage(env, payload, 35000, 2);

    if (!g?.image_url) return err("No image from Gemini", 502);

    return ok({
      page,
      image_url: g.image_url,
      provider: g.provider || "google",
      // prompt: prompt, // <– bara om du vill returnera den till frontend
    });
  } catch (e) {
    return err(e?.message || "images/next failed", 500);
  }
}

async function handleImageRegenerate(req, env) {
  try {
    const {
      story,
      page,
      ref_image_b64,
      prev_b64, // <--- NYTT: Ta emot föregående bild
      style,
      coherence_code,
      style_refs_b64
    } = await req.json().catch(() => ({}));

    if (!story?.book?.pages) return err("Missing story.pages", 400);
    if (page === undefined || page === null) return err("Missing page", 400);
    if (!ref_image_b64) return err("Missing ref_image_b64", 400);

    const pages = story.book.pages;
    const target = pages.find((p) => p.page === page);
    if (!target) return err(`Page ${page} not found`, 404);

    const heroName = story.book.bible?.main_character?.name || "Hero";
    
    // Hämta garderob (samma logik som handleImagesNext)
    const bibleWardrobe = story.book.bible?.wardrobe 
        ? (Array.isArray(story.book.bible.wardrobe) ? story.book.bible.wardrobe.join(", ") : story.book.bible.wardrobe)
        : null;
    const wardrobe = bibleWardrobe || deriveWardrobeSignature(story);

    // Bygg bas-prompten
    const prompt = buildFramePrompt({
      style: style || story.book.style || "cartoon",
      story,
      page: target,
      characterName: heroName,
      wardrobe_signature: wardrobe,
      coherence_code: coherence_code || makeCoherenceCode(story),
    });

    // Lägg till REGENERATE-instruktion
    const regenPrompt = [
       prompt,
       "*** REGENERATION REQUEST ***",
       "Create a NEW variation of this scene.",
       "Fix any previous errors.",
       "Maintain strict identity from Image 1.",
       prev_b64 ? "Maintain environment continuity from Image 2." : ""
    ].join("\n\n");

    // Payload
    const payload = {
      prompt: regenPrompt,
      character_ref_b64: ref_image_b64, // IMAGE 1
      prev_b64: prev_b64,               // IMAGE 2 (Nytt!)
      coherence_code: coherence_code || makeCoherenceCode(story),
    };

    if (Array.isArray(style_refs_b64) && style_refs_b64.length) {
      payload.style_refs_b64 = style_refs_b64;
    }

    // Anropa med 60s timeout (lite längre tid för enstaka regen är ok)
    const img = await geminiImage(env, payload, 60000, 2); 

    if (!img?.image_url) return err("No image from Gemini", 502);

    return ok({
      page,
      prompt: regenPrompt,
      image_url: img.image_url,
      provider: img.provider || "google",
    });
  } catch (e) {
    return err(e?.message || "Image regeneration failed", 500);
  }
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

/* ======================== Gelato – helpers ========================= */

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

  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }

  if (!r.ok) {
    const err = new Error(`Gelato ${r.status}: ${data?.message || data?.error || "Request contains errors"}`);
    err.name = "GelatoError";
    err.status = r.status;
    err.url = url;
    err.data = data;
    err.raw = txt;
    throw err;
  }
  return data;
}

function mapGelatoStatus(data) {
  const s =
    data?.fulfillmentStatus ||
    data?.status ||
    data?.orderStatus ||
    data?.order?.status ||
    null;

  const hist = Array.isArray(data?.statusHistory) ? data.statusHistory : [];
  const lastHist = hist.length ? (hist[hist.length - 1]?.status || hist[hist.length - 1]) : null;

  return String(s || lastHist || "unknown").toLowerCase();
}

/** Shipment methods */
async function gelatoGetShipmentMethods(env, country) {
  const url = new URL(`${GELATO_BASE.ship}/shipment-methods`);
  if (country) url.searchParams.set("country", country);
  return gelatoFetch(url.toString(), env);
}

/** Prislista för produkt */
async function gelatoGetPrices(env, productUid, { country, currency, pageCount } = {}) {
  const url = new URL(`${GELATO_BASE.product}/products/${encodeURIComponent(productUid)}/prices`);
  if (country)   url.searchParams.set("country", country);
  if (currency)  url.searchParams.set("currency", currency);
  if (pageCount) url.searchParams.set("pageCount", String(pageCount));
  return gelatoFetch(url.toString(), env);
}

async function gelatoApiCreateOrder(env, payload) {
  const url = `${GELATO_BASE.order}/orders`;
  return gelatoFetch(url, env, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Mappar Gelatos orderId → din order.id (för webhook lookup) */
async function kvIndexGelatoOrder(env, gelatoId, orderId, ttlSec = 60 * 24 * 60 * 60) {
  if (!gelatoId || !orderId) return;
  await env.ORDERS.put(`GELATO_IDX:${gelatoId}`, orderId, { expirationTtl: ttlSec });
}

/** Hämta orderinfo från Gelato */
async function gelatoGetOrder(env, gelatoOrderId) {
  if (!gelatoOrderId) throw new Error("Missing gelatoOrderId");
  const url = `${GELATO_BASE.order}/orders/${encodeURIComponent(gelatoOrderId)}`;
  return gelatoFetch(url, env, { method: "GET" });
}
async function gelatoCreateOrder(env, { order, shipment = {}, customer = {}, currency }) {
  const productUid = env.GELATO_PRODUCT_UID;
  if (!productUid) throw new Error("GELATO_PRODUCT_UID not configured");

  const contentUrl  = order?.files?.single_pdf_url || null;
  const kvPageCount = Number(order?.files?.page_count ?? 0);

  if (!contentUrl) throw new Error("Order is missing files.single_pdf_url (run /api/pdf/single-url first)");
  if (!Number.isFinite(kvPageCount) || kvPageCount <= 0) {
    throw new Error("Order is missing/invalid files.page_count");
  }

  // 🔒 Alltid 34 till Gelato (produktens pageCount), oavsett faktisk PDF-sidcount
  const pageCount = 34;

  const DRY_RUN = String(env.GELATO_DRY_RUN || "").toLowerCase() === "true";
  const FORCE_TEST_TO = env.GELATO_TEST_EMAIL || "noreply@bokpiloten.se";
  const CURR = (currency || env.GELATO_DEFAULT_CURRENCY || "SEK").toUpperCase();

  const custEmail = (customer.email || FORCE_TEST_TO);
  const recvEmail = DRY_RUN ? FORCE_TEST_TO : custEmail;
  const recvPhone = customer.phone || shipment.phone || "0700000000";

  // ✅ Endast shippingAddress (Gelato kräver namn + kontakt här)
  const shippingAddress = {
    firstName:     (customer.firstName || shipment.firstName || "Test").toString(),
    lastName:      (customer.lastName  || shipment.lastName  || "Kund").toString(),
    email:         recvEmail,
    phone:         recvPhone,
    addressLine1:  (shipment.addressLine1 || "Storgatan 1").toString(),
    addressLine2:  (shipment.addressLine2 || "").toString(),
    city:          (shipment.city || "Örebro").toString(),
    postCode:      (shipment.postCode || "70000").toString(),
    country:       String(shipment.country || "SE").toUpperCase(),
    state:         shipment.state || undefined,
  };

  const item = {
    itemReferenceId: `book-${order.id || "1"}`,
    productUid,
    quantity: 1,
    pageCount, // 👈 ALLTID 34
    files: [{ type: "default", url: contentUrl }],
  };

const shipmentMethodUid = "normal";

  const payload = {
  orderType: DRY_RUN ? "draft" : "order",
  orderReferenceId: order.id,
  customerReferenceId: custEmail || `cust-${order.id}`,
  currency: CURR,

  shippingAddress,
  items: [item],
 shipmentMethodUid,

  metadata: [
    { key: "bp_kind",         value: String(order.kind || order?.draft?.kind || "printed") },
    { key: "bp_pages_pdf",    value: String(order?.files?.pdf_page_count ?? kvPageCount) },
    { key: "bp_pages_gelato", value: String(pageCount) },
  ],
};

  console.log("📦 Payload to Gelato (order):", JSON.stringify(payload, null, 2));

  const g = await gelatoApiCreateOrder(env, payload);
  const gelato_id = g?.id || g?.orderId || null;

  if (gelato_id && order?.id) {
    await kvIndexGelatoOrder(env, gelato_id, order.id);
    await kvAttachFiles(env, order.id, { gelato_order_id: gelato_id });
  }

  return { payload, gelato: g };
}




/* ====================== Gelato – produktinfo/debug ====================== */

const GELATO_BASE_V3 = { product: "https://product.gelatoapis.com/v3" };

async function gelatoFetchV3(url, env, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "X-API-KEY": env.GELATO_API_KEY,
      ...(init.headers || {})
    }
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!r.ok) {
    const e = new Error(`Gelato ${r.status}: ${data?.message || data?.error || "Request contains errors"}`);
    e.name = "GelatoError";
    e.status = r.status;
    e.data = data;
    e.raw = txt;
    throw e;
  }
  return data;
}

async function gelatoGetCoverDimensions(env, productUid, pageCount) {
  if (!productUid) throw new Error("Missing GELATO_PRODUCT_UID");
  if (!Number.isFinite(pageCount) || pageCount <= 0) {
    throw new Error("Invalid pageCount for cover-dimensions");
  }

  const u = new URL(`${GELATO_BASE_V3.product}/products/${encodeURIComponent(productUid)}/cover-dimensions`);
  u.searchParams.set("pageCount", String(pageCount));
  return gelatoFetchV3(u.toString(), env);
}

function extractPageInfoFromProductV3(raw) {
  const spec = raw?.printSpec || raw?.printSpecification || raw?.specification || raw || {};
  return {
    pageCountMin:      spec.pageCountMin ?? spec.minPageCount ?? null,
    pageCountDefault:  spec.pageCountDefault ?? null,
    pageCountMax:      spec.pageCountMax ?? spec.maxPageCount ?? null,
    pageIncrement:     spec.pageIncrement ?? spec.pageStep ?? null,
    includesCoverInCount:
      spec.includesCoverInCount ?? spec.pageCountIncludesCover ?? null,
  };
}

async function probeValidPageCounts(env, uid, { from = 20, to = 60 }) {
  const okCounts = [];
  for (let n = from; n <= to; n++) {
    try {
      const u = new URL(`${GELATO_BASE_V3.product}/products/${encodeURIComponent(uid)}/cover-dimensions`);
      u.searchParams.set("pageCount", String(n));
      await gelatoFetchV3(u.toString(), env);
      okCounts.push(n);
    } catch {
      // ignore ogiltiga
    }
  }
  return okCounts;
}

/* ======================== Gelato – handlers ======================== */

async function handleGelatoShipmentMethods(req, env) {
  try {
    const country = new URL(req.url).searchParams.get("country") || env.GELATO_DEFAULT_COUNTRY || "SE";
    const data = await gelatoGetShipmentMethods(env, country);
    return ok(data);
  } catch (e) {
    return err(e?.message || "gelato shipment-methods failed", 500);
  }
}

async function handleGelatoPrices(req, env) {
  try {
    const productUid = env.GELATO_PRODUCT_UID;
    if (!productUid) return err("Missing GELATO_PRODUCT_UID", 400);
    const url = new URL(req.url);
    const country   = url.searchParams.get("country")  || env.GELATO_DEFAULT_COUNTRY || "SE";
    const currency  = url.searchParams.get("currency") || env.GELATO_DEFAULT_CURRENCY || "SEK";
    const pageCount = url.searchParams.get("pageCount");
    const prices = await gelatoGetPrices(env, productUid, {
      country,
      currency,
      pageCount: pageCount ? Number(pageCount) : undefined,
    });
    return ok(prices);
  } catch (e) {
    return err(e?.message || "gelato prices failed", 500);
  }
}

async function handleGelatoCreate(req, env) {
  try {
    const body = await req.json().catch(() => ({}));

    const orderId = body.order_id;
    if (!orderId) return err("Missing order_id", 400);

    const ord = await kvGetOrder(env, orderId);
    if (!ord) return err("Order not found in KV", 404);

    const shipment  = body.shipment || {};
    const customer  = body.customer || {};
    const currency  = body.currency || undefined;

    if (!ord.files?.single_pdf_url || !Number.isFinite(ord.files?.page_count)) {
      return err(
        "Order is missing PDF data (single_pdf_url or page_count). Run /api/pdf/single-url first.",
        400
      );
    }

    const { payload, gelato } = await gelatoCreateOrder(env, {
      order: ord,
      shipment,
      customer,
      currency,
    });

    return ok({ ok: true, payloadSent: payload, gelato });
  } catch (e) {
    if (e?.name === "GelatoError") {
      return ok(
        {
          ok: false,
          error: e.message,
          status: e.status,
          url: e.url,
          details: e.data || e.raw || null,
          where: "gelato.create",
        },
        { status: 400 }
      );
    }
    return err(e?.message || "gelato create failed", 500, {
      where: "gelato.create",
    });
  }
}

async function handleGelatoWebhook(req, env) {
  try {
    const evt = await req.json().catch(() => ({}));

    console.log("🔁 Gelato Webhook Payload:", JSON.stringify(evt, null, 2));

    const gelatoOrderId =
      evt?.orderId || evt?.id || evt?.data?.orderId || null;

    const status =
      mapGelatoStatus(evt) ||
      (evt?.eventType ? String(evt.eventType).toLowerCase() : "unknown");

    let orderId = null;
    if (gelatoOrderId) {
      orderId = await env.ORDERS.get(`GELATO_IDX:${gelatoOrderId}`);
      if (orderId) {
        await kvAttachFiles(env, orderId, {
          gelato_status: status,
          gelato_status_raw: evt?.fulfillmentStatus || evt?.status || null,
        });
      }
    }

    return new Response(
      JSON.stringify(
        {
          received: true,
          gelatoOrderId,
          status,
          mappedOrderId: orderId || null,
          rawEventType: evt?.eventType || null,
          fulfillmentStatus: evt?.fulfillmentStatus || evt?.status || null,
        },
        null,
        2
      ),
      {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
        status: 200,
      }
    );
  } catch (e) {
    return err(e?.message || "webhook error", 500);
  }
}

async function handleGelatoOrderStatus(req, env) {
  try {
    const url = new URL(req.url);
    const order_id   = url.searchParams.get("order_id");
    const gelato_idQ = url.searchParams.get("gelato_id");

    let ord = null;
    let gelatoId = gelato_idQ || null;

    if (order_id) {
      ord = await kvGetOrder(env, order_id);
      if (!ord) return err("Order not found", 404);
      gelatoId = gelatoId || ord?.files?.gelato_order_id;
    }

    if (!gelatoId) return err("Missing gelato_id (and order had none)", 400);

    const data = await gelatoGetOrder(env, gelatoId);
    const status = mapGelatoStatus(data);

    if (ord?.id) {
      await kvAttachFiles(env, ord.id, {
        gelato_status: status,
        gelato_status_raw: data?.fulfillmentStatus || data?.status || null
      });
    }

    return ok({ gelato_id: gelatoId, status, raw: data });
  } catch (e) {
    return err(e?.message || "order-status failed", 500);
  }
}

async function handleGelatoStatus(req, env) {
  const { searchParams } = new URL(req.url);
  const order_id = searchParams.get("order_id");
  if (!order_id) return err("Missing order_id", 400);

  const ord = await kvGetOrder(env, order_id);
  if (!ord) return err("Order not found", 404);

  const gelatoId = ord?.files?.gelato_order_id;
  if (!gelatoId) return err("No gelato_order_id on this order", 404);

  const g = await gelatoGetOrder(env, gelatoId);
  const status = mapGelatoStatus(g);
  const hist   = Array.isArray(g.statusHistory) ? g.statusHistory : [];
  const lastHist = hist.length ? (hist[hist.length - 1]?.status || hist[hist.length - 1]) : null;

  return ok({
    order: ord,
    gelato: g,
    derived: {
      status,
      lastHistory: lastHist,
      pageCount: g?.items?.[0]?.pageCount ?? ord?.files?.page_count ?? null,
      productUid: g?.items?.[0]?.productUid ?? null,
      shippingAddress: g?.shippingAddress ?? null
    }
  });
}

async function handleGelatoProductInfo(req, env) {
  try {
    const u = new URL(req.url);
    const uid  = u.searchParams.get("uid");
    const mode = (u.searchParams.get("mode") || "info").toLowerCase();
    if (!uid) return ok({ ok:false, error:"Missing uid" }, 400);

    if (mode === "probe") {
      const from = Number(u.searchParams.get("from") || 24);
      const to   = Number(u.searchParams.get("to")   || 60);
      const counts = await probeValidPageCounts(env, uid, { from, to });
      return ok({ ok:true, mode, uid, validPageCounts: counts });
    }

    const url = `${GELATO_BASE_V3.product}/products/${encodeURIComponent(uid)}`;
    const raw = await gelatoFetchV3(url, env);
    const pageInfo = extractPageInfoFromProductV3(raw);
    return ok({ ok:true, mode:"info", uid, pageInfo, raw });
  } catch (e) {
    const status = e?.status || 500;
    return ok({ ok:false, error:String(e?.message||e), details:e?.data||null }, status);
  }
}

async function handleGelatoDebugStatus(req, env) {
  try {
    const url = new URL(req.url);
    const gelatoId = url.searchParams.get("gelato_id") || url.searchParams.get("id");
    if (!gelatoId) return err("Missing gelato_id", 400);

    const data = await gelatoGetOrder(env, gelatoId);
    const status = mapGelatoStatus(data);

    return ok({ ok: true, gelato_id: gelatoId, status, raw: data });
  } catch (e) {
    return err(e?.message || "gelato debug-status failed", 500);
  }
}
export default {
  async fetch(req, env, ctx) {
    // 1) Alltid svara på preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      const url = new URL(req.url);
      // 2) Normalisera path (ta bort trailing slash)
      const pathname = url.pathname.replace(/\/+$/g, "") || "/";

      // 3) Health/Diag
      if ((req.method === "GET" || req.method === "HEAD") && pathname === "/") {
        return ok({ ok: true, ts: Date.now() });
      }
      if (req.method === "GET" && pathname === "/api/diag") {
        return await handleDiagRequest(req, env);
      }

      // 4) Orders (KV)
      if (req.method === "POST" && pathname === "/api/orders/draft") {
        return await handleOrdersDraft(req, env);
      }
      if (req.method === "GET" && pathname === "/api/orders/status") {
        return await handleOrdersStatus(req, env);
      }
      if (req.method === "GET" && pathname === "/api/order/get") {
        return await handleOrderGet(req, env);
      }

      // 5) Checkout (Stripe)
      if (req.method === "GET" && pathname === "/api/checkout/ping") {
        return await handleCheckoutPing(req, env);
      }
      if (req.method === "GET" && pathname === "/api/checkout/price") {
        return await handleCheckoutPriceLookup(req, env);
      }
      if (req.method === "POST" && pathname === "/api/checkout/pdf") {
        return await handleCheckoutPdf(req, env);
      }
      // Enda printed
      if (req.method === "POST" && pathname === "/api/checkout/printed") {
        return await handleCheckoutPrinted(req, env);
      }
      if (req.method === "GET" && pathname === "/api/checkout/verify") {
        return await handleCheckoutVerify(req, env);
      }
      if (req.method === "GET" && pathname === "/api/checkout/order-id") {
        return await handleCheckoutOrderId(req, env);
      }

      // Stripe-webhook (rå body etc)
      if (req.method === "POST" && pathname === "/api/stripe/webhook") {
        return await handleStripeWebhook(req, env);
      }

      // 6) Story & Images
      if (req.method === "POST" && pathname === "/api/story") {
        return await handleStory(req, env);
      }
      if (req.method === "POST" && pathname === "/api/ref-image") {
        return await handleRefImage(req, env);
      }
      if (req.method === "POST" && pathname === "/api/images") {
        return await handleImagesBatch(req, env);
      }
      if (req.method === "POST" && pathname === "/api/images/next") {
        return await handleImagesNext(req, env);
      }
      if (req.method === "POST" && pathname === "/api/image/regenerate") {
        return await handleImageRegenerate(req, env);
      }
      if (req.method === "POST" && pathname === "/api/cover") {
        return await handleCover(req, env);
      }

      // 7) PDF build & storage
      if (req.method === "POST" && pathname === "/api/images/upload") {
        return await handleUploadRequest(req, env);
      }
      if (req.method === "POST" && pathname === "/api/pdf") {
        return await handlePdfRequest(req, env);
      }
      if (req.method === "POST" && pathname === "/api/pdf/count-by-url") {
        return await handlePdfCountByUrl(req, env);
      }
      if (req.method === "POST" && pathname === "/api/pdf/single-url") {
        return await handlePdfSingleUrl(req, env);
      }

      // 8) Gelato (shipment/prices/create/status/debug/product-info)
      if (req.method === "GET" && pathname === "/api/gelato/shipment-methods") {
        return await handleGelatoShipmentMethods(req, env);
      }
      if (req.method === "GET" && pathname === "/api/gelato/prices") {
        return await handleGelatoPrices(req, env);
      }
      if (req.method === "POST" && pathname === "/api/gelato/create") {
        return await handleGelatoCreate(req, env);
      }
      if (req.method === "POST" && pathname === "/api/gelato/webhook") {
        return await handleGelatoWebhook(req, env);
      }
      if (req.method === "GET" && pathname === "/api/gelato/status") {
        return await handleGelatoStatus(req, env);
      }
      if (req.method === "GET" && pathname === "/api/gelato/order-status") {
        return await handleGelatoOrderStatus(req, env);
      }
      if (req.method === "GET" && pathname === "/api/gelato/product-info") {
        return await handleGelatoProductInfo(req, env);
      }
      if (req.method === "GET" && pathname === "/api/gelato/debug-status") {
        return await handleGelatoDebugStatus(req, env);
      }

      // 9) 404
      return err("Not found", 404);
    } catch (e) {
      // 10) Alltid CORS på oväntade fel
      return err(e?.message || "Unhandled error", 500);
    }
  },
};