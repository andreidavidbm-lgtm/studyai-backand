# StudyAI România — Ghid de pornire

## Pasul 1 — Completează cheile
Redenumește .env.example în .env și completează cu cheile tale (Anthropic + Stripe).

## Pasul 2 — Găzduire pe Railway
1. Cont pe railway.app (Login with GitHub)
2. New Project → Deploy from GitHub repo → studyai-backend
3. Tab Variables → adaugi ANTHROPIC_API_KEY și cheile Stripe
4. Settings → Networking → Generate Domain → primești URL-ul serverului

## Testare
Deschide URL-ul + /api/health — trebuie să apară aiConfigurat: true
