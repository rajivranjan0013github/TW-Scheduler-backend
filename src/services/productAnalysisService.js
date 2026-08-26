import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOWED_SOURCES = new Set(['website', 'app_store', 'play_store']);
const MAX_REDIRECTS = 3;
const MAX_PAGE_BYTES = 2_500_000;
const FETCH_TIMEOUT_MS = 12_000;

export const decodeHtml = (value = '') => String(value)
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));

export const normalizeWhitespace = (value = '') => decodeHtml(value)
  .replace(/\s+/g, ' ')
  .trim();

export const detectProductSource = (url = '') => {
  const normalized = String(url).toLowerCase().trim();
  if (normalized.includes('apps.apple.com') || normalized.includes('itunes.apple.com')) {
    return 'app_store';
  }
  if (normalized.includes('play.google.com')) {
    return 'play_store';
  }
  return 'website';
};

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
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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

// ----------------------------------------------------
// Apple App Store Extractor (iTunes Lookup API + Web)
// ----------------------------------------------------
export const extractAppStoreData = async (url) => {
  const idMatch = url.match(/id(\d+)/i) || url.match(/[?&]id=(\d+)/i);
  const appId = idMatch ? idMatch[1] : null;
  const countryMatch = url.match(/apps\.apple\.com\/([a-z]{2})\//i);
  const country = countryMatch ? countryMatch[1].toLowerCase() : 'us';

  if (appId) {
    try {
      const lookupUrl = `https://itunes.apple.com/lookup?id=${appId}&country=${country}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(lookupUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        if (data?.results?.length > 0) {
          const item = data.results[0];
          return {
            productSource: 'app_store',
            productUrl: item.trackViewUrl || url,
            productName: normalizeWhitespace(item.trackName || item.trackCensoredName || ''),
            productDescription: normalizeWhitespace(item.description || ''),
            iconUrl: item.artworkUrl512 || item.artworkUrl100 || item.artworkUrl60 || '',
            category: item.primaryGenreName || (item.genres && item.genres[0]) || 'Mobile App',
            developer: item.sellerName || item.artistName || '',
            rating: item.averageUserRating || null,
            ratingCount: item.userRatingCount || null,
            screenshots: item.screenshotUrls || item.ipadScreenshotUrls || [],
          };
        }
      }
    } catch (err) {
      console.warn('iTunes Lookup API fallback to page scraper:', err.message);
    }
  }

  // Fallback to web page scrape for App Store
  const fetched = await fetchProductPage(url, 'app_store');
  const details = extractPageDetails(fetched.html, fetched.finalUrl);
  return {
    productSource: 'app_store',
    productUrl: fetched.finalUrl,
    productName: details.productName,
    productDescription: details.description,
    iconUrl: details.iconUrl || '',
    category: 'Mobile App',
    developer: '',
    rating: null,
    ratingCount: null,
    screenshots: [],
    pageText: details.pageText,
  };
};

// ----------------------------------------------------
// Google Play Store Extractor (JSON-LD + Meta)
// ----------------------------------------------------
export const extractPlayStoreData = async (url) => {
  const fetched = await fetchProductPage(url, 'play_store');
  const html = fetched.html;
  let jsonLdData = null;

  // Try to parse Schema.org JSON-LD
  const jsonLdMatch = html.match(/<script type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  if (jsonLdMatch) {
    try {
      const parsed = JSON.parse(jsonLdMatch[1]);
      if (parsed && (parsed['@type'] === 'SoftwareApplication' || parsed.name)) {
        jsonLdData = parsed;
      }
    } catch (e) {
      // ignore json parse error
    }
  }

  const details = extractPageDetails(html, fetched.finalUrl);
  const productName = normalizeWhitespace(jsonLdData?.name || details.productName || '')
    .replace(/\s+[-–|]\s+(Apps on Google Play|Google Play).*$/i, '');
  const productDescription = normalizeWhitespace(jsonLdData?.description || details.description || '');
  const iconUrl = jsonLdData?.image || details.iconUrl || '';
  const category = jsonLdData?.applicationCategory || 'Mobile App';

  return {
    productSource: 'play_store',
    productUrl: fetched.finalUrl,
    productName,
    productDescription,
    iconUrl,
    category,
    developer: jsonLdData?.author?.name || '',
    rating: jsonLdData?.aggregateRating?.ratingValue ? Number(jsonLdData.aggregateRating.ratingValue) : null,
    ratingCount: jsonLdData?.aggregateRating?.ratingCount ? Number(jsonLdData.aggregateRating.ratingCount) : null,
    screenshots: [],
    pageText: details.pageText,
  };
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
  const iconUrl = getMetaContent(html, ['og:image', 'twitter:image', 'apple-touch-icon']);
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
    iconUrl,
    title: rawTitle.slice(0, 300),
    pageText,
  };
};

const cleanString = (value, maximum) => normalizeWhitespace(value).slice(0, maximum);

const buildCategorySpecificInsights = (name = 'Product', category = 'Mobile App', rawText = '') => {
  const lowerCat = category.toLowerCase();
  const lowerText = rawText.toLowerCase();

  const isMedical = lowerCat.includes('medical') || lowerCat.includes('health') || lowerText.includes('symptom') || lowerText.includes('diagnos') || lowerText.includes('doctor');
  const isCouples = lowerCat.includes('couple') || lowerCat.includes('relationship') || lowerText.includes('partner') || lowerText.includes('distance');
  const isEducation = lowerCat.includes('education') || lowerCat.includes('language') || lowerText.includes('learn') || lowerText.includes('lesson');
  const isProductivity = lowerCat.includes('productivity') || lowerCat.includes('utility') || lowerText.includes('notes') || lowerText.includes('tasks');

  if (isMedical) {
    return {
      keyBenefit: `Instant symptom insights and health clarity in seconds`,
      coreFunction: `AI-powered health checks, symptom scanning & medical guidance`,
      useCases: [
        `Checking sudden symptoms or health concerns from home`,
        `Preparing questions and symptom history for doctor appointments`,
        `Quickly understanding lab reports or medical terms`,
        `Monitoring recurring health patterns and family wellness`,
      ],
      targetAudience: [
        `Health-conscious adults seeking quick medical clarity`,
        `Parents managing family health and pediatric questions`,
        `Busy individuals who want to pre-screen symptoms before clinic visits`,
        `Seniors & caregivers monitoring daily health indicators`,
      ],
      marketingStrategies: [
        `[Split-Screen Video] Top 60% live symptom scan & instant report demo + Bottom 40% satisfying kinetic gameplay`,
        `[5-Slide Carousel] Slide 1: "Why does my body do this?" hook → Slides 2-4: Instant scan UI → Slide 5: App Store CTA`,
        `[7s Feature Teardown] 7-second fast cut showcasing instant AI analysis results with trending audio`,
        `[Relatable POV Reel] Hook: "POV: You finally stopped doom-scrolling symptoms and used this app" with UI flow`,
      ],
      keyMessaging: [
        `"Know what's happening with your health in 30 seconds."`,
        `"Stop searching random forums. Get structured health clarity."`,
        `"Your 24/7 symptom screening assistant."`,
        `"Fast, clear, and reassuring."`,
      ],
      positioningStatement: `${name} is the AI health assistant that gives users fast, reassuring symptom clarity and medical insights directly on their phone.`,
    };
  }

  if (isCouples) {
    return {
      keyBenefit: `Deepen your relationship and stay connected every day`,
      coreFunction: `Daily partner questions, distance tracking, lock screen widgets & couples games`,
      useCases: [
        `Answering daily thought-provoking questions with your partner`,
        `Tracking relationship milestones and countdowns on lock screen widgets`,
        `Sending instant doodle notes and mood updates across distance`,
        `Playing fun couples trivia games on date nights`,
      ],
      targetAudience: [
        `Couples in long-distance relationships (LDR)`,
        `Partners wanting more meaningful daily communication`,
        `Dating couples looking for fun shared activities`,
        `Engaged and newlywed couples`,
      ],
      marketingStrategies: [
        `[Split-Screen Video] Top 60% partner lock-screen widget reaction + Bottom 40% Subway Surfers gameplay`,
        `[5-Slide Carousel] Slide 1: Relatable relationship text hook → Slides 2-4: App feature reveal → Slide 5: Download link`,
        `[7s Feature Teardown] 7-second aesthetic walkthrough of partner distance tracker & doodles`,
        `[Relatable POV Reel] Hook: "Downloaded this for my partner 'as a joke'... now we're obsessed"`,
      ],
      keyMessaging: [
        `"The app made for partners who miss each other."`,
        `"Never run out of things to talk about."`,
        `"Stay close, no matter the distance."`,
        `"Our favorite part of the day."`,
      ],
      positioningStatement: `${name} is the couples app that keeps partners deeply connected through interactive widgets, daily questions, and shared moments.`,
    };
  }

  if (isEducation) {
    return {
      keyBenefit: `Master new skills with 5-minute bite-sized interactive lessons`,
      coreFunction: `Gamified practice, instant feedback, and streak motivation`,
      useCases: [
        `Practicing quick 5-minute lessons during daily commutes`,
        `Building long-term vocabulary and conversational confidence`,
        `Interactive quizzes and real-time pronunciation checks`,
        `Learning on the go without heavy textbooks`,
      ],
      targetAudience: [
        `Language learners, students & travel enthusiasts`,
        `Busy professionals learning for career growth`,
        `Self-taught learners building new skills`,
        `Kids and teens looking for gamified learning`,
      ],
      marketingStrategies: [
        `[Split-Screen Video] Top 60% rapid-fire lesson speedrun demo + Bottom 40% satisfying kinetic sand gameplay`,
        `[5-Slide Carousel] Slide 1: Common learning mistake meme → Slides 2-4: App lesson solution → Slide 5: CTA`,
        `[7s Feature Teardown] 7-second high-energy cut highlighting instant audio pronunciation feedback`,
        `[Relatable POV Reel] Hook: "POV: You actually stuck to your lessons for 30 days straight"`,
      ],
      keyMessaging: [
        `"5 minutes a day is all it takes."`,
        `"Learning that actually feels like a game."`,
        `"From beginner to fluent on your own schedule."`,
        `"Start speaking today."`,
      ],
      positioningStatement: `${name} makes learning fast, addictive, and effective with gamified bite-sized lessons designed for everyday life.`,
    };
  }

  // Default generic app fallback
  return {
    keyBenefit: `Automate and elevate your daily experience with ${name}`,
    coreFunction: `Smart features, intuitive tools & instant mobile access`,
    useCases: [
      `Streamlining your daily routine with one-tap actions`,
      `Accessing key features instantly via home screen widgets`,
      `Managing tasks and updates without complex menus`,
      `Sharing insights and progress seamlessly`,
    ],
    targetAudience: [
      `Active smartphone users looking for modern solutions`,
      `Busy professionals and students`,
      `Tech-savvy early adopters`,
      `People who value fast, clean design`,
    ],
    marketingStrategies: [
      `[Split-Screen Video] Top 60% ${name} demo in action + Bottom 40% satisfying kinetic gameplay`,
      `[5-Slide Swipe Carousel] Slide 1: Pain-point meme hook → Slides 2-4: App solution screenshots → Slide 5: Download CTA`,
      `[7s Feature Teardown] 7-second aesthetic cut highlighting the standout killer feature with trending audio`,
      `[Relatable POV Reel] Hook: "POV: You finally found an app made for this" with fast UI walkthrough`,
    ],
    keyMessaging: [
      `"${name}: Built for how you actually live."`,
      `"Stop doing it the hard way. Try this."`,
      `"Fast, simple, and beautifully designed."`,
      `"The companion you didn't know you needed."`,
    ],
    positioningStatement: `${name} is the modern mobile solution that empowers users to streamline their daily workflow through intuitive design and smart features.`,
  };
};

// ----------------------------------------------------
// Gemini AI Synthesis for MarketAI-Style Extracted Info & Insights
// ----------------------------------------------------
const analyzeWithGemini = async ({ rawData, source }) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const prompt = `You are an elite short-form video growth strategist for TikTok, Instagram Reels, and YouTube Shorts.
Analyze this product/app listing:

Source type: ${source}
App / Product Name: ${rawData.productName || 'Unknown'}
Category / Genre: ${rawData.category || 'General'}
Developer / Brand: ${rawData.developer || ''}
Extracted Store Description:
${(rawData.productDescription || rawData.pageText || '').slice(0, 4000)}

CRITICAL INSTRUCTIONS:
1. Deeply understand the EXACT category and real-world utility of this app (e.g. Medical Diagnosis, Couples Relationship, Language Learning, Productivity, Fitness, Gaming, etc.).
2. Under "marketingStrategies", talk SPECIFICALLY about 4 short-form video formats and carousel formats tailored to this exact app. Do NOT provide generic PR, email newsletter, or influencer partnership advice.
   - [Split-Screen Video]: Name the exact app screen / UI action to show on Top 60% with satisfying kinetic/gameplay footage on Bottom 40%.
   - [5-Slide Swipe Carousel]: Specific multi-slide breakdown (Slide 1 Hook meme -> Slides 2-4 App solution screenshots -> Slide 5 Download CTA).
   - [7s Feature Teardown]: Specific 7-second cut naming the standout feature with trending sound.
   - [Relatable POV Reel]: Realistic category-specific POV text hook and UI walkthrough.
3. Under "useCases", provide 4 practical, authentic everyday situations where people use this app. Do NOT use generic "Goal-based" filler.

Return JSON in this exact shape:
{
  "productName": "Clean concise official product name",
  "category": "Main clear category name",
  "keyBenefit": "One short punchy key benefit tailored to this app",
  "coreFunction": "Short description of core function",
  "productDescription": "Comprehensive 2-3 sentence description of product features and value",
  "targetAudienceSummary": "Concise 3-6 word audience summary",
  "useCases": [
    "4 specific, practical app use cases (each starting with an action or situation)"
  ],
  "targetAudience": [
    "4 specific personas/demographics who download this app"
  ],
  "marketingStrategies": [
    "[Split-Screen Video] Top 60% [exact app UI action] + Bottom 40% satisfying kinetic gameplay",
    "[5-Slide Carousel] Slide 1: [Pain-point hook] -> Slides 2-4: [App solution screenshots] -> Slide 5: App Store CTA",
    "[7s Feature Teardown] 7-second fast cut showcasing [exact killer feature] with trending audio",
    "[Relatable POV Reel] Hook: 'POV: You finally found an app made for [specific outcome]' with UI flow"
  ],
  "keyMessaging": [
    "4 punchy, viral 3-second hook quotes (enclosed in quotation marks)"
  ],
  "positioningStatement": "1-2 sentence compelling positioning statement"
}

Output valid JSON only.`;

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
  console.warn('Product AI analysis fell back to extracted store metadata:', lastError?.message || lastError);
  return null;
};

// ----------------------------------------------------
// Main Product Analyzer API Function
// ----------------------------------------------------
export const analyzeProductUrl = async ({ url, source }) => {
  const normalizedUrl = normalizeProductUrl(url);
  const detectedSource = source && ALLOWED_SOURCES.has(source)
    ? source
    : detectProductSource(normalizedUrl);

  let rawData;
  if (detectedSource === 'app_store') {
    rawData = await extractAppStoreData(normalizedUrl);
  } else if (detectedSource === 'play_store') {
    rawData = await extractPlayStoreData(normalizedUrl);
  } else {
    const fetched = await fetchProductPage(normalizedUrl, 'website');
    const details = extractPageDetails(fetched.html, fetched.finalUrl);
    rawData = {
      productSource: 'website',
      productUrl: fetched.finalUrl,
      productName: details.productName,
      productDescription: details.description,
      iconUrl: details.iconUrl || '',
      category: 'Product',
      developer: '',
      rating: null,
      ratingCount: null,
      screenshots: [],
      pageText: details.pageText,
    };
  }

  const aiResult = await analyzeWithGemini({ rawData, source: detectedSource });
  const finalName = cleanString(aiResult?.productName || rawData.productName, 180);
  const finalCategory = cleanString(aiResult?.category || rawData.category || 'Mobile App', 100);
  const defaultInsights = buildCategorySpecificInsights(finalName, finalCategory, rawData.productDescription || rawData.pageText || '');

  return {
    productSource: detectedSource,
    productUrl: rawData.productUrl || normalizedUrl,
    productName: finalName,
    productDescription: cleanString(aiResult?.productDescription || rawData.productDescription, 2_000),
    targetAudience: cleanString(aiResult?.targetAudienceSummary || aiResult?.targetAudience?.[0] || defaultInsights.targetAudience[0] || 'Active users', 180),
    category: finalCategory,
    iconUrl: rawData.iconUrl || '',
    rating: rawData.rating || null,
    ratingCount: rawData.ratingCount || null,
    screenshots: rawData.screenshots || [],
    keyBenefit: aiResult?.keyBenefit || defaultInsights.keyBenefit,
    coreFunction: aiResult?.coreFunction || defaultInsights.coreFunction,
    useCases: aiResult?.useCases?.length ? aiResult.useCases : defaultInsights.useCases,
    targetAudienceList: aiResult?.targetAudience?.length ? aiResult.targetAudience : defaultInsights.targetAudience,
    marketingStrategies: aiResult?.marketingStrategies?.length ? aiResult.marketingStrategies : defaultInsights.marketingStrategies,
    keyMessaging: aiResult?.keyMessaging?.length ? aiResult.keyMessaging : defaultInsights.keyMessaging,
    positioningStatement: aiResult?.positioningStatement || defaultInsights.positioningStatement,
    analysisSource: aiResult ? 'ai' : 'metadata',
  };
};
