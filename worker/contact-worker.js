/**
 * Liberty Coding contact-form worker.
 * Receives the site's form POST and forwards it to a private Discord channel.
 *
 * Deploy: Cloudflare Worker with a secret DISCORD_WEBHOOK_URL
 * (the #leads channel webhook — never commit it).
 * The webhook URL is a bearer credential: secret store only.
 */

const ALLOWED_ORIGINS = new Set([
  "https://libertycoding.net",
  "https://www.libertycoding.net",
]);

const SERVICES = new Set([
  "website",
  "automation",
  "custom-tool",
  "assistant",
  "other",
]);

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

const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

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

    // Honeypot: bots fill every field. Pretend success, forward nothing.
    if (clean(data.company, 10)) {
      return json({ ok: true }, 200, origin);
    }

    const name = clean(data.name, 120);
    const email = clean(data.email, 200);
    const message = clean(data.message, 2000);
    const service = SERVICES.has(data.service) ? data.service : "other";

    if (!name || !message || !email.includes("@") || email.length < 5) {
      return json({ ok: false, error: "missing fields" }, 400, origin);
    }

    const labels = {
      website: "A website",
      automation: "Paperwork / automation",
      "custom-tool": "A custom tool",
      assistant: "An assistant that answers questions",
      other: "Something else / not sure",
    };

    const payload = {
      username: "libertycoding.net",
      // No allowed mentions: form text is visitor-controlled.
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: "New lead from the website",
          color: 0x2563eb,
          fields: [
            { name: "Name", value: name.slice(0, 256) },
            { name: "Email", value: email.slice(0, 256) },
            { name: "Looking for", value: labels[service] },
            { name: "Message", value: message.slice(0, 1024) },
          ],
        },
      ],
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) return json({ ok: false, error: "relay" }, 502, origin);
      return json({ ok: true }, 200, origin);
    } catch {
      return json({ ok: false, error: "relay" }, 502, origin);
    } finally {
      clearTimeout(timer);
    }
  },
};
