const SK_TAKIP_URL = "https://www.suratkargo.com.tr/KargoTakip/?kargotakipno=";

function parsePaketSayisi(html) {
  if (!html) return 0;
  const source = String(html);
  let max = 0;
  const labeled = source.matchAll(/Par[cç]a\s*:\s*\d+\s*\/\s*(\d+)/gi);
  for (const match of labeled) {
    const total = parseInt(match[1], 10);
    if (total > max) max = total;
  }
  if (max) return max;
  const cells = source.matchAll(/>(\d+)\s*\/\s*(\d+)</g);
  for (const match of cells) {
    const total = parseInt(match[2], 10);
    if (total > max) max = total;
  }
  return max;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "skPaketSayisi") return;
  const takipNo = String(msg.takipNo || "").replace(/\D/g, "");
  if (!takipNo) {
    sendResponse(0);
    return;
  }

  const url = SK_TAKIP_URL + encodeURIComponent(takipNo);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);

  fetch(url, { credentials: "omit", cache: "no-store", signal: ctrl.signal })
    .then((res) => {
      if (!res.ok) throw new Error("Takip HTTP " + res.status);
      return res.text();
    })
    .then((html) => {
      const count = parsePaketSayisi(html);
      console.log("SK paket sayısı", takipNo, count);
      sendResponse(count);
    })
    .catch((err) => {
      console.warn("SK paket sayısı", takipNo, err);
      sendResponse(0);
    })
    .finally(() => clearTimeout(timer));

  return true;
});
