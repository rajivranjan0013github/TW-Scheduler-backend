import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Media from '../models/Media.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_TO_TRY = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

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
 * @returns {Promise<Object>} Updated media document
 */
export const analyzeMediaVideo = async (mediaId) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[videoAiService] GEMINI_API_KEY is not configured on the server. Skipping video AI analysis.');
    return null;
  }

  const media = await Media.findById(mediaId);
  if (!media) {
    console.warn(`[videoAiService] Media ${mediaId} not found.`);
    return null;
  }

  if (media.type !== 'video') {
    return media;
  }

  // Update status to processing
  media.aiStatus = 'processing';
  media.aiError = '';
  await media.save();

  let geminiFile = null;

  try {
    const videoBuffer = await getVideoBuffer(media);
    const mimeType = media.name?.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';

    // 1. Upload to Gemini File API
    geminiFile = await uploadToGeminiFileApi(
      videoBuffer,
      mimeType,
      `media_${media._id}_${Date.now()}`,
      apiKey
    );

    // 2. Structured Prompt for Pure Emotion & Reaction Video Analysis
    const prompt = `You are an expert video emotion and reaction analyst.
Analyze this short video clip carefully by examining the facial expressions, emotional tone, body language, and reactions of the person in the video.

Extract the following information:
1. Summary: A concise 1-2 sentence description of what happens in the video.
2. Reaction Understanding:
   - primaryEmotion: The single strongest emotion shown (choose strictly from: "shocked", "angry", "crying", "laughing", "confused", "surprised", "disappointed", "flustered", "excited", "candid", "smirking", "screaming", "relieved", "annoyed").
   - description: 1-2 sentences describing the facial expression and emotional reaction shown.
   - openingDialogue: Spoken opening words/dialogue or on-screen text in the first seconds (or empty string if none).
3. Tags (STRICT RULES: ONLY SPECIFIC REACTION/EMOTION TAGS, 1 TO 3 TAGS TOTAL):
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

    // 3. Normalize Tags (Strictly 1 to 3 reaction tags)
    const blacklist = new Set([
      'video', 'clip', 'media', 'phone', 'person', 'vertical', 'mobile', 'content',
      'short', 'reel', 'tiktok', 'post', 'pov', 'pov selfie', 'selfie', 'talking head',
      'ugc reaction', 'ugc', 'hook', 'app demo', 'showcase', 'demo'
    ]);

    const extractedTags = Array.isArray(parsedResponse.tags)
      ? parsedResponse.tags
          .map((t) => String(t).trim().toLowerCase().replace(/^#/, ''))
          .filter((t) => t.length > 0 && !blacklist.has(t))
          .slice(0, 3)
      : [];

    // Fallback to primaryEmotion if tags were filtered out
    if (extractedTags.length === 0 && parsedResponse.reaction?.primaryEmotion) {
      const em = String(parsedResponse.reaction.primaryEmotion).trim().toLowerCase().replace(/^#/, '');
      if (em && !blacklist.has(em)) {
        extractedTags.push(em);
      }
    }

    // 4. Update Media Document
    media.aiStatus = 'completed';
    media.aiProcessedAt = new Date();
    media.aiError = '';
    media.tags = extractedTags;
    media.aiAnalysis = {
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
      },
      autoTags: extractedTags,
    };

    await media.save();
    console.log(`[videoAiService] Successfully analyzed video ${media._id}: Emotion=${media.aiAnalysis.reaction.primaryEmotion}, Tags=[${extractedTags.join(', ')}]`);
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
