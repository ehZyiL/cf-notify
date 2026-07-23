const textEncoder = new TextEncoder();

export function base64UrlEncode(bytes) {
  let binary = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlDecode(value) {
  const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function timingSafeEqual(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 32) {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return base64UrlEncode(buf);
}

export async function sha1Hex(value) {
  const digest = await crypto.subtle.digest("SHA-1", textEncoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PASSWORD_ITERATIONS = 100000;

async function pbkdf2(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(password || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256
  );
  return new Uint8Array(bits);
}

export async function hashSecret(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(secret, salt, PASSWORD_ITERATIONS);
  return `pbkdf2.v1.${PASSWORD_ITERATIONS}.${base64UrlEncode(salt)}.${base64UrlEncode(hash)}`;
}

export async function verifySecret(secret, encoded) {
  const parts = String(encoded || "").split(".");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "v1") return false;
  const iterations = Number(parts[2]);
  if (!Number.isFinite(iterations) || iterations < 100000 || iterations > 100000) return false;
  try {
    const salt = base64UrlDecode(parts[3]);
    const expected = parts[4];
    const actual = base64UrlEncode(await pbkdf2(secret, salt, iterations));
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function verifyJwtHs256(token, secret, options = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("invalid token format");
  const [h, p, s] = parts;
  const body = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(body)));
  const expected = base64UrlEncode(sig);
  if (!timingSafeEqual(s, expected)) throw new Error("invalid token signature");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p)));
  } catch {
    throw new Error("invalid token payload");
  }
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || now >= payload.exp) throw new Error("token expired");
  if (options.audience != null && payload.aud !== options.audience) {
    throw new Error("invalid token audience");
  }
  return payload;
}

export async function signJwtHs256(claims, secret, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? 3600;
  const header = base64UrlEncode(textEncoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64UrlEncode(
    textEncoder.encode(
      JSON.stringify({
        ...claims,
        iat: now,
        exp: now + ttl
      })
    )
  );
  const body = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, textEncoder.encode(body)));
  return `${body}.${base64UrlEncode(sig)}`;
}
