// Splitting a body into the units a judgement is actually about. This is the part that changes per
// corpus; the check types and the engine do not.

// A JSONPath SUBSET, deliberately. Four operators cover every sweep written so far ($, .key, ..key,
// [*]) and a real JSONPath library would be a dependency for that. If a sweep ever needs filters or
// slices, add them here with a test rather than reaching for a package.
export function jsonPath(obj, expr) {
  // `$.sections..items[*].description` splits to ['sections', '', 'items[*]', 'description'].
  // The EMPTY segment is what `..` leaves behind, so it does not select anything itself; it sets a
  // flag that makes the NEXT segment search the whole subtree instead of one level.
  const parts = String(expr).replace(/^\$\.?/, '').split('.');
  let cur = [{ path: '', value: obj }];
  let descend = false;
  for (const part of parts) {
    if (part === '') { descend = true; continue; }
    const star = part.endsWith('[*]');
    const key = star ? part.slice(0, -3) : part;
    const next = [];
    for (const node of cur) {
      for (const f of collect(node, key, descend)) {
        if (!star) { next.push(f); continue; }
        if (!Array.isArray(f.value)) continue;
        f.value.forEach((v, i) => next.push({ path: `${f.path}[${i}]`, value: v }));
      }
    }
    cur = next;
    descend = false;
  }
  // `null` is kept, because a null field is something the chunker drops and COUNTS. Filtering it
  // here made it vanish before the drop counter could see it.
  return cur.filter((n) => n.value !== undefined);
}

function collect(node, key, recursive) {
  const out = [];
  const walk = (value, path, deep) => {
    if (value === null || typeof value !== 'object') return;
    if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)) {
      out.push({ path: path ? `${path}.${key}` : key, value: value[key] });
    }
    if (!deep) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, deep));
    else for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k, deep);
  };
  walk(node.value, node.path, recursive);
  return out;
}

// ⚠ Tags come out, ENTITIES STAY. `&amp;` is content as far as this tool is concerned, and a
// no-entities check looks for exactly that pattern in the chunk text. Decode here and that check
// reports clean forever, which is the failure mode a passing test cannot see.
//
// Block tags become a space and inline tags become nothing, so `Built X<br>Shipped Y` stays two
// words while `A <strong>bold</strong> claim` stays one phrase.
//
// ⚠ TEXT OUTSIDE THE <li>s IS KEPT, as one more piece after the bullets. A `<p>` lead line before
// the list is the normal editor shape, and taking only the items threw it away before anything
// counted it. Blank pieces are returned, not filtered, so the caller counts them as dropped: an
// empty description is `['']`, one drop, rather than nothing at all.
const LI = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
const toText = (s) => s.replace(/<\/?(?:p|br|li|ul|ol|div|h[1-6])\b[^>]*>/gi, ' ')
  .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
export function htmlLi(html) {
  const s = String(html);
  const items = [...s.matchAll(LI)].map((m) => toText(m[1]));
  if (!items.length) return [toText(s)];
  const rest = toText(s.replace(LI, ' '));
  return rest ? [...items, rest] : items;
}

const THEN = { 'html-li': htmlLi };

// `stats` is an out-parameter, and it exists because the return value cannot carry the one number
// that matters here. A null field, an empty or blank <li>, a blank piece and a JSONPath landing on an
// object or array are all dropped, and the caller sees only the survivors. NOTHING SWEPT fires at
// zero and says nothing about partial loss, so every one of those drops is counted here. The one
// uncounted case is a `[*]` on a non-array, which selects nothing rather than dropping something.
// ponytail: counting that needs jsonPath to report misses per segment, add it if a real sweep hits it.
export function chunk(body, spec, stats = {}) {
  const type = spec?.type;
  // ⚠ THE BODY SHAPE MUST MATCH THE STRATEGY. `String()` on a parsed JSON array gives one chunk of
  // `[object Object],[object Object]` or a comma-joined run of strings, which is judged and can come
  // back clean. A text strategy wants text and a list strategy wants an array, so either mismatch
  // throws before anything is sent.
  if ((type === 'lines' || type === 'paragraphs') && typeof body !== 'string') {
    throw new Error(`chunk type ${type} needs a text body, and this one parsed as JSON (pass --text to read it as text)`);
  }
  if ((type === 'files' || type === 'records') && !Array.isArray(body)) {
    throw new Error(`chunk type ${type} needs a JSON array body`);
  }
  let picked = [];
  // An object or array value is a path one segment short. `String()` renders it as `[object Object]`
  // or a comma-joined list of them, text about nothing, so it becomes a blank and is counted.
  if (type === 'jsonpath') picked = jsonPath(body, spec.path).map((h) => ({ path: h.path,
    text: h.value === null || typeof h.value === 'object' ? '' : String(h.value) }));
  // One trailing newline is the end of the file, not a blank line, so it is not counted as a drop.
  else if (type === 'lines') picked = body.replace(/\r?\n$/, '').split(/\r?\n/).map((t, i) => ({ path: `line[${i}]`, text: t }));
  else if (type === 'paragraphs') picked = body.split(/\n\s*\n/).map((t, i) => ({ path: `para[${i}]`, text: t }));
  else if (type === 'files') picked = body.map((f) => ({ path: f.path, text: String(f.text ?? '') }));
  // A null record is nothing to judge, so it is blanked and counted rather than sent as "null".
  else if (type === 'records') picked = body.map((r, i) => ({ path: `record[${i}]`, text: r == null ? '' : JSON.stringify(r) }));
  else throw new Error(`unknown chunk type: ${type}`);

  // An unrecognised `then` throws, exactly as an unrecognised `type` does. Silently ignoring it
  // would ship whole <ul> blobs to the model on a typo in a sweep file, which is the failure this
  // layer exists to prevent, and nothing in the output would show it. No `then` at all stays fine.
  if (spec?.then != null && !Object.hasOwn(THEN, spec.then)) throw new Error(`unknown chunk then: ${spec.then}`);
  const split = THEN[spec?.then];
  const out = [];
  let offered = 0;
  for (const p of picked) {
    const pieces = split ? split(p.text) : [p.text];
    offered += pieces.length;
    pieces.forEach((text, i) => {
      // A blank chunk is dropped, never sent. Given nothing to read, Jev answers from a prior
      // (measured mean 0.48 on an empty string), so an empty chunk buys a confident answer about
      // nothing and costs a question to get it.
      //
      // `[object Object]` is the same case wearing a disguise. A JSONPath landing one segment short
      // lands on an object, `String(value)` renders it as that literal, and it is non-blank so it
      // survives the guard above, gets asked about and can come back clean. The jsonpath arm blanks
      // objects before they get here, and this catches the literal arriving from any other arm.
      if (!String(text).trim() || String(text) === '[object Object]') return;
      out.push({ id: `c${out.length}`, path: split ? `${p.path}[${i}]` : p.path, text: String(text) });
    });
  }
  // `offered` counts pieces after the `then` split, not nodes before it, because that is the unit a
  // chunk would have been. Counting picked nodes instead would report a drop on every html-li sweep
  // that turns 3 nodes into 7 bullets.
  stats.offered = offered;
  stats.dropped = offered - out.length;
  return out;
}
