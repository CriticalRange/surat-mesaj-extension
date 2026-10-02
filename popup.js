const templateEl = document.getElementById("template");
const statusEl = document.getElementById("status");
const chipsEl = document.getElementById("chips");

let savedSel = { start: 0, end: 0, scroll: 0 };

function rememberCaret() {
  savedSel = {
    start: templateEl.selectionStart,
    end: templateEl.selectionEnd,
    scroll: templateEl.scrollTop
  };
}

function flash(text) {
  statusEl.textContent = text;
  clearTimeout(flash._t);
  flash._t = setTimeout(() => {
    if (statusEl.textContent === text) statusEl.textContent = "";
  }, 1800);
}

const warnEl = document.getElementById("warnIfDelivered");
const spareEl = document.getElementById("spareDesi");

function normalizeSpareDesi(value) {
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return SK_DEFAULT_SPARE_DESI;
  return n;
}

function load() {
  chrome.storage.sync.get(
    {
      template: SK_DEFAULT_TEMPLATE,
      warnIfDelivered: SK_DEFAULT_WARN_IF_DELIVERED,
      spareDesi: SK_DEFAULT_SPARE_DESI
    },
    (result) => {
      templateEl.value = result.template || SK_DEFAULT_TEMPLATE;
      warnEl.checked = result.warnIfDelivered !== false;
      spareEl.value = String(normalizeSpareDesi(result.spareDesi));
      savedSel = { start: 0, end: 0, scroll: 0 };
    }
  );
}

function insertToken(token) {
  const start = templateEl.selectionStart ?? savedSel.start;
  const end = templateEl.selectionEnd ?? savedSel.end;
  const scroll = templateEl.scrollTop;
  templateEl.setRangeText(token, start, end, "end");
  templateEl.scrollTop = scroll;
  rememberCaret();
}

["select", "click", "keyup", "mouseup"].forEach((evt) => {
  templateEl.addEventListener(evt, rememberCaret);
});

SK_PLACEHOLDERS.forEach((name) => {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.textContent = `{{${name}}}`;
  chip.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });
  chip.addEventListener("click", () => {
    insertToken(`{{${name}}}`);
  });
  chipsEl.appendChild(chip);
});

warnEl.addEventListener("change", () => {
  chrome.storage.sync.set({ warnIfDelivered: warnEl.checked }, () => {
    flash(warnEl.checked ? "Teslim uyarısı açık" : "Teslim uyarısı kapalı");
  });
});

function saveSpareDesi() {
  const n = normalizeSpareDesi(spareEl.value);
  spareEl.value = String(n);
  chrome.storage.sync.set({ spareDesi: n }, () => {
    flash("Yedek desi: " + n);
  });
}

spareEl.addEventListener("change", saveSpareDesi);

document.getElementById("save").addEventListener("click", () => {
  const spareDesi = normalizeSpareDesi(spareEl.value);
  spareEl.value = String(spareDesi);
  chrome.storage.sync.set(
    {
      template: templateEl.value,
      warnIfDelivered: warnEl.checked,
      spareDesi
    },
    () => flash("Kaydedildi")
  );
});

document.getElementById("reset").addEventListener("click", () => {
  templateEl.value = SK_DEFAULT_TEMPLATE;
  chrome.storage.sync.set({ template: SK_DEFAULT_TEMPLATE }, () => flash("Varsayılan yüklendi"));
});

const contactedCountEl = document.getElementById("contactedCount");

function refreshContactedCount() {
  chrome.storage.local.get({ contactedSiparis: {} }, (result) => {
    contactedCountEl.textContent = String(Object.keys(result.contactedSiparis || {}).length);
  });
}

document.getElementById("clearContacted").addEventListener("click", () => {
  chrome.storage.local.set({ contactedSiparis: {} }, () => {
    refreshContactedCount();
    flash("İşaretler temizlendi");
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.contactedSiparis) refreshContactedCount();
});

load();
refreshContactedCount();
