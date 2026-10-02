const SK_TAKIP_URL = "https://www.suratkargo.com.tr/KargoTakip/?kargotakipno=";
const CONTACTED_KEY = "contactedSiparis";
const phoneCache = new Map();
const paketCache = new Map();
let contactedCache = null;
let markTimer = 0;

if (typeof pdfjsLib !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.js");
}

const HEADER_ALIASES = {
  TakipNo: ["takipno", "takip no", "kargotakipno", "kargo takip no"],
  Barkod: ["barkod"],
  Alici: ["alici", "alıcı"],
  AliciTelefon: ["alicitelefon", "alıcıtelefon", "alici telefon", "alıcı telefon"],
  WebSiparisKodu: ["websipariskodu", "web siparis kodu", "web sipariş kodu", "websiparisno", "sipariskodu", "siparis kodu"],
  TeslimatDurum: ["teslimat durum", "teslimatdurum"],
  VarisSube: ["varışşubeadı", "varisşubeadı", "varissubeadi", "varış şube adı"],
  VarisSubeTel: ["varisşubetel", "varışşubetel", "varis sube tel"],
  GonSubeTel: ["gönşubetel", "gonsubetel", "gönderenşubetel"],
  Adres: ["aliciadres", "alıcıadres", "alici adres"],
  Il: ["varışil", "varisil", "varış il"],
  Ilce: ["varışilçe", "varisilce", "varış ilçe"],
  PlanlananTeslimTarihi: ["planlananteslimtarihi", "planlanan teslim tarihi"],
  TeslimTarihi: ["teslim tarihi", "teslimtarihi"],
  TeslimAlan: ["teslim alan", "teslimalan"],
  ToplamDesi: ["toplam desi", "toplamdesi"]
};

const MOBILE_RE = /(?:\+90|00?90|0)?\s*5\d{2}[\s./-]*\d{3}[\s./-]*\d{2}[\s./-]*\d{2}/g;

function normalizeHeader(text) {
  return (text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/İ/g, "i");
}

function foldKey(text) {
  return normalizeHeader(text).replace(/[^a-z0-9]/g, "");
}

let spareDesiLimit = SK_DEFAULT_SPARE_DESI;

function normalizeSpareDesi(value) {
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return SK_DEFAULT_SPARE_DESI;
  return n;
}

function getSettings() {
  return new Promise((resolve) => {
    const fallback = {
      template: SK_DEFAULT_TEMPLATE,
      warnIfDelivered: SK_DEFAULT_WARN_IF_DELIVERED,
      spareDesi: SK_DEFAULT_SPARE_DESI
    };
    try {
      chrome.storage.sync.get(fallback, (result) => {
        spareDesiLimit = normalizeSpareDesi(result.spareDesi);
        resolve({
          template: result.template || SK_DEFAULT_TEMPLATE,
          warnIfDelivered: result.warnIfDelivered !== false,
          spareDesi: spareDesiLimit
        });
      });
    } catch (err) {
      spareDesiLimit = SK_DEFAULT_SPARE_DESI;
      resolve(fallback);
    }
  });
}

function getTemplate() {
  return getSettings().then((s) => s.template);
}

function isDelivered(status) {
  const folded = foldKey(status);
  return folded === "teslimedildi" || folded.indexOf("teslimedildi") !== -1;
}

function isTekrarGidilecek(status) {
  return foldKey(status).indexOf("tekrargidilecek") !== -1;
}

function siparisKey(fields) {
  return String(fields.WebSiparisKodu || "")
    .replace(/\u00a0/g, " ")
    .trim();
}

function parseDesi(raw) {
  if (raw == null || raw === "") return NaN;
  let text = String(raw).trim().replace(/\s/g, "");
  if (!text) return NaN;
  if (text.indexOf(",") !== -1 && text.indexOf(".") !== -1) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else {
    text = text.replace(",", ".");
  }
  return parseFloat(text);
}

function parseSkDate(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  const iso = text.match(/(\d{4})[./-](\d{1,2})[./-](\d{1,2})/);
  const dmy = text.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  let year;
  let month;
  let day;
  if (iso) {
    year = parseInt(iso[1], 10);
    month = parseInt(iso[2], 10);
    day = parseInt(iso[3], 10);
  } else if (dmy) {
    day = parseInt(dmy[1], 10);
    month = parseInt(dmy[2], 10);
    year = parseInt(dmy[3], 10);
    if (year < 100) year += 2000;
  } else {
    return null;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatSkDate(date) {
  return pad2(date.getDate()) + "." + pad2(date.getMonth() + 1) + "." + date.getFullYear();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isPlanlananGecti(date) {
  if (!date) return false;
  return startOfDay(new Date()) > startOfDay(date);
}

function yakinGunIfadesi(date) {
  if (!date) return "";
  const diff = Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000);
  if (diff === 0) return "bugün";
  if (diff === 1) return "yarın";
  return "";
}

function planlananTeslimCumlesi(raw) {
  const date = parseSkDate(raw);
  if (!date || isPlanlananGecti(date)) return "";
  const yakin = yakinGunIfadesi(date);
  const when = yakin ? formatSkDate(date) + " " + yakin : formatSkDate(date);
  return "Kargo tarafından planlanan teslim tarihi: *" + when + "*";
}

function isSparePart(fields) {
  const desi = parseDesi(fields.ToplamDesi);
  return Number.isFinite(desi) && desi < spareDesiLimit;
}

function teslimatTagText(status) {
  const folded = foldKey(status);
  if (!folded) return "";
  if (folded.indexOf("teslimedildi") !== -1) return "Teslim edildi";
  if (folded.indexOf("gonderildi") !== -1) return "Gönderildi";
  return "";
}

function upsertTag(actions, className, text, title) {
  let el = actions.querySelector("." + className);
  if (!text) {
    if (el) el.remove();
    return null;
  }
  if (!el) {
    el = document.createElement("span");
    el.className = "sk-tag " + className;
  }
  el.textContent = text;
  el.title = title || text;
  actions.appendChild(el);
  return el;
}

function loadContacted() {
  return new Promise((resolve) => {
    if (contactedCache) {
      resolve(contactedCache);
      return;
    }
    try {
      chrome.storage.local.get({ [CONTACTED_KEY]: {} }, (result) => {
        contactedCache = result[CONTACTED_KEY] || {};
        resolve(contactedCache);
      });
    } catch (err) {
      contactedCache = {};
      resolve(contactedCache);
    }
  });
}

async function markContacted(fields) {
  const key = siparisKey(fields);
  if (!key) return;
  const map = await loadContacted();
  map[key] = {
    at: Date.now(),
    alici: fields.Alici || ""
  };
  contactedCache = map;
  try {
    chrome.storage.local.set({ [CONTACTED_KEY]: map });
  } catch (err) {
    /* ignore */
  }
  scheduleMarks();
}

function refreshMarks() {
  const table = document.getElementById("dataTable");
  if (!table) return;
  loadContacted().then((map) => {
    table.querySelectorAll("tbody tr").forEach((tr) => {
      const actions = tr.querySelector(".sk-actions");
      if (!actions) return;
      let fields;
      try {
        fields = buildFields(tr);
      } catch (err) {
        console.error("SK satır", err);
        return;
      }
      const key = siparisKey(fields);
      const hit = !!(key && map[key]);
      tr.classList.toggle("sk-contacted", hit);
      upsertTag(
        actions,
        "sk-tag-spare",
        isSparePart(fields) ? "Yedek" : "",
        "Yedek parça — toplam desi " + spareDesiLimit + " altı"
      );
      upsertTag(
        actions,
        "sk-tag-teslim",
        teslimatTagText(fields.TeslimatDurum) ? "Teslim" : "",
        "Teslimat durum: " + (fields.TeslimatDurum || "")
      );
      upsertTag(
        actions,
        "sk-tag-done",
        hit ? "✓" : "",
        "Bu sipariş kodu için mesaj kopyalandı"
      );
    });
  });
}

function scheduleMarks() {
  clearTimeout(markTimer);
  markTimer = setTimeout(() => {
    stampOrderCodes();
    refreshMarks();
  }, 40);
}

function headerCells(table) {
  if (!table) return [];
  const named = table.querySelectorAll("tr#tableHeaderRow th, tr#tableHeaderRow td");
  if (named.length) return [...named];
  const local = table.querySelectorAll("thead tr:first-child th, thead tr:first-child td");
  if (local.length) return [...local];
  const wrapper = table.closest(".dataTables_wrapper");
  if (!wrapper) return [];
  const scrolled = wrapper.querySelectorAll(
    ".dataTables_scrollHead tr#tableHeaderRow th, .dataTables_scrollHead tr#tableHeaderRow td, .dataTables_scrollHead thead tr:first-child th, .dataTables_scrollHead thead tr:first-child td"
  );
  return [...scrolled];
}

function headerMap(table) {
  const map = {};
  headerCells(table).forEach((cell) => {
    const index = cell.cellIndex;
    if (index == null || index < 0) return;
    const folded = foldKey(cell.textContent || "");
    if (folded && !(folded in map)) map[folded] = index;
  });
  return map;
}

function lookup(map, aliases) {
  for (const alias of aliases) {
    const folded = foldKey(alias);
    if (folded && folded in map) return map[folded];
  }
  for (const alias of aliases) {
    const folded = foldKey(alias);
    if (folded.length < 4) continue;
    for (const key of Object.keys(map)) {
      if (key.indexOf(folded) !== -1) return map[key];
    }
  }
  return null;
}

function cleanCell(text) {
  return String(text || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function cellString(td) {
  if (!td) return "";
  const text = cleanCell(td.textContent);
  if (text) return text;
  return cleanCell(
    td.getAttribute("data-order") || td.getAttribute("data-search") || td.getAttribute("title") || ""
  );
}

function cellAtColumn(tr, columnIndex) {
  if (!tr || columnIndex == null || columnIndex < 0) return null;
  try {
    return (tr.cells && tr.cells[columnIndex]) || null;
  } catch (err) {
    console.error("SK hücre", err);
    return null;
  }
}

function cellText(tr, index) {
  return cellString(cellAtColumn(tr, index));
}

function htmlToText(value) {
  if (value == null) return "";
  const html = String(value);
  if (html.indexOf("<") === -1) return cleanCell(html);
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return cleanCell(holder.textContent);
}

function dataTableApi(table) {
  const jq = window.jQuery;
  if (!table || !jq || !jq.fn || !jq.fn.dataTable || !jq.fn.dataTable.isDataTable) return null;
  try {
    if (!jq.fn.dataTable.isDataTable(table)) return null;
    return jq(table).DataTable();
  } catch (err) {
    return null;
  }
}

function apiCellText(tr, aliases) {
  const api = dataTableApi(tr.closest("table"));
  if (!api) return "";
  try {
    const map = {};
    api.columns().header().toArray().forEach((cell, index) => {
      const folded = foldKey(cell.textContent || "");
      if (folded && !(folded in map)) map[folded] = index;
    });
    const index = lookup(map, aliases);
    if (index == null) return "";
    return htmlToText(api.cell(tr, index).data());
  } catch (err) {
    return "";
  }
}

function childRowValue(tr, aliases) {
  const next = tr.nextElementSibling;
  if (!next || !next.classList.contains("child")) return "";
  const wanted = aliases.map(foldKey).filter(Boolean);
  const titles = next.querySelectorAll(".dtr-title");
  for (const title of titles) {
    const name = foldKey(title.textContent || "");
    if (!wanted.some((key) => name === key || name.indexOf(key) !== -1)) continue;
    const data = title.parentElement && title.parentElement.querySelector(".dtr-data");
    if (data) return cleanCell(data.textContent);
  }
  return "";
}

function readField(tr, map, aliases) {
  const dom = cellText(tr, lookup(map, aliases));
  if (dom) return dom;
  return childRowValue(tr, aliases) || apiCellText(tr, aliases);
}

function extractTakipNo(tr, map) {
  const fromCell = readField(tr, map, HEADER_ALIASES.TakipNo);
  const digits = (fromCell || "").replace(/\D/g, "");
  if (digits.length >= 8) return digits;

  const barkod = readField(tr, map, HEADER_ALIASES.Barkod).replace(/\D/g, "");
  if (barkod.length >= 8) return barkod;

  const rowText = (tr.innerText || "").match(/\b\d{10,16}\b/);
  return rowText ? rowText[0] : "";
}

function buildFields(tr) {
  const table = tr.closest("table") || document.getElementById("dataTable");
  const map = headerMap(table);
  const takipNo = extractTakipNo(tr, map);
  const teslimatDurum = readField(tr, map, HEADER_ALIASES.TeslimatDurum);
  const planlananTeslimTarihi = readField(tr, map, HEADER_ALIASES.PlanlananTeslimTarihi);
  const planlananDate = parseSkDate(planlananTeslimTarihi);
  const planlananGecti = isPlanlananGecti(planlananDate);
  const webSiparisKodu = readWebSiparisKodu(tr, map, takipNo);
  return {
    TakipNo: takipNo,
    TakipLink: takipNo ? SK_TAKIP_URL + takipNo : "",
    TekrarGidisUyarisi: isTekrarGidilecek(teslimatDurum) ? SK_TEKRAR_GIDIS_UYARI : "",
    Barkod: readField(tr, map, HEADER_ALIASES.Barkod),
    Alici: readField(tr, map, HEADER_ALIASES.Alici),
    AliciTelefon: readField(tr, map, HEADER_ALIASES.AliciTelefon),
    WebSiparisKodu: webSiparisKodu,
    SiparisMagazadan: siparisMagazadan(webSiparisKodu),
    TeslimatDurum: teslimatDurum,
    VarisSube: readField(tr, map, HEADER_ALIASES.VarisSube),
    VarisSubeTel: readField(tr, map, HEADER_ALIASES.VarisSubeTel),
    GonSubeTel: readField(tr, map, HEADER_ALIASES.GonSubeTel),
    Adres: readField(tr, map, HEADER_ALIASES.Adres),
    Il: readField(tr, map, HEADER_ALIASES.Il),
    Ilce: readField(tr, map, HEADER_ALIASES.Ilce),
    PlanlananTeslimTarihi: planlananGecti ? "" : planlananTeslimTarihi,
    PlanlananTeslimGunu: planlananGecti ? "" : yakinGunIfadesi(planlananDate),
    PlanlananTeslimCumlesi: planlananTeslimCumlesi(planlananTeslimTarihi),
    TeslimTarihi: readField(tr, map, HEADER_ALIASES.TeslimTarihi),
    TeslimAlan: readField(tr, map, HEADER_ALIASES.TeslimAlan),
    ToplamDesi: readField(tr, map, HEADER_ALIASES.ToplamDesi)
  };
}

const SK_TEKRAR_GIDIS_UYARI =
  "Kargo firması size ulaşamamış görünüyor. Gönderiniz için tekrar teslimat denemesi yapacaktır. Sorun halinde Sürat Kargo ile lütfen iletişime geçiniz.";
const SK_COKLU_PAKET_UYARI =
  "Kargo firması paketleri farklı günlerde teslim edebilmektedir. Bu nedenle tüm paketleriniz size ulaşmadan ürününüzün kurulumuna başlamamanızı rica ederiz.";
const SK_COKLU_PAKET_UYARI_ESKI =
  "Siparişlerimizi kargoya aynı gün teslim etmemize rağmen, kargo firması paketleri zaman zaman farklı günlerde teslim edebilmektedir. Bu nedenle tüm paketleriniz size ulaşmadan ürününüzün kurulumuna başlamamanızı rica ederiz.";
const SK_COKLU_KURULUM = "Tüm paketleriniz ulaştıktan sonra kurulumu gerçekleştirebilirsiniz.";

const SK_SIPARIS_MAGAZA = [
  { prefix: "876", text: "Vivense'den" },
  { prefix: "727", text: "Trendyol'dan" }
];

function magazaliKod(text, minLength) {
  const min = minLength || 6;
  const groups = String(text || "").match(/\d+/g) || [];
  const checks = groups.filter((digits) => digits.length >= min);
  const joined = groups.join("");
  if (joined.length >= min) checks.push(joined);
  for (const digits of checks) {
    for (const kanal of SK_SIPARIS_MAGAZA) {
      if (digits.startsWith(kanal.prefix)) return digits;
    }
  }
  return "";
}

function siparisMagazadan(webSiparisKodu) {
  const digits = magazaliKod(webSiparisKodu);
  if (!digits) return "";
  for (const kanal of SK_SIPARIS_MAGAZA) {
    if (digits.startsWith(kanal.prefix)) return kanal.text;
  }
  return "";
}

function stampOrderCodes() {
  try {
    document.dispatchEvent(new CustomEvent("sk-stamp-orders"));
  } catch (err) {
    console.error("SK damga", err);
    if (document.documentElement) {
      document.documentElement.setAttribute("data-sk-stamp-error", (err && err.message) || String(err));
    }
  }
}

function orderDebug(fields) {
  const root = document.documentElement;
  const error = root ? root.getAttribute("data-sk-stamp-error") || "" : "";
  const columns = root ? root.getAttribute("data-sk-columns") || "" : "";
  console.log("SK mesaj", {
    hook: root ? root.getAttribute("data-sk-hook") : "",
    stamped: root ? root.getAttribute("data-sk-stamped") : "",
    code: fields && fields.WebSiparisKodu,
    store: fields && fields.SiparisMagazadan,
    error: error,
    columns: columns
  });
  if (fields && fields.SiparisMagazadan) return "";
  if (!fields) return error;
  const parts = [
    root && root.getAttribute("data-sk-hook") ? "" : "sayfa kancası yok",
    "damga " + ((root && root.getAttribute("data-sk-stamped")) || "0"),
    error,
    columns ? "kolon " + columns : ""
  ].filter(Boolean);
  return parts.join(" · ");
}

function orderCodeForRow(tr) {
  const direct = tr.getAttribute("data-sk-websiparis");
  if (direct) return direct;
  const index = rowIndexIn(tr);
  if (index < 0) return "";
  const tables = tablesNear(tr.closest("table"));
  for (const table of tables) {
    const row = plainBodyRows(table)[index];
    const code = row && row.getAttribute("data-sk-websiparis");
    if (code) return code;
  }
  return "";
}

const ORDER_KEYS = ["websipariskodu", "websiparisno", "sipariskodu"];
let orderHitsAt = 0;
let orderHits = [];

function isOrderName(name) {
  if (!name || name.length > 48) return false;
  return ORDER_KEYS.some((key) => name === key || name.indexOf(key) !== -1);
}

function shortLabel(el) {
  if (!el) return "";
  let direct = "";
  for (let node = el.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 3) direct += node.nodeValue;
  }
  direct = cleanCell(direct);
  if (direct.length > 80) return "";
  if (direct) return direct;
  const titled = cleanCell(
    [el.getAttribute("title"), el.getAttribute("aria-label"), el.getAttribute("data-title"), el.getAttribute("data-field")]
      .filter(Boolean)
      .join(" ")
  );
  if (titled && titled.length <= 80) return titled;
  if (el.children && el.children.length === 1) {
    const inner = shortLabel(el.children[0]);
    if (inner) return inner;
  }
  if (el.tagName === "TH" || el.tagName === "TD" || el.getAttribute("role") === "columnheader") {
    const all = cleanCell(el.textContent);
    if (all && all.length <= 80) return all;
  }
  return "";
}

function columnPosition(el) {
  const cell = el.closest("th, td") || el;
  let index = cell.cellIndex;
  if (index == null || index < 0) {
    const row = cell.parentElement;
    index = row ? [...row.children].indexOf(cell) : -1;
  }
  if (index == null || index < 0) return null;
  return { index: index, table: cell.closest("table") };
}

function rankTable(table) {
  if (!table) return 2;
  if (table.id === "dataTable") return 0;
  if (table.closest("#dataTable_wrapper, .dataTables_wrapper, .dataTables_scroll, .dt-scroll, .dt-container")) return 0;
  return 1;
}

function nameRank(name) {
  if (name === "websipariskodu" || name === "websiparisno") return 0;
  if (name.indexOf("websipariskodu") !== -1 || name.indexOf("websiparisno") !== -1) return 1;
  return 2;
}

function orderColumnHits() {
  const hits = [];
  document.querySelectorAll("th, td, [role='columnheader']").forEach((el) => {
    const name = foldKey(shortLabel(el));
    if (!isOrderName(name)) return;
    const pos = columnPosition(el);
    if (!pos) return;
    pos.name = name;
    hits.push(pos);
  });
  hits.sort((a, b) => nameRank(a.name) - nameRank(b.name) || rankTable(a.table) - rankTable(b.table));
  return hits;
}

function cachedOrderHits() {
  const now = Date.now();
  if (orderHits.length && now - orderHitsAt < 300) return orderHits;
  if (!orderHits.length && now - orderHitsAt < 50) return orderHits;
  orderHits = orderColumnHits();
  orderHitsAt = now;
  return orderHits;
}

function plainBodyRows(table) {
  if (!table || !table.tBodies) return [];
  const rows = [];
  [...table.tBodies].forEach((tbody) => {
    [...tbody.rows].forEach((row) => {
      if (row.classList.contains("child") || row.id === "tableHeaderRow") return;
      rows.push(row);
    });
  });
  return rows;
}

function rowIndexIn(tr) {
  if (!tr || !tr.parentElement) return -1;
  const rows = [...tr.parentElement.rows].filter((row) => !row.classList.contains("child") && row.id !== "tableHeaderRow");
  return rows.indexOf(tr);
}

function tablesNear(table) {
  const list = [];
  const add = (item) => {
    if (item && item.tagName === "TABLE" && list.indexOf(item) === -1) list.push(item);
  };
  add(table);
  add(document.getElementById("dataTable"));
  const wrapper =
    (table && table.closest(".dataTables_wrapper, .dt-container, .dataTables_scroll, .DTFC_ScrollWrapper")) ||
    document.getElementById("dataTable_wrapper") ||
    document.querySelector(".dataTables_wrapper, .dt-container");
  if (wrapper) wrapper.querySelectorAll("table").forEach(add);
  document
    .querySelectorAll(
      ".dataTables_scrollBody table, .dt-scroll-body table, .DTFC_LeftBodyWrapper table, .DTFC_RightBodyWrapper table, .dtfc-fixed-left table, .dtfc-fixed-right table"
    )
    .forEach(add);
  return list;
}

function probeCell(td) {
  if (!td) return "";
  const bits = [];
  const text = cleanCell(td.textContent);
  if (text) bits.push(text);
  ["data-order", "data-search", "data-filter", "data-value", "title"].forEach((attr) => {
    const value = td.getAttribute(attr);
    if (value) bits.push(value);
  });
  td.querySelectorAll("input, textarea, select").forEach((el) => {
    if (el.value) bits.push(el.value);
  });
  return cleanCell(bits.join(" "));
}

function tableWidth(table) {
  if (!table || !table.rows) return 0;
  let width = 0;
  [...table.rows].forEach((row) => {
    if (row.cells) width = Math.max(width, row.cells.length);
  });
  return width;
}

function rowMatchKey(tr) {
  if (!tr || !tr.cells) return "";
  for (const cell of tr.cells) {
    const text = cleanCell(cell.textContent);
    const folded = foldKey(text);
    if (!text || text.length < 4 || text.length > 60) continue;
    if (/^(yazdir|mesajkopyala|telefonkopyala|detay|pdf)$/.test(folded)) continue;
    return text;
  }
  return "";
}

function rowHasText(row, key) {
  if (!row || !row.cells || !key) return false;
  for (const cell of row.cells) {
    if (cleanCell(cell.textContent) === key) return true;
  }
  return false;
}

function findAlignedRow(tr, table) {
  const rows = plainBodyRows(table);
  if (rows.indexOf(tr) !== -1) return tr;
  const index = rowIndexIn(tr);
  const key = rowMatchKey(tr);
  if (key) {
    const hits = rows.filter((row) => rowHasText(row, key));
    if (hits.length === 1) return hits[0];
    if (index >= 0 && hits.indexOf(rows[index]) !== -1) return rows[index];
  }
  return index >= 0 ? rows[index] || null : null;
}

function readOrderCodeFromGrid(tr, takipNo) {
  const index = rowIndexIn(tr);
  if (index < 0) return "";
  const hits = cachedOrderHits();
  const exact = hits.some((hit) => nameRank(hit.name) === 0);
  for (const hit of exact ? hits.filter((hit) => nameRank(hit.name) === 0) : hits) {
    const expected = tableWidth(hit.table);
    for (const table of tablesNear(hit.table)) {
      const width = tableWidth(table);
      if (width <= hit.index) continue;
      if (expected && Math.abs(width - expected) > 1) continue;
      const row = findAlignedRow(tr, table);
      if (!row || !row.cells || row.cells.length <= hit.index) continue;
      const text = probeCell(row.cells[hit.index]);
      if (text && !isOrderName(foldKey(text))) return text;
    }
  }
  let widest = null;
  let widestWidth = 0;
  tablesNear(tr.closest("table")).forEach((table) => {
    const width = tableWidth(table);
    if (width > widestWidth) {
      widestWidth = width;
      widest = table;
    }
  });
  const row = widest && findAlignedRow(tr, widest);
  if (!row || row === tr) return "";
  for (const cell of row.cells) {
    const code = magazaliKod(probeCell(cell));
    if (code && code !== takipNo) return code;
  }
  return "";
}

function readWebSiparisKodu(tr, map, takipNo) {
  const aliases = HEADER_ALIASES.WebSiparisKodu;
  const candidates = [
    orderCodeForRow(tr),
    readOrderCodeFromGrid(tr, takipNo),
    cellText(tr, lookup(map, aliases)),
    childRowValue(tr, aliases),
    apiCellText(tr, aliases)
  ];
  const tagged = candidates.find((value) => magazaliKod(value));
  if (tagged) return tagged;
  const cells = [...(tr.cells || [])];
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("child")) cells.push(next);
  for (const cell of cells) {
    const code = magazaliKod(probeCell(cell));
    if (code && code !== takipNo) return code;
  }
  return candidates.find(Boolean) || "";
}

function applyTemplate(template, fields) {
  let filled = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = fields[key];
    return value == null ? "" : String(value);
  });
  const paketSayisi = Number(fields.PaketSayisi) || 0;
  if (paketSayisi > 0 && filled.indexOf(SK_SIPARIS_CUMLESI_YALIN) !== -1) {
    filled = filled.replace(SK_SIPARIS_CUMLESI_YALIN, siparisCumlesi(paketSayisi));
    const urunCumlesi = paketCumlesi(paketSayisi);
    if (urunCumlesi) filled = filled.replace(urunCumlesi, "");
  }
  if (paketSayisi === 1) {
    filled = filled
      .replace(SK_COKLU_PAKET_UYARI, "")
      .replace(SK_COKLU_PAKET_UYARI_ESKI, "")
      .replace(SK_COKLU_KURULUM + " ", "")
      .replace(SK_COKLU_KURULUM, "");
  } else if (paketSayisi > 1) {
    filled = filled.replace(SK_COKLU_PAKET_UYARI_ESKI, SK_COKLU_PAKET_UYARI);
  }
  if (!fields.PlanlananTeslimCumlesi) {
    filled = filled.replace(/^[^\S\n]*Kargo tarafından planlanan teslim tarihi:[^\n]*\n?/gim, "");
    filled = filled.replace(/^[^\S\n]*Planlanan teslim tarihi\s*:?[^\n]*\n?/gim, "");
  }
  filled = insertTekrarGidisUyarisi(filled, fields.TekrarGidisUyarisi);
  return filled.replace(/^[ \t]+/gm, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

function insertTekrarGidisUyarisi(filled, warning) {
  if (!warning || filled.indexOf(warning) !== -1) return filled;
  const afterTracking = /^[^\S\n]*Kargo takip:[^\n]*$/im;
  if (afterTracking.test(filled)) {
    return filled.replace(afterTracking, (line) => line + "\n\n" + warning);
  }
  const afterCode = /^[^\S\n]*Takip no:[^\n]*$/im;
  if (afterCode.test(filled)) {
    return filled.replace(afterCode, (line) => line + "\n\n" + warning);
  }
  return filled.replace(/\s*$/, "\n\n" + warning);
}

const SK_SIPARIS_CUMLESI_YALIN = "Siparişiniz Sürat Kargo ile gönderilmektedir.";

function templateUsesPaket(template) {
  const text = template || "";
  return (
    /\{\{\s*(Paket(Sayisi|Ifadesi|Cumlesi)|SiparisCumlesi|CokluPaketUyarisi)\s*\}\}/.test(text) ||
    text.indexOf("farklı günlerde teslim") !== -1 ||
    text.indexOf("tüm paketleriniz") !== -1 ||
    text.indexOf("Sürat Kargo ile gönderilmektedir") !== -1
  );
}

function paketIfadesi(count) {
  if (!count) return "";
  return (count === 1 ? "tek" : String(count)) + " paket";
}

function paketCumlesi(count) {
  if (!count) return "";
  return "Ürününüz " + paketIfadesi(count) + " olarak gönderilmektedir.";
}

function siparisCumlesi(count) {
  if (!count) return SK_SIPARIS_CUMLESI_YALIN;
  return "Siparişiniz Sürat Kargo ile " + paketIfadesi(count) + " olarak gönderilmektedir.";
}

function cokluPaketUyarisi(count) {
  if (count === 1) return "";
  return SK_COKLU_PAKET_UYARI;
}

function fetchPaketSayisi(takipNo) {
  if (!takipNo) return Promise.resolve(0);
  if (paketCache.has(takipNo)) return Promise.resolve(paketCache.get(takipNo));

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "skPaketSayisi", takipNo }, (count) => {
        if (chrome.runtime.lastError) {
          console.warn("SK paket sayısı", chrome.runtime.lastError.message);
          resolve(0);
          return;
        }
        const n = Number(count) || 0;
        if (n) paketCache.set(takipNo, n);
        resolve(n);
      });
    } catch (err) {
      console.warn("SK paket sayısı", err);
      resolve(0);
    }
  });
}

async function enrichPaketFields(fields, template) {
  if (!templateUsesPaket(template)) return fields;
  const count = await fetchPaketSayisi(fields.TakipNo);
  fields.PaketSayisi = count ? String(count) : "";
  fields.PaketIfadesi = paketIfadesi(count);
  fields.PaketCumlesi = paketCumlesi(count);
  fields.SiparisCumlesi = siparisCumlesi(count);
  fields.CokluPaketUyarisi = cokluPaketUyarisi(count);
  return fields;
}

function toDisplayPhone(raw) {
  if (!raw) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("90") && digits.length >= 12) digits = "0" + digits.slice(2);
  if (digits.length === 10 && digits.startsWith("5")) digits = "0" + digits;
  if (digits.length === 11 && digits.startsWith("05")) return digits;
  return "";
}

function toWhatsAppPhone(raw) {
  const display = toDisplayPhone(raw);
  return display ? "90" + display.slice(1) : "";
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch (err) {
    /* ignore */
  }
  ta.remove();
}

function showToast(text, kind) {
  let el = document.getElementById("sk-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "sk-toast";
    document.body.appendChild(el);
  }
  el.className = "is-show" + (kind === "error" ? " is-error" : "");
  el.textContent = text;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("is-show"), 2800);
}

function ensureModal() {
  let overlay = document.getElementById("sk-mesaj-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "sk-mesaj-overlay";
  overlay.innerHTML = `
    <div class="sk-mesaj-dialog" role="dialog" aria-modal="true">
      <div class="sk-mesaj-header">
        <strong>Müşteri mesajı</strong>
        <button type="button" class="sk-mesaj-close" aria-label="Kapat">&times;</button>
      </div>
      <div class="sk-mesaj-meta"></div>
      <textarea class="sk-mesaj-body" spellcheck="false"></textarea>
      <div class="sk-mesaj-actions">
        <button type="button" class="sk-mesaj-copy">Kopyala</button>
        <a class="sk-mesaj-wa" target="_blank" rel="noopener noreferrer">WhatsApp</a>
        <span class="sk-mesaj-status"></span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector(".sk-mesaj-close").addEventListener("click", closeModal);
  overlay.querySelector(".sk-mesaj-copy").addEventListener("click", async () => {
    const text = overlay.querySelector(".sk-mesaj-body").value;
    await copyText(text);
    setStatus("Kopyalandı");
  });
  overlay.querySelector(".sk-mesaj-wa").addEventListener("click", (e) => {
    const link = e.currentTarget;
    if (link.classList.contains("is-disabled")) {
      e.preventDefault();
      return;
    }
    const phone = link.getAttribute("data-phone");
    const text = overlay.querySelector(".sk-mesaj-body").value;
    if (phone) {
      link.href = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) closeModal();
  });
  return overlay;
}

function setStatus(text) {
  const el = document.querySelector("#sk-mesaj-overlay .sk-mesaj-status");
  if (!el) return;
  el.textContent = text;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => {
    if (el.textContent === text) el.textContent = "";
  }, 2000);
}

function closeModal() {
  const overlay = document.getElementById("sk-mesaj-overlay");
  if (overlay) overlay.classList.remove("is-open");
}

function ensureConfirm() {
  let overlay = document.getElementById("sk-confirm-overlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "sk-confirm-overlay";
  overlay.innerHTML = `
    <div class="sk-confirm-dialog" role="dialog" aria-modal="true">
      <div class="sk-confirm-header">Uyarı</div>
      <p class="sk-confirm-text"></p>
      <div class="sk-confirm-actions">
        <button type="button" class="sk-confirm-cancel" data-act="cancel">Vazgeç</button>
        <button type="button" class="sk-confirm-skip" data-act="skip">Tekrar sorma</button>
        <button type="button" class="sk-confirm-go" data-act="go">Evet, gönder</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.querySelector("[data-act=cancel]").click();
  });
  return overlay;
}

function confirmDelivered(fields) {
  return new Promise((resolve) => {
    const overlay = ensureConfirm();
    const who = fields.Alici ? ` (${fields.Alici})` : "";
    overlay.querySelector(".sk-confirm-text").textContent =
      "Müşteriye teslim edilmiş" + who + ", yine de mesaj göndermek istiyor musunuz?";

    const finish = (value) => {
      overlay.classList.remove("is-open");
      resolve(value);
    };

    overlay.querySelector("[data-act=cancel]").onclick = () => finish(false);
    overlay.querySelector("[data-act=go]").onclick = () => finish(true);
    overlay.querySelector("[data-act=skip]").onclick = () => {
      try {
        chrome.storage.sync.set({ warnIfDelivered: false });
      } catch (err) {
        /* ignore */
      }
      finish(true);
    };
    overlay.classList.add("is-open");
  });
}

function ciktiUrl(yazdirLink) {
  const href = yazdirLink.getAttribute("href") || "";
  if (!href) return "";
  return new URL(href, location.origin).href;
}

function cacheKey(yazdirLink) {
  try {
    const url = new URL(ciktiUrl(yazdirLink));
    return url.searchParams.get("TesellumObjId") || url.href;
  } catch (err) {
    return ciktiUrl(yazdirLink);
  }
}

function collectMobiles(text) {
  if (!text) return [];
  const found = [];
  const seen = new Set();
  const matches = String(text).match(MOBILE_RE) || [];
  for (const match of matches) {
    const phone = toDisplayPhone(match);
    if (phone && !seen.has(phone)) {
      seen.add(phone);
      found.push(phone);
    }
  }
  return found;
}

function cepPhonesFromText(text, skip) {
  const found = [];
  const re = /cep\s+((?:\+90|0)?5\d{2}[\s./-]*\d{3}[\s./-]*\d{2}[\s./-]*\d{2})/gi;
  let match;
  while ((match = re.exec(text))) {
    const phone = toDisplayPhone(match[1]);
    if (phone && !skip.has(phone) && !found.includes(phone)) found.push(phone);
  }
  return found;
}

function pickAliciPhone(layout, exclude) {
  const skip = new Set((exclude || []).map(toDisplayPhone).filter(Boolean));
  const items = layout.items || [];
  const pageWidth = layout.pageWidth || 0;
  const text = layout.text || "";
  const splitX = pageWidth ? pageWidth * 0.45 : 0;

  const phones = [];
  for (const item of items) {
    for (const phone of collectMobiles(item.str)) {
      if (!skip.has(phone)) phones.push({ phone, x: item.x, y: item.y });
    }
  }

  const cepLabels = items.filter((item) => foldKey(item.str) === "cep" && item.x >= splitX);
  const rightPhones = phones.filter((p) => p.x >= splitX);

  function nearestRight(label, pool) {
    let best = null;
    let bestScore = Infinity;
    for (const p of pool) {
      if (p.x < label.x - 4) continue;
      const dy = Math.abs(p.y - label.y);
      if (dy > 28) continue;
      const score = dy * 4 + (p.x - label.x);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  for (const label of cepLabels) {
    const hit = nearestRight(label, rightPhones);
    if (hit) return hit.phone;
  }
  if (rightPhones.length) return rightPhones[0].phone;

  const cepPhones = cepPhonesFromText(text, skip);
  if (cepPhones.length >= 2) return cepPhones[cepPhones.length - 1];
  return "";
}

async function extractPdfLayout(buffer) {
  if (typeof pdfjsLib === "undefined") {
    throw new Error("PDF okuyucu yüklenemedi");
  }
  const loading = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loading.promise;
  const items = [];
  let pageWidth = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    pageWidth = Math.max(pageWidth, viewport.width);
    const content = await page.getTextContent();
    for (const item of content.items) {
      const str = (item.str || "").trim();
      if (!str) continue;
      items.push({
        str,
        x: item.transform[4],
        y: item.transform[5]
      });
    }
  }
  return {
    items,
    pageWidth,
    text: items.map((item) => item.str).join(" ")
  };
}

async function fetchCiktiBuffer(url) {
  const res = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!res.ok) {
    throw new Error("Yazdır çıktısı alınamadı (" + res.status + ")");
  }
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const buffer = await res.arrayBuffer();
  return { type, buffer };
}

function htmlToText(buffer) {
  const decoder = new TextDecoder("utf-8");
  const html = decoder.decode(buffer);
  const doc = new DOMParser().parseFromString(html, "text/html");
  return {
    text: doc.body ? doc.body.innerText : html,
    pdfSrc: (doc.querySelector("embed[src], object[data], iframe[src]") || {}).src
      || (doc.querySelector("object") || {}).getAttribute?.("data")
      || ""
  };
}

async function phoneFromPdfUrl(url, exclude) {
  const { type, buffer } = await fetchCiktiBuffer(url);
  const looksPdf = type.includes("pdf") || (buffer.byteLength > 4 && String.fromCharCode(...new Uint8Array(buffer.slice(0, 4))) === "%PDF");

  if (looksPdf) {
    const layout = await extractPdfLayout(buffer);
    return pickAliciPhone(layout, exclude);
  }

  const parsed = htmlToText(buffer);
  const fromHtml = pickAliciPhone({ items: [], pageWidth: 0, text: parsed.text }, exclude);
  if (fromHtml) return fromHtml;

  if (parsed.pdfSrc) {
    const nested = new URL(parsed.pdfSrc, url).href;
    const nestedFetch = await fetchCiktiBuffer(nested);
    const layout = await extractPdfLayout(nestedFetch.buffer);
    return pickAliciPhone(layout, exclude);
  }
  return "";
}

async function resolvePhone(yazdirLink, fields) {
  const key = cacheKey(yazdirLink);
  if (key && phoneCache.has(key)) return phoneCache.get(key);

  const exclude = [fields.VarisSubeTel, fields.GonSubeTel];
  const fromTable = toDisplayPhone(fields.AliciTelefon);
  const url = ciktiUrl(yazdirLink);
  let phone = "";

  if (url) {
    try {
      phone = await phoneFromPdfUrl(url, exclude);
    } catch (err) {
      console.warn("SK PDF telefon", err);
    }
  }

  if (!phone) phone = fromTable;
  if (phone && key) phoneCache.set(key, phone);
  return phone;
}

async function openMessage(yazdirLink) {
  const tr = yazdirLink.closest("tr");
  if (!tr) return;
  let fields;
  try {
    stampOrderCodes();
    fields = buildFields(tr);
  } catch (err) {
    console.error("SK mesaj", err);
    showToast("SK hata: " + ((err && err.message) || err), "error");
    return;
  }
  orderDebug(fields);
  const settings = await getSettings();
  if (settings.warnIfDelivered && isDelivered(fields.TeslimatDurum)) {
    const ok = await confirmDelivered(fields);
    if (!ok) return;
  }
  const template = settings.template;
  const overlay = ensureModal();
  const meta = overlay.querySelector(".sk-mesaj-meta");
  const body = overlay.querySelector(".sk-mesaj-body");
  const wa = overlay.querySelector(".sk-mesaj-wa");

  meta.textContent = [
    fields.Alici && `Alıcı: ${fields.Alici}`,
    fields.WebSiparisKodu && `Sipariş: ${fields.WebSiparisKodu}`,
    fields.SiparisMagazadan,
    fields.TakipNo && `Takip: ${fields.TakipNo}`
  ]
    .filter(Boolean)
    .join("  ·  ");
  wa.classList.add("is-disabled");
  wa.href = "#";
  overlay.classList.add("is-open");

  if (templateUsesPaket(template) && fields.TakipNo) {
    body.value = "Paket sayısı kargo takipten alınıyor...";
    setStatus("Paket sayısı alınıyor");
    await enrichPaketFields(fields, template);
  }

  const message = applyTemplate(template, fields).trim();
  body.value = message;
  if (fields.PaketSayisi) {
    meta.textContent = [meta.textContent, `Paket: ${fields.PaketSayisi}`].filter(Boolean).join("  ·  ");
  }
  await copyText(message);
  setStatus("Kopyalandı");
  showToast("Mesaj kopyalandı");
  markContacted(fields);
  body.focus();
  body.select();

  try {
    const phone = await resolvePhone(yazdirLink, fields);
    const waPhone = toWhatsAppPhone(phone);
    if (waPhone) {
      wa.setAttribute("data-phone", waPhone);
      wa.href = `https://wa.me/${waPhone}?text=${encodeURIComponent(body.value)}`;
      wa.classList.remove("is-disabled");
      wa.removeAttribute("aria-disabled");
      meta.textContent = [meta.textContent, `Tel: ${phone}`].filter(Boolean).join("  ·  ");
    }
  } catch (err) {
    /* WhatsApp optional */
  }
}

async function copyPhone(yazdirLink, button) {
  const tr = yazdirLink.closest("tr");
  if (!tr) return;
  const fields = buildFields(tr);
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Alınıyor...";
  try {
    const phone = await resolvePhone(yazdirLink, fields);
    if (!phone) {
      showToast("PDF'de telefon bulunamadı", "error");
      return;
    }
    await copyText(phone);
    showToast("Telefon kopyalandı: " + phone);
  } catch (err) {
    showToast(err.message || "Telefon alınamadı", "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function isYazdirLink(el) {
  if (!el || el.tagName !== "A") return false;
  if (el.classList.contains("sk-action-btn")) return false;
  const href = el.getAttribute("href") || "";
  const text = (el.textContent || "").trim();
  return href.indexOf("GonderilenKargoCiktisi") !== -1 || text === "Yazdır";
}

function injectButtons(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const links = scope.querySelectorAll
    ? scope.querySelectorAll('a.btn[href*="GonderilenKargoCiktisi"], a[onclick*="yazdir"]')
    : [];
  const extra = [];
  if (root && root.nodeType === 1 && isYazdirLink(root)) extra.push(root);
  [...links, ...extra].forEach((a) => {
    if (!isYazdirLink(a)) return;
    const td = a.parentElement;
    if (td && td.querySelector(":scope > .sk-actions, :scope > .sk-cell-bar > .sk-actions")) return;

    const wrap = document.createElement("span");
    wrap.className = "sk-actions";

    const msgBtn = document.createElement("button");
    msgBtn.type = "button";
    msgBtn.className = "btn btn-default sk-action-btn";
    msgBtn.textContent = "Mesaj Kopyala";
    msgBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMessage(a);
    });

    const telBtn = document.createElement("button");
    telBtn.type = "button";
    telBtn.className = "btn btn-default sk-action-btn sk-tel-btn";
    telBtn.textContent = "Telefon Kopyala";
    telBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyPhone(a, telBtn);
    });

    wrap.appendChild(msgBtn);
    wrap.appendChild(telBtn);
    a.insertAdjacentElement("afterend", wrap);
    ensureCellBar(a.parentElement);
  });
  scheduleMarks();
  scheduleTableChrome();
}

let chromeTimer = 0;
function scheduleTableChrome() {
  clearTimeout(chromeTimer);
  chromeTimer = setTimeout(setupTableChrome, 50);
}

function ensureCellBar(td) {
  if (!td || td.tagName !== "TD") return;
  if (td.querySelector(":scope > .sk-cell-bar")) return;
  const bar = document.createElement("div");
  bar.className = "sk-cell-bar";
  while (td.firstChild) bar.appendChild(td.firstChild);
  td.appendChild(bar);
}

function findHorizontalScroller(element) {
  for (let node = element && element.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflowX = getComputedStyle(node).overflowX;
    if ((overflowX === "auto" || overflowX === "scroll") && node.scrollWidth > node.clientWidth + 1) {
      return node;
    }
  }
  return element.closest(".portlet-body") || element.closest(".table-responsive");
}

function setupTableChrome() {
  const table = document.getElementById("dataTable");
  if (!table || !table.tBodies.length) return;
  const wrapper = document.getElementById("dataTable_wrapper") || table.closest(".dataTables_wrapper");
  if (!wrapper) return;

  const nested = table.closest(".sk-table-scroll");
  if (nested) {
    nested.parentNode.insertBefore(table, nested);
    nested.remove();
  }

  const scroller = findHorizontalScroller(table);
  if (!scroller) return;

  let top = scroller.querySelector(":scope > .sk-hscroll-top");
  if (!top) {
    top = document.createElement("div");
    top.className = "sk-hscroll-top";
    top.setAttribute("aria-hidden", "true");
    const innerEl = document.createElement("div");
    innerEl.className = "sk-hscroll-inner";
    top.appendChild(innerEl);
  }
  if (scroller.firstElementChild !== top) {
    scroller.insertBefore(top, scroller.firstChild);
  }

  const controlsParent = scroller.parentElement;
  if (!controlsParent) return;
  let paginationShell = controlsParent.querySelector(":scope > .sk-pagination-shell");
  if (!paginationShell) {
    paginationShell = document.createElement("div");
    paginationShell.className = "sk-pagination-shell";
    scroller.insertAdjacentElement("afterend", paginationShell);
  }
  const paginate = document.getElementById("dataTable_paginate");
  if (paginate && paginate.parentElement !== paginationShell) {
    paginate.style.position = "";
    paginate.style.left = "";
    paginationShell.appendChild(paginate);
  }

  const inner = top.querySelector(".sk-hscroll-inner");
  const syncSize = () => {
    const visible = scroller.clientWidth;
    const full = Math.max(table.scrollWidth, table.offsetWidth);
    top.style.width = visible + "px";
    inner.style.width = full + "px";
  };

  let lock = false;
  top.onscroll = () => {
    if (lock) return;
    lock = true;
    if (scroller.scrollLeft !== top.scrollLeft) scroller.scrollLeft = top.scrollLeft;
    lock = false;
  };
  const syncTopPosition = () => {
    const scrollLeft = scroller.scrollLeft;
    const liveTop = scroller.querySelector(":scope > .sk-hscroll-top");
    if (liveTop && liveTop.scrollLeft !== scrollLeft) liveTop.scrollLeft = scrollLeft;
  };
  if (!scroller.dataset.skScrollBound) {
    scroller.dataset.skScrollBound = "1";
    scroller.addEventListener("scroll", syncTopPosition, { passive: true });
  }

  if (!scroller.dataset.skResizeBound) {
    scroller.dataset.skResizeBound = "1";
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(syncSize);
      ro.observe(scroller);
      ro.observe(table);
    }
    window.addEventListener("resize", syncSize);
  }
  syncSize();
  syncTopPosition();
}

function startObserver() {
  document.documentElement.dataset.skExtensionBuild = chrome.runtime.getManifest().version;
  getSettings().then(() => scheduleMarks());
  injectButtons(document);
  setupTableChrome();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === 1) injectButtons(node);
        });
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[CONTACTED_KEY]) {
        contactedCache = changes[CONTACTED_KEY].newValue || {};
        scheduleMarks();
      }
      if (area === "sync" && changes.spareDesi) {
        spareDesiLimit = normalizeSpareDesi(changes.spareDesi.newValue);
        scheduleMarks();
      }
    });
  } catch (err) {
    /* ignore */
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startObserver);
} else {
  startObserver();
}
