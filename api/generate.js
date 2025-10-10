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
// Fixed model name constant - gemini-2.5-flash-lite only
const MODEL_NAME = 'gemini-2.5-flash-lite';
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
    
    // Check cache FIRST - cache hits don't create new Firestore documents
    const cacheKey = user_query.toLowerCase().trim();
    const cachedEntry = cache.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp < CACHE_TTL)) {
      return res.status(200).json({
        response: cachedEntry.response,
        source: 'cache'
      });
    }
    
    // Local pattern-based moderation
    const query = user_query.toLowerCase();
    const harmfulPatterns = [
      /\b(bomb|explosive|weapon|kill|murder|suicide)\b/i,
      /\b(hack|crack|steal|fraud|scam)\b/i,
      /\b(drug|cocaine|heroin|meth)\b/i
    ];
    const isBlocked = harmfulPatterns.some(pattern => pattern.test(query));
    
    // OpenAI moderation with timeout
    let openaiBlocked = false;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const openaiResult = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ input: user_query }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const openaiData = await openaiResult.json();
      openaiBlocked = openaiData.results?.[0]?.flagged || false;
    } catch (moderationError) {
      console.error('OpenAI moderation failed:', moderationError.message);
    }
    
    // If blocked by either check, log with moderated: false and return peaceful fallback
    if (isBlocked || openaiBlocked) {
      const blockMessage = "I can't assist with that request. Let me offer you a peaceful thought instead: " +
        FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
      
      // LOG BLOCKED QUERY: moderated FALSE, generated_prayer NULL
      try {
        await db.collection('requests').add({
          user_query: user_query,
          response: blockMessage,
          generated_prayer: null,
          moderated: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          source: 'blocked'
        });
      } catch (logError) {
        console.error('Firestore logging error:', logError);
      }
      
      return res.status(200).json({
        response: blockMessage,
        source: 'blocked'
      });
    }
    
    // Query passed moderation - proceed with Gemini API
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: `Generate a short, spiritual prayer or blessing based on this request: "${user_query}". Include Hindu mantras where appropriate. Keep it under 50 words.`
          }]
        }]
      })
    });
    
    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status}`);
    }
    
    const data = await response.json();
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ||
      FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
    
    // Cache successful response
    cache.set(cacheKey, {
      response: generatedText,
      timestamp: Date.now()
    });
    
    // LOG SUCCESSFUL PRAYER: moderated TRUE, generated_prayer has the prayer text
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
    
    // Fallback response for errors: moderated TRUE with fallback prayer
    const fallbackResponse = FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
    
    // LOG ERROR FALLBACK: moderated TRUE, generated_prayer has fallback prayer
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
