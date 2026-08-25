import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOWED_SOURCES = new Set(['website', 'app_store', 'play_store']);
const MAX_REDIRECTS = 3;
const MAX_PAGE_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 12_000;

const decodeHtml = (value = '') => String(value)
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));

const normalizeWhitespace = (value = '') => decodeHtml(value)
  .replace(/\s+/g, ' ')
  .trim();

const isPrivateIpv4 = (address) => {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
};

const isPrivateIp = (address) => {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;

  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateIpv4(normalized.slice(7));
  return false;
};

const validatePublicUrl = async (value, source) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Enter a valid product URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS product links are supported.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Product links cannot contain embedded credentials.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('The product link must point to a public website.');
  }

  if (source === 'app_store' && !['apps.apple.com', 'itunes.apple.com'].includes(hostname)) {
    throw new Error('Enter a valid Apple App Store link.');
  }
  if (source === 'play_store' && hostname !== 'play.google.com') {
    throw new Error('Enter a valid Google Play Store link.');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('The product link must point to a public website.');
  } else {
    let addresses;
    try {
      addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error('The product website could not be found.');
    }
    if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
      throw new Error('The product link must point to a public website.');
    }
  }

  parsed.hash = '';
  return parsed;
};

export const normalizeProductUrl = (value = '') => {
  const trimmed = String(value).trim();
  if (!trimmed) throw new Error('Product URL is required.');
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const readLimitedBody = async (response) => {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_PAGE_BYTES) throw new Error('The product page is too large to analyze.');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new Error('The product page is too large to analyze.');
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
};

const fetchProductPage = async (initialUrl, source) => {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const validated = await validatePublicUrl(currentUrl, source);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(validated, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,text/plain;q=0.7',
          'User-Agent': 'EasyPostProductAnalyzer/1.0',
        },
      });
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') throw new Error('The product page took too long to respond.');
      throw new Error('The product page could not be downloaded.');
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      clearTimeout(timeout);
      if (!location) throw new Error('The product page returned an invalid redirect.');
      if (redirectCount === MAX_REDIRECTS) throw new Error('The product page redirected too many times.');
      currentUrl = new URL(location, validated).toString();
      continue;
    }

    if (!response.ok) {
      clearTimeout(timeout);
      throw new Error(`The product page returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (!/(text\/html|application\/xhtml\+xml|application\/json|text\/plain)/i.test(contentType)) {
      clearTimeout(timeout);
      throw new Error('The product link did not return a readable web page.');
    }

    try {
      return {
        html: await readLimitedBody(response),
        finalUrl: validated.toString(),
      };
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The product page took too long to respond.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('The product page could not be loaded.');
};

const getMetaContent = (html, keys) => {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content="([^"]*)"[^>]*>`, 'i'),
      new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content='([^']*)'[^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:name|property)=["']${escaped}["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content='([^']*)'[^>]+(?:name|property)=["']${escaped}["'][^>]*>`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return normalizeWhitespace(match[1]);
    }
  }
  return '';
};

const extractPageDetails = (html, finalUrl) => {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = getMetaContent(html, ['og:title', 'twitter:title'])
    || normalizeWhitespace(titleMatch?.[1] || '');
  const description = getMetaContent(html, ['og:description', 'description', 'twitter:description']);
  const productName = rawTitle
    .replace(/\s+[-–|]\s+(App Store|Apps on Google Play|Google Play).*$/i, '')
    .replace(/\s+on the App Store.*$/i, '')
    .trim();
  const pageText = normalizeWhitespace(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .slice(0, 14_000);

  return {
    finalUrl,
    productName: productName.slice(0, 180),
    description: description.slice(0, 2_000),
    title: rawTitle.slice(0, 300),
    pageText,
  };
};

const cleanString = (value, maximum) => normalizeWhitespace(value).slice(0, maximum);

const analyzeWithGemini = async ({ page, source }) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = `Analyze this product page for a social-media campaign setup.

Source type: ${source}
Canonical URL: ${page.finalUrl}
Page title: ${page.title}
Metadata description: ${page.description}
Visible page content:
${page.pageText}

Return valid JSON only using this exact shape:
{
  "productName": "concise official product name",
  "productDescription": "clear factual description in 2-4 sentences"
}

Use only facts supported by the supplied page. Do not invent pricing, claims, or features. If a value cannot be inferred safely, return an empty string.`;

  const modelsToTry = ['gemini-2.5-flash', 'gemini-1.5-flash'];
  let lastError = null;
  for (const modelName of modelsToTry) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
      const responseText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!responseText) throw new Error('The analysis model returned an empty response.');
      return JSON.parse(responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
    } catch (error) {
      lastError = error;
    }
  }
  console.warn('Product AI analysis fell back to page metadata:', lastError?.message || lastError);
  return null;
};

export const analyzeProductUrl = async ({ url, source = 'website' }) => {
  const normalizedSource = String(source || 'website').trim().toLowerCase();
  if (!ALLOWED_SOURCES.has(normalizedSource)) throw new Error('Unsupported product source.');

  const normalizedUrl = normalizeProductUrl(url);
  const fetched = await fetchProductPage(normalizedUrl, normalizedSource);
  const page = extractPageDetails(fetched.html, fetched.finalUrl);
  const aiResult = await analyzeWithGemini({ page, source: normalizedSource });

  return {
    productSource: normalizedSource,
    productUrl: page.finalUrl,
    productName: cleanString(aiResult?.productName || page.productName, 180),
    productDescription: cleanString(aiResult?.productDescription || page.description, 2_000),
    analysisSource: aiResult ? 'ai' : 'metadata',
  };
};
