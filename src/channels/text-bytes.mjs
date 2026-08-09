/**
 * Byte-aware text slicing for WeChat / WeCom provider limits.
 *
 * Provider text fields (text.content, markdown.content) are byte-limited
 * (2048 bytes), not character-limited. Naive .slice(0, 2000) on a CJK string
 * produces up to 6000 bytes and gets truncated/rejected by the provider.
 *
 * sliceByBytes trims to a byte budget without splitting a multibyte sequence.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function sliceByBytes(text, maxBytes) {
  const value = String(text ?? "");
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;

  // Walk back until the byte view is decodable without splitting a multibyte
  // sequence. TextDecoder fatal=false would otherwise emit a replacement char.
  let cut = maxBytes;
  // A UTF-8 leading byte never starts with 10xxxxxx (0x80-0xBF); trim
  // trailing continuation bytes so we land on a clean boundary.
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
  return decoder.decode(bytes.subarray(0, cut));
}

export function byteLength(text) {
  return encoder.encode(String(text ?? "")).byteLength;
}
