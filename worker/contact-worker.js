/**
 * Liberty Coding contact-form worker.
 * Receives the site's form POST and delivers it as an email to the intake
 * inbox (hello@) through the Gmail API, with Reply-To set to the visitor so
 * replying just works. Optional Discord ping to #leads as a side channel —
 * and the only copy if the email send fails.
 *
 * Deploy (wrangler.toml alongside):
 *   secrets  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   — the "Liberty Helper" OAuth client
 *            GMAIL_SEND_REFRESH_TOKEN                 — gmail.send-only token for joshua@
 *            LEADS_WEBHOOK_URL (optional)             — Discord #leads webhook
 *   vars     TO_EMAIL, FROM_EMAIL                     — hello@libertycoding.net
 *   binding  RATE (ratelimit)                         — per-IP, see wrangler.toml
 * Never commit any secret; the refresh token and webhook URL are bearer credentials.
 *
 * Why Gmail and not a mail API: Josh already owns the mailbox and the OAuth
 * client; a send-only token is one consent click, versus a new vendor account
 * plus its DNS. The token can send as him and nothing else.
 */

const ALLOWED_ORIGINS = new Set([
  "https://libertycoding.net",
  "https://www.libertycoding.net",
]);

const SERVICES = new Set(["website", "automation", "custom-tool", "assistant", "other"]);

const LABELS = {
  website: "A website",
  automation: "Paperwork / automation",
  "custom-tool": "A custom tool",
  assistant: "An assistant that answers questions",
  other: "Something else / not sure",
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://libertycoding.net",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// Header-bound values must never carry line breaks (header injection).
const oneLine = (v, max) =>
  (typeof v === "string" ? v.replace(/[\r\n]+/g, " ").trim().slice(0, max) : "");
const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function withTimeout(doFetch, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await doFetch(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Gmail send -----------------------------------------------------------

function b64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
// RFC 2047 so a non-ASCII name or subject survives the header.
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildRawEmail({ from, to, replyTo, subject, text }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${encHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(text),
  ];
  return b64url(new TextEncoder().encode(lines.join("\r\n")));
}

async function gmailAccessToken(env, signal) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GMAIL_SEND_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
    signal,
  });
  if (!res.ok) throw new Error(`token ${res.status}`);
  return (await res.json()).access_token;
}

async function sendViaGmail(env, { name, email, business, service, text }) {
  return withTimeout(async (signal) => {
    const token = await gmailAccessToken(env, signal);
    const raw = buildRawEmail({
      from: `Liberty Coding site <${env.FROM_EMAIL}>`,
      to: env.TO_EMAIL,
      replyTo: `${encHeader(name)} <${email}>`,
      subject: `New lead — ${LABELS[service]} — ${name}${business ? ` (${business})` : ""}`,
      text,
    });
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
      signal,
    });
    return res.ok;
  }, 10000);
}

// ---- Handler --------------------------------------------------------------

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "method" }, 405, origin);
    }

    // Per-IP rate limit (binding configured in wrangler.toml). Absent binding
    // = no limit, so a misconfigured deploy degrades to "works" not "blocks".
    if (env.RATE) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.RATE.limit({ key: ip });
      if (!success) return json({ ok: false, error: "slow down" }, 429, origin);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ ok: false, error: "bad json" }, 400, origin);
    }

    // Honeypot: bots fill every field. Pretend success, deliver nothing.
    // (`website` is the current trap; `company` was the trap before the
    // visible business-name field existed — a cached old page may still send it.)
    if (clean(data.website, 10) || clean(data.company, 10)) {
      return json({ ok: true }, 200, origin);
    }

    const name = oneLine(data.name, 120);
    const email = oneLine(data.email, 200);
    const business = oneLine(data.business, 120);
    const message = clean(data.message, 2000);
    const service = SERVICES.has(data.service) ? data.service : "other";

    if (!name || !message || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
      return json({ ok: false, error: "missing fields" }, 400, origin);
    }

    const text = [
      `Name: ${name}`,
      `Email: ${email}`,
      ...(business ? [`Business: ${business}`] : []),
      `Looking for: ${LABELS[service]}`,
      ``,
      message,
      ``,
      `— sent from the libertycoding.net contact form`,
    ].join("\n");

    let delivered = false;
    try {
      delivered = await sendViaGmail(env, { name, email, business, service, text });
    } catch {
      delivered = false;
    }

    // Optional side-channel: instant Discord ping if configured.
    if (env.LEADS_WEBHOOK_URL) {
      try {
        await withTimeout(
          (signal) =>
            fetch(env.LEADS_WEBHOOK_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                username: "libertycoding.net",
                allowed_mentions: { parse: [] },
                embeds: [
                  {
                    title: delivered
                      ? "New lead (emailed to hello@)"
                      : "New lead — EMAIL DELIVERY FAILED, this ping is the only copy",
                    color: delivered ? 0x2563eb : 0xdc2626,
                    fields: [
                      { name: "Name", value: name.slice(0, 256) },
                      { name: "Email", value: email.slice(0, 256) },
                      ...(business ? [{ name: "Business", value: business.slice(0, 256) }] : []),
                      { name: "Looking for", value: LABELS[service] },
                      { name: "Message", value: message.slice(0, 1024) },
                    ],
                  },
                ],
              }),
              signal,
            }),
          10000,
        );
        // A ping that lands preserves the lead even when email failed.
        delivered = true;
      } catch {
        /* best effort */
      }
    }

    return delivered
      ? json({ ok: true }, 200, origin)
      : json({ ok: false, error: "relay" }, 502, origin);
  },
};
