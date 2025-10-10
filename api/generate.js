// generate.js - Safe free-tier backend with moderation, cache, and fallback
import admin from 'firebase-admin';

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

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
    const { user_query, tone } = req.body;
    
    if (!user_query || typeof user_query !== 'string') {
      return res.status(400).json({ error: 'user_query is required and must be a string' });
    }
    
    // Check cache first
    const cacheKey = user_query.toLowerCase().trim();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return res.status(200).json({ 
        safe: true, 
        fallback: false, 
        generatedPrayer: cached.response 
      });
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
      body: JSON.stringify({ input: user_query })
    });
    
    if (!moderationResponse.ok) {
      console.error('Moderation API error:', await moderationResponse.text());
      return res.status(500).json({ error: 'Moderation check failed' });
    }
    
    const moderation = await moderationResponse.json();
    const isFlagged = moderation.results?.[0]?.flagged || false;
    
    // Write to Firestore after moderation
    let generatedPrayer = null;
    let isFallback = false;
    
    if (isFlagged) {
      // Log flagged request to Firestore
      await db.collection('requests').add({
        user_query,
        moderated: false,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        generatedPrayer: null,
        fallback: false,
        tone: tone || null
      });
      
      return res.status(400).json({ 
        safe: false, 
        error: 'Content policy violation detected' 
      });
    }
    
    // Call Gemini API
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Gemini API key not configured' });
    }
    
    const model = 'gemini-2.0-flash-exp';
    
    // Build prompt with tone if provided
    const promptText = tone 
      ? `Generate a prayer with ${tone} tone: ${user_query}` 
      : `Generate a prayer: ${user_query}`;
    
    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
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
        const fallbackPrayer = FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
        generatedPrayer = fallbackPrayer;
        isFallback = true;
        
        // Log fallback request to Firestore
        await db.collection('requests').add({
          user_query,
          moderated: true,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          generatedPrayer,
          fallback: true,
          tone: tone || null
        });
        
        return res.status(200).json({ 
          safe: true, 
          fallback: true, 
          generatedPrayer: fallbackPrayer 
        });
      }
      
      return res.status(geminiResponse.status).json({ 
        error: 'Gemini API error', 
        details: errorData 
      });
    }
    
    const data = await geminiResponse.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response generated';
    generatedPrayer = responseText;
    
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
    
    // Log successful request to Firestore
    await db.collection('requests').add({
      user_query,
      moderated: true,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      generatedPrayer,
      fallback: false,
      tone: tone || null
    });
    
    return res.status(200).json({ 
      safe: true, 
      fallback: false, 
      generatedPrayer: responseText 
    });
  } catch (error) {
    console.error('Backend error:', error);
    return res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
}
