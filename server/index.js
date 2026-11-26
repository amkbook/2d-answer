const express = require("express");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const extraMonitor = require("./setExtraMonitor.js");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "..", "data");
const CHECKPOINTS_FILE = path.join(DATA_DIR, "checkpoints.json");
const TARGET_SLOTS = ["11:31", "11:41", "11:51", "12:01", "12:11", "12:21"];

app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

// Allow phone Chrome / APK / external clients to call API over HTTPS/HTTP
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

app.use(express.static(path.join(__dirname, "..", "public")));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CHECKPOINTS_FILE)) {
    fs.writeFileSync(
      CHECKPOINTS_FILE,
      JSON.stringify({ updatedAt: null, records: [] }, null, 2),
      "utf8"
    );
  }
}

function readStore() {
  ensureStore();
  try {
    const raw = fs.readFileSync(CHECKPOINTS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      updatedAt: parsed.updatedAt || null,
      records: Array.isArray(parsed.records) ? parsed.records : []
    };
  } catch {
    return { updatedAt: null, records: [] };
  }
}

function writeStore(store) {
  ensureStore();
  fs.writeFileSync(CHECKPOINTS_FILE, JSON.stringify(store, null, 2), "utf8");
}

function parseNumber(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (typeof val !== "string") return null;
  const cleaned = val.replace(/,/g, "").trim();
  const match = cleaned.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function stripHtml(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function getIctNow(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const map = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  const isWeekend = map.weekday === "Sat" || map.weekday === "Sun";
  const dateKey = `${map.year}-${map.month}-${map.day}`;
  const hmKey = `${map.hour}:${map.minute}`;
  const displayStr = `${map.weekday} ${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}:${map.second} ICT`;

  return {
    ...map,
    isWeekend,
    dateKey,
    hmKey,
    displayStr
  };
}

// Fetch core SET market metrics from SET website
async function fetchSetSnapshot() {
  const url = "https://www.set.or.th/en/market/product/stock/overview";
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,th;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`SET website HTTP ${response.status}`);
  }

  const html = await response.text();
  const plain = stripHtml(html);

  const setMatch = plain.match(
    /\bSET\b\s+(-?\d[\d,]*\.\d{2})\s+([+-]?\d[\d,]*\.\d{2})\s*\([^)]*\)\s+(-?\d[\d,]*\.\d{2})\s+(-?\d[\d,]*\.\d{2})\s+(-?\d[\d,]*\.\d{2})\s+([\d,]+)\s+([\d,]+\.\d{2})/
  );

  if (!setMatch) {
    throw new Error("Could not parse SET row from SET website HTML.");
  }

  const set50Match = plain.match(
    /\bSET50\b\s+(-?\d[\d,]*\.\d{2})\s+([+-]?\d[\d,]*\.\d{2})\s*\([^)]*\)\s+(-?\d[\d,]*\.\d{2})\s+(-?\d[\d,]*\.\d{2})\s+(-?\d[\d,]*\.\d{2})\s+([\d,]+)\s+([\d,]+\.\d{2})/
  );

  const advMatch = plain.match(/Advancers?\s*[:\-]?\s*([\d,]+)/i);
  const decMatch = plain.match(/Decliners?\s*[:\-]?\s*([\d,]+)/i);
  const lastUpdateMatch = plain.match(/Last Update\s+([^\n]+?\d{2}:\d{2}:\d{2})/i);

  return {
    sourceUrl: url,
    lastUpdate: lastUpdateMatch ? lastUpdateMatch[1].trim() : null,
    setIndex: parseNumber(setMatch[1]),
    indexChange: setMatch[2].trim(),
    volumeKShares: parseNumber(setMatch[6]),
    valueMBaht: parseNumber(setMatch[7]),
    set50Index: set50Match ? parseNumber(set50Match[1]) : null,
    advancers: advMatch ? parseNumber(advMatch[1]) : null,
    decliners: decMatch ? parseNumber(decMatch[1]) : null
  };
}

// Updated: passes coreSnap into collectEnrichedCheckpoint
async function enrichWithExtraMonitor(checkpointTime, coreSnap = null) {
  if (typeof extraMonitor?.collectEnrichedCheckpoint !== "function") {
    return null;
  }
  const cleanLabel = String(checkpointTime || "").replace(/\s*ICT$/i, "").trim();
  try {
    return await extraMonitor.collectEnrichedCheckpoint(cleanLabel, coreSnap);
  } catch (err) {
    console.warn(`[ExtraMonitor Collect Warning] ${cleanLabel}: ${err.message}`);
    return null;
  }
}

function saveCheckpointRecord(raw) {
  const store = readStore();
  const ict = getIctNow();

  const dateKey = raw.dateKey || ict.dateKey;
  const checkpointTime = raw.checkpointTime || raw.time || `${ict.hmKey} ICT`;

  const sameDayPrior = store.records.filter(
    (r) => r.dateKey === dateKey && r.checkpointTime !== checkpointTime
  );
  const prevMaxVol = sameDayPrior.reduce(
    (max, r) => Math.max(max, parseNumber(r.volumeKShares) ?? 0),
    0
  );
  const prevMaxVal = sameDayPrior.reduce(
    (max, r) => Math.max(max, parseNumber(r.valueMBaht) ?? 0),
    0
  );

  const parsedVol = parseNumber(raw.volumeKShares);
  const parsedVal = parseNumber(raw.valueMBaht);

  const record = {
    dateKey,
    checkpointTime,
    ictTimestamp: raw.ictTimestamp || ict.displayStr,
    source: raw.source || "set-website",
    setIndex: parseNumber(raw.setIndex),
    indexChange: raw.indexChange || null,
    volumeKShares: parsedVol !== null ? Math.max(prevMaxVol, parsedVol) : prevMaxVol || null,
    valueMBaht: parsedVal !== null ? Math.max(prevMaxVal, parsedVal) : prevMaxVal || null,
    set50Index: parseNumber(raw.set50Index),
    advancers: parseNumber(raw.advancers),
    decliners: parseNumber(raw.decliners),
    lastUpdate: raw.lastUpdate || null,
    extra: raw.extra || null,
    promptLine: raw.promptLine || null
  };

  const idx = store.records.findIndex(
    (r) => r.dateKey === record.dateKey && r.checkpointTime === record.checkpointTime
  );

  if (idx >= 0) {
    store.records[idx] = {
      ...store.records[idx],
      ...record,
      updatedAt: new Date().toISOString()
    };
  } else {
    store.records.push({
      ...record,
      createdAt: new Date().toISOString()
    });
  }

  store.updatedAt = new Date().toISOString();
  writeStore(store);
  return { store, record };
}

async function run10MinAutoMonitor() {
  const ict = getIctNow();
  if (ict.isWeekend) return;
  if (!TARGET_SLOTS.includes(ict.hmKey)) return;

  try {
    const snap = await fetchSetSnapshot();
    const enriched = await enrichWithExtraMonitor(ict.hmKey, snap);

    if (
      snap.setIndex !== null &&
      snap.volumeKShares !== null &&
      snap.valueMBaht !== null
    ) {
      saveCheckpointRecord({
        dateKey: ict.dateKey,
        checkpointTime: `${ict.hmKey} ICT`,
        ictTimestamp: ict.displayStr,
        source: "auto-10min-set",
        ...snap,
        extra: enriched
          ? {
              overview: enriched.overview || null,
              netFlow: enriched.netFlow || null,
              top5: enriched.top5 || []
            }
          : null,
        promptLine: enriched?.promptLine || null
      });
      console.log(
        `[Auto 10m Checkpoint] ${ict.dateKey} ${ict.hmKey} ICT -> SET ${snap.setIndex}, Vol ${snap.volumeKShares}, Val ${snap.valueMBaht}`
      );
      if (enriched?.promptLine) {
        console.log(`[Enriched Line] ${enriched.promptLine}`);
      }
    }
  } catch (err) {
    console.warn(`[Auto 10m Fetch Warning] ${ict.displayStr}: ${err.message}`);
  }
}

setInterval(() => {
  run10MinAutoMonitor();
}, 30 * 1000);

function isTemporaryOverload(status, message = "") {
  return (
    status === 503 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 504 ||
    /high demand|overloaded|temporarily unavailable|try again later|rate limit|resource_exhausted/i.test(
      message
    )
  );
}

async function callGeminiWithRetry({
  apiKey,
  modelName,
  prompt,
  thinkingBudget = 1024,
  maxRetries = 2
}) {
  const cleanModel = String(modelName || "").replace(/^models\//, "").trim();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    cleanModel
  )}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            temperature: 0.35,
            thinkingConfig: {
              thinkingBudget
            }
          }
        })
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts
          .map((p) => (typeof p?.text === "string" ? p.text : ""))
          .filter(Boolean)
          .join("\n")
          .trim();

        return {
          ok: true,
          model: cleanModel,
          analysis: text
        };
      }

      const errMsg = data?.error?.message || "Gemini API request failed.";
      const temporary = isTemporaryOverload(response.status, errMsg);

      if (!temporary || attempt === maxRetries) {
        return {
          ok: false,
          status: response.status || 500,
          error: errMsg,
          details: data
        };
      }

      await sleep(1500 * (attempt + 1));
    } catch (err) {
      if (attempt === maxRetries) {
        return {
          ok: false,
          status: 502,
          error: err?.message || "Network error while calling Gemini API."
        };
      }
      await sleep(1500 * (attempt + 1));
    }
  }
}

app.get("/api/health", (req, res) => {
  const ict = getIctNow();
  const store = readStore();
  res.json({
    ok: true,
    hasApiKey: Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()),
    ictTime: ict.displayStr,
    isWeekend: ict.isWeekend,
    targetSlots: TARGET_SLOTS,
    savedCheckpointsCount: store.records.length,
    updatedAt: store.updatedAt,
    port: PORT
  });
});

app.get("/api/checkpoints", (req, res) => {
  const store = readStore();
  res.json({ ok: true, ...store });
});

app.post("/api/checkpoints/fetch-now", async (req, res) => {
  try {
    const ict = getIctNow();
    const snap = await fetchSetSnapshot();
    const enriched = await enrichWithExtraMonitor(ict.hmKey, snap);

    const { record, store } = saveCheckpointRecord({
      dateKey: ict.dateKey,
      checkpointTime: `${ict.hmKey} ICT`,
      ictTimestamp: ict.displayStr,
      source: "manual-fetch",
      ...snap,
      extra: enriched
        ? {
            overview: enriched.overview || null,
            netFlow: enriched.netFlow || null,
            top5: enriched.top5 || []
          }
        : null,
      promptLine: enriched?.promptLine || null
    });
    res.json({ ok: true, record, totalRecords: store.records.length, records: store.records });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.post("/api/checkpoints", (req, res) => {
  const incoming = Array.isArray(req.body?.records)
    ? req.body.records
    : req.body?.checkpoint
    ? [req.body.checkpoint]
    : [];

  for (const item of incoming) {
    if (item && typeof item === "object") {
      saveCheckpointRecord(item);
    }
  }

  const store = readStore();
  res.json({ ok: true, totalRecords: store.records.length, records: store.records });
});

app.delete("/api/checkpoints", (req, res) => {
  const store = { updatedAt: new Date().toISOString(), records: [] };
  writeStore(store);
  res.json({ ok: true, totalRecords: 0, records: [] });
});

// Analyze ONLY recorded 10-minute checkpoints -> Output TOP 3 sets (SET Index, Volume, Value)
app.post("/api/analyze", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return res.status(400).json({
      error: "GEMINI_API_KEY is missing in .env file."
    });
  }

  try {
    const ict = getIctNow();
    const store = readStore();
    const clientRecords = Array.isArray(req.body?.checkpoints) ? req.body.checkpoints : [];
    const recordsToAnalyze = [...store.records, ...clientRecords];

    const slot1221Record =
      recordsToAnalyze.find((r) => String(r?.checkpointTime || "").includes("12:21")) ||
      null;
    const latestCheckpoint =
      slot1221Record ||
      (recordsToAnalyze.length > 0
        ? recordsToAnalyze[recordsToAnalyze.length - 1]
        : null);

    const enrichedLines = recordsToAnalyze
      .map((r) => r?.promptLine)
      .filter(Boolean);

    const prompt = [
      "You are a veteran Stock Exchange of Thailand (SET) market analyst.",
      "Analyze ONLY the recorded 10-minute market checkpoints chronologically (progression of SET Index, Volume '000 Shares, Value M.Baht, SET50, High/Low, Investor Net Flow, Top 5 Value stocks, and market breadth).",
      `Current ICT Time: ${ict.displayStr} | Weekend (Sat/Sun): ${ict.isWeekend ? "YES" : "NO"}.`,
      "Latest Reference Checkpoint (12:21 ICT if present, otherwise the latest recorded checkpoint):",
      latestCheckpoint ? JSON.stringify(latestCheckpoint, null, 2) : "NONE",
      enrichedLines.length > 0 ? "Enriched Checkpoint Lines:" : "",
      ...enrichedLines,
      "Strict Rules:",
      "1) Treat the Latest Reference Checkpoint (12:21 ICT if available, otherwise the latest checkpoint) as the final monitored baseline and evaluate the 10-minute progression/momentum leading into the 11-minute pre-close target.",
      "2) SET Index may move up or down, while Volume ('000 Shares) and Value (M.Baht) must strictly increase (never decrease).",
      "3) Output ONLY the TOP 3 highest-probability sets for the 11-minute pre-close target.",
      "4) For EACH of the TOP 3 sets, output ONLY these 3 fields: SET Index, Volume ('000 Shares), and Value (M.Baht).",
      "5) Do NOT include extra sets, external guesses, or long commentary.",
      "",
      "Recorded 10-Minute Checkpoints JSON:",
      JSON.stringify(recordsToAnalyze, null, 2)
    ]
      .filter(Boolean)
      .join("\n");

    const primaryModel = (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
    const fallbackModel = (process.env.GEMINI_FALLBACK_MODEL || "").trim();
    const thinkingBudgetRaw = Number(process.env.GEMINI_THINKING_BUDGET || 1024);
    const thinkingBudget = Number.isFinite(thinkingBudgetRaw)
      ? Math.max(0, Math.min(4096, thinkingBudgetRaw))
      : 1024;

    let result = await callGeminiWithRetry({
      apiKey,
      modelName: primaryModel,
      prompt,
      thinkingBudget,
      maxRetries: 2
    });

    if (!result.ok && fallbackModel && fallbackModel !== primaryModel) {
      result = await callGeminiWithRetry({
        apiKey,
        modelName: fallbackModel,
        prompt,
        thinkingBudget,
        maxRetries: 1
      });
    }

    if (!result.ok) {
      return res.status(result.status || 500).json({
        error: result.error,
        details: result.details
      });
    }

    res.json({
      ok: true,
      model: result.model,
      latestCheckpointTime: latestCheckpoint?.checkpointTime || null,
      checkpointsAnalyzed: recordsToAnalyze.length,
      analysis: result.analysis
    });
  } catch (err) {
    res.status(500).json({
      error: err.message || "Internal server error."
    });
  }
});

ensureStore();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`SET 10m Checkpoint & Gemini TOP 3 server running on port ${PORT}`);
});