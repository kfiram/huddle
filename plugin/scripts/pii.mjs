// huddle/plugin/scripts/pii.mjs — ADVISOR 2026-10-31 — a copy of tools/whatsup/pii-filter.mjs (S.12) for the plugin, which ships on its own:
// secrets and personal details are MASKED on the agent's own machine before its work lines leave it (mirror.mjs). Keep the two in step.
const SECRET = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bgithub_pat_[A-Za-z0-9_]{30,}/g, /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bAIza[0-9A-Za-z_-]{35}\b/g, /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?<![\d])(?:\+972[-\s]?|0)(?:5\d|[2-489]|7\d)[-\s]?\d{3}[-\s]?\d{4}(?![\d])|(?<![\d\w])\+(?:[1-9]\d{0,2})[-\s]?\d{2,4}[-\s]?\d{3,4}[-\s]?\d{3,4}(?![\d])/g;
const DIGITS = /(?<![\d])\d(?:[ -]?\d){8,18}(?![\d])/g;
const luhn = (d) => { let s = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; } return s % 10 === 0; };
const ilId = (d) => { if (d.length !== 9) return false; let s = 0; for (let i = 0; i < 9; i++) { let n = +d[i] * ((i % 2) + 1); if (n > 9) n -= 9; s += n; } return s % 10 === 0; };

/** Pure: every match, with its kind. → [{ kind, value }] */
export function findings(text) {
  const t = String(text || ''), out = [];
  for (const re of SECRET) for (const m of t.matchAll(re)) out.push({ kind: 'secret', value: m[0] });
  for (const m of t.matchAll(EMAIL)) out.push({ kind: 'email', value: m[0] });
  for (const m of t.matchAll(PHONE)) out.push({ kind: 'phone', value: m[0] });
  for (const m of t.matchAll(DIGITS)) { const d = m[0].replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && luhn(d)) out.push({ kind: 'card', value: m[0] }); else if (ilId(d)) out.push({ kind: 'id', value: m[0] }); }
  return out;
}
/** Pure: the text with each finding masked, and how many. → { text, masked, kinds } */
export function mask(text) {
  let t = String(text || ''); const f = findings(t).sort((a, b) => b.value.length - a.value.length);
  for (const x of f) t = t.split(x.value).join(`[${x.kind} hidden]`);
  return { text: t, masked: f.length, kinds: [...new Set(f.map((x) => x.kind))] };
}
