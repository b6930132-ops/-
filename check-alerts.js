// Runs on a schedule via GitHub Actions. Reads the watchlist from Supabase,
// checks price + golden-cross conditions against fresh Twelve Data prices,
// and emails anyone whose alert condition is met — using Resend.
//
// Required environment variables (set as GitHub repo secrets):
//   SUPABASE_URL, SUPABASE_SECRET_KEY, TWELVEDATA_API_KEY, RESEND_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const GOLDEN_CROSS_LOOKBACK_DAYS = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'TWELVEDATA_API_KEY', 'RESEND_API_KEY']
    .filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing required environment variables/secrets: ${missing.join(', ')}`);
  }
}

// ---------- Same math as the web app, ported to plain Node ----------
function maSeries(closes, period) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function detectGoldenCross(ma50, ma200, lookbackDays) {
  const n = ma50.length;
  const currentlyAbove =
    ma50[n - 1] != null && ma200[n - 1] != null ? ma50[n - 1] > ma200[n - 1] : null;
  let crossIdx = null;
  const earliest = Math.max(1, n - lookbackDays);
  for (let idx = n - 1; idx >= earliest; idx--) {
    const prev = idx - 1;
    if (ma50[prev] == null || ma200[prev] == null || ma50[idx] == null || ma200[idx] == null) continue;
    const wasBelowOrEqual = ma50[prev] <= ma200[prev];
    const nowAbove = ma50[idx] > ma200[idx];
    if (wasBelowOrEqual && nowAbove) {
      crossIdx = idx;
      break;
    }
  }
  return { currentlyAbove, crossIdx };
}

// ---------- Supabase (secret key — full access, never expose this key client-side) ----------
async function fetchAllRows() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/watchlist_alerts?select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function updateRow(id, fields) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/watchlist_alerts?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(fields),
  });
  if (!res.ok) console.error(`Failed to update row ${id}:`, res.status, await res.text());
}

// ---------- Twelve Data ----------
async function fetchTickerData(ticker) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(ticker)}&interval=1day&outputsize=260&apikey=${TWELVEDATA_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status === 'error' || !data.values) {
    throw new Error(data.message || `No data returned for ${ticker}`);
  }
  const values = data.values.slice().reverse(); // API returns newest-first
  const dates = values.map((v) => v.datetime);
  const closes = values.map((v) => Number(v.close));
  return { dates, closes };
}

// ---------- Resend ----------
async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Stock Alerts <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) console.error('Resend send failed:', res.status, await res.text());
}

// ---------- Main ----------
async function main() {
  requireEnv();

  const rows = await fetchAllRows();
  if (!rows.length) {
    console.log('No watchlist rows to check.');
    return;
  }

  // Group by ticker so we only ask Twelve Data once per symbol, even if
  // several people are watching the same stock.
  const byTicker = new Map();
  for (const row of rows) {
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, []);
    byTicker.get(row.ticker).push(row);
  }

  const tickers = [...byTicker.keys()];
  console.log(`Checking ${tickers.length} unique ticker(s) across ${rows.length} watchlist row(s)...`);

  for (const ticker of tickers) {
    let data;
    try {
      data = await fetchTickerData(ticker);
    } catch (e) {
      console.error(`Failed to fetch ${ticker}:`, e.message);
      continue;
    }

    const ma50 = maSeries(data.closes, 50);
    const ma200 = maSeries(data.closes, 200);
    const { crossIdx } = detectGoldenCross(ma50, ma200, GOLDEN_CROSS_LOOKBACK_DAYS);
    const crossDate = crossIdx != null ? data.dates[crossIdx] : null;
    const lastClose = data.closes[data.closes.length - 1];

    for (const row of byTicker.get(ticker)) {
      // --- price alert: one-shot with automatic rearm ---
      if (row.price_alert_enabled && row.price_alert_target != null) {
        const triggered =
          row.price_alert_direction === 'above'
            ? lastClose >= row.price_alert_target
            : lastClose <= row.price_alert_target;

        if (triggered && !row.price_alert_triggered) {
          console.log(`Price alert firing for ${row.email} / ${ticker}`);
          await sendEmail(
            row.email,
            `התראת מחיר: ${ticker}`,
            `<p>המחיר של <b>${ticker}</b> עכשיו <b>$${lastClose.toFixed(2)}</b> — ` +
              `${row.price_alert_direction === 'above' ? 'עלה מעל' : 'ירד מתחת ל'} היעד שקבעת ($${row.price_alert_target}).</p>`
          );
          await updateRow(row.id, { price_alert_triggered: true });
        } else if (!triggered && row.price_alert_triggered) {
          // price moved back past the target — rearm so a future crossing notifies again
          await updateRow(row.id, { price_alert_triggered: false });
        }
      }

      // --- golden cross alert: notify once per distinct cross date ---
      if (row.golden_cross_alert_enabled && crossDate && row.golden_cross_last_notified_date !== crossDate) {
        console.log(`Golden cross alert firing for ${row.email} / ${ticker}`);
        await sendEmail(
          row.email,
          `צלב זהב זוהה: ${ticker}`,
          `<p>הממוצע הנע ל-50 יום של <b>${ticker}</b> חצה מעל הממוצע הנע ל-200 יום בתאריך ${crossDate}. ` +
            `זהו סימן טכני שמשקיעים רבים עוקבים אחריו.</p>`
        );
        await updateRow(row.id, { golden_cross_last_notified_date: crossDate });
      }
    }

    await sleep(8000); // stay comfortably under Twelve Data's free-tier rate limit (8 req/min)
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
