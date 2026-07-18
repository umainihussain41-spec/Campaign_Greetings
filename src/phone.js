// Normalize an arbitrary phone string to digits, and derive a 10-digit
// "key" used to match the number Exotel reports (To/DialWhomNumber) back
// to the campaign that dialed it.

export function digitsOnly(raw) {
  return String(raw || '').replace(/\D/g, '');
}

// Last 10 digits - robust across "+91 98…", "098…", "98…" variants.
export function numberKey(raw) {
  const d = digitsOnly(raw);
  return d.slice(-10);
}

// Format to E.164 (e.g. +919876543210) - the only shape Exotel's Contacts
// API accepts. Takes the last 10 digits (the subscriber number, consistent
// with numberKey) and prepends the country code. Returns null if too short.
export function toE164(raw, countryCode = '91') {
  const d = digitsOnly(raw);
  if (d.length < 10) return null;
  return `+${countryCode}${d.slice(-10)}`;
}

// Parse a textarea / CSV blob of numbers into a clean, de-duped list.
export function parseNumbers(blob) {
  const seen = new Set();
  const out = [];
  for (const token of String(blob || '').split(/[\s,;]+/)) {
    const d = digitsOnly(token);
    if (d.length < 10) continue;
    const key = d.slice(-10);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
