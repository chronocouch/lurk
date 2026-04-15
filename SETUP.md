# Faction Pulse — Setup Guide

Multi-tenant activity intelligence for Torn City factions.

## What's in this project

```
├── public/
│   └── index.html          # Frontend: landing, auth, onboarding, app shell
├── functions/
│   ├── index.js             # Cloud Functions: collector, aggregator, war tracker
│   └── package.json         # Node 22 dependencies
├── firebase.json            # Firebase project config
├── firestore.rules          # Security rules (per-faction isolation)
├── firestore.indexes.json   # Empty (single-field indexes are auto-created)
└── SETUP.md                 # This file
```

## Step 1: Create a new Firebase project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **Add Project**
3. Name it something neutral (e.g., `faction-pulse`, `torn-heatmap`, whatever you want to brand it)
4. Enable Google Analytics if you want usage stats (optional)
5. Click **Create Project**

## Step 2: Enable services

In the Firebase console for your new project:

### Firestore
- Go to **Build → Firestore Database**
- Click **Create Database**
- Choose **Production mode** (our security rules will handle access)
- Pick a region close to you (us-central1 is fine)

### Authentication
- Go to **Build → Authentication**
- Click **Get Started**
- Enable **Google** sign-in provider (toggle it on, add your email as support contact)
- Optionally enable **Email/Password** too for users who prefer it

### Hosting
- Go to **Build → Hosting**
- Click **Get Started** and follow the prompts (you'll set this up via CLI)

### Functions
- Functions require the **Blaze (pay-as-you-go)** plan
- Go to **Settings → Usage and billing → Modify plan** → select Blaze
- Set a budget alert at $5/month to start (actual costs will be well under this)

## Step 3: Get your Firebase config

1. In the Firebase console, click the **⚙ gear icon → Project Settings**
2. Scroll down to **Your apps** → click the web icon `</>`
3. Register a web app (name: "Faction Pulse")
4. Copy the `firebaseConfig` object — you'll need it for `public/index.html`

## Step 4: Update the config in the frontend

Open `public/index.html` and find the `FIREBASE_CONFIG` block near the top of the `<script>` section. Replace the placeholder values with your real config:

```javascript
const FIREBASE_CONFIG = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.firebasestorage.app",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef",
};
```

## Step 5: Install Firebase CLI & deploy

```bash
# Install Firebase CLI (if you haven't already)
npm install -g firebase-tools

# Log in
firebase login

# Initialize the project (select your new project)
firebase use your-project-id

# Install Cloud Function dependencies
cd functions && npm install && cd ..

# Deploy everything
firebase deploy
```

If you get a port conflict on deploy, you can set a custom port:
```bash
firebase deploy --port 22
```

## Step 6: Test the flow

1. Visit your Firebase Hosting URL (e.g., `your-project.web.app`)
2. You should see the Faction Pulse landing page
3. Sign in with Google
4. You'll be prompted to paste your Torn API key
5. The system validates the key, detects your faction, and starts collecting

Data will start appearing within 15 minutes (first collector run).
The heatmap will populate after the first aggregator run (hourly).

---

## Architecture Overview

### Multi-tenant Firestore structure

```
factions/{factionId}/
  internal/
    config              # API key (encrypted), owner UID, settings
  snapshots/{timestamp} # Raw activity polls (14-day retention)
  aggregated/
    patterns            # Peacetime heatmap data
    war_patterns        # Wartime heatmap data
  members/{tornId}      # Member info (name, level, position)
  war_tracking/
    config              # War active flag, opponent faction ID
    status              # Opponent positions (real-time)
    events              # Travel event log
    opponent_activity_* # Opponent heatmap data

users/{firebaseUid}
    factionId           # Which faction this user belongs to
    factionName         # Cached faction name
    role                # "owner" or "member"
```

### Cloud Functions

| Function | Trigger | Purpose |
|----------|---------|---------|
| `registerFaction` | HTTPS callable | Validates API key, creates faction config |
| `getFactionStatus` | HTTPS callable | Returns faction info for frontend |
| `collectActivity` | Every 15 min | Polls Torn API for all active factions |
| `aggregatePatterns` | Every 1 hour | Builds heatmap patterns from snapshots |
| `watchReturning` | Firestore trigger | Rapid-polls opponents near landing |

### Security model

- **API keys**: Stored in `factions/{id}/internal/config` — this path is blocked from all client reads by Firestore rules. Only Cloud Functions can access it.
- **Faction data isolation**: Firestore rules check that the authenticated user's `factionId` matches the document path before allowing reads.
- **No cross-faction access**: User A cannot read User B's faction data, even if they know the faction ID.

---

## Cost Estimates (per faction per month)

| Resource | Usage | Est. Cost |
|----------|-------|-----------|
| Cloud Functions (collector) | ~2,880 invocations | ~$0.40 |
| Cloud Functions (aggregator) | ~720 invocations | ~$0.10 |
| Firestore reads | ~5,000/day | ~$0.30 |
| Firestore writes | ~3,000/day | ~$0.30 |
| Hosting | < 1 GB bandwidth | ~$0.00 |
| **Total** | | **~$1.00–1.50** |

War tracking adds ~$0.20–0.50/month during active wars.
Firebase free tier covers the first ~50K function invocations/month.

---

## Beta Checklist

- [ ] Create new Firebase project
- [ ] Enable Firestore, Auth (Google), Hosting, Functions
- [ ] Upgrade to Blaze plan
- [ ] Paste Firebase config into `public/index.html`
- [ ] Deploy with `firebase deploy`
- [ ] Test sign-in → onboarding → data collection flow
- [ ] Invite 3-5 faction leaders for beta testing
- [ ] Monitor costs in Firebase console
- [ ] Integrate full heatmap & war buddy UI into the app shell

---

## Next Steps (post-beta)

- [ ] Integrate existing heatmap UI (index.html) into the app shell
- [ ] Integrate War Buddy UI (war.html) into the app shell
- [ ] Add Torn OAuth for sign-in (verifies player identity)
- [ ] Upgrade API key storage to Cloud KMS encryption
- [ ] Add billing (Stripe) for paid tiers
- [ ] Add faction member management (invite co-leaders)
- [ ] Custom domain + branding
