/**
 * Byte-aware text slicing for WeChat / WeCom provider limits.
 *
 * egress is a standalone Node service deployed independently of the Worker;
 * it cannot reach ../src/channels/text-bytes.mjs. This is a self-contained
 * copy kept behavior-identical to the Worker-side helper.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function sliceByBytes(text, maxBytes) {
  const value = String(text ?? "");
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;

  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return decoder.decode(bytes.subarray(0, cut));
}

export function byteLength(text) {
  return encoder.encode(String(text ?? "")).byteLength;
}
