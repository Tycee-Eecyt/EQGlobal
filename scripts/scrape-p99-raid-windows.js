/*
  Scrapes Project 1999 wiki raid encounter pages for respawn windows and zones,
  then merges results into src/shared/mobWindows.json.

  Usage:
    node scripts/scrape-p99-raid-windows.js
*/

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'src', 'shared', 'mobWindows.json');

const CATEGORY_URL = 'https://wiki.project1999.com/Category:Raid_Encounters';

function slugifyId(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function decodeHtmlEntities(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html = '') {
  return String(html).replace(/<[^>]*>/g, '');
}

function parseDurationToMinutes(input = '') {
  const s = String(input).toLowerCase();
  let total = 0;
  const re = /(\d+(?:\.\d+)?)\s*(d(?:ays?)?|h(?:ours?)?|m(?:in(?:ute)?s?)?)/g;
  let m;
  while ((m = re.exec(s))) {
    const val = parseFloat(m[1]);
    const unit = m[2][0];
    if (unit === 'd') total += val * 24 * 60;
    else if (unit === 'h') total += val * 60;
    else total += val;
  }
  if (total > 0) return Math.round(total);
  // fallback: try a bare hours like "8h" or "7d"
  const bare = /(\d+(?:\.\d+)?)([dhm])/i.exec(s);
  if (bare) {
    const val = parseFloat(bare[1]);
    const unit = bare[2].toLowerCase();
    if (unit === 'd') return Math.round(val * 24 * 60);
    if (unit === 'h') return Math.round(val * 60);
    return Math.round(val);
  }
  return null;
}

function normalizeRespawnDisplay(baseMinutes, varianceMinutes) {
  function fmt(mins) {
    if (mins % (24 * 60) === 0) {
      const d = Math.round(mins / (24 * 60));
      return `${d}d`;
    }
    if (mins % 60 === 0) {
      const h = Math.round(mins / 60);
      return `${h}h`;
    }
    return `${mins}m`;
  }
  if (!Number.isFinite(baseMinutes)) return '';
  const base = fmt(baseMinutes);
  const varPart = Number.isFinite(varianceMinutes) && varianceMinutes > 0 ? ` ± ${fmt(varianceMinutes)}` : '';
  return `${base}${varPart}`;
}

function parseRespawnField(text = '') {
  // Accept forms like:
  //  - 7 days +/- 12 hours
  //  - 3 d ± 12 h
  //  - 8 hours
  //  - 12h ± 1h
  // Return { baseMinutes, varianceMinutes, minHours, maxHours, display }
  const s = String(text).trim();
  const plusMinusIdx = s.search(/\u00B1|\+\/-/); // ± or +/-
  let baseMinutes = null;
  let varianceMinutes = 0;

  if (plusMinusIdx !== -1) {
    const left = s.slice(0, plusMinusIdx);
    const right = s.slice(plusMinusIdx).replace(/[\u00B1]|\+\/-/g, '');
    baseMinutes = parseDurationToMinutes(left);
    varianceMinutes = parseDurationToMinutes(right) || 0;
  } else {
    baseMinutes = parseDurationToMinutes(s);
    varianceMinutes = 0;
  }

  if (!Number.isFinite(baseMinutes)) return null;
  const minMinutes = Math.max(1, Math.round(baseMinutes - varianceMinutes));
  const maxMinutes = Math.max(minMinutes + 1, Math.round(baseMinutes + varianceMinutes));

  return {
    baseMinutes,
    varianceMinutes,
    minHours: Math.round(minMinutes / 60),
    maxHours: Math.round(maxMinutes / 60),
    display: normalizeRespawnDisplay(baseMinutes, varianceMinutes),
  };
}

function extractFirst(regex, text, idx = 1) {
  const m = regex.exec(text);
  return m ? decodeHtmlEntities(m[idx]).trim() : null;
}

function extractAllLinksFromCategory(html) {
  // Grab content links within the category listing; exclude Category:/File:/Talk:/Template:
  const links = new Map();
  const re = /<a\s+href=\"(\/[^\"#?]+)\"\s+title=\"([^\"]+)\"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    const title = decodeHtmlEntities(stripTags(m[2] || m[3] || '')).trim();
    if (!href || !title) continue;
    if (/\/(Category|File|Talk|Template):/i.test(href)) continue;
    // small heuristic: only include links under main wiki namespace
    links.set(title, `https://wiki.project1999.com${href}`);
  }
  return Array.from(links.entries()).map(([title, url]) => ({ title, url }));
}

function parsePage(html, url) {
  const out = {
    name: null,
    zone: null,
    respawn: null,
    respawnDisplay: '',
    minRespawnHours: null,
    maxRespawnHours: null,
    aliases: [],
  };

  // Name
  out.name = stripTags(extractFirst(/<h1[^>]*id=\"firstHeading\"[^>]*>(.*?)<\/h1>/i, html) || '')
    || stripTags(extractFirst(/<title>([^<]+)<\/title>/i, html) || '')
    || null;
  if (out.name) {
    out.name = out.name.replace(/ - Project 1999 Wiki$/, '').trim();
  }

  // Redirect From alias
  const redirected = extractFirst(/<span[^>]*class=\"mw-redirectedfrom\"[^>]*>\s*\(<a[^>]*>(.*?)<\/a>\)\s*<\/span>/i, html);
  if (redirected) out.aliases.push(redirected);

  // Zone
  // Zone can be plain text or link(s); try multiple strategies and strip tags.
  let zone = null;
  // Case: table/infobox style "Zone:" followed by closing tag then value (possibly with tags).
  const zoneBlock = extractFirst(/>\s*Zone\s*:\s*<\/[^>]+>\s*([\s\S]{0,120})/i, html);
  if (zoneBlock) {
    zone = stripTags(zoneBlock).split(/\r?\n|<br\s*\/?>/i)[0];
  }
  // Fallback: plain label "Zone: ..."
  if (!zone) {
    const z2 = extractFirst(/\bZone\s*:\s*([\s\S]{0,120})/i, html);
    if (z2) zone = stripTags(z2).split(/\r?\n|<br\s*\/?>/i)[0];
  }
  out.zone = zone ? decodeHtmlEntities(zone).replace(/\s+/g, ' ').trim() : null;

  // Respawn Time
  const respawnRaw = extractFirst(/>\s*Respawn\s*Time\s*:\s*<\/[^>]+>\s*([^<\n]+)/i, html)
    || extractFirst(/\bRespawn\s*Time\s*:\s*([^<\n]+)/i, html);
  if (respawnRaw) {
    const parsed = parseRespawnField(respawnRaw);
    if (parsed) {
      out.respawn = respawnRaw.trim();
      out.respawnDisplay = parsed.display;
      out.minRespawnHours = parsed.minHours;
      out.maxRespawnHours = parsed.maxHours;
    }
  }

  return out;
}

async function fetchHtml(url) {
  const res = await axios.get(url, { timeout: 15000 });
  return String(res.data || '');
}

async function main() {
  const existing = await (async () => {
    try {
      const raw = await fs.promises.readFile(OUT_PATH, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return [];
    }
  })();

  const existingById = new Map();
  for (const item of existing) {
    const id = slugifyId(item.id || item.name || '');
    if (id) existingById.set(id, item);
  }

  console.log('Fetching category:', CATEGORY_URL);
  const categoryHtml = await fetchHtml(CATEGORY_URL);
  const links = extractAllLinksFromCategory(categoryHtml);
  if (!links || links.length === 0) {
    throw new Error('No links found in category page.');
  }

  console.log(`Found ${links.length} candidate pages. Fetching...`);

  const results = [];
  // limit concurrency to 6
  const queue = [...links];
  const workers = 6;
  async function worker() {
    while (queue.length) {
      const { title, url } = queue.shift();
      try {
        const html = await fetchHtml(url);
        const parsed = parsePage(html, url);
        if (parsed && parsed.name && parsed.minRespawnHours && parsed.maxRespawnHours) {
          const id = slugifyId(parsed.name);
          const merged = {
            id,
            name: parsed.name,
            aliases: parsed.aliases && parsed.aliases.length ? parsed.aliases : undefined,
            zone: parsed.zone || '',
            respawnDisplay: parsed.respawnDisplay,
            minRespawnHours: parsed.minRespawnHours,
            maxRespawnHours: parsed.maxRespawnHours,
            notes: '',
          };
          results.push(merged);
          console.log(`Parsed ${parsed.name}: ${parsed.respawnDisplay} (${parsed.minRespawnHours}-${parsed.maxRespawnHours}h)`);
        } else {
          console.log(`Skipped ${title} (missing respawn data)`);
        }
      } catch (err) {
        console.warn(`Failed ${title}:`, err.message || err);
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));

  // Merge with existing, prefer newly scraped values for respawn fields
  const mergedMap = new Map();
  for (const item of existing) {
    const id = slugifyId(item.id || item.name || '');
    if (!id) continue;
    mergedMap.set(id, { ...item, id });
  }
  for (const item of results) {
    // Unify known 'The ' prefix slugs to existing without 'the-'
    let targetId = item.id;
    const withoutThe = item.id.replace(/^the-/, '');
    if (mergedMap.has(withoutThe)) {
      targetId = withoutThe;
    }
    const prev = mergedMap.get(targetId) || {};
    const merged = { ...prev };
    merged.id = targetId;
    merged.name = item.name || prev.name || '';
    if (Array.isArray(item.aliases) && item.aliases.length) merged.aliases = item.aliases;
    else if (prev.aliases) merged.aliases = prev.aliases;
    if (item.zone) merged.zone = item.zone;
    else if (prev.zone) merged.zone = prev.zone;
    if (item.respawnDisplay) merged.respawnDisplay = item.respawnDisplay;
    else if (prev.respawnDisplay) merged.respawnDisplay = prev.respawnDisplay;
    if (Number.isFinite(item.minRespawnHours)) merged.minRespawnHours = item.minRespawnHours;
    else if (Number.isFinite(prev.minRespawnHours)) merged.minRespawnHours = prev.minRespawnHours;
    if (Number.isFinite(item.maxRespawnHours)) merged.maxRespawnHours = item.maxRespawnHours;
    else if (Number.isFinite(prev.maxRespawnHours)) merged.maxRespawnHours = prev.maxRespawnHours;
    merged.notes = (prev.notes && prev.notes.trim()) ? prev.notes : (item.notes || '');
    mergedMap.set(targetId, merged);
  }

  // Remove duplicate entries that differ only by leading 'the-'
  for (const key of Array.from(mergedMap.keys())) {
    if (key.startsWith('the-')) {
      const alt = key.replace(/^the-/, '');
      if (mergedMap.has(alt)) {
        mergedMap.delete(key);
      }
    }
  }

  // Remove any bad entries that still contain HTML tags or auto span ids
  const finalList = Array.from(mergedMap.values())
    .filter((e) => e && typeof e.name === 'string' && !/[<>]/.test(e.name) && !(String(e.id || '').startsWith('span-dir-auto-')))
    .sort((a, b) => a.name.localeCompare(b.name));

  await fs.promises.writeFile(OUT_PATH, JSON.stringify(finalList, null, 2), 'utf8');
  console.log(`Wrote ${finalList.length} entries to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
