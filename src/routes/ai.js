import express from 'express';
import { protect } from '../middleware/auth.js';
import Campaign from '../models/Campaign.js';
import Media from '../models/Media.js';
import SavedCaption from '../models/SavedCaption.js';
import { analyzeProductUrl } from '../services/productAnalysisService.js';
import { formatGeminiAttemptFailures, getGeminiModelCandidates } from '../services/geminiModels.js';

const router = express.Router();

// Helper to resolve campaign product context
const getProductContext = async (req) => {
  const campaignId = req.query.campaignId || req.body.campaignId || null;
  if (campaignId) {
    try {
      const campaign = await Campaign.findById(campaignId).lean();
      if (campaign) {
        return {
          name: campaign.productName || campaign.name || 'Product',
          description: campaign.productDescription || campaign.description || 'Our product',
          category: campaign.category || '',
          targetAudience: campaign.targetAudience || '',
          productSource: campaign.productSource || 'website',
          productUrl: campaign.productUrl || campaign.productWebsite || '',
          iconUrl: campaign.iconUrl || '',
        };
      }
    } catch (e) {
      console.warn('Failed to load campaign for AI prompt context:', e.message);
    }
  }
  return {
    name: 'Penguin',
    description: 'Penguin is a couples app where partners can answer 3000+ questions, play games, complete rituals, update moods, send doodles, see relationship countdowns, track distance, and use lock screen/home screen widgets.',
    category: 'Couples / Lifestyle',
    targetAudience: 'Couples and partners in relationships',
    productSource: 'app_store',
    productUrl: '',
    iconUrl: '',
  };
};

// @desc    Analyze product or app store URL (App Store / Play Store / Website)
// @route   POST /api/ai/analyze-product
// @access  Private
router.post('/analyze-product', protect, async (req, res) => {
  const { url, source } = req.body;
  if (!url || !String(url).trim()) {
    return res.status(400).json({ message: 'A valid product or app store link is required.' });
  }

  try {
    const analysis = await analyzeProductUrl({ url: String(url).trim(), source });
    res.status(200).json(analysis);
  } catch (error) {
    console.error('Error in /api/ai/analyze-product:', error);
    res.status(400).json({ message: error.message || 'Failed to extract store information.' });
  }
});

const cleanStringList = (value, limit = 10) => (
  Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, limit)
    : []
);

const canAccessCampaign = (campaign, user) => {
  if (!campaign || !user) return false;
  if (['owner', 'admin'].includes(user.role)) return true;
  const userId = String(user._id || '');
  const email = String(user.email || '').trim().toLowerCase();
  return String(campaign.createdBy || '') === userId
    || String(campaign.mainEmail || '').trim().toLowerCase() === email;
};

// @desc    Turn product context + analyzed showcase recordings into edit-ready ad blueprints
// @route   POST /api/ai/generate-campaign-strategy
// @access  Private
router.post('/generate-campaign-strategy', protect, async (req, res) => {
  const campaignId = String(req.body?.campaignId || '').trim();
  const requestedMediaIds = cleanStringList(req.body?.mediaIds, 16);
  const useListingOnly = Boolean(req.body?.useListingOnly);
  const apiKey = process.env.GEMINI_API_KEY;

  if (!campaignId) {
    return res.status(400).json({ message: 'Campaign is required.' });
  }
  if (!apiKey) {
    return res.status(500).json({ message: 'GEMINI_API_KEY is not configured on the server.' });
  }

  let campaign = null;
  try {
    campaign = await Campaign.findById(campaignId);
    if (!campaign || !canAccessCampaign(campaign, req.user)) {
      return res.status(404).json({ message: 'Campaign not found or access denied.' });
    }

    const media = requestedMediaIds.length > 0
      ? await Media.find({
          _id: { $in: requestedMediaIds },
          campaignId: campaign._id,
          type: 'video',
          aiStatus: 'completed',
        })
        .select('_id name aiAnalysis tags thumbnailUrl url')
        .lean()
      : [];

    if (!useListingOnly && media.length === 0) {
      return res.status(400).json({
        message: 'Upload at least one showcase video and wait for its AI analysis to finish.',
      });
    }

    campaign.strategyStatus = 'generating';
    campaign.strategyError = '';
    await campaign.save();

    const mediaEvidence = media.map((item) => ({
      mediaId: String(item._id),
      fileName: item.name,
      summary: item.aiAnalysis?.summary || '',
      featuresShown: item.aiAnalysis?.appShowcase?.featuresShown || [],
      userFlow: item.aiAnalysis?.appShowcase?.userFlow || [],
      strongestMoments: item.aiAnalysis?.appShowcase?.strongestMoments || [],
      suggestedOverlays: item.aiAnalysis?.appShowcase?.suggestedOverlays || [],
      screenDetails: item.aiAnalysis?.appShowcase?.screenDetails || '',
      confidence: item.aiAnalysis?.appShowcase?.confidence || '',
    }));

    const prompt = `You are a senior performance creative strategist for TikTok, Reels, and Shorts.
Build edit-ready ads by connecting three things: a creator HOOK, a short on-screen OVERLAY, and an exact APP SHOWCASE moment.

Product:
${JSON.stringify({
  name: campaign.productName || campaign.name,
  description: campaign.productDescription || campaign.description,
  category: campaign.category,
  audience: campaign.targetAudience,
  keyBenefit: campaign.keyBenefit,
  coreFunction: campaign.coreFunction,
  useCases: campaign.useCases,
  positioning: campaign.positioningStatement,
})}

Analyzed showcase evidence:
${JSON.stringify(mediaEvidence)}

Rules:
- Produce 3 distinct concepts.
- Ground showcase directions in visible evidence. Never claim an unobserved feature.
- When showcase evidence exists, mediaId must exactly match one of: ${mediaEvidence.map((item) => item.mediaId).join(', ')}.
- When no video was supplied, use an empty mediaId and state what screen recording should be captured.
- Hook is the creator/reaction footage direction, not copy.
- Overlay is one punchy line, maximum 8 words.
- Showcase direction names the exact screen/action and usable moment.
- Prefer a 0-2s hook, overlay continuing to 3-4s, then the app proof.
- Explain why each pairing works for this exact audience.
- No generic advice such as "show the app".

Return valid JSON only:
{
  "showcaseLearning": {
    "summary": "What the available demos collectively prove",
    "featuresShown": ["Only visibly demonstrated features"],
    "strongestMoments": ["Best descriptive visual proof moments"],
    "audienceFit": "Who these demos will persuade and why",
    "coverageGaps": ["Important missing screen recordings to capture next"]
  },
  "creativeBlueprints": [
    {
      "title": "Short concept name",
      "hook": {
        "visual": "Creator footage to use",
        "direction": "Performance/edit direction",
        "duration": "0-2s"
      },
      "overlay": {
        "text": "Maximum eight words",
        "duration": "0-3s",
        "placement": "upper-third"
      },
      "showcase": {
        "mediaId": "Exact supplied media id or empty string",
        "feature": "Visible feature",
        "direction": "Exact screen action and edit instruction",
        "startTime": "00:03",
        "endTime": "00:09"
      },
      "cta": "Short product-specific CTA",
      "rationale": "Why this hook and proof belong together"
    }
  ]
}`;

    const modelsToTry = getGeminiModelCandidates({
      preferred: [process.env.GEMINI_TEXT_MODEL, process.env.GEMINI_MODEL],
    });
    const failures = [];
    let parsed = null;

    for (const modelName of modelsToTry) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0.45 },
            }),
          }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`);
        const responseText = payload.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!responseText) throw new Error('The strategy model returned an empty response.');
        parsed = JSON.parse(responseText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
        break;
      } catch (error) {
        failures.push({ model: modelName, error });
      }
    }

    if (!parsed) {
      throw new Error(`All model attempts failed. ${formatGeminiAttemptFailures(failures)}`);
    }

    const allowedMediaIds = new Set(mediaEvidence.map((item) => item.mediaId));
    const learning = parsed.showcaseLearning || {};
    const blueprints = (Array.isArray(parsed.creativeBlueprints) ? parsed.creativeBlueprints : [])
      .slice(0, 6)
      .map((item) => {
        const requestedMediaId = String(item?.showcase?.mediaId || '');
        return {
          title: String(item?.title || 'Campaign concept').trim(),
          hook: {
            visual: String(item?.hook?.visual || '').trim(),
            direction: String(item?.hook?.direction || '').trim(),
            duration: String(item?.hook?.duration || '0-2s').trim(),
          },
          overlay: {
            text: String(item?.overlay?.text || '').trim().split(/\s+/).slice(0, 8).join(' '),
            duration: String(item?.overlay?.duration || '0-3s').trim(),
            placement: String(item?.overlay?.placement || 'upper-third').trim(),
          },
          showcase: {
            mediaId: allowedMediaIds.has(requestedMediaId) ? requestedMediaId : null,
            feature: String(item?.showcase?.feature || '').trim(),
            direction: String(item?.showcase?.direction || '').trim(),
            startTime: String(item?.showcase?.startTime || '').trim(),
            endTime: String(item?.showcase?.endTime || '').trim(),
          },
          cta: String(item?.cta || '').trim(),
          rationale: String(item?.rationale || '').trim(),
        };
      })
      .filter((item) => item.overlay.text && item.showcase.direction);

    if (blueprints.length === 0) {
      throw new Error('The strategy model did not return usable creative blueprints.');
    }

    if (!useListingOnly) campaign.showcaseMediaIds = media.map((item) => item._id);
    campaign.showcaseLearning = {
      summary: String(learning.summary || '').trim(),
      featuresShown: cleanStringList(learning.featuresShown, 12),
      strongestMoments: cleanStringList(learning.strongestMoments, 10),
      audienceFit: String(learning.audienceFit || '').trim(),
      coverageGaps: cleanStringList(learning.coverageGaps, 8),
      generatedAt: new Date(),
    };
    campaign.creativeBlueprints = blueprints;
    campaign.marketingStrategies = blueprints.map((item) => (
      `[Hook + Overlay + Showcase] ${item.hook.duration} ${item.hook.visual} -> "${item.overlay.text}" -> ${item.showcase.direction} -> ${item.cta}`
    ));
    campaign.keyMessaging = blueprints.map((item) => item.overlay.text);
    campaign.strategyStatus = 'completed';
    campaign.strategyError = '';
    await campaign.save();

    return res.status(200).json({
      showcaseLearning: campaign.showcaseLearning,
      creativeBlueprints: campaign.creativeBlueprints,
      marketingStrategies: campaign.marketingStrategies,
      keyMessaging: campaign.keyMessaging,
      strategyStatus: campaign.strategyStatus,
    });
  } catch (error) {
    console.error('Error in /api/ai/generate-campaign-strategy:', error);
    if (campaign) {
      campaign.strategyStatus = 'failed';
      campaign.strategyError = error.message || 'Strategy generation failed.';
      await campaign.save().catch(() => {});
    }
    return res.status(500).json({ message: error.message || 'Failed to generate campaign strategy.' });
  }
});

// @desc    Generate overlay text options using Gemini API via native fetch
// @route   POST /api/ai/generate-text
// @access  Private
router.post('/generate-text', protect, async (req, res) => {
  const { vibe, exclude } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ message: 'GEMINI_API_KEY is not configured on the server.' });
  }

  try {
    const product = await getProductContext(req);
    const modelsToTry = getGeminiModelCandidates({
      preferred: [process.env.GEMINI_TEXT_MODEL, process.env.GEMINI_MODEL],
    });
    const modelFailures = [];
    let responseText = '';

    const prompt = `You are an elite short-form UGC video copywriter creating viral, rich narrative on-screen story hooks for TikTok, Instagram Reels, and YouTube Shorts.

Product / Campaign Context:
App / Product Name: ${product.name}
${product.category ? `Category: ${product.category}` : ''}
${product.targetAudience ? `Target Audience: ${product.targetAudience}` : ''}

Product Description:
${product.description}

Generate 20 distinct rich, paragraph-style on-screen story hooks (typically 2 to 3 natural sentences, 15 to 35 words) that immediately pull viewers into a compelling, relatable scenario tailored to THIS EXACT product and target audience.
${vibe ? `Tailor the suggestions to the specific topic/vibe: "${vibe}".` : ''}
${Array.isArray(exclude) && exclude.length > 0 ? `Avoid generating duplicate or highly similar phrases to these existing captions: ${JSON.stringify(exclude)}.` : ''}

STRICTLY BANNED PHRASES & CLICHES (NEVER USE):
- "Stop scrolling" / "You need this app" / "Everyone must try"
- "This app is a game changer" / "Download now" / "Check out this app"
- "Wait till the end" / "Watch till the end" / "This is your sign"
- Sterile corporate phrasing: "the easiest way to know", "optimize your workflow", "where we stand", "great tool for users"
- Detached third-person terminology ("users", "individuals", "what they're feeling"). Always speak from authentic 1st-person creator experience ("I", "my", "we", "our").

UNIVERSAL UGC STORY HOOK BLUEPRINTS (ADAPT TO THIS PRODUCT CATEGORY):
1. Relatable Everyday Frustration Solved:
   * "I used to spend hours dealing with this the hard way every single week until I found this one shortcut..."
   * "Instead of stressing over this every morning, I just set up this one feature and it completely fixed my routine..."
2. Secret Hack & "Gatekeeping" Intrigue:
   * "Why is nobody talking about this hidden trick? It literally replaced 3 different tools I used to use..."
   * "People genuinely thought I spent all weekend building this from scratch, but it took me 30 seconds on this app..."
3. Situational POV & Social Reaction:
   * "POV: You finally discover the one feature everyone in your space has secretly been using..."
   * "I decided to test this out for 24 hours without telling anyone, and the results completely shocked me..."
4. Contrarian & High-Stakes Transformation:
   * "Deleting 4 different apps after setting this up on my phone..."
   * "Stop doing this the painful manual way when this feature solves it in literally 10 seconds..."

Requirements:
- Output must be valid JSON only
- No markdown, no explanation, no quotation marks inside text
- Rich narrative length: 15 to 35 words per hook (2-3 punchy natural sentences)
- Authentic 1st-person creator voice tailored to ${product.category || 'this product'} and ${product.targetAudience || 'the target audience'}
- Ground every single hook directly in the real use cases and features described in the product details above

JSON format:
{
  "overlay_texts": [
    {
      "id": 1,
      "text": "I used to spend hours dealing with this the hard way until I found this one shortcut...",
      "category": "relatable"
    }
  ]
}`;

    for (const modelName of modelsToTry) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt,
                  }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: "application/json",
            }
          })
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          break; // successfully generated content, break loop
        }
      } catch (err) {
        console.error(`Gemini REST API failed for model ${modelName}:`, err);
        modelFailures.push({ model: modelName, error: err });
      }
    }

    if (!responseText) {
      throw new Error(`All model attempts failed. ${formatGeminiAttemptFailures(modelFailures)}`);
    }

    // Parse output JSON to ensure valid list of items
    const parsed = JSON.parse(responseText.trim());
    let suggestions = [];
    if (parsed && Array.isArray(parsed.overlay_texts)) {
      suggestions = parsed.overlay_texts.map(item => item.text || item);
    } else if (Array.isArray(parsed)) {
      suggestions = parsed.map(item => typeof item === 'object' ? item.text || item : item);
    } else {
      throw new Error('Response is not in the expected JSON format.');
    }

    return res.status(200).json({ suggestions });
  } catch (error) {
    console.error('Error in /api/ai/generate-text:', error);
    res.status(500).json({ message: `Failed to generate overlay text: ${error.message}` });
  }
});

// @desc    Generate campaign media caption using Gemini API
// @route   POST /api/ai/generate-caption
// @access  Private
router.post('/generate-caption', protect, async (req, res) => {
  const { videoName } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ message: 'GEMINI_API_KEY is not configured on the server.' });
  }

  try {
    const product = await getProductContext(req);
    const modelsToTry = getGeminiModelCandidates({
      preferred: [process.env.GEMINI_CAPTION_MODEL, process.env.GEMINI_MODEL],
    });
    const modelFailures = [];
    let responseText = '';

    const prompt = `You are a social media and product marketing copywriter. We need a short, relatable, viral social media caption for a video representing our product: "${product.name}".

App / Product Name: ${product.name}
${product.category ? `Category: ${product.category}` : ''}
${product.targetAudience ? `Target Audience: ${product.targetAudience}` : ''}
Product Description:
${product.description}

Video File Name/Context: "${videoName || 'video'}"

Generate a short, viral caption tailored to this product. The total output MUST be strictly less than 100 characters.
Requirements:
1. One short relatable hook line.
2. Followed by exactly five dots (each dot on a new line).
3. Followed by 3 to 4 relevant viral hashtags suited to the product.

Formatting style example:
she always be clutching me out tbh
.
.
.
.
.
#viral #relatable #trending #product

Output ONLY the final caption text. Do not include markdown codeblocks or explanations. Just output the raw caption.`;

    for (const modelName of modelsToTry) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt,
                  }
                ]
              }
            ],
          })
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        responseText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (responseText) {
          break;
        }
      } catch (err) {
        console.error(`Gemini failed for model ${modelName}:`, err);
        modelFailures.push({ model: modelName, error: err });
      }
    }

    if (!responseText) {
      throw new Error(`All model attempts failed. ${formatGeminiAttemptFailures(modelFailures)}`);
    }

    let captionText = responseText.trim();
    if (captionText.startsWith('```')) {
      captionText = captionText.replace(/^```[a-zA-Z]*\n/, '').replace(/\n```$/, '');
    }

    return res.status(200).json({ caption: captionText.trim() });
  } catch (error) {
    console.error('Error in /api/ai/generate-caption:', error);
    res.status(500).json({ message: `Failed to generate caption: ${error.message}` });
  }
});

// @desc    Get all saved captions for the logged-in user
// @route   GET /api/ai/saved-captions
// @access  Private
router.get('/saved-captions', protect, async (req, res) => {
  try {
    const saved = await SavedCaption.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.status(200).json(saved);
  } catch (error) {
    console.error('Error fetching saved captions:', error);
    res.status(500).json({ message: 'Failed to fetch saved captions.' });
  }
});

// @desc    Save a caption (bookmark it)
// @route   POST /api/ai/saved-captions
// @access  Private
router.post('/saved-captions', protect, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ message: 'Caption text is required.' });
  }

  try {
    // Prevent duplicate entries of the same text for this user
    let existing = await SavedCaption.findOne({ userId: req.user._id, text: text.trim() });
    if (existing) {
      return res.status(200).json(existing);
    }

    const saved = await SavedCaption.create({
      userId: req.user._id,
      text: text.trim(),
    });
    res.status(201).json(saved);
  } catch (error) {
    console.error('Error saving caption:', error);
    res.status(500).json({ message: 'Failed to save caption.' });
  }
});

// @desc    Delete a saved caption by ID
// @route   DELETE /api/ai/saved-captions/:id
// @access  Private
router.delete('/saved-captions/:id', protect, async (req, res) => {
  try {
    const deleted = await SavedCaption.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!deleted) {
      return res.status(404).json({ message: 'Saved caption not found.' });
    }
    res.status(200).json({ message: 'Saved caption deleted successfully.', id: req.params.id });
  } catch (error) {
    console.error('Error deleting saved caption:', error);
    res.status(500).json({ message: 'Failed to delete saved caption.' });
  }
});

export default router;
