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
    const { user_query } = req.body;
    
    if (!user_query || typeof user_query !== 'string') {
      return res.status(400).json({ error: 'user_query is required and must be a string' });
    }
    
    // Check cache first
    const cacheKey = user_query.toLowerCase().trim();
    const cached = cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return res.status(200).json({
        response: cached.response,
        source: 'cache',
        cached_at: new Date(cached.timestamp).toISOString()
      });
    }
    
    // Simple content moderation - block obvious harmful content
    const harmfulPatterns = [
      /\b(bomb|explosive|weapon|kill|murder|suicide)\b/i,
      /\b(hack|crack|steal|fraud|scam)\b/i,
      /\b(drug|cocaine|heroin|meth)\b/i
    ];
    
    const isHarmful = harmfulPatterns.some(pattern => pattern.test(user_query));
    
    if (isHarmful) {
      const moderationResponse = "I can't assist with that request. Let me offer you a peaceful thought instead: " + 
        FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
      
      // Log moderation (blocked) to Firestore: moderated false, generated_prayer null
      try {
        await db.collection('requests').add({
          user_query: user_query,
          response: moderationResponse,
          generated_prayer: null,
          moderated: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          source: 'moderation'
        });
      } catch (logError) {
        console.error('Firestore logging error:', logError);
      }
      
      return res.status(200).json({
        response: moderationResponse,
        source: 'moderation'
      });
    }
    
    // Minimal, robust prompt for dumb models
    const prompt = `Generate a short Sanskrit prayer only. Format: Om [mantra]। Om [mantra]। [English blessing]. Om Shanti Shanti Shantiḥ. Rules: 2 Sanskrit mantras, diacritics ok, dots (।) after each, 1-2 sentence English blessing, end with "Om Shanti Shanti Shantiḥ.", UNDER 250 characters, NO explanations, NO extra text, ONLY prayer. Examples: Om Aiṃ Sarasvatyai Namaḥ। Om Gaṇ Gaṇapataye Namaḥ। May your mind be sharp and your efforts rewarded. Om Shanti Shanti Shantiḥ. Om Durgāyai Namaḥ। Om Hanumate Namaḥ। May you find strength and courage to face any challenge. Om Shanti Shanti Shantiḥ. User Request: "${user_query}"`;
    
    // Call Gemini API with gemini-2.5-flash-lite
    const geminiResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + process.env.GEMINI_API_KEY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      })
    });
    
    if (!geminiResponse.ok) {
      const errorBody = await geminiResponse.text();
      const errorDetail = `Gemini API error: ${geminiResponse.status} ${geminiResponse.statusText} - ${errorBody}`;
      console.error('Gemini API Error Details:', errorDetail);
      throw new Error(errorDetail);
    }
    
    const geminiData = await geminiResponse.json();
    const generatedText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!generatedText) {
      const errorDetail = 'No response from Gemini - ' + JSON.stringify(geminiData);
      console.error('Gemini Response Error:', errorDetail);
      throw new Error(errorDetail);
    }
    
    // Cache the response
    cache.set(cacheKey, {
      response: generatedText,
      timestamp: Date.now()
    });
    
    // Log successful generation to Firestore: approved/generated prayer -> moderated true
    try {
      await db.collection('requests').add({
        user_query: user_query,
        response: generatedText,
        generated_prayer: generatedText,
        moderated: true,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        source: 'gemini'
      });
    } catch (logError) {
      console.error('Firestore logging error:', logError);
    }
    
    return res.status(200).json({
      response: generatedText,
      source: 'gemini'
    });
    
  } catch (error) {
    // Enhanced error logging for troubleshooting
    const errorDetail = {
      message: error.message,
      stack: error.stack,
      name: error.name
    };
    console.error('API Error Details:', JSON.stringify(errorDetail, null, 2));
    
    // Fallback response (errors/rate-limits): still moderated true
    const fallbackResponse = FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
    
    // Log error fallback to Firestore: moderated true, generated_prayer present as fallback, with full error details
    try {
      await db.collection('requests').add({
        user_query: req.body?.user_query || 'unknown',
        response: fallbackResponse,
        generated_prayer: fallbackResponse,
        moderated: true,
        error: JSON.stringify(errorDetail),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        source: 'fallback'
      });
    } catch (logError) {
      console.error('Firestore logging error:', logError);
    }
    
    return res.status(200).json({
      response: fallbackResponse,
      source: 'fallback',
      note: 'Service temporarily limited, showing peaceful message'
    });
  }
}
