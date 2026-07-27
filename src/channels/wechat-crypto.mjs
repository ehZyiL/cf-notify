/**
 * WeChat message encryption helpers (安全模式).
 * EncodingAESKey is 43-char base64; AES key = base64(AESKey + "=") 32 bytes.
 * PKCS#7 pad to 32; layout: random(16) + msg_len(4 BE) + msg + appId
 *
 * P1.5: encrypt/decrypt used when WECHAT_AES_KEY is set.
 */

// Node and Workers both have subtle for AES-CBC
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function pkcs7Pad(data, blockSize = 32) {
  const pad = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + pad);
  out.set(data);
  out.fill(pad, data.length);
  return out;
}

function pkcs7Unpad(data) {
  const pad = data[data.length - 1];
  if (pad < 1 || pad > 32 || pad > data.length) {
    throw new Error("invalid PKCS#7 padding");
  }
  for (let index = data.length - pad; index < data.length; index += 1) {
    if (data[index] !== pad) throw new Error("invalid PKCS#7 padding");
  }
  return data.subarray(0, data.length - pad);
}

function aesKeyFromEncoding(encodingAesKey) {
  // WeChat: EncodingAESKey + "=" then standard base64 decode → 32 bytes
  const b64 = String(encodingAesKey || "").trim() + "=";
  const binary = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const key = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) key[i] = binary.charCodeAt(i);
  if (key.length !== 32) throw new Error("EncodingAESKey must decode to 32 bytes");
  return key;
}

function writeUInt32BE(n) {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xff;
  b[1] = (n >>> 16) & 0xff;
  b[2] = (n >>> 8) & 0xff;
  b[3] = n & 0xff;
  return b;
}

function readUInt32BE(buf, offset) {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

export async function wechatEncrypt(plainXml, encodingAesKey, appId) {
  const key = aesKeyFromEncoding(encodingAesKey);
  const iv = key.subarray(0, 16);
  const random = crypto.getRandomValues(new Uint8Array(16));
  const msg = textEncoder.encode(plainXml);
  const app = textEncoder.encode(appId);
  const len = writeUInt32BE(msg.length);
  const raw = new Uint8Array(random.length + 4 + msg.length + app.length);
  raw.set(random, 0);
  raw.set(len, 16);
  raw.set(msg, 20);
  raw.set(app, 20 + msg.length);
  const padded = pkcs7Pad(raw, 32);

  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
  const cipherWithWebPadding = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv }, cryptoKey, padded)
  );
  // Web Crypto always adds 16-byte PKCS#7 padding. The WeChat protocol has
  // already padded to 32 bytes, so discard only Web Crypto's final block.
  const cipher = cipherWithWebPadding.subarray(0, cipherWithWebPadding.length - 16);
  // WeChat uses standard base64
  let binary = "";
  for (const b of cipher) binary += String.fromCharCode(b);
  return btoa(binary);
}

export async function wechatDecrypt(encryptBase64, encodingAesKey, appId) {
  const key = aesKeyFromEncoding(encodingAesKey);
  const iv = key.subarray(0, 16);
  const binary = atob(String(encryptBase64 || "").replace(/-/g, "+").replace(/_/g, "/"));
  const data = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error("invalid AES-CBC ciphertext length");
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-CBC" },
    false,
    ["encrypt", "decrypt"]
  );
  // Web Crypto rejects protocol padding values 17-32. Append one synthetic
  // ciphertext block whose plaintext is valid 16-byte Web Crypto padding;
  // decrypt() removes that block and leaves the protocol-padded plaintext.
  const lastBlock = data.subarray(data.length - 16);
  const syntheticPaddingBlock = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CBC", iv: lastBlock },
      cryptoKey,
      new Uint8Array(0)
    )
  );
  const decryptable = new Uint8Array(data.length + syntheticPaddingBlock.length);
  decryptable.set(data);
  decryptable.set(syntheticPaddingBlock, data.length);
  const decrypted = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, decryptable)
  );
  const unpadded = pkcs7Unpad(decrypted);
  if (unpadded.length < 20) throw new Error("invalid encrypted message layout");
  const msgLen = readUInt32BE(unpadded, 16);
  if (20 + msgLen > unpadded.length) throw new Error("invalid encrypted message length");
  const msg = textDecoder.decode(unpadded.subarray(20, 20 + msgLen));
  const gotAppId = textDecoder.decode(unpadded.subarray(20 + msgLen));
  if (appId && gotAppId !== appId) {
    throw new Error("appId mismatch in encrypted message");
  }
  return msg;
}
