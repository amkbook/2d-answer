const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,th;q=0.8"
};

const BLOCKED_SYMBOLS = new Set([
  "SET",
  "SET50",
  "SET100",
  "SET50FF",
  "SET100FF",
  "SETCLMV",
  "SETHD",
  "SETESG",
  "SETWB",
  "SETTRI",
  "SSET",
  "MAI",
  "TFEX",
  "VALUE",
  "VOLUME",
  "GAINERS",
  "LOSERS",
  "MORE",
  "LAST",
  "CHANGE",
  "BAHT",
  "SHARES",
  "TYPE",
  "BUY",
  "SELL",
  "NET",
  "HIGH",
  "LOW",
  "OPEN",
  "OPEN1",
  "OPEN2",
  "ICT",
  "REMARK",
  "INDEX",
  "TOTAL",
  "TRADING",
  "SUMMARY",
  "INSTITUTION",
  "PROPRIETARY",
  "FOREIGN",
  "INDIVIDUAL"
]);

function isStockSymbol(sym) {
  if (!sym) return false;
  const s = String(sym).trim().toUpperCase();
  if (!/^[A-Z]{2,8}[0-9]?$/.test(s)) return false;
  if (BLOCKED_SYMBOLS.has(s)) return false;
  if (s.startsWith("SET")) return false;
  return true;
}

function cleanNum(text) {
  if (text === null || text === undefined) return null;
  const n = parseFloat(String(text).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function stripHtmlToText(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(tr|td|th|li|p|div|span|a|button|h1|h2|h3|h4|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return await res.text();
}

function parseHighLowFromText(text) {
  const m1 = text.match(
    /\bHigh\b[^\d-]*([\d,]+\.\d{2})[\s\S]{0,80}?\bLow\b[^\d-]*([\d,]+\.\d{2})/i
  );
  if (m1) {
    return { high: cleanNum(m1[1]), low: cleanNum(m1[2]) };
  }

  const setRowMatch = text.match(
    /\bSET\b\s+(-?\d[\d,]*\.\d{2})\s+([+-]?\d[\d,]*\.\d{2})\s*\(([^)]+)\)\s+(-?\d[\d,]*\.\d{2})\s+(-?\d[\d,]*\.\d{2})\s+(-?\d[\d,]*\.\d{2})/
  );
  if (setRowMatch) {
    return {
      high: cleanNum(setRowMatch[5]),
      low: cleanNum(setRowMatch[6])
    };
  }

  return { high: null, low: null };
}

async function fetchSetOverviewDetails() {
  const url = "https://www.set.or.th/en/market/product/stock/overview";
  const html = await fetchHtml(url);
  const bodyText = stripHtmlToText(html);
  const singleLine = bodyText.replace(/\s+/g, " ");

  const setMatch = singleLine.match(
    /\bSET\b\s+(-?\d[\d,]*\.\d{2})\s+([+-]?\d[\d,]*\.\d{2})\s*\(([^)]+)\)/
  );
  const set50Match = singleLine.match(
    /\bSET50\b\s+(-?\d[\d,]*\.\d{2})\s+([+-]?\d[\d,]*\.\d{2})\s*\(([^)]+)\)/
  );
  const { high, low } = parseHighLowFromText(singleLine);

  return {
    setIndex: setMatch ? cleanNum(setMatch[1]) : null,
    setChange: setMatch ? setMatch[2] : null,
    setChangePct: setMatch ? setMatch[3] : null,
    set50Index: set50Match ? cleanNum(set50Match[1]) : null,
    high,
    low
  };
}

function parseTop5StocksFromText(text) {
  const top5 = [];
  const seen = new Set();

  const valueCardRegex =
    /\b([A-Z]{2,8}[0-9]?)\b[\s\S]{0,120}?([\d,]+\.\d{2})[\s\S]{0,120}?Value\s*\('000\s*Baht\)[\s\S]{0,80}?([+-]?[\d,]+\.\d{2})\s*\(\s*([+-]?[\d,.]+%)\s*\)/gi;

  for (const m of text.matchAll(valueCardRegex)) {
    const symbol = String(m[1]).trim().toUpperCase();
    if (!isStockSymbol(symbol) || seen.has(symbol)) continue;

    const price = cleanNum(m[2]);
    const change = m[3];
    const pctStr = m[4].replace(/\s+/g, "");
    const pct = parseFloat(pctStr.replace("%", ""));
    if (price === null || !Number.isFinite(pct)) continue;

    seen.add(symbol);
    const dir = pct > 0 ? "▲" : pct < 0 ? "▼" : "▬";
    top5.push({
      symbol,
      price,
      change,
      changePct: pctStr,
      dir
    });

    if (top5.length >= 5) return top5;
  }

  return [];
}

async function fetchFlowAndTop5() {
  const homeUrl = "https://www.set.or.th/en/home";
  const overviewUrl = "https://www.set.or.th/en/market/product/stock/overview";

  const [homeRes, overviewRes] = await Promise.allSettled([
    fetchHtml(homeUrl),
    fetchHtml(overviewUrl)
  ]);

  const homeHtml = homeRes.status === "fulfilled" ? homeRes.value : "";
  const overviewHtml = overviewRes.status === "fulfilled" ? overviewRes.value : "";

  const homeText = stripHtmlToText(homeHtml);
  const fallbackText = stripHtmlToText(overviewHtml);
  const singleLine = (homeText || fallbackText).replace(/\s+/g, " ");

  const investorTypes = ["Institution", "Proprietary", "Foreign", "Individual"];
  const netFlow = {};

  for (const type of investorTypes) {
    const re = new RegExp(
      `\\b${type}\\b\\s+([+-]?[\\d,]+(?:\\.\\d+)?)\\s+([+-]?[\\d,]+(?:\\.\\d+)?)\\s+([+-]?[\\d,]+(?:\\.\\d+)?)`
    );
    const m = singleLine.match(re);
    netFlow[type] = m
      ? {
          buy: cleanNum(m[1]),
          sell: cleanNum(m[2]),
          net: cleanNum(m[3])
        }
      : { buy: null, sell: null, net: null };
  }

  let top5 = parseTop5StocksFromText(homeText);
  if (top5.length === 0 && fallbackText) {
    top5 = parseTop5StocksFromText(fallbackText);
  }

  return { netFlow, top5 };
}

async function collectEnrichedCheckpoint(ictTimeLabel, coreSnap = null) {
  const [overviewRes, flowRes] = await Promise.allSettled([
    fetchSetOverviewDetails(),
    fetchFlowAndTop5()
  ]);

  const overview = overviewRes.status === "fulfilled" ? overviewRes.value : {};
  const { netFlow = {}, top5 = [] } = flowRes.status === "fulfilled" ? flowRes.value : {};

  const fmtNet = (val) =>
    val === null || val === undefined ? "N/A" : `${val > 0 ? "+" : ""}${val}`;

  const flowSummary = `Inst ${fmtNet(netFlow.Institution?.net)} | Prop ${fmtNet(
    netFlow.Proprietary?.net
  )} | Foreign ${fmtNet(netFlow.Foreign?.net)} | Indiv ${fmtNet(netFlow.Individual?.net)}`;

  const top5Summary =
    top5.length > 0
      ? top5
          .map(
            (s) =>
              `${s.symbol} ${s.price ?? ""} ${s.dir} (${s.changePct})`
                .replace(/\s+/g, " ")
                .trim()
          )
          .join(" | ")
      : "N/A";

  const setVal = overview.setIndex ?? coreSnap?.setIndex ?? "N/A";
  const setChg = overview.setChange ?? coreSnap?.indexChange ?? "N/A";
  const setPct = overview.setChangePct ?? "N/A";
  const volVal = coreSnap?.volumeKShares ?? "N/A";
  const valBaht = coreSnap?.valueMBaht ?? "N/A";
  const set50Val = overview.set50Index ?? coreSnap?.set50Index ?? "N/A";

  const promptLine = [
    `[${ictTimeLabel} ICT]`,
    `SET: ${setVal} (${setChg}, ${setPct})`,
    `Vol: ${volVal} | Val: ${valBaht}`,
    `High/Low: ${overview.high ?? "N/A"}/${overview.low ?? "N/A"}`,
    `SET50: ${set50Val}`,
    `Net Flow (M.Baht): ${flowSummary}`,
    `Top 5 Value: ${top5Summary}`
  ].join(" | ");

  return {
    time: ictTimeLabel,
    overview,
    netFlow,
    top5,
    promptLine
  };
}

module.exports = {
  fetchSetOverviewDetails,
  fetchFlowAndTop5,
  collectEnrichedCheckpoint
};