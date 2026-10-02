(function () {
  const captured = [];

  function rememberJquery(value) {
    if (!value || (typeof value !== "function" && typeof value !== "object")) return;
    if (!value.fn || captured.indexOf(value) !== -1) return;
    captured.push(value);
  }

  function watchGlobal(name) {
    let current;
    try {
      current = window[name];
    } catch (err) {
      return;
    }
    rememberJquery(current);
    try {
      const desc = Object.getOwnPropertyDescriptor(window, name);
      if (desc && desc.configurable === false) return;
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: !desc || desc.enumerable !== false,
        get: function () {
          return current;
        },
        set: function (value) {
          current = value;
          rememberJquery(value);
        }
      });
    } catch (err) {
      rememberJquery(current);
    }
  }

  watchGlobal("jQuery");
  watchGlobal("$");
  watchGlobal("jquery");

  function fold(text) {
    return String(text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase("tr-TR")
      .replace(/ı/g, "i")
      .replace(/İ/g, "i")
      .replace(/[^a-z0-9]/g, "");
  }

  const WANTED = ["websipariskodu", "websiparisno", "sipariskodu"];

  function matches(name) {
    if (!name || name.length > 48) return false;
    return WANTED.some((key) => name === key || name.indexOf(key) !== -1);
  }

  function textOf(value) {
    if (value == null) return "";
    if (typeof value === "number") return String(value);
    if (typeof value === "object") {
      if (typeof value.display === "string" || typeof value.display === "number") return textOf(value.display);
      if (typeof value["@data-order"] === "string") return textOf(value["@data-order"]);
      return "";
    }
    const html = String(value);
    if (html.indexOf("<") === -1) return html.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const holder = document.createElement("div");
    holder.innerHTML = html;
    return (holder.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function scanWindowForJquery() {
    let names = [];
    try {
      names = Object.getOwnPropertyNames(window);
    } catch (err) {
      return;
    }
    for (let i = 0; i < names.length; i++) {
      if (!/jquery|datatable/i.test(names[i]) && names[i] !== "$") continue;
      try {
        rememberJquery(window[names[i]]);
      } catch (err) {
        /* getter */
      }
    }
  }

  function settingsList() {
    scanWindowForJquery();
    const lists = [];
    const sources = captured.slice();
    [window.jQuery, window.$, window.jquery, window.DataTable, window.dataTable].forEach((item) => {
      if (item && sources.indexOf(item) === -1) sources.push(item);
    });
    sources.forEach((jq) => {
      try {
        if (jq && jq.fn && jq.fn.dataTable && jq.fn.dataTable.settings) lists.push(jq.fn.dataTable.settings);
        if (jq && jq.fn && jq.fn.dataTableSettings) lists.push(jq.fn.dataTableSettings);
        if (jq && jq.settings && jq.ext && typeof jq.settings.length === "number") lists.push(jq.settings);
      } catch (err) {
        /* ignore */
      }
    });
    const out = [];
    const seen = new Set();
    lists.forEach((list) => {
      for (let i = 0; i < list.length; i++) {
        if (!list[i] || seen.has(list[i])) continue;
        seen.add(list[i]);
        out.push(list[i]);
      }
    });
    return out;
  }

  function columnField(col) {
    if (!col) return "";
    if (typeof col.mData === "string") return col.mData;
    if (typeof col.mDataProp === "string") return col.mDataProp;
    if (typeof col.data === "string") return col.data;
    if (typeof col.name === "string") return col.name;
    if (typeof col.sName === "string") return col.sName;
    return "";
  }

  function columnIndex(settings) {
    const cols = settings.aoColumns || [];
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i] || {};
      const header = col.nTh ? col.nTh.textContent : "";
      const name = fold(header + " " + (col.sTitle || "") + " " + columnField(col));
      if (matches(name)) return i;
    }
    return -1;
  }

  function codeFromData(data) {
    if (!data || typeof data !== "object") return "";
    if (Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        const item = data[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const nested = codeFromData(item);
        if (nested) return nested;
      }
      return "";
    }
    const keys = Object.keys(data);
    for (let i = 0; i < keys.length; i++) {
      if (!matches(fold(keys[i]))) continue;
      const text = textOf(data[keys[i]]);
      if (text) return text;
    }
    return "";
  }

  function valueFrom(settings, data, colIndex) {
    if (data == null || colIndex < 0) return "";
    if (Array.isArray(data) || typeof data[colIndex] === "string" || typeof data[colIndex] === "number") {
      const direct = textOf(data[colIndex]);
      if (direct) return direct;
    }
    const key = columnField((settings.aoColumns || [])[colIndex]);
    if (key && data[key] != null) return textOf(data[key]);
    return "";
  }

  function cellValue(cell) {
    if (!cell) return "";
    const bits = [cell.textContent];
    ["title", "data-order", "data-search", "data-filter", "data-value"].forEach((attr) => {
      const value = cell.getAttribute && cell.getAttribute(attr);
      if (value) bits.push(value);
    });
    if (cell.querySelectorAll) {
      cell.querySelectorAll("input, textarea, select").forEach((el) => {
        if (el.value) bits.push(el.value);
      });
    }
    return textOf(bits.filter(Boolean).join(" "));
  }

  function bodyRows(table) {
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

  function tablesNear(table) {
    const list = [];
    const add = (item) => {
      if (item && item.tagName === "TABLE" && list.indexOf(item) === -1) list.push(item);
    };
    add(table);
    add(document.getElementById("dataTable"));
    const wrapper =
      (table && table.closest && table.closest(".dataTables_wrapper, .dt-container, .dataTables_scroll, .DTFC_ScrollWrapper")) ||
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

  function copyCode(sourceRows, tables, expected) {
    tables.forEach((table) => {
      const width = tableWidth(table);
      if (expected && width && Math.abs(width - expected) > 1) return;
      bodyRows(table).forEach((row, index) => {
        const code = sourceRows[index] && sourceRows[index].getAttribute("data-sk-websiparis");
        if (code) row.setAttribute("data-sk-websiparis", code);
      });
    });
  }

  function stampSettings(settings) {
    const colIndex = columnIndex(settings);
    const ao = settings.aoData || [];
    const sourceRows = [];
    for (let i = 0; i < ao.length; i++) {
      const row = ao[i];
      if (!row || !row.nTr) continue;
      const fromKey = codeFromData(row._aData);
      const fromCol = colIndex >= 0 ? valueFrom(settings, row._aData, colIndex) : "";
      const fromCell = colIndex >= 0 && row.anCells ? cellValue(row.anCells[colIndex]) : "";
      const code = fromKey || fromCol || fromCell;
      if (code && !matches(fold(code))) row.nTr.setAttribute("data-sk-websiparis", code);
      sourceRows.push(row.nTr);
    }
    const wrapper = settings.nTableWrapper || (settings.nTable && settings.nTable.closest(".dataTables_wrapper, .dt-container"));
    if (!wrapper) return;
    copyCode(sourceRows, tablesNear(settings.nTable), tableWidth(settings.nTable));
  }

  function labelOf(el) {
    if (!el) return "";
    let direct = "";
    for (let node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) direct += node.nodeValue;
    }
    direct = direct.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    if (direct.length > 80) return "";
    if (direct) return direct;
    const titled = [el.getAttribute && el.getAttribute("title"), el.getAttribute && el.getAttribute("aria-label"), el.getAttribute && el.getAttribute("data-title"), el.getAttribute && el.getAttribute("data-field")]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (titled && titled.length <= 80) return titled;
    if (el.children && el.children.length === 1) {
      const inner = labelOf(el.children[0]);
      if (inner) return inner;
    }
    const role = el.getAttribute && el.getAttribute("role");
    if (el.tagName === "TH" || el.tagName === "TD" || role === "columnheader") {
      const all = (el.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      if (all && all.length <= 80) return all;
    }
    return "";
  }

  function columnPosition(el) {
    const cell = el.closest ? el.closest("th, td") || el : el;
    let index = cell.cellIndex;
    if (index == null || index < 0) {
      const row = cell.parentElement;
      index = row ? [...row.children].indexOf(cell) : -1;
    }
    if (index == null || index < 0) return null;
    return { index: index, table: cell.closest ? cell.closest("table") : null };
  }

  function nameRank(name) {
    if (name === "websipariskodu" || name === "websiparisno") return 0;
    if (name.indexOf("websipariskodu") !== -1 || name.indexOf("websiparisno") !== -1) return 1;
    return 2;
  }

  function orderHits() {
    const hits = [];
    document.querySelectorAll("th, td, [role='columnheader']").forEach((el) => {
      const name = fold(labelOf(el));
      if (!matches(name)) return;
      const pos = columnPosition(el);
      if (!pos) return;
      pos.name = name;
      hits.push(pos);
    });
    hits.sort((a, b) => nameRank(a.name) - nameRank(b.name) || rankTable(a.table) - rankTable(b.table));
    return hits;
  }

  function rankTable(table) {
    if (!table) return 2;
    if (table.id === "dataTable") return 0;
    if (table.closest && table.closest("#dataTable_wrapper, .dataTables_wrapper, .dataTables_scroll, .dt-scroll, .dt-container")) return 0;
    return 1;
  }

  function tableWidth(table) {
    if (!table || !table.rows) return 0;
    let width = 0;
    [...table.rows].forEach((row) => {
      if (row.cells) width = Math.max(width, row.cells.length);
    });
    return width;
  }

  function usableCode(cell) {
    const text = cellValue(cell);
    if (!text || matches(fold(text))) return "";
    return text;
  }

  function stampColumn(index, headerTable) {
    const tables = tablesNear(headerTable);
    const expected = tableWidth(headerTable);
    let source = [];
    tables.forEach((table) => {
      if (source.length) return;
      const width = tableWidth(table);
      if (width <= index) return;
      if (expected && Math.abs(width - expected) > 1) return;
      const rows = bodyRows(table);
      if (!rows.some((row) => row.cells && row.cells.length > index && usableCode(row.cells[index]))) return;
      source = rows;
    });
    source.forEach((row) => {
      if (!row.cells || row.cells.length <= index) return;
      const code = usableCode(row.cells[index]);
      if (code) row.setAttribute("data-sk-websiparis", code);
    });
    if (source.length) copyCode(source, tables, expected);
    return source.length;
  }

  function digitCode(text) {
    const groups = String(text || "").match(/\d+/g) || [];
    const checks = groups.filter((digits) => digits.length >= 6);
    const joined = groups.join("");
    if (joined.length >= 6) checks.push(joined);
    for (let i = 0; i < checks.length; i++) {
      if (checks[i].indexOf("876") === 0 || checks[i].indexOf("727") === 0) return checks[i];
    }
    return "";
  }

  function stampWidestRows(tables) {
    let source = [];
    let width = 0;
    tables.forEach((table) => {
      const rows = bodyRows(table);
      const w = rows.reduce((max, row) => Math.max(max, row.cells ? row.cells.length : 0), 0);
      if (w > width) {
        width = w;
        source = rows;
      }
    });
    source.forEach((row) => {
      if (row.getAttribute("data-sk-websiparis")) return;
      let code = "";
      [...row.cells].forEach((cell) => {
        if (code) return;
        code = digitCode(cellValue(cell));
      });
      if (code) row.setAttribute("data-sk-websiparis", code);
    });
    if (source.length) copyCode(source, tables, width);
  }

  function stampFromDocument() {
    const hits = orderHits();
    const exact = hits.some((hit) => nameRank(hit.name) === 0);
    let column = -1;
    hits.forEach((hit) => {
      if (column >= 0) return;
      if (exact && nameRank(hit.name) > 0) return;
      const stamped = stampColumn(hit.index, hit.table);
      if (stamped) column = hit.index;
    });
    if (column < 0 && hits.length) column = hits[0].index;
    if (!document.querySelector("[data-sk-websiparis]")) stampWidestRows(tablesNear(document.getElementById("dataTable")));
    return { column: column };
  }

  function columnNames(settings) {
    const cols = settings.aoColumns || [];
    const names = [];
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i] || {};
      const header = col.nTh ? col.nTh.textContent : "";
      const name = fold(header + " " + (col.sTitle || "") + " " + columnField(col));
      if (name) names.push(i + ":" + name.slice(0, 32));
    }
    return names;
  }

  function headerSample() {
    const names = [];
    const nodes = document.querySelectorAll(
      "thead th, thead td, tr#tableHeaderRow th, tr#tableHeaderRow td, .dataTables_scrollHead th, .dataTables_scrollHead td, .dt-scroll-head th, .dt-scroll-head td, [role='columnheader']"
    );
    nodes.forEach((el) => {
      if (names.length >= 24) return;
      const name = fold(labelOf(el)).slice(0, 28);
      if (!name || names.indexOf(name) !== -1) return;
      names.push(name);
    });
    return names;
  }

  function writeStatus(status) {
    const root = document.documentElement;
    if (!root) return;
    root.setAttribute("data-sk-hook", "1");
    root.setAttribute("data-sk-stamp-error", status.error || "");
    root.setAttribute("data-sk-columns", (status.columns || []).join("|").slice(0, 900));
    root.setAttribute("data-sk-stamped", String(status.stamped || 0));
  }

  let lastReported = "";

  function stamp() {
    const status = { columns: [], error: "", stamped: 0 };
    try {
      const seen = new Set();
      settingsList().forEach((settings) => {
        if (!settings || seen.has(settings)) return;
        seen.add(settings);
        status.columns = status.columns.concat(columnNames(settings));
        stampSettings(settings);
      });
      const dom = stampFromDocument();
      if (dom.column >= 0) status.columns.push("kolon " + dom.column);
      if (!status.columns.length) status.columns = headerSample();
      status.stamped = document.querySelectorAll("[data-sk-websiparis]").length;
      if (!status.stamped) {
        status.error = dom.column >= 0 ? "sipariş kolonu boş" : status.columns.length ? "sipariş kolonu yok" : "başlık bulunamadı";
      }
    } catch (err) {
      status.error = (err && (err.stack || err.message)) || String(err);
      console.error("SK sipariş", err);
    }
    writeStatus(status);
    const line = status.error ? status.error + "|" + (status.columns || []).join(",") : "";
    if (!line || line === lastReported) return;
    lastReported = line;
    console.error("SK sipariş", status.error, status.columns);
  }

  function markHook() {
    if (!document.documentElement) return;
    document.documentElement.setAttribute("data-sk-hook", "1");
  }

  if (document.documentElement) markHook();
  else document.addEventListener("DOMContentLoaded", markHook);
  document.addEventListener("sk-stamp-orders", stamp);
})();
