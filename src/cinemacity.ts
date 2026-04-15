/**
 * CinemaCity Scraper — based on working Cinecityfinal.js
 * Uses native fetch (not undici) to match the working implementation.
 * CDN URLs expire quickly, so we use a lazy proxy for playback.
 */
import * as cheerio from 'cheerio';

const MAIN_URL = 'https://cinemacity.cc';

const HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36',
    'Cookie': 'dle_user_id=32729; dle_password=894171c6a8dab18ee594d5c652009a35;',
    'Referer': MAIN_URL + '/'
};

export const CINEMACITY_HEADERS = HEADERS;

const TMDB_API_KEY = '1865f43a0549ca50d341dd9ab8b29f49';

const atobPolyfill = (str: string): string => {
    try {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
        let output = '';
        str = String(str).replace(/[=]+$/, '');
        if (str.length % 4 === 1) return '';

        for (
            let bc = 0, bs = 0, buffer: any, i = 0;
            (buffer = str.charAt(i++));
            ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
                ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
                : 0
        ) {
            buffer = chars.indexOf(buffer);
        }
        return output;
    } catch {
        return '';
    }
};

async function fetchText(url: string): Promise<string> {
    const res = await fetch(url, { headers: HEADERS });
    return await res.text();
}

async function fetchJson(url: string): Promise<any> {
    const res = await fetch(url);
    return await res.json();
}

/**
 * Extract file data from a CinemaCity page HTML.
 * Shared between discovery (getCinemaCityStreams) and lazy resolve (extractFreshStreamUrl).
 */
function extractFileData(html: string): any {
    const $ = cheerio.load(html);
    let fileData: any = null;

    $('script').each((_i: number, el: any) => {
        if (fileData) return;

        const scriptHtml = $(el).html();
        if (!scriptHtml || !scriptHtml.includes('atob')) return;

        const regex = /atob\s*\(\s*(['"])(.*?)\1\s*\)/g;
        let match;

        while ((match = regex.exec(scriptHtml)) !== null) {
            const decoded = atobPolyfill(match[2]);

            const fileMatch =
                decoded.match(/file\s*:\s*(['"])(.*?)\1/s) ||
                decoded.match(/file\s*:\s*(\[.*?\])/s) ||
                decoded.match(/sources\s*:\s*(\[.*?\])/s);

            if (fileMatch) {
                let raw = fileMatch[2] || fileMatch[1];
                try {
                    if (raw.startsWith('[') || raw.startsWith('{')) {
                        raw = raw.replace(/\\(.)/g, '$1');
                        fileData = JSON.parse(raw);
                    } else {
                        fileData = raw;
                    }
                } catch {
                    fileData = raw;
                }
                console.log('[CinemaCity] File data extracted');
            }
        }
    });

    return fileData;
}

/**
 * Parse file data into a raw stream URL string.
 */
function resolveStreamUrl(fileData: any): string | null {
    let url: string | null = null;

    if (Array.isArray(fileData)) {
        const obj = fileData.find((f: any) => f.file) || fileData[0];
        if (obj?.file) url = obj.file;
    } else if (typeof fileData === 'string') {
        url = fileData;
    }

    if (!url) return null;

    if (url.startsWith('//')) url = 'https:' + url;

    return url;
}

/**
 * Search CinemaCity and return the first matching page URL.
 */
async function searchCinemaCity(query: string): Promise<string | null> {
    const searchUrl = `${MAIN_URL}/index.php?do=search&subaction=search&story=${encodeURIComponent(query)}`;
    console.log(`[CinemaCity] Searching: ${query}`);

    const searchHtml = await fetchText(searchUrl);
    const $ = cheerio.load(searchHtml);

    let mediaUrl: string | null = null;

    $('div.dar-short_item').each((_i: number, el: any) => {
        if (mediaUrl) return;
        const anchor = $(el).find("a[href*='.html']").first();
        if (!anchor.length) return;

        const foundTitle = anchor.text().split('(')[0].trim();
        const href = anchor.attr('href');
        if (!href) return;

        if (
            foundTitle.toLowerCase().includes(query.toLowerCase()) ||
            query.toLowerCase().includes(foundTitle.toLowerCase())
        ) {
            mediaUrl = href;
            console.log('[CinemaCity] Match:', href);
        }
    });

    return mediaUrl;
}

/**
 * Main entry: discover streams for a TMDB ID.
 * Returns a lazy proxy URL — the actual CDN URL is resolved at playback time.
 */
export async function getCinemaCityStreams(
    tmdbId: string,
    mediaType: string,
    season?: string,
    episode?: string,
    preferredLang?: string
): Promise<{ name: string; title: string; url: string }[]> {
    try {
        const lang = preferredLang || 'en';
        console.log(`[CinemaCity] id=${tmdbId}, type=${mediaType}, S=${season}, E=${episode}, lang=${lang}`);

        // 1. TMDB — get IMDB ID + title (using native fetch like the working code)
        const tmdbType = mediaType === 'series' ? 'tv' : 'movie';
        const tmdbData = await fetchJson(
            `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`
        );

        const imdbId: string | null = tmdbData?.imdb_id || tmdbData?.external_ids?.imdb_id || null;

        // Title in preferred language
        let title: string | null = null;
        if (lang !== 'en') {
            try {
                const langData = await fetchJson(
                    `https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}&language=${lang}`
                );
                title = langData?.title || langData?.name || null;
            } catch { /* fallback */ }
        }
        if (!title) {
            title = tmdbData?.title || tmdbData?.name || null;
        }

        if (!title) return [];
        console.log(`[CinemaCity] IMDB: ${imdbId}, Title: ${title}`);

        // 2. Search CinemaCity — IMDB ID first, then title
        let mediaUrl: string | null = null;

        if (imdbId) {
            mediaUrl = await searchCinemaCity(imdbId);
        }
        if (!mediaUrl) {
            mediaUrl = await searchCinemaCity(title);
        }

        if (!mediaUrl) {
            console.log('[CinemaCity] No results found');
            return [];
        }

        // 3. Verify page has playable content
        const pageHtml = await fetchText(mediaUrl);
        const fileData = extractFileData(pageHtml);

        if (!fileData) {
            console.log('[CinemaCity] No playable content on page');
            return [];
        }

        // 4. Return lazy proxy URL — CDN URL resolved fresh at playback time
        const pageToken = Buffer.from(JSON.stringify({ page: mediaUrl })).toString('base64url');

        console.log(`[CinemaCity] Stream ready (lazy proxy)`);
        return [{
            name: 'CinemaCity',
            title: `🎬 ${title}`,
            url: `/proxy/cc/manifest.m3u8?token=${pageToken}`
        }];
    } catch (err: any) {
        console.error('[CinemaCity] Error:', err?.message || err);
        return [];
    }
}

/**
 * Extract a fresh stream URL from a CinemaCity page.
 * Called at playback time by the lazy proxy endpoint in addon.ts.
 */
export async function extractFreshStreamUrl(pageUrl: string): Promise<string | null> {
    try {
        console.log(`[CinemaCity] Lazy resolve: ${pageUrl}`);
        const pageHtml = await fetchText(pageUrl);
        const fileData = extractFileData(pageHtml);

        if (!fileData) {
            console.log('[CinemaCity] Lazy resolve: no file data');
            return null;
        }

        const url = resolveStreamUrl(fileData);
        if (url) {
            console.log(`[CinemaCity] Fresh URL: ${url.substring(0, 100)}...`);
        }
        return url;
    } catch (err: any) {
        console.error('[CinemaCity] Lazy resolve error:', err?.message || err);
        return null;
    }
}
