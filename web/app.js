const $ = id => document.getElementById(id);
const month = new Intl.DateTimeFormat("en-CA", { month:"long",timeZone:"UTC" });
const dateLabel = new Intl.DateTimeFormat("en-CA", { year:"numeric",month:"short",day:"numeric",timeZone:"UTC" });
const number = new Intl.NumberFormat("en-CA");
const pageSize = 18;
const modal = $("detail");
let manifest;
let port;
let ready = false;
let failed = false;
let requestId = 0;
let page = 1;
let timer;
let active;
let sequence = 0;
let initial = new URLSearchParams(location.hash.slice(1));
let shardCache = new Map();

function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function btn(label, action, className) {
  const el = node("button", label, className);
  el.type = "button";
  el.addEventListener("click", action);
  return el;
}

function link(label, value, className) {
  try {
    const url = new URL(value);
    if (!["https:","http:"].includes(url.protocol) || url.username || url.password) return undefined;
    const el = node("a", label, className);
    el.href = url.href;
    el.target = "_blank";
    el.rel = "noopener noreferrer";
    return el;
  } catch { return undefined; }
}

function append(container, ...elements) {
  for (const element of elements) if (element) container.append(element);
}

function date(value) {
  return value ? dateLabel.format(new Date(value + "T00:00:00Z")) : "Date unavailable";
}

function filters() {
  return {q:$("query").value.trim(),org:$("org").value,year:$("year").value,facet:$("facet").value,sort:$("sort").value};
}

function replaceHash() {
  const parameters = new URLSearchParams();
  for (const [key,value] of Object.entries(filters())) {
    if (value && (key !== "sort" || value !== "relevance")) parameters.set(key,value);
  }
  if (active) {
    parameters.set("record", active[0]);
    if (manifest?.mode === "graveyard" && active[6]) parameters.set("date",active[6]);
  }
  const hash = parameters.toString();
  history.replaceState(null,"",hash ? `#${hash}` : location.pathname + location.search);
}

function clear() {
  for (const field of ["query","org","year","facet"]) $(field).value = "";
  $("sort").value = "relevance";
  schedule();
}

function schedule(next = 1, random = false) {
  clearTimeout(timer);
  if (failed || !ready) return;
  page = next;
  replaceHash();
  const id = ++requestId;
  timer = setTimeout(() => port.postMessage({type:"search",id,page,filters:filters(),random}),20);
}

function addOptions(select, values, display = value => value) {
  for (const [value] of values) select.add(new Option(display(value),value));
}

function configure(data) {
  ({manifest} = data);
  const grave = manifest.mode === "graveyard";
  $("total").textContent = number.format(manifest.count);
  $("snapshot").textContent = [
    manifest.publisherDate ? `Export modified ${date(manifest.publisherDate)}.` : "Publisher export date unavailable.",
    `Snapshot built ${date(manifest.built)}.`,
    manifest.newest ? `Latest recorded ${grave ? "removal" : "modification"} ${date(manifest.newest)}.` : "",
  ].filter(Boolean).join(" ");
  const alpha = (a,b) => a[0].localeCompare(b[0],"en-CA");
  addOptions($("org"), data.organizations.sort(alpha));
  addOptions($("year"), data.years.sort((a,b) => -alpha(a,b)));
  addOptions($("facet"), data.facets.sort(alpha), value => grave
    ? month.format(new Date(`2000-${value}-01T00:00:00Z`)) : value);
  const summary = grave ? data.years.slice(0,10) : data.facets.sort((a,b)=>b[1]-a[1]).slice(0,9);
  for (const [key,count] of summary) {
    const tile = btn("", () => {$(grave ? "year" : "facet").value = key;schedule();$("result-heading").focus();},"statline");
    tile.append(node("span",key),node("strong",number.format(count)));
    $("summary").append(tile);
  }
  if (initial.has("q") && $("query").value === "") $("query").value = initial.get("q").slice(0,240);
  for (const field of ["org","year","facet","sort"]) {
    const value = initial.get(field);
    if (value && Array.from($(field).options).some(item=>item.value === value)) $(field).value = value;
  }
  ready = true;
  port.postMessage({type:"search",id:++requestId,page:1,filters:filters(),record:initial.get("record"),date:initial.get("date")});
  initial = new URLSearchParams();
}

function card(row) {
  const [id,title,french,org,day,formats,,,resources] = row;
  const grave = manifest.mode === "graveyard";
  const block = node("article",undefined,"card");
  block.append(node("p",[org || "Organization unavailable",day ? date(day) : ""].filter(Boolean).join(" · "),"meta"));
  const heading = node("h3");
  heading.append(btn(title,()=>openDetail(row)));
  block.append(heading);
  const chips = node("div",undefined,"chips");
  if (grave) {
    chips.append(node("span",id));
  } else {
    chips.append(node("span",`${number.format(resources)} resource${resources === 1 ? "" : "s"}`));
    for (const label of formats.slice(0,6)) chips.append(node("span",label,"tag"));
    if (formats.length > 6) chips.append(node("span",`+${formats.length - 6} more formats`));
  }
  block.append(chips);
  return block;
}

function show(data) {
  if (data.id !== requestId) return;
  page = data.page;
  const count = `${number.format(data.total)} ${data.total === 1 ? "entry" : "entries"}`;
  $("count").textContent = data.total ? count : "No matching entries";
  $("results").replaceChildren(...data.rows.map(card));
  if (!data.total) {
    const empty = node("div",undefined,"panel");
    empty.append(node("h3","Try a different search"),node("p","Search a shorter title or clear the filters to browse the whole snapshot.","note"),btn("Clear all filters",clear,"btn secondary"));
    $("results").append(empty);
  }
  $("surprise").disabled = !data.total;
  $("pages").hidden = data.max <= 1;
  $("page").textContent = `Page ${number.format(page)} of ${number.format(data.max)}`;
  $("prev").disabled = page === 1;
  $("next").disabled = page >= data.max;
  if (data.selected) openDetail(data.selected);
}

function formatDetail(row) {
  return `https://open.canada.ca/data/en/dataset/${encodeURIComponent(row[0])}`;
}

async function fetchShard(i) {
  if (!shardCache.has(i)) {
    const job = (async () => {
      const name = manifest.shards[i];
      if (!name) throw new Error("Detail file missing");
      const response = await fetch(new URL(`./data/${name}`, import.meta.url),{signal:AbortSignal.timeout(20000)});
      if (!response.ok) throw new Error("Detail file unavailable");
      const raw = new Uint8Array(await response.arrayBuffer());
      const data = raw[0] === 31 && raw[1] === 139
        ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).json()
        : JSON.parse(new TextDecoder().decode(raw));
      return new Map(data);
    })();
    shardCache.set(i,job);
    job.catch(()=>shardCache.delete(i));
    if (shardCache.size > 6) shardCache.delete(shardCache.keys().next().value);
  }
  return shardCache.get(i);
}

async function copy(status) {
  try {
    await navigator.clipboard.writeText(location.href);
    status.textContent = "Record link copied";
  } catch {
    status.textContent = location.href;
  }
}

async function openDetail(row) {
  const [id,title,french,org,day,,timestamp,,,file] = row;
  const grave = manifest.mode === "graveyard";
  const token = ++sequence;
  active = row;
  $("detail-title").textContent = title;
  const body = $("detail-body");
  body.replaceChildren(node("p",[org || "Organization unavailable",day ? date(day) : ""].filter(Boolean).join(" · "),"stamp"),
    node("p",`Record ID ${id}`,"stamp"));
  if (grave && timestamp) body.append(node("p", `Removal timestamp in source: ${timestamp}`, "stamp"));
  if (french && french !== title) body.append(node("p",french));
  const actions = node("div",undefined,"dialog-actions");
  const status = node("p",undefined,"stamp");
  status.setAttribute("role","status");
  append(actions,link(grave ? "Check original URL ↗" : "Open government record ↗",formatDetail(row),"btn"),
    btn("Copy record link",()=>copy(status),"btn secondary"));
  body.append(actions,status);
  if (grave) {
    const subject = new URLSearchParams({search_text:title});
    const tools = node("div",undefined,"dialog-actions");
    const archived = `https://web.archive.org/web/*/https://open.canada.ca/data/en/dataset/${encodeURIComponent(id)}`;
    append(tools,link("Wayback Machine ↗",archived,"btn secondary"),
      link("Search the current portal ↗",`https://search.open.canada.ca/opendata/?${subject}`,"btn secondary"),
      link("Find related records on CoolCode ↗",`https://coolcode.ca/datasetexplorer/#${new URLSearchParams({q:title.slice(0,240)})}`,"btn secondary"));
    body.append(node("h3","Follow the record"),node("p","These lookups can help find earlier captures or newer releases. A removal entry only records a catalogue change."),tools);
  }
  if (!modal.open) modal.showModal();
  replaceHash();
  if (grave) return;
  const detail = node("p","Loading resources…","stamp");
  body.append(detail);
  try {
    const data = (await fetchShard(file)).get(id);
    if (token !== sequence) return;
    if (!data) throw new Error("Record not found in detail file");
    detail.remove();
    const [description,licence,licenceUrl,resources,published] = data;
    if (published) body.append(node("p",`Published ${date(published)}`,"stamp"));
    if (licence) append(body,link(licence,licenceUrl) || node("p",licence));
    if (description) {
      body.append(node("h3","Publisher description"),node("p",description + (description.length >= 5000 ? "…" : "")));
    }
    body.append(node("h3",`${number.format(resources.length)} published resource${resources.length === 1 ? "" : "s"}`));
    if (!resources.length) body.append(node("p","No resource links were supplied in the catalogue feed."));
    const list = node("ul");
    for (const [name,fr,format,url,filename] of resources) {
      const item = node("li");
      append(item,link(`${name} ↗`,url) || node("span",name));
      item.append(node("span",[format,filename].filter(Boolean).join(" · "),"stamp"));
      list.append(item);
    }
    body.append(list);
  } catch {
    if (token === sequence) detail.textContent = "Resource details could not be loaded. Use the government record link above.";
  }
}

function error() {
  failed = true;
  $("count").textContent = "Catalogue snapshot could not be loaded.";
  const notice = node("div",undefined,"panel");
  notice.append(node("h3","Search data unavailable"),
    node("p","Reload to try again, or open the government source in the provenance panel.","note"),
    btn("Reload snapshot",()=>location.reload(),"btn"));
  $("results").replaceChildren(notice);
}

$("query").addEventListener("input",()=>schedule());
$("search-form").addEventListener("submit",event=>{event.preventDefault();schedule();});
for (const id of ["org","year","facet","sort"]) $(id).addEventListener("change",()=>schedule());
$("clear").addEventListener("click",()=>{clear();$("query").focus();});
$("prev").addEventListener("click",()=>{schedule(page - 1);$("result-heading").focus();});
$("next").addEventListener("click",()=>{schedule(page + 1);$("result-heading").focus();});
$("surprise").addEventListener("click",()=>schedule(page,true));
for (const button of document.querySelectorAll("[data-q]")) button.addEventListener("click",()=>{
  $("query").value = button.dataset.q;
  schedule();
  $("query").focus();
});
modal.addEventListener("close",()=>{sequence++;active=null;replaceHash();});
if (initial.has("q")) $("query").value = initial.get("q").slice(0,240);
try {
  port = new Worker(new URL("./search-worker.mjs",import.meta.url),{type:"module"});
  port.addEventListener("error",error);
  port.addEventListener("message",({data})=>{
    if (data.type === "progress" && !ready) $("count").textContent =
      `Loading search index · ${number.format(data.completed)} / ${number.format(data.total)}`;
    else if (data.type === "ready") configure(data);
    else if (data.type === "results") show(data);
    else if (data.type === "error") error();
  });
} catch { error(); }
