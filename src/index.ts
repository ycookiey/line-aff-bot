interface Env {
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
}

const TAG = "ycookiey-22";

const AMAZON_URL_RE =
  /https?:\/\/(?:www\.)?amazon\.co\.jp\/[^\s)\]>"']*|https?:\/\/amzn\.asia\/[^\s)\]>"']*|https?:\/\/amzn\.to\/[^\s)\]>"']*/g;

// --- LINE 署名検証 ---

async function verifySignature(
  secret: string,
  body: string,
  signature: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === signature;
}

// --- Amazon URL 変換 ---

function extractAsin(url: string): string | null {
  const m = url.match(/\/dp\/([A-Z0-9]{10})/);
  if (m) return m[1];
  const m2 = url.match(/\/gp\/product\/([A-Z0-9]{10})/);
  if (m2) return m2[1];
  return null;
}

function isShortUrl(url: string): boolean {
  return url.includes("amzn.asia/") || url.includes("amzn.to/");
}

async function resolveShortUrl(url: string): Promise<string> {
  try {
    const resp = await fetch(url, { redirect: "manual" });
    const loc = resp.headers.get("Location");
    // ボディを消費してコネクションを解放
    await resp.body?.cancel();
    return loc || url;
  } catch {
    return url;
  }
}

async function makeAffiliateUrl(url: string): Promise<string> {
  let resolved = url;
  if (isShortUrl(url)) {
    resolved = await resolveShortUrl(url);
  }
  const asin = extractAsin(resolved);
  if (asin) {
    return `https://www.amazon.co.jp/dp/${asin}?tag=${TAG}`;
  }
  // ASINが取れない場合はタグだけ付与
  const u = new URL(resolved);
  u.searchParams.set("tag", TAG);
  return u.toString();
}

async function shorten(longUrl: string): Promise<string> {
  try {
    const apiUrl = `https://is.gd/create.php?format=json&url=${encodeURIComponent(longUrl)}`;
    const resp = await fetch(apiUrl);
    if (!resp.ok) {
      const errBody = await resp.text();
      console.error(`is.gd error ${resp.status}: ${errBody}`);
      return longUrl;
    }
    const data = (await resp.json()) as { shorturl?: string; errorcode?: number; errormessage?: string };
    if (data.shorturl) return data.shorturl;
    console.error(`is.gd error: ${data.errormessage}`);
    return longUrl;
  } catch (e) {
    console.error("is.gd exception:", e);
    return longUrl;
  }
}

async function convertUrls(text: string): Promise<string[]> {
  const urls = [...new Set(text.match(AMAZON_URL_RE) || [])];
  if (urls.length === 0) return [];

  // 並列処理で高速化（replyToken有効期限対策）
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const affiliate = await makeAffiliateUrl(url);
        return await shorten(affiliate);
      } catch {
        return url;
      }
    })
  );
  return results;
}

// --- LINE Reply ---

async function replyMessage(
  replyToken: string,
  messages: string[],
  accessToken: string
): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: messages.join("\n") }],
    }),
  });
}

// --- Worker ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK");
    }

    const url = new URL(request.url);
    if (url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    const body = await request.text();

    // 署名検証
    const signature = request.headers.get("X-Line-Signature") || "";
    const valid = await verifySignature(env.LINE_CHANNEL_SECRET, body, signature);
    if (!valid) {
      return new Response("Invalid signature", { status: 403 });
    }

    const payload = JSON.parse(body) as {
      events: Array<{
        type: string;
        replyToken: string;
        message?: { type: string; text: string };
      }>;
    };

    try {
      for (const event of payload.events) {
        if (event.type !== "message" || event.message?.type !== "text") continue;

        const text = event.message.text;
        const converted = await convertUrls(text);

        if (converted.length > 0) {
          await replyMessage(
            event.replyToken,
            converted,
            env.LINE_CHANNEL_ACCESS_TOKEN
          );
        }
      }
    } catch (e) {
      console.error("Webhook error:", e);
      return new Response("Internal Error", { status: 500 });
    }

    return new Response("OK");
  },
};
