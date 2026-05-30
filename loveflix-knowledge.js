// ── LoveFlix Knowledge Base ───────────────────────────────────────────────────
// Single source of truth injected into both the landing and concierge system
// prompts so every AI mode has accurate product context.
// Update this file when features, pricing, or status change.

export const LOVEFLIX_KNOWLEDGE = `
WHAT IS LOVEFLIX:
- LoveFlix (loveflix.us) is a private Netflix-style streaming platform built exclusively for couples.
- Couples upload their own personal videos, photos, voice notes, and memories.
- It is NOT a movie streaming service — there is no public content library.
- Think of it as your relationship's own private Netflix, filled only with your story.
- Designed as a gift, anniversary present, or ongoing relationship keepsake.

FEATURES:
- "Who's Watching?" profile selector for each partner.
- Continue Watching row that tracks where you left off.
- Custom cinematic video player with Skip Intro button.
- PIN-protected accounts for privacy.
- Love Connect — syncs both partners' locations and schedules.
- Love Music — shared music listening history between partners.
- Mobile friendly, works on any device.
- All content is 100% private, only accessible by the couple.
- No ads, no public sharing, no third-party access.

PRICING TIERS:
- Basic (Crush): $6/month — upload and stream memories, basic player.
- Standard (Sweetheart): $12/month — full Netflix-style interface, Continue Watching, profiles.
- Premium (Forever): $24/month — everything plus the personal AI Relationship Concierge, Love Connect, Love Music, calendar sync, date planning.
- Family: $49/month — multiple couples under one account, ideal for families tracking shared memories.

RELATIONSHIP CONCIERGE (Premium / Forever plan only):
- Personal AI that knows the couple's entire LoveFlix history.
- Suggests date spots based on their uploaded memories and music taste.
- Calculates travel time from both partners' locations to suggested spots.
- Syncs with Google Calendar and Apple Calendar.
- Plans surprise dates, tracks anniversaries, nudges couples who haven't uploaded recently.
- Suggests nearby theaters, restaurants, and activities based on their city.

CURRENT STATUS:
- Actively in beta with waitlist at loveflix.us.
- Early access signups open now.
- Built on Cloudflare Pages with a Supabase backend.

BRAND TONE:
- Warm, romantic, cinematic.
- Inspired by Netflix UI but intimate and personal.
- Colors: Crimson #e50914, Void Black #141414, Warm Gold #c9a96e.
- Tagline energy: "Your love story, streaming forever."

COMMON QUESTIONS:
- Is it private? Yes, completely. Only you and your partner can access your content.
- Can I cancel anytime? Yes.
- What can I upload? Videos, photos, voice notes — anything that captures your memories together.
- Is there a free trial? Direct them to loveflix.us to join the waitlist for early access.
- How many videos can I upload? Depends on the tier — direct to loveflix.us for full details.
- Does it work on phone? Yes, fully mobile responsive.
- Is it like Netflix? Same beautiful interface, but your content only — no movies or shows.
`.trim();
