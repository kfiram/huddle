// huddle/plugin/scripts/e2e.mjs — a byte-for-byte copy of huddle/crypto/e2e.mjs (the plugin ships alone; tests/huddle-e2e.test.mjs keeps them equal)
// אנקריפטד. אצלנו יש דרך?» → «ויאללה הצפנה».
// ONE MODULE, EVERY END: WebCrypto only, so the same file runs in the browser (the web app), in Node (an agent's local Huddle proxy) and in
// tests. The server never imports it - it only stores what this produces.
//   · a ROOM KEY: 32 random bytes, AES-256-GCM. A sealed room's every text is «e2e1:<iv>:<ciphertext>» under it.
//   · a DEVICE IDENTITY: an ECDH P-256 key pair made on the device; its private half never leaves it.
//   · the room key reaches a device WRAPPED to that device's public key: an ephemeral ECDH key, HKDF-SHA-256, AES-GCM - so the server
//     holds, per device, a box only that device opens.
// What stays visible to the server, by design: who is in a room, who wrote when, message sizes, reactions, and an @tag the sender chose
// to show (routing). Never the words.
const C = globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto : null;
const S = () => { if (!C) throw new Error('WebCrypto is not available here'); return C.subtle; };
const enc = new TextEncoder(), dec = new TextDecoder();
export const PREFIX = 'e2e1:';

export const b64 = (u8) => { let s = ''; const a = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
export const unb64 = (s) => Uint8Array.from(atob(String(s || '')), (c) => c.charCodeAt(0));
const rand = (n) => { const u = new Uint8Array(n); C.getRandomValues(u); return u; };

/** A new room key, as base64 (32 bytes). */
export const newRoomKey = () => b64(rand(32));
const aes = (raw, use) => S().importKey('raw', unb64(raw), { name: 'AES-GCM' }, false, use);

/** Is this text sealed? */
export const isSealed = (t) => typeof t === 'string' && t.startsWith(PREFIX);

/** text → «e2e1:<iv>:<ct>» under the room key */
export async function seal(roomKey, text) {
  const iv = rand(12), ct = await S().encrypt({ name: 'AES-GCM', iv }, await aes(roomKey, ['encrypt']), enc.encode(String(text ?? '')));
  return `${PREFIX}${b64(iv)}:${b64(ct)}`;
}
/** «e2e1:…» → text; throws on a wrong key or a changed byte (AES-GCM authenticates) */
export async function open(roomKey, sealed) {
  if (!isSealed(sealed)) return sealed;
  const [iv, ct] = sealed.slice(PREFIX.length).split(':');
  return dec.decode(await S().decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aes(roomKey, ['decrypt']), unb64(ct)));
}

/** A device identity: { id, publicJwk, privateJwk }. The id is a short hash of the public key. Keep privateJwk on the device only. */
export async function newIdentity() {
  const kp = await S().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicJwk = await S().exportKey('jwk', kp.publicKey), privateJwk = await S().exportKey('jwk', kp.privateKey);
  return { id: await fingerprint(publicJwk), publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }, privateJwk };
}
/** A public key's short fingerprint (what a person can compare with someone else's screen). */
export async function fingerprint(publicJwk) {
  const d = new Uint8Array(await S().digest('SHA-256', enc.encode(`${publicJwk.crv}:${publicJwk.x}:${publicJwk.y}`)));
  return [...d.slice(0, 10)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const pub = (jwk) => S().importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
const priv = (jwk) => S().importKey('jwk', { ...jwk, ext: true }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
async function kek(myPriv, theirPub, salt) {
  const bits = await S().deriveBits({ name: 'ECDH', public: theirPub }, myPriv, 256);
  const hk = await S().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return S().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('huddle-room-key-v1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
/** The room key, wrapped for one device: { v, epk, salt, iv, ct } - only that device's private key opens it. */
export async function wrapKey(roomKey, recipientPublicJwk) {
  const eph = await S().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const salt = rand(16), iv = rand(12), k = await kek(eph.privateKey, await pub(recipientPublicJwk), salt);
  const e = await S().exportKey('jwk', eph.publicKey);
  return { v: 1, epk: { x: e.x, y: e.y }, salt: b64(salt), iv: b64(iv), ct: b64(await S().encrypt({ name: 'AES-GCM', iv }, k, unb64(roomKey))) };
}
/** A wrapped room key → the room key (base64), with this device's private key */
export async function unwrapKey(w, myPrivateJwk) {
  const k = await kek(await priv(myPrivateJwk), await pub(w.epk), unb64(w.salt));
  return b64(new Uint8Array(await S().decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, k, unb64(w.ct))));
}
