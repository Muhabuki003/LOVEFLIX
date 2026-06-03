# Event Taxonomy

The canonical SaaS event vocabulary this skill proposes in Phase 2. Skip any events that don't apply to the discovered product surface.

## Naming rules

1. **`snake_case`** for event names and property names. PostHog UI displays both. Mixed case fragments funnels and dashboards.
2. **Past tense for completed actions**: `user_signed_up`, not `user_signs_up` or `signing_up`.
3. **Use `_started` / `_completed` / `_failed` suffixes** for multi-step or async actions. A `report_generated` event without a started/failed pair makes funnels and error rates impossible to build later.
4. **Name the WHAT and WHY, not the HOW**. `note_created` is good. `post_request_to_notes_endpoint` is implementation-leaked.
5. **No PII in event names**. Never `signup_for_jane@example.com`. Identify the user separately.
6. **Property names describe what's interesting about the event**. For `note_created`: `word_count`, `template_used`, `is_first_note`. Not `req_body_size`.

## distinctId rules

Every event needs a `distinctId`. The rules:

- **Logged-in user**: `distinctId` = your internal user id (UUID, not email — emails change).
- **Anonymous user, client-side**: PostHog's `posthog-js` generates an anonymous id automatically. Don't override.
- **Logged-in user, server-side capture**: pass `distinctId` explicitly with the user id.
- **Server-only event with no user in scope** (e.g. organization-level webhook): use the org id, prefixed (`org_<uuid>`) so it doesn't collide with user ids. Document the prefix convention in `posthog-setup-report.md`.
- **Webhook with customer id only** (Stripe sends `cus_xxx`, not your user id): map customer id → user id via your database, then use the user id. Capture with org id as a fallback only if user lookup fails.

## The vocabulary

### Auth

| Event | When | Where | Required properties | Optional properties |
|---|---|---|---|---|
| `user_signed_up` | After successful registration; email-confirmation flows fire with `confirmed: false` and a separate `user_email_confirmed` fires later | Client (form) OR Server (OAuth callback) | `method: 'email' \| 'google' \| 'github' \| ...` | `referrer`, `utm_source`, `confirmed`, `invited_by` |
| `user_email_confirmed` | When email confirmation link is clicked | Server (confirmation route) | — | `hours_since_signup` |
| `user_signed_in` | After successful auth (email/password AND OAuth) | Client OR Server | `method` | `days_since_last_sign_in` |
| `user_signed_out` | After successful sign-out | Client | — | `session_duration_seconds` |

### Core product actions

For each of the 3–7 core actions identified in Phase 1, instrument the triplet:

| Event | When | Where | Required properties | Optional properties |
|---|---|---|---|---|
| `<action>_started` | User commits to the action (clicks Generate, submits form) | Client | — | Inputs that drive the action (`template`, `model`, `input_word_count`) |
| `<action>_completed` | The action succeeds | Wherever it completes (often Server) | `duration_ms` | Outputs (`output_word_count`, `cost_cents`) |
| `<action>_failed` | The action fails | Same site as `_completed` | `error_code`, `error_message_truncated` | `duration_ms` |

**Example for a transcription product:**
- `transcript_generated_started` — fired when user clicks Generate
- `transcript_generated_completed` — fired when the upload + processing pipeline finishes
- `transcript_generated_failed` — fired in the catch block of the processing pipeline

The triplet enables: conversion funnel (`started → completed`), error rate (`failed / started`), latency distributions (`duration_ms` on `completed`).

### Billing / monetization

| Event | When | Where | Required properties | Optional properties |
|---|---|---|---|---|
| `checkout_started` | User clicks the upgrade/buy button that sends them to Stripe Checkout / Paddle / etc. | Client | `plan`, `interval: 'monthly' \| 'yearly'` | `referrer_page`, `paywall_seen` |
| `subscription_activated` | Webhook receives `checkout.session.completed` or `customer.subscription.created` | Server (webhook handler) | `plan`, `interval`, `amount_cents`, `currency` | `coupon`, `trial_days` |
| `subscription_canceled` | Webhook receives `customer.subscription.deleted` or `.updated` with `cancel_at_period_end: true` | Server (webhook handler) | `plan`, `reason` (if collected via cancellation flow) | `lifetime_value_cents`, `tenure_days` |
| `subscription_payment_failed` | Webhook receives `invoice.payment_failed` | Server (webhook handler) | `amount_cents`, `attempt_count` | `next_retry_at` |
| `paywall_seen` | A paywall/upgrade prompt becomes visible | Client | `paywall_id`, `trigger: 'quota_exceeded' \| 'feature_locked' \| ...` | `current_plan` |

### Secondary value events

Capture these only if they map to product behaviors that matter to the business.

| Event | When | Where |
|---|---|---|
| `<thing>_shared` | User shares output (link copied, email sent, social share) | Client |
| `<thing>_exported` | User exports output (PDF, CSV, image download) | Client |
| `team_member_invited` | An invite is sent | Server |
| `team_member_joined` | An invite is accepted | Server |
| `feedback_submitted` | NPS, in-app feedback widget, support form | Client |

## Properties to capture on every event (auto)

PostHog's `posthog-js` automatically captures `$current_url`, `$pathname`, `$browser`, `$os`, `$device_type`, `$referrer`, `$utm_*` on every client event. Do not duplicate these.

For server captures, PostHog captures less automatically. Add `$ip` from the request if available, and the user-agent if relevant for the event.

## User properties (identify traits)

When calling `posthog.identify(userId, traits)`, include the slow-changing facts about the user:

```js
posthog.identify(user.id, {
  email: user.email,           // for contacting users from PostHog
  name: user.name,
  created_at: user.createdAt,  // for cohort analysis
  plan: user.subscriptionTier, // for filtering by plan
  org_id: user.orgId,          // for group analytics
})
```

Use `posthog.group('organization', orgId, { name, plan, seat_count })` if the product is B2B/multi-tenant and you want org-level analytics in addition to user-level.

## Properties to NEVER capture

- Passwords (obvious)
- API keys, access tokens, refresh tokens, session cookies
- Full credit card numbers (PCI scope), bank account numbers
- Government IDs (SSN, passport, driver's license)
- Health data unless you've explicitly confirmed HIPAA compliance with PostHog
- Children's data under 13 (COPPA)
- Email addresses **as event properties** — put them on the user via `identify(traits)` once, not on every event. Email-as-property bloats the database and complicates GDPR deletes.

## Property naming examples

| Bad | Good | Why |
|---|---|---|
| `userId` | `user_id` | snake_case for everything |
| `Plan` | `plan` | lowercase |
| `data` | (split into specific properties) | "data" is uselessly generic |
| `req` / `request_body` | (specific fields from the request) | implementation leak |
| `metaData` | (split into specific properties) | "metadata" is uselessly generic |
| `error` | `error_code` + `error_message_truncated` | structured beats free text |
| `success: true` | (use distinct event names for success vs failure) | bools split funnels awkwardly |
