/**
 * StudyAI România — Backend securizat
 * ------------------------------------
 * Acest server este singurul loc unde stau cheile secrete (Anthropic, Stripe).
 * Aplicația (frontend-ul) NU vede niciodată aceste chei — trimite doar cereri
 * către acest server, iar serverul vorbește cu Anthropic / Stripe.
 *
 * Ce trebuie să faci TU înainte să pornească:
 *  1. Copiază fișierul .env.example în .env
 *  2. Completează ANTHROPIC_API_KEY și cheile STRIPE_* (vezi ghidul din README.md)
 *  3. npm install
 *  4. npm start   (local, pentru testare)
 *  5. Urcă acest folder pe un serviciu de hosting (Railway, Render sau Supabase Edge Functions)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Config din variabile de mediu (NICIODATĂ scrise direct în cod)
// ---------------------------------------------------------------------------
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_ID_MONTHLY || '';
const STRIPE_PRICE_YEARLY = process.env.STRIPE_PRICE_ID_YEARLY || '';
const FRONTEND_URL = process.env.FRONTEND_URL || '*';

// Limite implicite pentru contul FREE — poți schimba doar aceste numere,
// fără să atingi restul codului (cum cerea specificația inițială).
const LIMITE_FREE = {
  intrebariAiPeZi: Number(process.env.LIMIT_FREE_INTREBARI_ZI || 15),
  imaginiPeZi: Number(process.env.LIMIT_FREE_IMAGINI_ZI || 5),
  quizPeZi: Number(process.env.LIMIT_FREE_QUIZ_ZI || 3)
};
const LIMITE_PREMIUM = {
  intrebariAiPeZi: Number(process.env.LIMIT_PREMIUM_INTREBARI_ZI || 300),
  imaginiPeZi: Number(process.env.LIMIT_PREMIUM_IMAGINI_ZI || 100),
  quizPeZi: Number(process.env.LIMIT_PREMIUM_QUIZ_ZI || 100)
};

const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// ---------------------------------------------------------------------------
// Middleware de bază
// ---------------------------------------------------------------------------
app.use(cors({ origin: FRONTEND_URL }));

// IMPORTANT: ruta de webhook Stripe are nevoie de body-ul brut (raw), deci
// o definim ÎNAINTE de express.json() global.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

app.use(express.json({ limit: '8mb' })); // 8mb ca să încapă și o poză codificată base64

// Protecție anti-spam: limitează câte cereri poate face o singură adresă IP
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minut
  max: 12,             // max 12 cereri pe minut per IP către AI
  message: { error: 'Prea multe cereri. Așteaptă puțin și încearcă din nou.' }
});
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use(generalLimiter);

// "Bază de date" simplă în memorie DOAR pentru demo/test local.
// Într-o aplicație reală, înlocuiește asta cu Supabase/Postgres (vezi README).
const usageStore = new Map(); // cheie: userId+data -> { intrebari, imagini }

function getTodayKey(userId) {
  const today = new Date().toISOString().slice(0, 10);
  return `${userId}_${today}`;
}

function checkAndIncrementLimit(userId, isPremium, field) {
  const key = getTodayKey(userId);
  const limite = isPremium ? LIMITE_PREMIUM : LIMITE_FREE;
  const current = usageStore.get(key) || { intrebariAiPeZi: 0, imaginiPeZi: 0, quizPeZi: 0 };
  if (current[field] >= limite[field]) {
    return { allowed: false, limite };
  }
  current[field] += 1;
  usageStore.set(key, current);
  return { allowed: true, ramase: limite[field] - current[field] };
}

// ---------------------------------------------------------------------------
// RUTA 1: AI Tutor — chat text + imagine
// ---------------------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

app.post('/api/chat', chatLimiter, upload.array('images', 3), async (req, res) => {
  try {
    const userId = req.body.userId || req.headers['x-user-id'];
    const isPremium = req.body.isPremium === 'true';
    const message = (req.body.message || '').slice(0, 4000); // validăm lungimea
    const subject = req.body.subject || 'Altă materie';
    const actionType = req.body.actionType || 'intrebare'; // rezolva/explica/verifica/similar/simplu

    if (!userId) {
      return res.status(400).json({ error: 'Lipsește identificatorul utilizatorului.' });
    }
    if (!message && (!req.files || req.files.length === 0)) {
      return res.status(400).json({ error: 'Scrie o întrebare sau atașează o poză.' });
    }

    // Verificăm limitele FREE / Premium
    const check = checkAndIncrementLimit(userId, isPremium, 'intrebariAiPeZi');
    if (!check.allowed) {
      return res.status(429).json({
        error: 'DEMO/LIMITA',
        message: 'Ai atins limita zilnică de întrebări AI. Urmărește o reclamă pentru una suplimentară sau treci la Premium.'
      });
    }
    if (req.files && req.files.length > 0) {
      const imgCheck = checkAndIncrementLimit(userId, isPremium, 'imaginiPeZi');
      if (!imgCheck.allowed) {
        return res.status(429).json({
          error: 'DEMO/LIMITA',
          message: 'Ai atins limita zilnică de imagini analizate.'
        });
      }
    }

    // Dacă nu există cheie API configurată, răspundem în mod DEMO (nu crăpăm aplicația)
    if (!anthropic) {
      return res.json({
        mode: 'demo',
        reply: 'Modul DEMO este activ (nu există încă o cheie API configurată pe server). Adaugă ANTHROPIC_API_KEY în .env ca să primești răspunsuri reale.'
      });
    }

    const promptByAction = {
      rezolva: 'Rezolvă exercițiul pas cu pas, fără să sari direct la răspunsul final.',
      explica: 'Explică conceptul cerut pas cu pas, cu un exemplu simplu.',
      verifica: 'Verifică dacă raționamentul/răspunsul elevului este corect și explică unde a greșit, dacă e cazul.',
      similar: 'Generează un exercițiu similar, de aceeași dificultate, ca elevul să exerseze.',
      simplu: 'Reexplică ultimul răspuns într-un mod mult mai simplu, ca pentru un elev de gimnaziu.',
      intrebare: 'Răspunde la întrebarea elevului, explicând pas cu pas raționamentul.'
    };

    const systemPrompt = `Ești un tutore AI prietenos pentru elevi din România, specializat în materia "${subject}".
Răspunzi întotdeauna în limba română, clar și pas cu pas — nu oferi doar răspunsul final la exerciții.
Adaptează explicația la nivelul unui elev de liceu/gimnaziu. Fii încurajator, dar corect din punct de vedere științific.`;

    const contentParts = [];
    if (message) contentParts.push({ type: 'text', text: `${promptByAction[actionType] || ''}\n\nÎntrebarea elevului: ${message}` });
    if (req.files) {
      for (const file of req.files) {
        contentParts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: file.mimetype,
            data: file.buffer.toString('base64')
          }
        });
      }
    }

    // Timeout de siguranță — dacă AI-ul nu răspunde în 25s, oprim cererea
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: contentParts }]
    }, { signal: controller.signal });

    clearTimeout(timeout);

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    res.json({ mode: 'live', reply: text, ramaseAstazi: check.ramase });

  } catch (err) {
    console.error('Eroare /api/chat:', err.message);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI-ul a răspuns prea încet. Încearcă din nou.' });
    }
    res.status(500).json({ error: 'A apărut o eroare la procesarea cererii. Încearcă din nou în câteva momente.' });
  }
});

// ---------------------------------------------------------------------------
// RUTA 2: Stripe — pornește un abonament (checkout)
// ---------------------------------------------------------------------------
app.post('/api/stripe/create-checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Plățile nu sunt încă configurate pe server (lipsesc cheile Stripe în .env).' });
    }
    const { plan, userId, userEmail } = req.body; // plan: 'monthly' | 'yearly'
    if (!userId || !plan) return res.status(400).json({ error: 'Date lipsă.' });

    const priceId = plan === 'yearly' ? STRIPE_PRICE_YEARLY : STRIPE_PRICE_MONTHLY;
    if (!priceId) return res.status(500).json({ error: 'Prețul pentru acest plan nu este configurat.' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: userEmail,
      client_reference_id: userId,
      success_url: `${FRONTEND_URL}?plata=succes`,
      cancel_url: `${FRONTEND_URL}?plata=anulata`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Eroare /api/stripe/create-checkout:', err.message);
    res.status(500).json({ error: 'Nu am putut porni plata. Încearcă din nou.' });
  }
});

// ---------------------------------------------------------------------------
// RUTA 3: Stripe — webhook (Stripe ne anunță când plata reușește/se anulează)
// ---------------------------------------------------------------------------
async function stripeWebhookHandler(req, res) {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe neconfigurat.');
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Semnătură webhook invalidă:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.client_reference_id;
      // TODO: aici marchezi userId ca Premium în baza ta de date reală (Supabase/Postgres)
      console.log(`✅ Utilizatorul ${userId} a devenit Premium.`);
      break;
    }
    case 'customer.subscription.deleted': {
      // TODO: marchezi userId ca FREE din nou în baza de date
      console.log('ℹ️ Un abonament a expirat/a fost anulat — utilizatorul revine la FREE.');
      break;
    }
    default:
      break;
  }
  res.json({ received: true });
}

// ---------------------------------------------------------------------------
// Health check — util pentru serviciul de hosting (ex. Railway) ca să știe
// dacă serverul e "viu"
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    aiConfigurat: !!anthropic,
    platiConfigurate: !!stripe
  });
});

app.listen(PORT, () => {
  console.log(`StudyAI backend pornit pe portul ${PORT}`);
  console.log(`AI real: ${anthropic ? 'DA' : 'NU (mod demo)'} | Plăți: ${stripe ? 'DA' : 'NU'}`);
});
