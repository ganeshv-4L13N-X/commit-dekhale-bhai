// Secret redaction for anything a Node lab writes to a trace, stdout, or an error message.
// A Node port of spans.py's redact() - same patterns, same "redact at the sink" rule: this is
// applied at write time, not hoped for upstream, so it can't be forgotten by a caller.
const SECRET_NAMES = /(token|secret|passw(or)?d|credential|api_?key|private_?key|auth|_key$)/i;
const PATTERNS = [
  [/bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer [REDACTED]"],
  [/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]"],
  [/\b[0-9a-f]{32,}\b/g, "[REDACTED-HEX]"],
];

function secretValues() {
  return Object.entries(process.env)
    .filter(([k, v]) => SECRET_NAMES.test(k) && v && v.length >= 8)
    .map(([, v]) => v);
}

/** Mask secrets in a string, or recursively in an array/object. limit=null keeps the full length
    (for text that is sent on, e.g. a diff); the default MAX_ATTR-style cut is 600 chars. */
export function redact(value, limit = 600) {
  if (Array.isArray(value)) return value.map((v) => redact(v, limit));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_NAMES.test(k) ? "[REDACTED]" : redact(v, limit);
    return out;
  }
  if (typeof value !== "string") return value;
  let out = value;
  for (const secret of secretValues()) out = out.split(secret).join("[REDACTED]");
  for (const [pat, repl] of PATTERNS) out = out.replace(pat, repl);
  if (limit != null && out.length > limit) out = `${out.slice(0, limit)}...[+${out.length - limit} chars]`;
  return out;
}
