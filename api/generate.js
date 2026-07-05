// generate.js - OpenAI backend with moderation, cache, rate limiting, and fallback
import admin from 'firebase-admin';
import crypto from 'crypto';

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

const cache = new Map();
const CACHE_TTL = 3600000; // 1 hour
const FREE_PRAYER_DAILY_LIMIT = 3;
const MODEL_NAME = 'gpt-5-nano';

const FALLBACK_PRAYERS = [
  'Om Shanti Shanti Shanti',
  'May peace prevail on earth',
  'Let there be light and wisdom',
  'Om Namah Shivaya',
  'Lokah Samastah Sukhino Bhavantu',
];

const PRAYER_SYSTEM_PROMPT =
  'Pandit composing one prayer paragraph: 1-2 Sanskrit mantras (transliterated, diacritics), 1-2 English blessing sentences for the request, end "Om Shanti Shanti Shantiḥ." One flowing paragraph, no headings/labels/commentary, under 350 chars.';

const PRAYER_USER_PROMPT = (name, userQuery) =>
  `Request from ${name}: "${userQuery}"

Format: [1-2 theme mantras]. [1-2 compassionate English sentences for their situation]. Om Shanti Shanti Shantiḥ.

"Om Hrīm Śrīm Klīm Parameshwari Durgaayai Namaḥ Om Santāna Gopāla Om Dhanvantaraye. May sister's delivery be smooth and safe, baby arrive healthy, and mother-child both thrive beautifully. Om Shanti Shanti Shantiḥ."

"Om Namo Bhagavate Vāsudevāya, Om Dum Durgāyai Namaḥ. Bless the devotee with meaningful companionship, genuine connections, and inner peace. May loneliness dissolve into belonging. Om Shanti Shanti Shantiḥ."

Output prayer text only.`;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 32);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

async function verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return null;
  }
  try {
    return await admin.auth().verifyIdToken(token);
  } catch {
    return null;
  }
}

async function isUserPro(uid) {
  const snap = await db
    .collection('users')
    .doc(uid)
    .collection('entitlements')
    .doc('status')
    .get();
  return snap.exists && snap.data().isPro === true;
}

async function checkAndIncrementPrayerUsage(userDocId, uidForProCheck) {
  if (uidForProCheck && (await isUserPro(uidForProCheck))) {
    return { ok: true, remaining: -1, isPro: true };
  }

  const today = todayKey();
  const ref = db.collection('users').doc(userDocId).collection('usage').doc('status');

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const prayerDate = data.prayerDate || '';
    let count = data.prayerCountToday || 0;

    if (prayerDate !== today) {
      count = 0;
    }

    if (count >= FREE_PRAYER_DAILY_LIMIT) {
      return { ok: false, remaining: 0, isPro: false };
    }

    tx.set(
      ref,
      {
        prayerCountToday: count + 1,
        prayerDate: today,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return {
      ok: true,
      remaining: FREE_PRAYER_DAILY_LIMIT - (count + 1),
      isPro: false,
    };
  });
}

async function callOpenAI(name, userQuery) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENAI_API_KEY environment variable');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_NAME,
        messages: [
          { role: 'system', content: PRAYER_SYSTEM_PROMPT },
          { role: 'user', content: PRAYER_USER_PROMPT(name, userQuery) },
        ],
        // gpt-5-nano is a reasoning model: low token budgets produce empty content.
        reasoning_effort: 'low',
        max_completion_tokens: 2048,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error: ${response.status} ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) {
      throw new Error('OpenAI returned empty content');
    }
    return content;
  } finally {
    clearTimeout(timeoutId);
  }
}

function randomFallback() {
  return FALLBACK_PRAYERS[Math.floor(Math.random() * FALLBACK_PRAYERS.length)];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { user_query, name, email } = req.body || {};
    const sanitizedName = (name || 'Friend').toString().trim().slice(0, 64) || 'Friend';

    if (!user_query || typeof user_query !== 'string') {
      return res.status(400).json({ error: 'user_query is required and must be a string' });
    }

    const trimmedQuery = user_query.trim();
    if (trimmedQuery.length < 3) {
      return res.status(400).json({ error: 'user_query too short' });
    }
    if (trimmedQuery.length > 200) {
      return res.status(400).json({ error: 'user_query too long' });
    }

    const authUser = await verifyAuth(req);
    const rateLimitDocId = authUser?.uid || `ip_${hashIp(getClientIp(req))}`;

    const cacheKey = trimmedQuery.toLowerCase();
    const cachedEntry = cache.get(cacheKey);
    if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_TTL) {
      return res.status(200).json({
        generated_prayer: cachedEntry.generated_prayer,
        source: 'cache',
      });
    }

    const query = trimmedQuery.toLowerCase();
    const harmfulPatterns = [
      /\b(bomb|explosive|weapon|kill|murder|suicide)\b/i,
      /\b(hack|crack|steal|fraud|scam)\b/i,
      /\b(drug|cocaine|heroin|meth)\b/i,
    ];
    const isBlocked = harmfulPatterns.some((pattern) => pattern.test(query));

    let openaiBlocked = false;
    if (process.env.OPENAI_API_KEY) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const openaiResult = await fetch('https://api.openai.com/v1/moderations', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input: trimmedQuery }),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const openaiData = await openaiResult.json();
        openaiBlocked = openaiData.results?.[0]?.flagged || false;
      } catch (moderationError) {
        console.error('OpenAI moderation failed:', moderationError.message);
      }
    }

    if (isBlocked || openaiBlocked) {
      const blockMessage =
        "I can't assist with that request. Let me offer you a peaceful thought instead: " +
        randomFallback();

      try {
        await db.collection('requests').add({
          name: sanitizedName || null,
          email: email || null,
          user_query: trimmedQuery,
          response: blockMessage,
          generated_prayer: null,
          moderated: false,
          status: 'pending',
          movedToPublic: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          source: 'blocked',
          uid: authUser?.uid || null,
        });
      } catch (logError) {
        console.error('Firestore logging error:', logError);
      }

      return res.status(200).json({
        response: blockMessage,
        source: 'blocked',
      });
    }

    const usage = await checkAndIncrementPrayerUsage(rateLimitDocId, authUser?.uid || null);
    if (!usage.ok) {
      return res.status(429).json({
        error: 'prayer_limit_reached',
        message:
          'You have reached your free daily prayer limit. Upgrade to Pro for unlimited prayers.',
        remaining: 0,
      });
    }

    const generatedText = await callOpenAI(sanitizedName, trimmedQuery);

    cache.set(cacheKey, {
      generated_prayer: generatedText,
      timestamp: Date.now(),
    });

    try {
      await db.collection('requests').add({
        name: sanitizedName || null,
        email: email || null,
        user_query: trimmedQuery,
        generated_prayer: generatedText,
        moderated: true,
        status: 'pending',
        movedToPublic: false,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        source: 'openai',
        uid: authUser?.uid || null,
        remaining_prayers: usage.remaining,
      });
    } catch (logError) {
      console.error('Firestore logging error:', logError);
    }

    return res.status(200).json({
      generated_prayer: generatedText,
      source: 'openai',
      remaining_prayers: usage.remaining,
    });
  } catch (error) {
    const errorDetail = {
      message: error.message,
      stack: error.stack,
      name: error.name,
    };
    console.error('API Error Details:', JSON.stringify(errorDetail, null, 2));

    const fallbackResponse = randomFallback();

    try {
      await db.collection('requests').add({
        name: req.body?.name || null,
        email: req.body?.email || null,
        user_query: req.body?.user_query || 'unknown',
        generated_prayer: fallbackResponse,
        moderated: true,
        status: 'pending',
        movedToPublic: false,
        error: JSON.stringify(errorDetail),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        source: 'fallback',
      });
    } catch (logError) {
      console.error('Firestore logging error:', logError);
    }

    return res.status(200).json({
      generated_prayer: fallbackResponse,
      source: 'fallback',
      note: 'Service temporarily limited, showing peaceful message',
    });
  }
}
