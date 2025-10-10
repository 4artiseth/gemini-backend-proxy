// generate.js - Safe free-tier backend with moderation, cache, and fallback

// In-memory cache
const cache = new Map();
const CACHE_TTL = 3600000; // 1 hour

// Fallback prayers for rate limits
const FALLBACK_PRAYERS = [
  "Om Shanti Shanti Shanti",
  "May peace prevail on earth",
  "Let there be light and wisdom",
  "Om Namah Shivaya",
  "Lokah Samastah Sukhino Bhavantu"
];

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required and must be a string' });
    }

    // Check cache first
    const cacheKey = prompt.toLowerCase().trim();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return res.status(200).json({ text: cached.response, cached: true });
    }

    // OpenAI moderation check
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }

    const moderationResponse = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({ input: prompt })
    });

    if (!moderationResponse.ok) {
      console.error('Moderation API error:', await moderationResponse.text());
      return res.status(500).json({ error: 'Moderation check failed' });
    }

    const moderation = await moderationResponse.json();
    if (moderation.results?.[0]?.flagged) {
      return res.status(400).json({ error: 'Content policy violation detected' });
    }

    // Call Gemini API
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }

    const model = 'gemini-2.0-flash-exp';
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024
          }
        })
      }
    );

    if (!geminiResponse.ok) {
      const errorData = await geminiResponse.text();
      console.error('Gemini API error:', errorData);
      
      // Fallback to random prayer on rate limit or error
      if (geminiResponse.status === 429 || geminiResponse.status >= 500) {
        const fallback = FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
        return res.status(200).json({ text: fallback, fallback: true });
      }
      
      return res.status(geminiResponse.status).json({ 
        error: 'Gemini API error', 
        details: errorData 
      });
    }

    const data = await geminiResponse.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated';

    // Cache the response
    cache.set(cacheKey, {
      response: responseText,
      timestamp: Date.now()
    });

    // Clean old cache entries
    if (cache.size > 100) {
      const entries = Array.from(cache.entries());
      const now = Date.now();
      entries.forEach(([key, value]) => {
        if (now - value.timestamp > CACHE_TTL) {
          cache.delete(key);
        }
      });
    }

    return res.status(200).json({ text: responseText });

  } catch (error) {
    console.error('Backend error:', error);
    return res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
}
