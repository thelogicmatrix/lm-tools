// Narrow 179 documents to a shortlist locally, before spending a token.
//
// Two reasons, and the second is the one that forces it. Cost: jev bills $0.042 per million input
// tokens and the corpus IS the request, so the bill is linear in how many documents are described.
// Context: jev 1.13's window is 32K and the shipped call already uses 18,546 of it at 103.6 tokens
// a document, so the router stops fitting at about 310 documents. Sending everything every time is
// not just expensive, it has a wall in front of it.
//
// BM25 over the purposes. Not an embedding: an embedding needs a model, a download, or a second
// API call, and this is a lexical problem. "the torrent client stopped downloading after I restarted
// the vpn container" shares rare words with the document that answers it, and a rare shared word is
// what BM25 scores. What it cannot do is match a prompt sharing no vocabulary with the right
// document, which is why it hands jev a shortlist to JUDGE rather than an answer, and why the
// shortlist is sized from the worst rank the probe measured, never the median.
//
// k1 and b are the standard defaults. Left untuned deliberately: fitting two constants to eight
// cases fits the constants to the cases.
const K1 = 1.5;
const B = 0.75;
const STOP = new Set(('a an the and or but if then this that these those is are was were be been being '
  + 'to of in on at for with from by as it its i my me we our you your they them he she his her '
  + 'do does did doing done have has had having can could should would will shall may might must '
  + 'not no nor so than too very just now new get got make made what which who whom when where why '
  + 'how all any both each few more most other some such only own same don').split(' '));

export const tokenise = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])
  .filter((w) => w.length > 1 && !STOP.has(w));

// The document's own words: its filename AND its purpose. The filename often carries the subject
// (`torrent-vpn-netns`) more plainly than the prose does.
const docWords = (b) => tokenise(b.file.replace(/\.md$/, '') + ' ' + b.purpose);

export function buildIndex(books) {
  const docs = books.map((b) => {
    const tf = new Map();
    const w = docWords(b);
    for (const t of w) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { b, tf, len: w.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return { docs, df, avg: docs.reduce((a, d) => a + d.len, 0) / docs.length, n: docs.length };
}

export function rank(prompt, index) {
  const { docs, df, avg, n } = index;
  const q = tokenise(prompt);
  return docs.map((d) => {
    let s = 0;
    for (const t of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n_t = df.get(t) ?? 0;
      // +1 inside the log keeps a term present in every document at idf 0 rather than negative, so
      // a ubiquitous word cannot push a document DOWN the ranking.
      const idf = Math.log(1 + (n - n_t + 0.5) / (n_t + 0.5));
      s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avg));
    }
    return { b: d.b, s };
  }).sort((x, y) => y.s - x.s);
}

// The shortlist, padded to n even where documents score zero. A zero-score document costs tokens
// and nothing else; a missing one cannot be recovered by the stage that follows.
export const shortlist = (prompt, index, n) => rank(prompt, index).slice(0, n).map((x) => x.b);
