const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,th;q=0.8"
};

function cleanNum(text) {
  if (text === null || text === undefined) return null;
  const n = parseFloat(String(text).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function stripHtmlToText(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(tr|td|th|li|p|div|h1|h2|h3|h4|section|article|br)>/gi, " \n ")
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

function parseTop5FromSection(sectionText) {
  const top5 = [];
  const lines = sectionText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const ignoreSymbols = new Set([
    "SET",
    "SET50",
    "SET100",
    "SSET",
    "MAI",
    "TFEX",
    "TOP",
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
    "TOTAL",
    "TRADING",
    "SUMMARY",
    "OPEN2",
    "ICT",
    "NOV",
    "DEC",
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT"
  ]);

  const regex =
    /\b([A-Z][A-Z0-9]{1,9})\b[\s\S]{0,80}?([\d,]+\.\d{2})\s+([+-]?[\d,]+\.\d{2})\s*\(\s*([+-]?[\d,.]+%)\s*\)/g;

  const seen = new Set();
  for (const m of sectionText.matchAll(regex)) {
    const symbol = m[1].toUpperCase();
    if (ignoreSymbols.has(symbol) || seen.has(symbol)) continue;

    const price = cleanNum(m[2]);
    const pctStr = m[4].replace(/\s+/g, "");
    const pct = parseFloat(pctStr.replace("%", ""));
    if (price === null || !Number.isFinite(pct)) continue;

    seen.add(symbol);
    const dir = pct > 0 ? "▲" : pct < 0 ? "▼" : "▬";
    top5.push({
      symbol,
      price,
      change: m[3],
      changePct: pctStr,
      dir
    });

    if (top5.length >= 5) break;
  }

  if (top5.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      const symCandidate = lines[i].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      if (
        /^[A-Z][A-Z0-9]{1,9}$/.test(symCandidate) &&
        !ignoreSymbols.has(symCandidate) &&
        !seen.has(symCandidate)
      ) {
        const windowStr = lines.slice(i, i + 6).join(" ");
        const wm = windowStr.match(
          /([\d,]+\.\d{2})\s+([+-]?[\d,]+\.\d{2})\s*\(\s*([+-]?[\d,.]+%)\s*\)/
        );
        if (wm) {
          seen.add(symCandidate);
          const pctStr = wm[3].replace(/\s+/g, "");
          const pct = parseFloat(pctStr.replace("%", ""));
          top5.push({
            symbol: symCandidate,
            price: cleanNum(wm[1]),
            change: wm[2],
            changePct: pctStr,
            dir: pct > 0 ? "▲" : pct < 0 ? "▼" : "▬"
          });
          if (top5.length >= 5) break;
        }
      }
    }
  }

  return top5;
}

function extractTop5FromHtml(html = "") {
  // Check embedded JSON / script objects first
  const jsonTop5 = [];
  const objMatches = [
    ...html.matchAll(
      /"(?:symbol|securitySymbol|stockSymbol)"\s*:\s*"([A-Z][A-Z0-9]{1,9})"[\s\S]{0,180}?"(?:last|lastPrice|price)"\s*:\s*([\d.]+)[\s\S]{0,180}?"(?:percentChange|changePercent|pctChange)"\s*:\s*([+-]?[\d.]+)/gi
    )
  ];

  const seen = new Set();
  for (const m of objMatches) {
    const symbol = String(m[1]).toUpperCase();
    if (seen.has(symbol)) continue;
    const price = cleanNum(m[2]);
    const pctNum = parseFloat(m[3]);
    if (price === null || !Number.isFinite(pctNum)) continue;
    seen.add(symbol);
    const pctStr = `${pctNum > 0 ? "+" : ""}${pctNum.toFixed(2)}%`;
    const dir = pctNum > 0 ? "▲" : pctNum < 0 ? "▼" : "▬";
    jsonTop5.push({
      symbol,
      price,
      changePct: pctStr,
      dir
    });
    if (jsonTop5.length >= 5) return jsonTop5;
  }

  const text = stripHtmlToText(html);
  const top5Idx = text.search(/Top\s*5/i);
  const slice = top5Idx >= 0 ? text.slice(top5Idx, top5Idx + 4000) : text;
  return parseTop5FromSection(slice);
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

  const text = stripHtmlToText(homeHtml || overviewHtml);
  const singleLine = text.replace(/\s+/g, " ");

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

  let top5 = extractTop5FromHtml(homeHtml);
  if (top5.length === 0 && overviewHtml) {
    top5 = extractTop5FromHtml(overviewHtml);
  }

  return { netFlow, top5 };
}

async function collectEnrichedCheckpoint(ictTimeLabel) {
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

  const promptLine = [
    `[${ictTimeLabel} ICT]`,
    `SET: ${overview.setIndex ?? "N/A"} (${overview.setChange ?? "N/A"}, ${
      overview.setChangePct ?? "N/A"
    })`,
    `High/Low: ${overview.high ?? "N/A"}/${overview.low ?? "N/A"}`,
    `SET50: ${overview.set50Index ?? "N/A"}`,
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