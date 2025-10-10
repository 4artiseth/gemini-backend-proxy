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
    const cached = cache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return res.status(200).json({
        response: cached.response,
        source: 'cache',
        cached_at: new Date(cached.timestamp).toISOString()
      });
    }
    
    // ========================================
    // MODERATION CHECKS - Block harmful content early
    // ========================================
    
    let isBlocked = false;
    let blockSource = '';
    
    // Check 1: OpenAI Moderation API
    try {
      const moderationResponse = await fetch('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          input: user_query
        })
      });
      
      if (moderationResponse.ok) {
        const moderationData = await moderationResponse.json();
        const isFlagged = moderationData.results?.[0]?.flagged;
        
        if (isFlagged) {
          isBlocked = true;
          blockSource = 'openai_moderation';
        }
      }
    } catch (openaiError) {
      console.error('OpenAI Moderation API Error:', openaiError.message);
      // Continue to pattern matching if OpenAI fails
    }
    
    // Check 2: Pattern-based moderation (only if OpenAI didn't block)
    if (!isBlocked) {
      const harmfulPatterns = [
        /\b(bomb|explosive|weapon|kill|murder|suicide)\b/i,
        /\b(hack|crack|steal|fraud|scam)\b/i,
        /\b(drug|cocaine|heroin|meth)\b/i
      ];
      
      const isHarmful = harmfulPatterns.some(pattern => pattern.test(user_query));
      
      if (isHarmful) {
        isBlocked = true;
        blockSource = 'pattern_moderation';
      }
    }
    
    // If moderated/blocked: return early with ONE Firestore document (moderated: false)
    if (isBlocked) {
      const blockMessage = "I can't assist with that request. Let me offer you a peaceful thought instead: " + 
        FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
      
      // SINGLE LOG POINT FOR BLOCKED REQUESTS: moderated FALSE, generated_prayer NULL
      try {
        await db.collection('requests').add({
          user_query: user_query,
          response: blockMessage,
          generated_prayer: null,
          moderated: false,
          block_source: blockSource,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          source: blockSource
        });
      } catch (logError) {
        console.error('Firestore logging error:', logError);
      }
      
      // Return early - DO NOT call Gemini API for blocked requests
      return res.status(200).json({
        response: blockMessage,
        source: blockSource
      });
    }
    
    // ========================================
    // Moderation passed - Call Gemini API
    // ========================================
    
    const prompt = `Generate a short Sanskrit prayer only. Format: Om [mantra]। Om [mantra]। [English blessing]. Om Shanti Shanti Shantiḥ. Rules: 2 Sanskrit mantras, diacritics ok, dots (।) after each, 1-2 sentence English blessing, end with "Om Shanti Shanti Shantiḥ.", UNDER 350 characters, NO explanations, NO extra text, ONLY prayer. Examples: Om Aiṃ Sarasvatyai Namaḥ। Om Gaṇ Gaṇapataye Namaḥ। May your mind be sharp and your efforts rewarded. Om Shanti Shanti Shantiḥ. Om Durgāyai Namaḥ। Om Hanumate Namaḥ। May you find strength and courage to face any challenge. Om Shanti Shanti Shantiḥ. User Request: "${user_query}"`;
    
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
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
    
    // SINGLE LOG POINT FOR SUCCESSFUL GENERATION: moderated TRUE, generated_prayer present
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
    
    // Fallback response (errors/rate-limits): moderated TRUE
    const fallbackResponse = FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
    
    // SINGLE LOG POINT FOR ERROR FALLBACK: moderated TRUE (query passed moderation but Gemini failed)
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
