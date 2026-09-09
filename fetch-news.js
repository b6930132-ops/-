// Runs on a schedule via GitHub Actions. Fetches general market news
// SERVER-SIDE (Node has no CORS restrictions — this is the whole point: no
// more depending on flaky public CORS-relay services), translates the
// headlines to Hebrew, and caches the result in Supabase so the app can just
// read it instantly instead of doing all this work in the visitor's browser.
//
// Required environment variables (GitHub repo secrets — same ones already
// used by check-alerts.js, no new secrets needed):
//   SUPABASE_URL, SUPABASE_SECRET_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;

const NEWS_SOURCES = [
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
  { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'Google News', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('stock market') + '&hl=en-US&gl=US&ceid=US:en' },
];

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

function parseRss(xml) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    let title = cleanText(extractTag(block, 'title'));
    const link = cleanText(extractTag(block, 'link'));
    const pubDate = extractTag(block, 'pubDate');
    const description = cleanText(extractTag(block, 'description'));
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

async function main() {
  requireEnv();

  let items = [];
  let usedSource = null;

  for (const src of NEWS_SOURCES) {
    try {
      const res = await fetch(src.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalNewsFetcher/1.0)' } });
      if (!res.ok) { console.log(`${src.name}: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const parsed = parseRss(xml);
      if (parsed.length) {
        items = parsed.slice(0, 15);
        usedSource = src.name;
        if (items.some((it) => it.image)) break; // good enough — has images, stop here
      }
    } catch (e) {
      console.log(`${src.name} failed: ${e.message}`);
    }
  }

  if (!items.length) {
    console.log('No news items fetched from any source this run — leaving the existing cache as-is.');
    return;
  }

  console.log(`Fetched ${items.length} items from ${usedSource}. Translating...`);

  await Promise.all(
    items.map(async (it) => {
      it.title = await translateOne(it.title);
      it.description = await translateOne(it.description);
    })
  );

  const payload = {
    cache_key: 'general',
    items,
    source: usedSource,
    updated_at: new Date().toISOString(),
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/news_cache?on_conflict=cache_key`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error('Failed to save to Supabase:', res.status, await res.text());
    process.exit(1);
  }
  console.log('News cache updated successfully.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
