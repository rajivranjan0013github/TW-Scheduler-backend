import express from 'express';
import { protect } from '../middleware/auth.js';
import SavedCaption from '../models/SavedCaption.js';

const router = express.Router();

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
    const modelsToTry = ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-1.5-flash'];
    let errorMsg = '';
    let responseText = '';

    const prompt = `You are a mobile app marketing copywriter.

App Name: Penguin

Penguin is a couples app where partners can answer 3000+ questions, play games, complete rituals, update moods, send doodles, see relationship countdowns, track distance, and use lock screen/home screen widgets.

Generate 20 short overlay texts for the first 3–4 seconds of a TikTok/Reels ad.
${vibe ? `Tailor the suggestions to the specific topic/vibe: "${vibe}".` : ''}
${Array.isArray(exclude) && exclude.length > 0 ? `Avoid generating duplicate or highly similar phrases to these existing captions: ${JSON.stringify(exclude)}.` : ''}

Requirements:
- Output must be valid JSON only
- No markdown
- No explanation
- Each overlay text must be maximum 8 words
- Emotional, relatable, curiosity-driven
- Natural Gen Z couple tone
- Avoid sounding like an ad
- Model the copywriting style, formatting, and tone EXACTLY like these examples:
  * "POV: You finally found an app made for couples."
  * "Date nights were getting boring... until this."
  * "We downloaded this app 'for fun'... and got addicted."
  * "This is what healthy couples do differently."
  * "Every couple should try this at least once."

JSON format:
{
  "overlay_texts": [
    {
      "id": 1,
      "text": "POV: You finally found an app made for couples.",
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
        errorMsg = err.message || 'Generation failed';
      }
    }

    if (!responseText) {
      throw new Error(`All model attempts failed. Last error: ${errorMsg}`);
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
    const modelsToTry = ['gemini-2.5-flash', 'gemini-1.5-flash'];
    let errorMsg = '';
    let responseText = '';

    const prompt = `You are a mobile app marketing copywriter. We need a short, relatable, Gen Z couple/relationship caption for a video representing our couples app: "Penguin".

App Name: Penguin
Penguin is a couples app where partners can answer 3000+ questions, play games, complete rituals, update moods, send doodles, see relationship countdowns, track distance, and use lock screen/home screen widgets.

Video File Name/Context: "${videoName || 'couple video'}"

Generate a short, viral, Gen Z couple caption.
Requirements:
1. One short relatable line (e.g. "she always be clutching me out tbh", "i'm actually addicted to this", "my bf downloads the weirdest apps").
2. Followed by exactly five dots (each dot on a new line).
3. Followed by exactly 10 relevant hashtags starting with relationship/couple topics like #couple #ldr #relationship #longdistance #bfgf #longdistancerelationships #game #widget #relationshipadvice and 1 related to the video context.

Formatting style example:
she always be clutching me out tbh
.
.
.
.
.
#couple #ldr #relationship #longdistance #bfgf #longdistancerelationships #game #widget #relationshipadvice #clutch

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
        errorMsg = err.message || 'Generation failed';
      }
    }

    if (!responseText) {
      throw new Error(`All model attempts failed. Last error: ${errorMsg}`);
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
