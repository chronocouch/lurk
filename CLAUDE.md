# Lurk

Multi-tenant Firebase web app providing activity intelligence for Torn City factions. Evolved from a single-faction tool ("Underworld Availability") into a public SaaS where any faction leader signs up by connecting their Torn API key.

**Live at:** https://lurk-e154e.web.app
**Firebase project ID:** `lurk-e154e`
**Region:** `us-central1`
**Plan:** Blaze (required for Cloud Functions)

---

## Working style (read this first)

- **Be concise.** I prefer short, direct answers. Skip preambles.
- **Confirm intent before implementing** anything non-trivial. For one-line fixes, just do it. For anything touching multiple files, schema, security rules, or deployed functions, propose the change first and wait for approval.
- **Targeted edits over rewrites.** Use `str_replace` style edits whenever possible. Don't rewrite a whole file to change three lines.
- **Verify before declaring done.** Re-read the file after editing. If you ran a deploy, check the output. Don't say "done" if you haven't confirmed.
- **Show me diffs, not full files.** When proposing a change, show the old → new snippet with the file path and approximate line area.
- **Project files in this repo are the source of truth.** Don't assume from memory — read the actual file.

---

## Architecture

### Frontend
- **Single file:** `public/index.html` (vanilla JS, no framework)
- Contains: landing page, Google + email auth, onboarding flow, app shell with four tabs (Activity heatmap, War Buddy, Flights, War Intel), Settings
- **Styles:** extracted to `public/styles.css`
- **PWA:** `public/manifest.webmanifest`, `public/sw.js`
- Reads from per-faction Firestore paths
- **Gotcha:** the `FIREBASE_CONFIG` block at the top of the script section must contain real values. If `IS_CONFIGURED` is false, the app shows "Firebase not configured." Whenever `index.html` is replaced wholesale, this block needs to be re-pasted.

### Backend
- **Single file:** `functions/index.js`
- **Runtime:** Firebase Cloud Functions, Node 22, Gen 2
- **Region:** us-central1

**Functions:**

| Name | Type | Purpose |
|---|---|---|
| `registerFaction` | callable | Validates API key, detects faction, creates marker doc + encrypted config, handles multi-user join |
| `detectWar` | callable | Uses stored API key server-side to detect active ranked wars |
| `getFactionStatus` | callable | Returns faction info to frontend |
| `collectActivity` | scheduled (15 min) | Iterates all active factions, polls Torn API, writes snapshots, also polls opponents during war |
| `aggregatePatterns` | scheduled (hourly) | Builds peacetime/wartime heatmap data per faction |
| `watchReturning` | Firestore trigger | Rapid-polls opponents near landing for accurate landing detection |
| `cleanupStaleUsers` | scheduled (weekly) | Removes stale user records |
| `collectTravelMarket` | scheduled (15 min) | Flights planner: YATA foreign stock/cost + `torn/items` market value + per-favorite bazaar/item-market sell prices → shared `travel_market/board`+`items` |
| `collectStock` | scheduled (5 min) | Flights planner: YATA-only stock poll (no key), finer depletion/restock for the fly window → shared `travel_market/flow` |

### Firestore structure
```
users/{uid}                                          → user → faction mapping
factions/{factionId}                                 → marker doc (REQUIRED for collector to find faction)
factions/{factionId}/internal/config                 → encrypted API key, owner UID (Cloud Functions only)
factions/{factionId}/snapshots/{ts}                  → raw 15-min polls, 14-day retention
factions/{factionId}/aggregated/patterns             → peacetime heatmap
factions/{factionId}/aggregated/war_patterns         → wartime heatmap
factions/{factionId}/members/{memberId}              → member info
factions/{factionId}/war_tracking/config             → war buddy config
factions/{factionId}/war_tracking/status             → current war state
factions/{factionId}/war_tracking/events             → war events
factions/{factionId}/war_tracking/opponent_activity_*  → tracked opponent data
factions/{factionId}/flight_planner/config           → Flights: watchlist favorites + planner settings (owner-writable)

travel_market/board                                  → GLOBAL: all foreign items (cost, stock, market-value sell, 24h margin trend, stats)
travel_market/items                                  → GLOBAL: precise sell + 7d reliability for favorited items only
travel_market/flow                                   → GLOBAL: 5-min stock series → depletion/restock for the fly window
travel_market/history                                → GLOBAL: rolling per-item cost/stock history (board stats source)
```

**Flights data is global, not per-faction:** foreign stock/cost and market prices are identical for everyone, so `travel_market/*` is one shared collection (any signed-in user reads; Cloud Functions only write). This keeps its cost fixed regardless of faction count.

### Security
- Firestore rules enforce per-faction isolation
- `internal/config` is fully blocked from clients (Cloud Functions only)
- All other faction data requires the authenticated user's `factionId` to match
- **Past bug:** recursive wildcard in rules conflicted with `war_tracking` writes. Fixed by consolidating to a single match. Don't re-introduce nested wildcards.

### Activity detection logic
**Action-based, not status-based.** Compares consecutive `lastActionTimestamp` snapshots to detect real activity. Classification:
- ≥50% of polls show action = "active" (green)
- ≥1 action = "awake" (yellow)
- 0 actions = "inactive" (dark)

---

## Auth & users

- Firebase Auth: Google + Email/Password enabled
- Currently first registrant per faction owns it (multi-user join is supported but ownership is single-user)
- API keys stored with base64 + reverse obfuscation. **TODO: upgrade to Cloud KMS** before broader public launch.

---

## Current status (beta)

**Working:**
- Auth, onboarding, faction registration, API key validation
- Multi-tenant collector, aggregator
- Heatmap UI: peacetime, wartime, opponent views
- War Buddy: opponent travel tracker, flight estimates, imminent alerts, filter chips
- War Intel: differential coverage bar + auto-detected vulnerability/opportunity windows (<2 online flagged, 0 = critical) with member lists
- Flights planner: discovery board of all foreign items ranked by expected $/min, favorites (pinned + precise pricing), fly window (depletion vs. flight time), copyable bazaar list-price recommendation, ✈ links to Torn's travel agency. Backed by YATA + `torn/items`; reliability/window sharpen over ~1–2 weeks of history.
- Firestore rules
- In active use by my faction "The North Stand" during ranked wars

**Pending:**
- Stripe billing for paid tiers
- Torn OAuth (instead of/in addition to Google)
- KMS encryption for API keys
- Custom domain
- Multi-user faction ownership

---

## Deployment gotchas (learned the hard way)

1. **Gen 2 callable functions need both:**
   - `cors: true` in their config
   - `gcloud run services add-iam-policy-binding {function-name} --region=us-central1 --member=allUsers --role=roles/run.invoker` (function name must be lowercase)

   Without both, browser preflight fails.

2. **First-time Gen 2 deploy** requires manual IAM policy bindings for Pub/Sub, Compute, and Eventarc service accounts. Firebase suggests these in the deploy error output — follow them.

3. **Eventarc permissions take 1–2 minutes** to propagate after enabling. Retry deploys if `watchReturning` fails the first time.

4. **`db.collection("factions").get()` does NOT return phantom parent documents** created by writes to subcollections. Must explicitly write a marker doc at `factions/{factionId}` for the collector to find the faction.

5. **Node engine in `functions/package.json` must be `"22"`.** Node 18 is decommissioned.

6. **`firestore.indexes.json` must use empty `"indexes": []`.** Defining single-field indexes causes a 400 error.

7. **Activity data appears sparse with <7 days of collection.** That's expected, not a bug.

---

## Common commands

```bash
# Deploy everything
firebase deploy

# Deploy only functions (faster iteration)
firebase deploy --only functions

# Deploy a single function
firebase deploy --only functions:collectActivity

# Deploy only hosting (frontend)
firebase deploy --only hosting

# Deploy only Firestore rules
firebase deploy --only firestore:rules

# Local emulator
firebase emulators:start

# View function logs
firebase functions:log

# Tail logs for a specific function
firebase functions:log --only collectActivity
```

---

## Patterns I follow

- **Mobile-first.** Most users open Lurk on their phone during wars. Test mobile layouts after any UI change.
- **Coverage bar / War Intel grid:** uses `minmax(0, 1fr)` to prevent overflow on narrow screens. Don't change this without testing mobile.
- **War Buddy cards:** kept tight on mobile (small padding, attack button inline with status chip to save vertical space).
- **No frameworks in frontend.** Vanilla JS. If you find yourself wanting React, propose it as a discussion first — don't just add it.

---

## What I'm building toward

A war intelligence layer for Torn factions. Lurk's moat is **temporal pattern data** — historical activity heatmaps and opponent vulnerability prediction — not the live status snapshots that every other tool already provides. Feature decisions should reinforce this positioning.
