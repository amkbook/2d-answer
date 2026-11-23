const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,th;q=0.8"
};

function cleanNum(text) {
  if (!text) return null;
  const n = parseFloat(String(text).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function stripHtmlToText(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return await res.text();
}

async function fetchSetOverviewDetails() {
  const url = "https://www.set.or.th/en/market/product/stock/overview";
  const html = await fetchHtml(url);
  const bodyText = stripHtmlToText(html);

  const setMatch = bodyText.match(
    /\bSET\b\s+(-?\d[\d,]*\.\d{2})\s+([+-]?\d[\d,]*\.\d{2})\s*\(([^)]+)\)/
  );
  const set50Match = bodyText.match(
    /\bSET50\b\s+(-?\d[\d,]*\.\d{2})\s+([+-]?\d[\d,]*\.\d{2})\s*\(([^)]+)\)/
  );
  const highLowMatch = bodyText.match(/\bHigh\s+([\d,]+\.\d{2})\s+Low\s+([\d,]+\.\d{2})/i);

  return {
    setIndex: setMatch ? cleanNum(setMatch[1]) : null,
    setChange: setMatch ? setMatch[2] : null,
    setChangePct: setMatch ? setMatch[3] : null,
    set50Index: set50Match ? cleanNum(set50Match[1]) : null,
    high: highLowMatch ? cleanNum(highLowMatch[1]) : null,
    low: highLowMatch ? cleanNum(highLowMatch[2]) : null
  };
}

async function fetchFlowAndTop5() {
  const url = "https://www.set.or.th/en/home";
  const html = await fetchHtml(url);
  const text = stripHtmlToText(html);

  const investorTypes = ["Institution", "Proprietary", "Foreign", "Individual"];
  const netFlow = {};

  for (const type of investorTypes) {
    const re = new RegExp(
      `\\b${type}\\b\\s+([+-]?[\\d,.]+)\\s+([+-]?[\\d,.]+)\\s+([+-]?[\\d,.]+)`
    );
    const m = text.match(re);
    netFlow[type] = m
      ? {
          buy: cleanNum(m[1]),
          sell: cleanNum(m[2]),
          net: cleanNum(m[3])
        }
      : { buy: null, sell: null, net: null };
  }

  const top5 = [];
  const top5SectionMatch = text.match(/Top\s*5[\s\S]{0,2500}/i);
  if (top5SectionMatch) {
    const chunk = top5SectionMatch[0];
    const symMatches = [
      ...chunk.matchAll(
        /\b([A-Z0-9]{2,10})\b\s+([\d,]+\.\d{2})\s+([+-]?[\d,]+\.\d{2})\s*\(([+-]?[\d,.]+%)\)/g
      )
    ];
    for (const item of symMatches.slice(0, 5)) {
      const pct = parseFloat(item[4].replace("%", ""));
      const dir = pct > 0 ? "▲" : pct < 0 ? "▼" : "▬";
      top5.push({
        symbol: item[1],
        price: cleanNum(item[2]),
        changePct: item[4],
        dir
      });
    }
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
      ? top5.map((s) => `${s.symbol} ${s.dir} (${s.changePct})`).join(" | ")
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