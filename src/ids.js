/**
 * XDB-style IDs (see `AbstractIds.putId` in xdb, default/standard length):
 * numeric stored as string, 22 date-based digits:
 *   yy + dayOfYear(3) + HHmmss + millis(3) + bite(8)
 * The bite is random (0..99999999); if `user` is given,
 * it is salt(3) + random 0..99999.
 */

function asLeadingZeros(n, len) {
  return String(n).padStart(len, "0");
}

function weight(str) {
  let j = 0;
  for (const ch of str) j += ch.codePointAt(0);
  return j;
}

function salt(str, n = 5) {
  if (!str) return str;
  let s = String(weight(str));
  if (s.length < n) s = "0" + s;
  else if (s.length > n) s = s.substring(s.length - n);
  return s;
}

function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}

export function newMessageId(user = null, stamp = null) {
  const t = stamp ?? new Date();
  const yy = String(t.getFullYear()).substring(2, 4);
  const days = asLeadingZeros(dayOfYear(t), 3);
  const hh = asLeadingZeros(t.getHours(), 2);
  const mm = asLeadingZeros(t.getMinutes(), 2);
  const ss = asLeadingZeros(t.getSeconds(), 2);
  const millis = asLeadingZeros(t.getMilliseconds(), 3);
  let head = yy + days + hh + mm + ss;
  let bite;
  if (user) bite = salt(user, 3) + asLeadingZeros(Math.floor(Math.random() * 100000), 5);
  else bite = asLeadingZeros(Math.floor(Math.random() * 100000000), 8);
  return head + millis + bite;
}

export function nowIso() {
  return new Date().toISOString();
}

/** TTL epoch seconds: now + 30 days */
export function ttl30d(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000) + 30 * 24 * 60 * 60;
}

export function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter(Boolean).map(String) : [String(v)];
}
