import express from 'express';
import { protect } from '../middleware/auth.js';
import Campaign from '../models/Campaign.js';
import SavedCaption from '../models/SavedCaption.js';
import Campaign from '../models/Campaign.js';
import { analyzeProductUrl } from '../services/productAnalysisService.js';
import { formatGeminiAttemptFailures, getGeminiModelCandidates } from '../services/geminiModels.js';
import { analyzeProductUrl } from '../services/productAnalysisService.js';

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

    const prompt = `You are a mobile app and product marketing copywriter.

App / Product Name: ${product.name}
${product.category ? `Category: ${product.category}` : ''}
${product.targetAudience ? `Target Audience: ${product.targetAudience}` : ''}

Product Description:
${product.description}

Generate 20 short overlay texts for the first 3–4 seconds of a TikTok/Reels ad.
${vibe ? `Tailor the suggestions to the specific topic/vibe: "${vibe}".` : ''}
${Array.isArray(exclude) && exclude.length > 0 ? `Avoid generating duplicate or highly similar phrases to these existing captions: ${JSON.stringify(exclude)}.` : ''}

Requirements:
- Output must be valid JSON only
- No markdown
- No explanation
- Each overlay text must be maximum 8 words
- Emotional, relatable, curiosity-driven
- Natural social media tone
- Avoid sounding like a dry corporate ad
- Model the copywriting style, formatting, and tone like these examples:
  * "POV: You finally found an app made for this."
  * "Our routine was getting boring... until this."
  * "We downloaded this 'for fun'... and got addicted."
  * "This is what people do differently."
  * "Everyone should try this at least once."

JSON format:
{
  "overlay_texts": [
    {
      "id": 1,
      "text": "POV: You finally found an app made for this.",
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