// Runs on a schedule via GitHub Actions. Fetches general market news
// SERVER-SIDE (Node has no CORS restrictions — this is the whole point: no
// more depending on flaky public CORS-relay services), translates the
// headlines to Hebrew, and caches the result in Supabase so the app can just
// read it instantly instead of doing all this work in the visitor's browser.
//
// Required environment variables (GitHub repo secrets — same ones already
// used by check-alerts.js, no new secrets needed):
//   SUPABASE_URL, SUPABASE_SECRET_KEY

// Runs on a schedule via GitHub Actions. Fetches general market news AND news
// for every ticker currently on someone's watchlist (reusing the same
// watchlist_alerts table the alert-checker already reads) — all SERVER-SIDE,
// so no CORS/proxy issues at all, and translates + caches everything in
// Supabase so the app can just read it instantly.
//
// Required environment variables (GitHub repo secrets — same ones already
// used by check-alerts.js, no new secrets needed):
//   SUPABASE_URL, SUPABASE_SECRET_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const GENERAL_NEWS_SOURCES = [
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'Google News', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('stock market') + '&hl=en-US&gl=US&ceid=US:en' },
];

function tickerNewsSources(ticker) {
  return [
    { name: 'Google News', url: `https://news.google.com/rss/search?q=${encodeURIComponent(ticker + ' stock')}&hl=en-US&gl=US&ceid=US:en` },
    { name: 'Bing News', url: `https://www.bing.com/news/search?q=${encodeURIComponent(ticker + ' stock')}&format=RSS` },
  ];
}

function requireEnv() {
  const missing = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error('Missing required secrets: ' + missing.join(', '));
}

// ---------- Tiny regex-based RSS parser (no XML library dependency to install) ----------
function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  let content = m[1];
  const cdata = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) content = cdata[1];
  return content.trim();
}

function cleanText(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#8226;/g, '•')
    .replace(/\s+/g, ' ')
    .trim();
}

// Google News descriptions are very often just a list of "<a href=...>Source
// name</a>" links ("Also covered by...") rather than real article content.
// Detect and skip these instead of showing a garbled run-on of outlet names.
function isLinkListJunk(raw) {
  const linkCount = (raw.match(/<a\s/gi) || []).length;
  return linkCount >= 2;
}

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    let title = cleanText(extractTag(block, 'title'));
    const link = cleanText(extractTag(block, 'link'));
    const pubDate = extractTag(block, 'pubDate');
    const descRaw = extractTag(block, 'description');
    const description = isLinkListJunk(descRaw) ? '' : cleanText(descRaw);
    let source = cleanText(extractTag(block, 'source') || extractTag(block, 'author'));
    if (!source && title.includes(' - ')) {
      const parts = title.split(' - ');
      source = parts[parts.length - 1].trim();
      title = parts.slice(0, -1).join(' - ').trim();
    }
    let image = null;
    const mediaMatch =
      block.match(/<media:content[^>]+url=["']([^"']+)["']/i) ||
      block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i) ||
      block.match(/<enclosure[^>]+url=["']([^"']+)["']/i);
    if (mediaMatch) image = mediaMatch[1];
    if (!image) {
      const imgMatch = block.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (imgMatch) image = imgMatch[1].replace(/&amp;/g, '&');
    }
    if (title && link) items.push({ title, link, pubDate, description, source, image });
  }
  return items;
}

// ---------- Translation (server-side — no CORS concerns here either) ----------
async function translateOne(text) {
  const t = (text || '').trim();
  if (!t) return t;
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(t.slice(0, 480))}&langpair=en|he`;
    const res = await fetch(url);
    const data = await res.json();
    const translated = data?.responseData?.translatedText;
    if (!translated || /MYMEMORY WARNING/i.test(translated)) return t;
    return translated;
  } catch (e) {
    return t;
  }
}

// ---------- Fetch + parse + translate from a list of candidate sources,
// preferring whichever one actually has images and real descriptions ----------
function scoreNewsItems(parsed) {
  if (!parsed.length) return 0;
  const withImage = parsed.filter((it) => it.image).length;
  const withDesc = parsed.filter((it) => it.description).length;
  return withImage / parsed.length + withDesc / parsed.length; // 0..2
}

async function fetchAndTranslate(sources, maxItems) {
  let items = [];
  let usedSource = null;
  let best = null;

  for (const src of sources) {
    try {
      const res = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalNewsFetcher/1.0)' } });
      if (!res.ok) { console.log(`  ${src.name}: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const parsed = parseRss(xml);
      if (parsed.length) {
        const score = scoreNewsItems(parsed);
        if (!best || score > best.score) best = { items: parsed.slice(0, maxItems), name: src.name, score };
        if (score >= 1.8) break; // great source — good enough, stop here
      }
    } catch (e) {
      console.log(`  ${src.name} failed: ${e.message}`);
    }
  }
  if (best) { items = best.items; usedSource = best.name; }
  if (!items.length) return null;

  await Promise.all(
    items.map(async (it) => {
      it.title = await translateOne(it.title);
      it.description = await translateOne(it.description);
    })
  );

  return { items, source: usedSource };
}

async function saveCache(table, cacheKey, result) {
  const payload = {
    cache_key: cacheKey,
    items: result.items,
    source: result.source,
    updated_at: new Date().toISOString(),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=cache_key`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error(`Failed to save ${table}/${cacheKey}:`, res.status, await res.text());
  return res.ok;
}

async function fetchWatchlistTickers() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/watchlist_alerts?select=ticker`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return [...new Set(rows.map((r) => r.ticker))].slice(0, 15); // cap it — keeps runtime & translation quota reasonable
  } catch (e) {
    console.log('Could not read watchlist tickers:', e.message);
    return [];
  }
}

async function main() {
  requireEnv();

  console.log('--- General market news ---');
  const general = await fetchAndTranslate(GENERAL_NEWS_SOURCES, 15);
  if (general) {
    console.log(`Fetched ${general.items.length} items from ${general.source}. Saving...`);
    await saveCache('news_cache', 'general', general);
  } else {
    console.log('No general news fetched this run — leaving the existing cache as-is.');
  }

  console.log('\n--- Per-ticker news for watchlisted stocks ---');
  const tickers = await fetchWatchlistTickers();
  console.log(`Found ${tickers.length} watchlisted ticker(s): ${tickers.join(', ') || '(none)'}`);

  for (const ticker of tickers) {
    console.log(`\n${ticker}:`);
    const result = await fetchAndTranslate(tickerNewsSources(ticker), 8);
    if (result) {
      console.log(`  Fetched ${result.items.length} items from ${result.source}. Saving...`);
      await saveCache('ticker_news_cache', ticker, result);
    } else {
      console.log('  No news found — skipping.');
    }
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

