/**
 * Liberty Coding contact-form worker.
 * Receives the site's form POST and delivers it as an email to the business
 * inbox, with Reply-To set to the visitor so replying just works.
 *
 * Deploy: Cloudflare Worker with secrets/vars:
 *   RESEND_API_KEY  (secret) — Resend API key
 *   TO_EMAIL        (var)    — where leads land, e.g. josh@libertycoding.net
 *   FROM_EMAIL      (var)    — verified sender, e.g. leads@libertycoding.net
 *   LEADS_WEBHOOK_URL (secret, optional) — if set, also pings Discord #leads
 * Never commit any of these; the webhook URL and API key are bearer credentials.
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "method" }, 405, origin);
    }

    let data;
    try {
      data = await request.json();
    } catch {
      return json({ ok: false, error: "bad json" }, 400, origin);
    }

    // Honeypot: bots fill every field. Pretend success, deliver nothing.
    if (clean(data.company, 10)) {
      return json({ ok: true }, 200, origin);
    }

    const name = oneLine(data.name, 120);
    const email = oneLine(data.email, 200);
    const message = clean(data.message, 2000);
    const service = SERVICES.has(data.service) ? data.service : "other";

    if (!name || !message || !email.includes("@") || email.length < 5) {
      return json({ ok: false, error: "missing fields" }, 400, origin);
    }

    const text = [
      `Name: ${name}`,
      `Email: ${email}`,
      `Looking for: ${LABELS[service]}`,
      ``,
      message,
      ``,
      `— sent from the libertycoding.net contact form`,
    ].join("\n");

    let delivered = false;
    try {
      const res = await withTimeout(
        (signal) =>
          fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: `Liberty Coding leads <${env.FROM_EMAIL}>`,
              to: [env.TO_EMAIL],
              reply_to: email,
              subject: `New lead — ${LABELS[service]} — ${name}`,
              text,
            }),
            signal,
          }),
        10000,
      );
      delivered = res.ok;
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
                      ? "New lead (emailed to inbox)"
                      : "New lead — EMAIL DELIVERY FAILED, this ping is the only copy",
                    color: delivered ? 0x2563eb : 0xdc2626,
                    fields: [
                      { name: "Name", value: name.slice(0, 256) },
                      { name: "Email", value: email.slice(0, 256) },
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
