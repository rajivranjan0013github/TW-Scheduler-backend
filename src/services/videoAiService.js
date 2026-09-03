import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Media from '../models/Media.js';
import Campaign from '../models/Campaign.js';

import Folder from '../models/Folder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_TO_TRY = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

const TRIVIAL_UI_REGEX = /^(color|colour|brush|undo|redo|delete|eraser?|clear|zoom|palette|slider|picker|size|send\s*message|tap\s*button|click\s*button|keyboard|scroll|navigation|close\s*modal)\b/i;

export const cleanProductFeature = (feature = '') => {
  let cleaned = String(feature || '')
    .trim()
    .replace(/\b(display|functionality|action|mechanic|interface|screen)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 3) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
};

export const filterProductFeatures = (features = [], limit = 6) => {
  if (!Array.isArray(features)) return [];
  const seen = new Set();
  const result = [];

  for (const raw of features) {
    const trimmed = String(raw || '').trim();
    if (!trimmed || TRIVIAL_UI_REGEX.test(trimmed)) continue;
    const cleaned = cleanProductFeature(trimmed);
    if (!cleaned || TRIVIAL_UI_REGEX.test(cleaned)) continue;
    const lower = cleaned.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(cleaned);
    if (result.length >= limit) break;
  }

  return result;
};

/**
 * Automatically determines whether a media asset should be analyzed as an
 * App Showcase (screen recording/product demo) or a Hook (creator facial reaction).
 *
 * @param {Object} media - Media document or lean object
 * @param {string|null} [explicitMode] - Explicitly provided mode override
 * @returns {Promise<'app_showcase'|'reaction'>}
 */
export async function determineMediaAiMode(media, explicitMode = null) {
  if (explicitMode === 'app_showcase' || explicitMode === 'reaction') {
    return explicitMode;
  }

  // 1. Check if media already has app-showcase tags
  const existingTags = Array.isArray(media?.tags)
    ? media.tags.map((t) => String(t || '').toLowerCase().trim())
    : [];
  if (existingTags.some((t) => t === 'app-showcase' || t === 'showcase' || t === 'app showcase' || t === 'promo')) {
    return 'app_showcase';
  }
  if (existingTags.some((t) => t === 'hooks' || t === 'hook' || t === 'ugc' || t === 'creator')) {
    return 'reaction';
  }

  // 2. Check the folder hierarchy (name and tags)
  const targetFolderId = media?.folderId?._id || media?.folderId || null;
  if (targetFolderId) {
    try {
      let currentId = String(targetFolderId);
      const visited = new Set();
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const folder = await Folder.findById(currentId).lean();
        if (!folder) break;

        const folderName = String(folder.name || '').toLowerCase().trim();
        const folderTags = (folder.tags || []).map((t) => String(t || '').toLowerCase().trim());

        if (
          folderName.includes('showcase') ||
          folderName.includes('promo') ||
          folderName.includes('demo') ||
          folderTags.includes('app-showcase') ||
          folderTags.includes('showcase') ||
          folderTags.includes('promo')
        ) {
          return 'app_showcase';
        }

        if (
          folderName.includes('hook') ||
          folderTags.includes('hooks') ||
          folderTags.includes('hook')
        ) {
          return 'reaction';
        }

        currentId = folder.parentFolderId ? String(folder.parentFolderId?._id || folder.parentFolderId) : null;
      }
    } catch (err) {
      console.warn('[videoAiService] Failed to inspect folder for AI mode determination:', err.message);
    }
  }

  // 3. Check campaign promoFolderId and showcaseMediaIds
  if (media?.campaignId) {
    try {
      const campaign = await Campaign.findById(media.campaignId)
        .select('promoFolderId showcaseMediaIds')
        .lean();
      if (campaign) {
        if (campaign.promoFolderId && targetFolderId && String(campaign.promoFolderId) === String(targetFolderId)) {
          return 'app_showcase';
        }
        if (Array.isArray(campaign.showcaseMediaIds) && campaign.showcaseMediaIds.some((id) => String(id) === String(media._id))) {
          return 'app_showcase';
        }
      }
    } catch (err) {
      console.warn('[videoAiService] Failed to inspect campaign for AI mode determination:', err.message);
    }
  }

  return 'reaction';
}

/**
 * Uploads a video buffer to the Google Gemini File API via resumable upload
 * @param {Buffer} buffer 
 * @param {string} mimeType 
 * @param {string} displayName 
 * @param {string} apiKey 
 * @returns {Promise<{ name: string, uri: string, mimeType: string }>}
 */
async function uploadToGeminiFileApi(buffer, mimeType, displayName, apiKey) {
  const normalizedMime = mimeType || 'video/mp4';
  const initUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;

  const initResponse = await fetch(initUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buffer.length),
      'X-Goog-Upload-Header-Content-Type': normalizedMime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file: {
        display_name: displayName || `video_${Date.now()}`,
      },
    }),
  });

  if (!initResponse.ok) {
    const errBody = await initResponse.text().catch(() => '');
    throw new Error(`Failed to initiate Gemini File upload (${initResponse.status}): ${errBody}`);
  }

  const uploadUrl = initResponse.headers.get('x-goog-upload-url') || initResponse.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) {
    throw new Error('Gemini File upload did not return an upload URL.');
  }

  // Upload the actual file content
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(buffer.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: buffer,
  });

  if (!uploadResponse.ok) {
    const errBody = await uploadResponse.text().catch(() => '');
    throw new Error(`Gemini File upload failed (${uploadResponse.status}): ${errBody}`);
  }

  const fileData = await uploadResponse.json();
  const file = fileData.file;
  if (!file || !file.name || !file.uri) {
    throw new Error('Invalid Gemini File upload response');
  }

  // Poll until file reaches ACTIVE state (videos usually take 1-5 seconds to process)
  let currentState = file.state;
  let attempts = 0;
  const maxAttempts = 30; // 30 * 2s = 60s max wait

  while (currentState === 'PROCESSING' && attempts < maxAttempts) {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${apiKey}`);
    if (checkRes.ok) {
      const checkData = await checkRes.json();
      currentState = checkData.state;
      if (currentState === 'FAILED') {
        throw new Error(`Gemini video processing state is FAILED for ${file.name}`);
      }
    }
  }

  return {
    name: file.name,
    uri: file.uri,
    mimeType: normalizedMime,
  };
}

/**
 * Deletes a file from Gemini File API
 */
async function deleteFromGeminiFileApi(fileName, apiKey) {
  if (!fileName || !apiKey) return;
  try {
    await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`, {
      method: 'DELETE',
    });
  } catch (err) {
    console.warn(`[videoAiService] Non-critical: Failed to delete Gemini file ${fileName}:`, err.message);
  }
}

/**
 * Retrieves the video buffer from local disk or remote URL
 */
async function getVideoBuffer(media) {
  // If local file exists
  if (media.storageKey) {
    const localFilePath = path.join(__dirname, '../../public/uploads', media.storageKey);
    if (fs.existsSync(localFilePath)) {
      return fs.readFileSync(localFilePath);
    }
  }

  // Otherwise fetch from public URL (R2 or CDN)
  if (media.url) {
    const response = await fetch(media.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch media from URL (${response.status}): ${media.url}`);
    }
    const arrayBuf = await response.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  throw new Error('No valid storage path or URL found on media record.');
}

/**
 * Main service function to analyze a video with Gemini
 * @param {string} mediaId 
 * @param {Object} [options]
 * @param {'app_showcase'|'reaction'} [options.mode]
 * @returns {Promise<Object>} Updated media document
 */
export const analyzeMediaVideo = async (mediaId, { mode: explicitMode = null, campaignId: overrideCampaignId = null } = {}) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const media = await Media.findById(mediaId);
  if (!media) {
    console.warn(`[videoAiService] Media ${mediaId} not found.`);
    return null;
  }

  if (!apiKey) {
    console.warn('[videoAiService] GEMINI_API_KEY is not configured on the server.');
    media.aiStatus = 'failed';
    media.aiError = 'Video AI is unavailable because GEMINI_API_KEY is not configured.';
    await media.save().catch(() => {});
    return media;
  }

  if (media.type !== 'video') {
    return media;
  }

  // Auto-determine analysis mode if not explicitly provided
  const mode = await determineMediaAiMode(media, explicitMode);

  // Update status to processing
  media.aiStatus = 'processing';
  media.aiError = '';
  await media.save();

  let tempVideoPath = null;
  let geminiFile = null;

  try {
    const { buffer: videoBuffer, mimeType } = await getMediaFileBuffer(media);
    const mode = await determineMediaAiMode(media, explicitMode);

    // 1. Upload to Gemini File API
    geminiFile = await uploadToGeminiFileApi(
      videoBuffer,
      mimeType,
      `media_${media._id}_${Date.now()}`,
      apiKey
    );

    const resolvedCampaignId = media.campaignId || overrideCampaignId;
    const campaign = resolvedCampaignId
      ? await Campaign.findById(resolvedCampaignId)
        .select('name productName productDescription description category targetAudience keyBenefit coreFunction useCases positioningStatement keyMessaging targetAudienceList')
        .lean()
      : null;

    // 2. Use a purpose-built prompt. Screen recordings need high-level feature and value flow
    // analysis; creator clips need emotion and reaction analysis.
    const prompt = mode === 'app_showcase'
      ? `You are an expert mobile product marketer and short-form video creative director.
Analyze this mobile app showcase recording frame by frame. Focus entirely on the core product capabilities, value delivered to the user, and visual proof of what the app does.

Product Context (Use this as your primary product reference):
- App / Product Name: ${campaign?.productName || campaign?.name || 'Unknown product'}
- Category: ${campaign?.category || 'General App / Product'}
- Full Product Description: ${campaign?.productDescription || campaign?.description || 'N/A'}
- Core Function & Value: ${campaign?.coreFunction || campaign?.keyBenefit || 'N/A'}
- Key Benefits: ${campaign?.keyBenefit || 'N/A'}
- Target Audience: ${campaign?.targetAudience || 'General Users'}
- Use Cases: ${(campaign?.useCases || []).join(', ') || 'N/A'}
- Positioning Statement: ${campaign?.positioningStatement || 'N/A'}
- Key Messaging: ${(campaign?.keyMessaging || []).join(', ') || 'N/A'}

Extraction Rules:
1. summary: A concise 1-2 sentence factual summary of what this app recording demonstrates and the value shown.
2. featuresShown (STRICT RULES — HIGH-LEVEL PRODUCT CAPABILITIES ONLY, 2 TO 4 ITEMS MAX):
   - Extract only substantial, marketable product features (e.g. "Live Home Screen Drawing Widget", "Handwritten Couple Notes", "Interactive Doodling Canvas", "Real-Time Relationship Tracker").
   - STRICTLY FORBIDDEN (DO NOT INCLUDE):
     * NO minor UI controls, tools, or settings (STRICTLY NO: "color selection", "color picker", "brush size", "undo/redo", "eraser", "delete action", "zoom", "palette", "brush size adjustment").
     * NO generic OS/utility mechanics (STRICTLY NO: "send message", "send message functionality", "tap button", "keyboard input", "scroll view", "widget display", "message display").
   - Always group micro-tools into their overarching product capability (e.g. instead of color picker + brush size + undo -> "Interactive Drawing Canvas").
3. userFlow: 3 to 6 ordered milestones describing the user experience (e.g. ["Draws a doodle on the canvas", "Sends to partner's lockscreen", "Widget updates live on home screen"]). DO NOT list low-level button clicks like "selects blue color" or "adjusts slider".
4. strongestMoments: 2 to 4 clear, punchy visual proof moments for an ad (e.g. "Live lockscreen interactive widget update", "Instant doodle reveal on partner's phone"). Do NOT include timestamp numbers.
5. suggestedOverlays: 3 to 5 short on-screen overlay text lines (max 7 words each) that match the visible screen action.
6. confidence: "high", "medium", or "low".
7. tags (STRICT RULES: ONLY SPECIFIC HIGH-LEVEL PRODUCT/FEATURE TAGS, 3 TO 5 TAGS TOTAL):
   - Choose 3 to 5 compact feature/function tags (e.g. ["lockscreen-widget", "drawing-canvas", "couple-notes"]).
   - STRICTLY DO NOT include emotion or reaction tags (NO "shocked", "laughing", "crying", etc.).
   - DO NOT include generic format words (NO "video", "clip", "screen", "recording", "ugc", "hook", "showcase", "demo").

Output valid JSON only:
{
  "summary": "...",
  "appShowcase": {
    "detected": true,
    "featuresShown": ["Live Home Screen Widget", "Handwritten Couple Notes"],
    "screenDetails": "...",
    "userFlow": ["..."],
    "strongestMoments": ["..."],
    "suggestedOverlays": ["..."],
    "confidence": "high"
  },
  "tags": ["feature-tag-1", "feature-tag-2"]
}`
      : `You are an expert video emotion and reaction analyst.
Analyze this short video clip carefully by examining the facial expressions, emotional tone, body language, and reactions of the person in the video.

Extract the following information:
1. summary: A concise 1-2 sentence description of what happens in the video.
2. Reaction Understanding:
   - primaryEmotion: The single strongest emotion shown (choose strictly from: "shocked", "angry", "crying", "laughing", "confused", "surprised", "disappointed", "flustered", "excited", "candid", "smirking", "screaming", "relieved", "annoyed").
   - description: 1-2 sentences describing the facial expression and emotional reaction shown.
   - openingDialogue: Spoken opening words/dialogue or on-screen text in the first seconds (or empty string if none).
3. tags (STRICT RULES: ONLY SPECIFIC REACTION/EMOTION TAGS, 1 TO 3 TAGS TOTAL):
   - Choose strictly 1 to 3 reaction/emotion tags from: ["shocked", "angry", "crying", "laughing", "confused", "surprised", "disappointed", "flustered", "excited", "candid", "smirking", "screaming", "relieved", "annoyed"].
   - DO NOT include camera angle/style tags (NO "pov selfie", "mirror selfie", "talking head", etc.).
   - DO NOT include hook or format tags (NO "ugc reaction", "hook", "app demo", "showcase", etc.).
   - DO NOT include filler words (NO "video", "clip", "phone", "person", "media").
   - Return strictly 1 to 3 reaction tags.

Output must strictly follow this JSON schema:
{
  "summary": "...",
  "reaction": {
    "primaryEmotion": "shocked",
    "description": "...",
    "openingDialogue": "..."
  },
  "tags": ["shocked"]
}`;

    let parsedResponse = null;
    let lastError = '';

    for (const modelName of MODELS_TO_TRY) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      fileData: {
                        fileUri: geminiFile.uri,
                        mimeType: geminiFile.mimeType,
                      },
                    },
                    {
                      text: prompt,
                    },
                  ],
                },
              ],
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.2,
              },
            }),
          }
        );

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          let cleanText = responseText.trim();
          if (cleanText.startsWith('```')) {
            cleanText = cleanText.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
          }
          parsedResponse = JSON.parse(cleanText);
          break;
        }
      } catch (err) {
        console.warn(`[videoAiService] Model ${modelName} attempt failed:`, err.message);
        lastError = err.message;
      }
    }

    if (!parsedResponse) {
      throw new Error(`Gemini video analysis failed on all models. Last error: ${lastError}`);
    }

    // 3. Normalize tags according to the selected analysis mode.
    const blacklist = new Set([
      'video', 'clip', 'media', 'phone', 'person', 'vertical', 'mobile', 'content',
      'short', 'reel', 'tiktok', 'post', 'pov', 'pov selfie', 'selfie', 'talking head',
      'ugc reaction', 'ugc', 'hook', 'app demo', 'showcase', 'demo', 'screen', 'recording'
    ]);

    const reactionBlacklist = new Set([
      'shocked', 'angry', 'crying', 'laughing', 'confused', 'surprised',
      'disappointed', 'flustered', 'excited', 'candid', 'smirking', 'screaming',
      'relieved', 'annoyed'
    ]);

    let extractedTags = Array.isArray(parsedResponse.tags)
      ? parsedResponse.tags
          .map((t) => String(t).trim().toLowerCase().replace(/^#/, ''))
          .filter((t) => t.length > 0 && !blacklist.has(t))
      : [];

    if (mode === 'app_showcase') {
      // Discard any accidental emotion tags
      extractedTags = extractedTags.filter((t) => !reactionBlacklist.has(t)).slice(0, 6);
    } else {
      // Reaction mode: keep strictly 1 to 3 reaction tags
      extractedTags = extractedTags.slice(0, 3);
      if (extractedTags.length === 0 && parsedResponse.reaction?.primaryEmotion) {
        const em = String(parsedResponse.reaction.primaryEmotion).trim().toLowerCase().replace(/^#/, '');
        if (em && !blacklist.has(em)) {
          extractedTags.push(em);
        }
      }
    }

    // 4. Update Media Document
    media.aiStatus = 'completed';
    media.aiProcessedAt = new Date();
    media.aiError = '';
    media.tags = extractedTags;

    const showcase = parsedResponse.appShowcase || {};
    media.aiAnalysis = mode === 'app_showcase'
      ? {
          summary: parsedResponse.summary || '',
          reaction: { primaryEmotion: '', description: '', openingDialogue: '' },
          hook: { detected: false, hookConcept: '', description: '', openingDialogue: '' },
          appShowcase: {
            detected: showcase.detected !== false,
            featuresShown: filterProductFeatures(showcase.featuresShown, 5),
            screenDetails: showcase.screenDetails || '',
            userFlow: Array.isArray(showcase.userFlow) ? showcase.userFlow.slice(0, 8) : [],
            strongestMoments: Array.isArray(showcase.strongestMoments) ? showcase.strongestMoments.slice(0, 6) : [],
            suggestedOverlays: Array.isArray(showcase.suggestedOverlays) ? showcase.suggestedOverlays.slice(0, 6) : [],
            confidence: ['high', 'medium', 'low'].includes(showcase.confidence) ? showcase.confidence : 'medium',
          },
          autoTags: extractedTags,
        }
      : {
          summary: parsedResponse.summary || '',
          reaction: {
            primaryEmotion: parsedResponse.reaction?.primaryEmotion || extractedTags[0] || '',
            description: parsedResponse.reaction?.description || '',
            openingDialogue: parsedResponse.reaction?.openingDialogue || '',
          },
          hook: {
            detected: false,
            hookConcept: '',
            description: '',
            openingDialogue: parsedResponse.reaction?.openingDialogue || '',
          },
          appShowcase: {
            detected: false,
            featuresShown: [],
            screenDetails: '',
            userFlow: [],
            strongestMoments: [],
            suggestedOverlays: [],
            confidence: '',
          },
          autoTags: extractedTags,
        };

    await media.save();
    console.log(`[videoAiService] Successfully analyzed video ${media._id}: Mode=${mode}, Tags=[${extractedTags.join(', ')}]`);
    return media;
  } catch (error) {
    console.error(`[videoAiService] Error analyzing video media ${mediaId}:`, error.message);
    media.aiStatus = 'failed';
    media.aiError = error.message || 'Video AI analysis failed.';
    await media.save().catch(() => {});
    return media;
  } finally {
    // 5. Cleanup temporary Gemini File
    if (geminiFile?.name) {
      deleteFromGeminiFileApi(geminiFile.name, apiKey);
    }
  }
};
