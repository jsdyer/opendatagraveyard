const resolveData = name => new URL(`./data/${name}`, import.meta.url);
const normalize = value => String(value ?? "").normalize("NFKD").toLowerCase()
  .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

let manifest;
let entries = [];
let ready = false;
let queued;
let latest;

async function load(name) {
  const response = await fetch(resolveData(name), { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`Data request returned HTTP ${response.status}`);
  if (!name.endsWith(".gz")) return response.json();
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer[0] === 31 && buffer[1] === 139) {
    return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"))).json();
  }
  return JSON.parse(new TextDecoder().decode(buffer));
}

function frequencies(extract) {
  const counts = new Map();
  for (const { row } of entries) {
    for (const label of extract(row)) {
      if (label) counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  return Array.from(counts.entries());
}

function termsOf(query) {
  return Array.from(query.matchAll(/(^|\s)(-)?(?:"([^"]*)"?|([^\s"]+))/gu))
    .map(match => [normalize(match[3] ?? match[4]), Boolean(match[2])])
    .filter(([term]) => term);
}

function search(filters) {
  const terms = termsOf(filters.q);
  const key = normalize(filters.q);
  let found = [];
  for (const { row, title, french, lookup } of entries) {
    if (filters.org && row[3] !== filters.org) continue;
    if (filters.year && row[4].slice(0, 4) !== filters.year) continue;
    if (filters.facet && !row[5].includes(filters.facet)) continue;
    if (!terms.every(([term, exclusion]) => lookup.includes(term) !== exclusion)) continue;
    let score = 0;
    if (filters.sort === "relevance" && terms.length) {
      if (row[0].toLowerCase() === filters.q.trim().toLowerCase()) score += 120;
      if (key && (title === key || french === key)) score += 30;
      if (key && title.startsWith(key)) score += 9;
      for (const [term, exclusion] of terms) {
        if (!exclusion && (title.includes(term) || french.includes(term))) score += 4;
      }
    }
    found.push({ row, score });
  }
  if (filters.sort === "title") found.sort((a,b) => a.row[1].localeCompare(b.row[1],"en-CA"));
  else if (filters.sort === "oldest") found.sort((a,b) => a.row[6].localeCompare(b.row[6]) || a.row[0].localeCompare(b.row[0]));
  else if (filters.sort === "relevance" && terms.length) found.sort((a,b) => b.score - a.score);
  return found;
}

function publicRow(r) {
  if (!r) return null;
  const copy = r.slice();
  copy[7] = "";
  return copy;
}

function postResults(msg) {
  if (!ready) { queued = msg; return; }
  const cache = JSON.stringify(msg.filters);
  if (latest?.cache !== cache) latest = { cache, found: search(msg.filters) };
  const { found } = latest;
  const size = 18;
  const max = Math.max(1, Math.ceil(found.length / size));
  const page = Math.max(1, Math.min(max, msg.page));
  let detail;
  if (msg.record) {
    detail = entries.find(({row}) => row[0] === msg.record && (!msg.date || row[6] === msg.date));
  }
  const selected = msg.random && found.length ? found[Math.floor(Math.random() * found.length)] : detail;
  self.postMessage({
    type:"results", id:msg.id, total:found.length, page, max,
    rows:found.slice((page - 1) * size, page * size).map(x => publicRow(x.row)),
    selected: publicRow(selected?.row),
  });
}

async function init() {
  manifest = await load("manifest.json");
  if (!Array.isArray(manifest.index) || !manifest.index.length || !manifest.count ||
      !["catalogue","graveyard"].includes(manifest.mode)) throw new Error("Malformed snapshot.");
  const chunks = new Array(manifest.index.length);
  let completed = 0;
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(3, manifest.index.length)}, async () => {
    while (cursor < manifest.index.length) {
      const i = cursor++;
      const rows = await load(manifest.index[i]);
      if (!Array.isArray(rows)) throw new Error("Invalid search data.");
      chunks[i] = rows.map(row => {
        if (!Array.isArray(row) || row.length < 9 || !Array.isArray(row[5])) throw new Error("Invalid record.");
        return { row, title:normalize(row[1]), french:normalize(row[2]),
          lookup: normalize([row[0],row[1],row[2],row[3],row[4],row[7],...row[5]].join(" ")) };
      });
      completed += rows.length;
      self.postMessage({ type:"progress", completed, total:manifest.count });
    }
  }));
  entries = chunks.flat();
  if (entries.length !== manifest.count) throw new Error("The dataset download is incomplete.");
  ready = true;
  self.postMessage({
    type:"ready", manifest,
    organizations: frequencies(r => [r[3]]), years: frequencies(r => [r[4].slice(0,4)]),
    facets: frequencies(r => r[5]),
  });
  if (queued) postResults(queued);
}

self.onmessage = ({data}) => {
  if (data.type === "search") postResults(data);
};
init().catch(error => self.postMessage({type:"error", message:error.message}));
