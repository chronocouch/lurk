const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// ══════════════════════════════════════════════════════════════
//  FLIGHT TIME DATA (standard times in seconds)
// ══════════════════════════════════════════════════════════════
const FLIGHT_TIMES = {
  "Mexico":              26 * 60,
  "Canada":              37 * 60,
  "Cayman Islands":      57 * 60,
  "Hawaii":             121 * 60,
  "United Kingdom":     152 * 60,
  "Switzerland":        169 * 60,
  "Argentina":          189 * 60,
  "Japan":              203 * 60,
  "China":              219 * 60,
  "UAE":                259 * 60,
  "United Arab Emirates": 259 * 60,
  "South Africa":       311 * 60,
};

function getFlightEstimates(destination) {
  let matched = null;
  for (const [name, secs] of Object.entries(FLIGHT_TIMES)) {
    if (destination.toLowerCase().includes(name.toLowerCase())) {
      matched = secs;
      break;
    }
  }
  if (!matched) return null;
  return {
    airstrip: Math.round(matched * 0.70),
    standard: matched,
    wlt:      Math.round(matched * 0.50),
  };
}

// ══════════════════════════════════════════════════════════════
//  FLIGHT PLANNER DATA
//  YATA country codes → display names (must match FLIGHT_TIMES keys).
//  YATA's crowdsourced travel export gives foreign stock + cost, which
//  the official Torn API does not expose.
// ══════════════════════════════════════════════════════════════
const YATA_COUNTRY = {
  mex: "Mexico",         cay: "Cayman Islands", can: "Canada",
  haw: "Hawaii",         uni: "United Kingdom", arg: "Argentina",
  swi: "Switzerland",    jap: "Japan",          chi: "China",
  uae: "UAE",            sou: "South Africa",
};
const TRAVEL_MARKET_HIST_CAP = 672; // ~7 days at 15-min cadence (favorites)
const BOARD_HIST_CAP = 96;          // ~24h at 15-min cadence (full board — kept small
                                    // so the all-items history doc stays well under 1MB)
const STOCK_HIST_CAP = 120;         // fine-grained qty series for the fly-window model
                                    // (deduped to YATA's native cadence, not fixed 5-min)

// Depletion + restock flow from a qty/cost history series. Sampling is
// coarse (15 min), so these are NET rates over observed intervals, not a
// perfect gross consumption model — good enough to size a fly window and
// they sharpen as history accrues.
function computeFlowStats(hist) {
  if (!Array.isArray(hist) || hist.length < 3) {
    return { depletionPerMin: 0, restockIntervalMin: 0, restockSize: 0, restockCount: 0, flowSamples: hist ? hist.length : 0 };
  }
  let depSum = 0, depN = 0;
  const restockTimes = [], restockSizes = [];
  for (let i = 1; i < hist.length; i++) {
    const a = hist[i - 1], b = hist[i];
    const dtMin = (b.t - a.t) / 60;
    if (dtMin <= 0) continue;
    const dq = (b.q || 0) - (a.q || 0);
    if (dq < 0) { depSum += (-dq) / dtMin; depN++; }
    else if (dq > 0) { restockTimes.push(b.t); restockSizes.push(dq); }
  }
  let restockIntervalMin = 0;
  if (restockTimes.length >= 2) {
    let gaps = 0;
    for (let i = 1; i < restockTimes.length; i++) gaps += restockTimes[i] - restockTimes[i - 1];
    restockIntervalMin = Math.round(gaps / (restockTimes.length - 1) / 60);
  }
  const restockSize = restockSizes.length
    ? Math.round(restockSizes.reduce((a, b) => a + b, 0) / restockSizes.length) : 0;
  return {
    depletionPerMin: depN ? Math.round(depSum / depN) : 0,
    restockIntervalMin,
    restockSize,
    restockCount: restockSizes.length,
    flowSamples: hist.length,
  };
}

// Cost stats over a watched item's price history.
function computeCostStats(hist) {
  const costs = hist.map((h) => h.c).filter(Boolean);
  const n = costs.length;
  if (!n) {
    return { costLow: 0, costMedian: 0, volatilityPct: 0, inStockRate: 0, avgQty: 0, samples: 0 };
  }
  const sorted = [...costs].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const mean = costs.reduce((a, b) => a + b, 0) / n;
  const variance = costs.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const volatilityPct = mean ? Math.round((Math.sqrt(variance) / mean) * 1000) / 10 : 0;
  const inStock = hist.filter((h) => (h.q || 0) > 0).length;
  const avgQty = Math.round(hist.reduce((a, h) => a + (h.q || 0), 0) / hist.length);
  return {
    costLow: sorted[0],
    costMedian: median,
    volatilityPct,
    inStockRate: Math.round((inStock / hist.length) * 100) / 100,
    avgQty,
    samples: n,
  };
}

// ══════════════════════════════════════════════════════════════
//  HELPER: Decrypt API key
//  For beta we store keys in Firestore with basic obfuscation.
//  TODO: upgrade to Cloud KMS before public launch.
// ══════════════════════════════════════════════════════════════
function encryptApiKey(key) {
  // Simple base64 + reversal — NOT real encryption.
  // Prevents casual eyeballing in Firestore console.
  // Replace with KMS before going public.
  return Buffer.from(key.split('').reverse().join('')).toString('base64');
}

function decryptApiKey(stored) {
  return Buffer.from(stored, 'base64').toString('utf8').split('').reverse().join('');
}

// Battle Stat Score = √str + √def + √spd + √dex (the scale FFScouter uses).
function bssScore(str, def, spd, dex) {
  return Math.sqrt(str || 0) + Math.sqrt(def || 0) + Math.sqrt(spd || 0) + Math.sqrt(dex || 0);
}

// ══════════════════════════════════════════════════════════════
//  CALLABLE: Register / update a faction
//  Called from the frontend after auth + API key entry.
//  Validates the key against Torn API, detects faction, saves.
// ══════════════════════════════════════════════════════════════
exports.registerFaction = onCall(
  { memory: "256MiB", maxInstances: 10, cors: true },
  async (request) => {
    // Require authentication
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    // Defense in depth: email/password accounts must have a verified email
    // before they can register/join a faction. Google sign-in is verified.
    const token = request.auth.token || {};
    const provider = token.firebase && token.firebase.sign_in_provider;
    if (provider === "password" && !token.email_verified) {
      throw new HttpsError(
        "failed-precondition",
        "Please verify your email address before connecting your faction."
      );
    }

    const uid = request.auth.uid;
    const apiKey = (request.data.apiKey || "").trim();

    if (!apiKey || apiKey.length < 10) {
      throw new HttpsError("invalid-argument", "Invalid API key format.");
    }

    // ── Validate the key against Torn API ──
    let factionData;
    try {
      const res = await fetch(
        `https://api.torn.com/faction/?selections=basic&key=${apiKey}`
      );
      factionData = await res.json();
    } catch (e) {
      throw new HttpsError("unavailable", "Could not reach Torn API.");
    }

    if (factionData.error) {
      const code = factionData.error.code;
      if (code === 2 || code === 10) {
        throw new HttpsError("permission-denied", "Invalid API key. Check that it has Faction access.");
      }
      throw new HttpsError("unknown", `Torn API error: ${factionData.error.error}`);
    }

    // ── Fetch caller's Torn user info to get their player ID ──
    // We need this so the collector can verify membership over time.
    let userData;
    try {
      const res = await fetch(
        `https://api.torn.com/user/?selections=basic&key=${apiKey}`
      );
      userData = await res.json();
    } catch (e) {
      throw new HttpsError("unavailable", "Could not reach Torn API.");
    }
    if (userData.error) {
      throw new HttpsError("unknown", `Torn API error: ${userData.error.error}`);
    }
    const tornId = userData.player_id || null;
    const tornName = userData.name || null;

    const factionId = String(factionData.ID || 0);
    const factionName = factionData.name || "Unknown";

    // ── Factionless handling ──
    // If the caller is not in a faction, disassociate them from any prior
    // faction they had access to and tell them to join one in Torn first.
    if (!factionId || factionId === "0") {
      const nowSec = Math.floor(Date.now() / 1000);
      await db.collection("users").doc(uid).set({
        factionId: null,
        factionName: null,
        tornId,
        tornName,
        role: null,
        leftFactionAt: nowSec,
      }, { merge: true });
      throw new HttpsError(
        "failed-precondition",
        "You're not currently in a Torn faction. Join one in Torn, then come back and reconnect your API key."
      );
    }

    // ── Check if this faction is already registered ──
    const existingConfig = await db
      .collection("factions")
      .doc(factionId)
      .collection("internal")
      .doc("config")
      .get();

    const isExisting = existingConfig.exists;
    const existingOwnerUid = isExisting ? existingConfig.data().ownerUid : null;
    const existingActive = isExisting ? existingConfig.data().active : false;

    // Three cases:
    //  A) Faction doesn't exist yet → caller becomes owner, key is stored.
    //  B) Faction exists, caller IS the owner → treat as key rotation (update key).
    //  C) Faction exists, caller is NOT the owner → JOIN as member.
    //     Their key just proved they're in the faction; we discard it and grant
    //     read access via the users/{uid} mapping. The owner's stored key keeps
    //     polling. If the previous owner's config was deactivated (they left),
    //     this new member can claim ownership by re-running registration.

    const isOwnerCase = !isExisting || existingOwnerUid === uid;
    const canClaimOwnership = isExisting && existingOwnerUid !== uid && !existingActive;

    if (isOwnerCase || canClaimOwnership) {
      // ── Save faction marker doc (so collection().get() finds it) ──
      await db.collection("factions").doc(factionId).set({
        factionId: parseInt(factionId),
        factionName,
        active: true,
        registeredAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      // ── Save / update faction config with this user's API key ──
      await db
        .collection("factions")
        .doc(factionId)
        .collection("internal")
        .doc("config")
        .set({
          ownerUid: uid,
          ownerTornId: tornId,
          apiKey: encryptApiKey(apiKey),
          factionName,
          factionId: parseInt(factionId),
          memberCount: Object.keys(factionData.members || {}).length,
          active: true,
          registeredAt: existingConfig.exists ? existingConfig.data().registeredAt : FieldValue.serverTimestamp(),
          lastUpdated: FieldValue.serverTimestamp(),
          // Clear any prior deactivation reason
          deactivatedReason: FieldValue.delete(),
          deactivatedAt: FieldValue.delete(),
        }, { merge: true });

      // ── Save user → faction mapping as owner ──
      await db.collection("users").doc(uid).set({
        factionId,
        factionName,
        tornId,
        tornName,
        role: "owner",
        registeredAt: FieldValue.serverTimestamp(),
        leftFactionAt: FieldValue.delete(),
      }, { merge: true });

      return {
        success: true,
        factionId,
        factionName,
        memberCount: Object.keys(factionData.members || {}).length,
        role: "owner",
        joined: false,
      };
    } else {
      // ── JOIN flow: existing active faction, caller is not the owner ──
      // Their working key proved they belong to this faction. We do NOT
      // store the key — the owner's key handles polling.
      await db.collection("users").doc(uid).set({
        factionId,
        factionName,
        tornId,
        tornName,
        role: "member",
        registeredAt: FieldValue.serverTimestamp(),
        leftFactionAt: FieldValue.delete(),
      }, { merge: true });

      return {
        success: true,
        factionId,
        factionName,
        memberCount: Object.keys(factionData.members || {}).length,
        role: "member",
        joined: true,
      };
    }
  }
);

// ══════════════════════════════════════════════════════════════
//  CALLABLE: Get faction status (for frontend)
// ══════════════════════════════════════════════════════════════
exports.getFactionStatus = onCall(
  { memory: "256MiB", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const uid = request.auth.uid;
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      throw new HttpsError("not-found", "No faction registered. Please set up your API key.");
    }

    const { factionId } = userDoc.data();

    const configDoc = await db
      .collection("factions")
      .doc(factionId)
      .collection("internal")
      .doc("config")
      .get();

    if (!configDoc.exists) {
      throw new HttpsError("not-found", "Faction configuration not found.");
    }

    const config = configDoc.data();
    return {
      factionId,
      factionName: config.factionName,
      memberCount: config.memberCount,
      active: config.active,
    };
  }
);


// ══════════════════════════════════════════════════════════════
//  CALLABLE: Detect active ranked war using stored API key
//  Returns opponent faction info without exposing the API key.
// ══════════════════════════════════════════════════════════════
exports.detectWar = onCall(
  { memory: "256MiB", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be signed in.");
    }

    const uid = request.auth.uid;

    // Look up the user's faction
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      throw new HttpsError("not-found", "No faction registered.");
    }
    const { factionId } = userDoc.data();

    // Load stored API key
    const configDoc = await db
      .collection("factions")
      .doc(factionId)
      .collection("internal")
      .doc("config")
      .get();

    if (!configDoc.exists) {
      throw new HttpsError("not-found", "Faction configuration not found.");
    }

    const apiKey = decryptApiKey(configDoc.data().apiKey);

    // Fetch ranked wars from Torn API
    let warData;
    try {
      const res = await fetch(
        `https://api.torn.com/faction/?selections=rankedwars&key=${apiKey}`
      );
      warData = await res.json();
    } catch (e) {
      throw new HttpsError("unavailable", "Could not reach Torn API.");
    }

    if (warData.error) {
      throw new HttpsError("unknown", `Torn API error: ${warData.error.error}`);
    }

    const wars = warData.rankedwars || {};
    const activeWar = Object.values(wars).find(
      (w) => w.war && (!w.war.end || w.war.end === 0)
    );

    if (!activeWar) {
      return { found: false, message: "No active ranked war found." };
    }

    const factions = activeWar.factions || {};
    const factionIds = Object.keys(factions);
    const myId = String(factionId);
    const opponentId = factionIds.find((id) => id !== myId);

    if (!opponentId) {
      return { found: false, message: "Could not determine opponent faction." };
    }

    const warStart = activeWar.war?.start || 0;
    const now = Math.floor(Date.now() / 1000);

    return {
      found: true,
      opponentFactionId: parseInt(opponentId),
      opponentFactionName: factions[opponentId]?.name || "Unknown",
      opponentScore: factions[opponentId]?.score || 0,
      ourScore: factions[myId]?.score || 0,
      warStart,
      warStarted: warStart > 0 && warStart <= now,
      secondsUntilStart: warStart > now ? warStart - now : 0,
    };
  }
);


// ══════════════════════════════════════════════════════════════
//  CALLABLE: Set / clear the FFScouter API key (owner only)
//  Stored obfuscated in internal/config; used server-side to pull
//  opponent battle-stat estimates during a war. Never exposed to clients.
// ══════════════════════════════════════════════════════════════
exports.setScouterKey = onCall(
  { memory: "256MiB", cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "You must be signed in.");

    const uid = request.auth.uid;
    const userDoc = await db.collection("users").doc(uid).get();
    if (!userDoc.exists) throw new HttpsError("not-found", "No faction registered.");
    const { factionId, role } = userDoc.data();
    if (!factionId) throw new HttpsError("failed-precondition", "You're not in a faction.");
    if (role !== "owner") throw new HttpsError("permission-denied", "Only the faction owner can set the scouter key.");

    const key = (request.data.key || "").trim();
    const configRef = db.collection("factions").doc(String(factionId)).collection("internal").doc("config");

    if (!key) {
      await configRef.set({ scouterKey: FieldValue.delete() }, { merge: true });
      return { success: true, cleared: true };
    }
    if (key.length < 8) throw new HttpsError("invalid-argument", "That doesn't look like a valid key.");

    // Validate it actually works against FFScouter before saving.
    try {
      const res = await fetch(`https://ffscouter.com/api/v1/get-stats?key=${key}&targets=1`);
      const data = await res.json();
      if (data && data.error) {
        throw new HttpsError("permission-denied", "FFScouter rejected that key.");
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      throw new HttpsError("unavailable", "Couldn't reach FFScouter to validate the key.");
    }

    await configRef.set({ scouterKey: encryptApiKey(key) }, { merge: true });
    return { success: true };
  }
);


// ══════════════════════════════════════════════════════════════
//  SHARED: Build hourly activity patterns from snapshots
// ══════════════════════════════════════════════════════════════
function buildPatterns(snapshots) {
  const hourlyData = {};
  const memberNames = {};


  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const utcHour = new Date(snap.timestamp * 1000).getUTCHours();

    for (const [memberId, memberInfo] of Object.entries(snap.members || {})) {
      if (!hourlyData[memberId]) {
        hourlyData[memberId] = {};
        for (let h = 0; h < 24; h++) {
          hourlyData[memberId][h] = { acted: 0, total: 0 };
        }
      }

      memberNames[memberId] = memberInfo.name;

      if (i === 0) continue;

      const prevSnap = snapshots[i - 1];
      const prevMember = prevSnap.members?.[memberId];
      if (!prevMember) continue;

      const bucket = hourlyData[memberId][utcHour];
      bucket.total++;

      const currentTs = memberInfo.lastActionTimestamp || 0;
      const prevTs = prevMember.lastActionTimestamp || 0;

      if (currentTs > 0 && prevTs > 0 && currentTs !== prevTs) {
        bucket.acted++;
      }
    }
  }

  const patterns = {};
  for (const [memberId, hours] of Object.entries(hourlyData)) {
    patterns[memberId] = {
      name: memberNames[memberId] || "Unknown",
      hours: {},
    };

    for (let h = 0; h < 24; h++) {
      const bucket = hours[h];
      if (bucket.total === 0) {
        patterns[memberId].hours[h] = { classification: "no_data", activeRate: 0, sampleCount: 0 };
        continue;
      }

      const activeRate = bucket.acted / bucket.total;
      let classification;
      if (activeRate >= 0.5) classification = "active";
      else if (bucket.acted > 0) classification = "awake";
      else classification = "inactive";

      patterns[memberId].hours[h] = {
        classification,
        activeRate: Math.round(activeRate * 100),
        sampleCount: bucket.total,
      };
    }
  }

  return { patterns, memberNames };
}


// ══════════════════════════════════════════════════════════════
//  COLLECTOR — runs every 15 minutes
//  Multi-tenant: iterates over all active factions
// ══════════════════════════════════════════════════════════════
exports.collectActivity = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "UTC",
    retryCount: 1,
    memory: "512MiB",
  },
  async (event) => {
    const now = Math.floor(Date.now() / 1000);

    // ── Get all active factions ──
    // We query the internal/config doc inside each faction.
    // Firestore doesn't support collection group queries on subcollections
    // with different parents easily, so we use a top-level registry.
    //
    // Alternative approach: maintain a top-level "active_factions" collection
    // that mirrors faction configs. Let's do that for efficiency.

    let activeFactions;
    try {
      const factionsSnap = await db.collection("factions").get();
      activeFactions = [];

      for (const factionDoc of factionsSnap.docs) {
        const configDoc = await factionDoc.ref
          .collection("internal")
          .doc("config")
          .get();

        if (configDoc.exists && configDoc.data().active) {
          activeFactions.push({
            factionId: factionDoc.id,
            ...configDoc.data(),
          });
        }
      }
    } catch (e) {
      console.error("Failed to load active factions:", e);
      return;
    }

    if (activeFactions.length === 0) {
      console.log("No active factions to poll");
      return;
    }

    console.log(`Polling ${activeFactions.length} active factions`);

    // ── Poll each faction ──
    for (const faction of activeFactions) {
      try {
        const apiKey = decryptApiKey(faction.apiKey);
        const factionId = faction.factionId;

        // Check if war tracking is active for this faction
        let warActive = false;
        let opponentFactionId = null;
        try {
          const warConfig = await db
            .collection("factions")
            .doc(String(factionId))
            .collection("war_tracking")
            .doc("config")
            .get();
          if (warConfig.exists && warConfig.data().active) {
            warActive = true;
            opponentFactionId = warConfig.data().opponentFactionId;
          }
        } catch (e) {
          // Non-fatal
        }

        // ── Fetch faction data from Torn API ──
        const response = await fetch(
          `https://api.torn.com/faction/?selections=basic&key=${apiKey}`
        );
        const data = await response.json();

        if (data.error) {
          console.error(`Torn API error for faction ${factionId}:`, data.error);

          // If key is invalid, mark faction as inactive
          if (data.error.code === 2 || data.error.code === 10) {
            await db
              .collection("factions")
              .doc(String(factionId))
              .collection("internal")
              .doc("config")
              .update({ active: false, deactivatedReason: "invalid_api_key" });
            console.log(`Deactivated faction ${factionId} — invalid API key`);
          }
          continue;
        }

        // ── Faction-change detection ──
        // If the key owner left the faction, the API now returns a different
        // faction's data. We must NOT write that data under the old factionId,
        // as it would silently corrupt the dataset. Mark inactive instead.
        const returnedFactionId = String(data.ID || 0);
        if (returnedFactionId && returnedFactionId !== "0" && returnedFactionId !== String(factionId)) {
          await db
            .collection("factions")
            .doc(String(factionId))
            .collection("internal")
            .doc("config")
            .update({
              active: false,
              deactivatedReason: "owner_left_faction",
              deactivatedAt: now,
              lastSeenInFaction: returnedFactionId,
            });
          console.log(
            `Deactivated faction ${factionId} — key owner moved to faction ${returnedFactionId}`
          );
          continue;
        }

        const members = data.members || {};
        const snapshot = {};
        for (const [memberId, memberData] of Object.entries(members)) {
          snapshot[memberId] = {
            name: memberData.name,
            lastActionTimestamp: memberData.last_action?.timestamp || 0,
          };
        }

        // ── Write snapshot ──
        const factionRef = db.collection("factions").doc(String(factionId));

        await factionRef
          .collection("snapshots")
          .doc(String(now))
          .set({
            timestamp: now,
            members: snapshot,
            memberCount: Object.keys(snapshot).length,
            isWartime: warActive,
          });

        // ── Update member info ──
        const batch = db.batch();
        for (const [memberId, memberData] of Object.entries(members)) {
          const memberRef = factionRef.collection("members").doc(memberId);
          batch.set(memberRef, {
            name: memberData.name,
            level: memberData.level || 0,
            position: memberData.position || "",
            daysInFaction: memberData.days_in_faction || 0,
            lastSeen: now,
            lastStatus: memberData.last_action?.status || "Offline",
          }, { merge: true });
        }
        await batch.commit();

        // ── Verify registered users still belong to this faction ──
        // Any user with users/{uid}.factionId == this faction whose Torn ID
        // is no longer in the live member list has left. Clear their mapping
        // so they lose Firestore read access on next request.
        //
        // Grace period: skip users registered in the last 5 minutes to avoid
        // a race where a brand-new joiner's user doc is cleared because the
        // current API snapshot predates their join.
        //
        // NOTE: this only runs when the faction's config is active (i.e. the
        // owner is still polling). If the owner left, the config was already
        // marked inactive above and we 'continue'-d before reaching here, so
        // legitimate remaining members keep their access until someone
        // re-registers and resumes polling.
        try {
          const memberIdSet = new Set(Object.keys(members));
          const usersSnap = await db
            .collection("users")
            .where("factionId", "==", String(factionId))
            .get();

          const gracePeriod = 5 * 60; // seconds
          const verifyBatch = db.batch();
          let cleared = 0;

          usersSnap.forEach((userDoc) => {
            const u = userDoc.data();
            if (!u.tornId) return; // legacy user without tornId — skip

            // Skip very recent registrations to avoid race condition
            const regTs = u.registeredAt?.seconds || 0;
            if (regTs && (now - regTs) < gracePeriod) return;

            if (!memberIdSet.has(String(u.tornId))) {
              verifyBatch.set(userDoc.ref, {
                factionId: null,
                factionName: null,
                role: null,
                leftFactionAt: now,
                previousFactionId: String(factionId),
              }, { merge: true });
              cleared++;
            }
          });

          if (cleared > 0) {
            await verifyBatch.commit();
            console.log(
              `[${faction.factionName}] Disassociated ${cleared} user(s) no longer in faction`
            );
          }
        } catch (e) {
          console.error(`Membership verification failed for ${factionId}:`, e);
          // Non-fatal
        }

        // ── Clean up old snapshots (keep 14 days) ──
        const cutoff = now - 14 * 24 * 60 * 60;
        const oldDocs = await factionRef
          .collection("snapshots")
          .where("timestamp", "<", cutoff)
          .limit(50)
          .get();

        if (!oldDocs.empty) {
          const deleteBatch = db.batch();
          oldDocs.forEach((doc) => deleteBatch.delete(doc.ref));
          await deleteBatch.commit();
        }

        console.log(
          `[${faction.factionName}] Collected ${Object.keys(snapshot).length} members${warActive ? ' [WAR]' : ''}`
        );

        // ══════════════════════════════════════════════════════
        //  WAR TRACKING (if active for this faction)
        // ══════════════════════════════════════════════════════
        if (warActive && opponentFactionId) {
          await pollOpponents(factionRef, apiKey, opponentFactionId, now);
        }

      } catch (e) {
        console.error(`Failed to poll faction ${faction.factionId}:`, e);
        // Continue to next faction
      }
    }

    console.log(`Collection complete for ${activeFactions.length} factions`);
  }
);


// ── War tracking: poll opponent faction ─────────────────────
async function pollOpponents(factionRef, apiKey, opponentFactionId, now) {
  const warRef = factionRef.collection("war_tracking");

  // Load previous status
  const statusDoc = await warRef.doc("status").get();
  const prevOpponents = statusDoc.exists ? statusDoc.data().opponents || {} : {};

  // Fetch opponent faction
  const factionRes = await fetch(
    `https://api.torn.com/faction/${opponentFactionId}?selections=basic&key=${apiKey}`
  );
  const factionData = await factionRes.json();

  if (factionData.error) {
    console.error(`Torn API error (opponent ${opponentFactionId}):`, factionData.error);
    return;
  }

  const oppMembers = factionData.members || {};
  const opponents = {};

  // Find traveling members that need profile lookups
  const travelingIds = [];
  for (const [id, m] of Object.entries(oppMembers)) {
    const desc = m.status?.description || "";
    const state = m.status?.state || "";
    if (
      state === "Traveling" || state === "Abroad" ||
      desc.includes("Traveling") || desc.includes("In ") || desc.includes("Returning")
    ) {
      travelingIds.push(id);
    }
  }

  // Fetch profiles for travelers
  const profileDetails = {};
  for (const id of travelingIds) {
    try {
      const res = await fetch(
        `https://api.torn.com/user/${id}?selections=profile&key=${apiKey}`
      );
      const userData = await res.json();
      if (!userData.error) {
        profileDetails[id] = {
          statusDesc: userData.status?.description || "",
          statusState: userData.status?.state || "",
          statusUntil: userData.status?.until || 0,
        };
      }
    } catch (e) {
      console.error(`Failed to fetch profile for ${id}:`, e);
    }
  }

  // Build opponent status map
  for (const [id, m] of Object.entries(oppMembers)) {
    const prev = prevOpponents[id] || {};
    const profile = profileDetails[id] || {};

    const statusDesc = profile.statusDesc || m.status?.description || "Unknown";
    const statusState = profile.statusState || m.status?.state || "Unknown";
    const statusUntil = m.status?.until || profile.statusUntil || 0;

    let travelState = "in_torn";
    let destination = null;

    if (statusState === "Traveling") {
      // Torn phrases the return leg as "Returning to Torn from X" or
      // "Traveling from X to Torn"; outbound is "Traveling to X".
      const headingToTorn = /to torn/i.test(statusDesc) || /^returning/i.test(statusDesc);
      if (headingToTorn) {
        travelState = "returning";
        const m = statusDesc.match(/from (.+?)(?: to torn)?$/i);
        destination = (m && m[1].trim()) || prev.lastKnownDestination || null;
      } else {
        travelState = "traveling_out";
        destination = statusDesc.replace(/^traveling to /i, "").trim();
      }
    } else if (statusState === "Abroad") {
      travelState = "abroad";
      destination = statusDesc.startsWith("In ")
        ? statusDesc.replace("In ", "")
        : prev.lastKnownDestination || null;
    } else if (statusState === "Hospital" || statusDesc.includes("hospital")) {
      travelState = "hospital";
    } else if (statusState === "Jail" || statusDesc.includes("jail")) {
      travelState = "jail";
    } else if (statusState === "Okay") {
      travelState = "okay";
    }

    // Detect transitions
    const prevTravelState = prev.travelState || "unknown";
    let departedAt = prev.departedAt || null;
    let returnDepartedAt = prev.returnDepartedAt || null;
    let flightEstimates = prev.flightEstimates || null;

    if (travelState === "traveling_out" && prevTravelState !== "traveling_out") {
      departedAt = now;
      flightEstimates = destination ? getFlightEstimates(destination) : null;
    }
    if (travelState === "returning" && prevTravelState !== "returning") {
      returnDepartedAt = now;
      const dest = destination || prev.lastKnownDestination;
      flightEstimates = dest ? getFlightEstimates(dest) : null;
    }
    if (
      travelState !== "traveling_out" && travelState !== "returning" &&
      (prevTravelState === "traveling_out" || prevTravelState === "returning")
    ) {
      departedAt = null;
      returnDepartedAt = null;
      flightEstimates = null;
    }

    opponents[id] = {
      name: m.name || "Unknown",
      level: m.level || 0,
      position: m.position || "",
      travelState, statusDesc, statusState, statusUntil, destination,
      lastKnownDestination: destination || prev.lastKnownDestination || null,
      departedAt, returnDepartedAt, flightEstimates,
      lastActionTimestamp: m.last_action?.timestamp || 0,
      lastActionStatus: m.last_action?.status || "Offline",
      lastUpdated: now,
    };
  }

  // ── Battle-stat intel (best-effort) ──
  // Owner's own stats via Torn, opponent estimates via FFScouter (one
  // batched call). Both are optional — a missing scouter key or a hiccup
  // just leaves the fields empty.
  let ownStats = null;
  try {
    const bsRes = await fetch(`https://api.torn.com/user/?selections=battlestats&key=${apiKey}`);
    const bs = await bsRes.json();
    if (!bs.error && bs.total != null) {
      ownStats = {
        strength: bs.strength, defense: bs.defense, speed: bs.speed, dexterity: bs.dexterity,
        total: bs.total, bss: Math.round(bssScore(bs.strength, bs.defense, bs.speed, bs.dexterity)),
        updated: now,
      };
    }
  } catch (e) { console.error("own battlestats fetch failed:", e); }

  let scouterEnabled = false;
  try {
    const cfg = await factionRef.collection("internal").doc("config").get();
    const scouterKey = cfg.exists && cfg.data().scouterKey ? decryptApiKey(cfg.data().scouterKey) : null;
    scouterEnabled = !!scouterKey;
    if (scouterKey) {
      const ids = Object.keys(opponents);
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        const ffRes = await fetch(
          `https://ffscouter.com/api/v1/get-stats?key=${scouterKey}&targets=${batch.join(",")}`
        );
        const arr = await ffRes.json();
        if (Array.isArray(arr)) {
          for (const p of arr) {
            const o = opponents[String(p.player_id)];
            if (!o) continue;
            o.bsEstimate = p.bs_estimate != null ? p.bs_estimate : null;
            o.bsHuman = p.bs_estimate_human || null;
            o.fairFight = p.fair_fight != null ? p.fair_fight : null;
            o.statsUpdated = p.last_updated || null;
          }
        }
      }
    }
  } catch (e) { console.error("FFScouter fetch failed:", e); }

  // Write status
  await warRef.doc("status").set({
    opponents,
    opponentFactionId,
    opponentFactionName: factionData.name || "Unknown",
    ownStats,
    scouterEnabled,
    lastPoll: now,
    memberCount: Object.keys(opponents).length,
    travelingCount: travelingIds.length,
    apiCallsUsed: 1 + travelingIds.length,
  });

  // Accrue per-opponent "bag discipline" targeting stats (bag vs lapse,
  // attackable dwell, AFK-at-expiry) for the catchability profile.
  try {
    await updateTargeting(warRef, opponents, prevOpponents, now);
  } catch (e) {
    console.error("targeting update failed:", e);
  }

  // Log travel events
  const travelEvents = [];
  for (const [id, opp] of Object.entries(opponents)) {
    const prev = prevOpponents[id] || {};
    if (opp.travelState !== (prev.travelState || "unknown")) {
      travelEvents.push({
        memberId: id, name: opp.name,
        from: prev.travelState || "unknown", to: opp.travelState,
        destination: opp.destination, timestamp: now,
      });
    }
  }

  if (travelEvents.length > 0) {
    await warRef.doc("events").set(
      { events: FieldValue.arrayUnion(...travelEvents) },
      { merge: true }
    );
  }

  // Opponent activity tracking
  const utcHour = String(new Date(now * 1000).getUTCHours());
  try {
    const oppDocId = `opponent_activity_${opponentFactionId}`;
    const oppActivityDoc = await warRef.doc(oppDocId).get();
    const oppRaw = oppActivityDoc.exists ? oppActivityDoc.data()._raw || {} : {};

    for (const [id, opp] of Object.entries(opponents)) {
      if (!oppRaw[id]) {
        oppRaw[id] = { name: opp.name, hours: {} };
        for (let h = 0; h < 24; h++) {
          oppRaw[id].hours[String(h)] = { acted: 0, total: 0 };
        }
      }
      oppRaw[id].name = opp.name;

      const prevOpp = prevOpponents[id];
      const bucket = oppRaw[id].hours[utcHour];
      bucket.total++;

      if (prevOpp) {
        const currentTs = opp.lastActionTimestamp || 0;
        const prevTs = prevOpp.lastActionTimestamp || 0;
        if (currentTs > 0 && prevTs > 0 && currentTs !== prevTs) {
          bucket.acted++;
        }
      }
    }

    const oppPatterns = {};
    for (const [id, raw] of Object.entries(oppRaw)) {
      oppPatterns[id] = { name: raw.name, hours: {} };
      for (let h = 0; h < 24; h++) {
        const b = raw.hours[String(h)];
        if (!b || b.total === 0) {
          oppPatterns[id].hours[h] = { classification: "no_data", activeRate: 0, sampleCount: 0 };
          continue;
        }
        const rate = b.acted / b.total;
        let classification;
        if (rate >= 0.5) classification = "active";
        else if (b.acted > 0) classification = "awake";
        else classification = "inactive";
        oppPatterns[id].hours[h] = {
          classification,
          activeRate: Math.round(rate * 100),
          sampleCount: b.total,
        };
      }
    }

    await warRef.doc(oppDocId).set({
      patterns: oppPatterns, _raw: oppRaw,
      lastUpdated: now, opponentFactionId,
      opponentFactionName: factionData.name || "Unknown",
      memberCount: Object.keys(oppPatterns).length,
    });
  } catch (e) {
    console.error("Failed to update opponent activity:", e);
  }

  console.log(
    `  War watch: ${Object.keys(opponents).length} opponents, ${travelingIds.length} traveling (${1 + travelingIds.length} API calls)`
  );
}


// ── Targeting: accrue per-opponent "bag discipline" ──────────
// Compares the new opponent snapshot to the previous one and records:
//   • bags        — proactive re-hosp (hospital `until` refreshed upward)
//   • okayEntries — times they became attackable ("Okay" in Torn)
//   • okayDwellSecTotal — total observed attackable time (your window)
//   • afkOnEntry  — entries where last_action was not "Online"
// The frontend turns these into a catchability score (lapse rate ×
// avg dwell × AFK rate). Higher = a sloppier, more exploitable target.
async function updateTargeting(warRef, opponents, prevOpponents, now) {
  const doc = await warRef.doc("targeting").get();
  const target = doc.exists ? doc.data().opponents || {} : {};

  for (const [id, curr] of Object.entries(opponents)) {
    const prev = prevOpponents[id] || {};
    const t = target[id] || {
      okayEntries: 0, okayDwellSecTotal: 0, afkOnEntry: 0, bags: 0,
      okaySince: 0, events: [],
    };

    const currOkay = curr.travelState === "okay";
    const prevOkay = prev.travelState === "okay";
    const afkNow = (curr.lastActionStatus || "Offline") !== "Online";

    // Proactive bag: still in hospital but the release time jumped up.
    if (curr.travelState === "hospital" && prev.travelState === "hospital" &&
        (curr.statusUntil || 0) > (prev.statusUntil || 0) + 30) {
      t.bags++;
      t.events.push({ t: now, type: "bag" });
    }

    // Became attackable (entry into "Okay").
    if (currOkay && !prevOkay) {
      t.okayEntries++;
      t.okaySince = now;
      if (afkNow) t.afkOnEntry++;
      t.events.push({ t: now, type: "attackable", from: prev.travelState || "unknown", afk: afkNow });
    }
    // Left attackable — bank the dwell (bounded by poll cadence).
    if (!currOkay && t.okaySince) {
      t.okayDwellSecTotal += now - t.okaySince;
      t.okaySince = 0;
    }

    if (t.events.length > 20) t.events = t.events.slice(-20);
    t.name = curr.name;
    t.lastState = curr.travelState;
    t.lastUntil = curr.statusUntil || 0;
    t.lastUpdated = now;
    target[id] = t;
  }

  await warRef.doc("targeting").set({ opponents: target, lastUpdated: now });
}


// ══════════════════════════════════════════════════════════════
//  AGGREGATOR — runs every hour, multi-tenant
// ══════════════════════════════════════════════════════════════
exports.aggregatePatterns = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "UTC",
    retryCount: 1,
    memory: "512MiB",
  },
  async (event) => {
    const now = Math.floor(Date.now() / 1000);

    // Get all faction IDs
    const factionsSnap = await db.collection("factions").get();

    for (const factionDoc of factionsSnap.docs) {
      const factionId = factionDoc.id;
      const factionRef = db.collection("factions").doc(factionId);

      try {
        // Check if active
        const configDoc = await factionRef.collection("internal").doc("config").get();
        if (!configDoc.exists || !configDoc.data().active) continue;

        // ── Load snapshots (last 7 days for peacetime) ──
        const peacetimeSince = now - 7 * 24 * 60 * 60;
        const snapshotsQuery = await factionRef
          .collection("snapshots")
          .where("timestamp", ">=", peacetimeSince)
          .orderBy("timestamp")
          .get();

        if (snapshotsQuery.empty) continue;

        const allSnapshots = [];
        snapshotsQuery.forEach((doc) => allSnapshots.push(doc.data()));

        const peacetimeSnapshots = allSnapshots.filter(s => !s.isWartime);
        const wartimeSnapshots = allSnapshots.filter(s => s.isWartime);

        // ── Peacetime aggregation ──
        const peaceSource = peacetimeSnapshots.length > 0 ? peacetimeSnapshots : allSnapshots;
        const { patterns } = buildPatterns(peaceSource);

        await factionRef.collection("aggregated").doc("patterns").set({
          patterns,
          lastUpdated: now,
          daysAnalyzed: 7,
          totalSnapshots: peaceSource.length,
          memberCount: Object.keys(patterns).length,
        });

        // ── Wartime aggregation (90-day lookback) ──
        if (wartimeSnapshots.length > 0) {
          const wartimeSince = now - 90 * 24 * 60 * 60;
          let allWartimeSnapshots = wartimeSnapshots;

          if (wartimeSince < peacetimeSince) {
            const olderQuery = await factionRef
              .collection("snapshots")
              .where("timestamp", ">=", wartimeSince)
              .where("timestamp", "<", peacetimeSince)
              .orderBy("timestamp")
              .get();

            const olderWartime = [];
            olderQuery.forEach((doc) => {
              const d = doc.data();
              if (d.isWartime) olderWartime.push(d);
            });
            allWartimeSnapshots = [...olderWartime, ...wartimeSnapshots];
          }

          const { patterns: warPatterns } = buildPatterns(allWartimeSnapshots);
          const warHoursTracked = Math.round(allWartimeSnapshots.length / 4);

          await factionRef.collection("aggregated").doc("war_patterns").set({
            patterns: warPatterns,
            lastUpdated: now,
            totalSnapshots: allWartimeSnapshots.length,
            memberCount: Object.keys(warPatterns).length,
            warHoursTracked,
          });
        }

        console.log(`[${configDoc.data().factionName}] Aggregated patterns`);
      } catch (e) {
        console.error(`Aggregation failed for faction ${factionId}:`, e);
      }
    }
  }
);


// ══════════════════════════════════════════════════════════════
//  FLIGHT PLANNER COLLECTOR — runs every 30 minutes
//  Builds a full "opportunity board" of every foreign item so a flyer
//  can discover what's becoming valuable — not just a hand-picked list.
//
//   • YATA export           → foreign cost + stock for ALL items (global)
//   • torn/items (1 call)    → market_value baseline sell price for ALL items
//   • market/{id} per fav    → precise bazaar/item-market sell + 7d history
//
//  All output is stored in the shared top-level `travel_market`
//  collection because foreign stock/cost is identical for everyone.
// ══════════════════════════════════════════════════════════════
exports.collectTravelMarket = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "UTC",
    retryCount: 1,
    memory: "256MiB",
  },
  async (event) => {
    const now = Math.floor(Date.now() / 1000);

    // ── 1) Gather an API key + the union of all favorited item ids ──
    let apiKey = null;
    const favorites = {}; // id -> true
    try {
      const factionsSnap = await db.collection("factions").get();
      for (const fdoc of factionsSnap.docs) {
        const cfg = await fdoc.ref.collection("internal").doc("config").get();
        if (!cfg.exists || !cfg.data().active) continue;
        if (!apiKey) apiKey = decryptApiKey(cfg.data().apiKey);

        const plan = await fdoc.ref.collection("flight_planner").doc("config").get();
        if (plan.exists && plan.data().active !== false) {
          for (const id of plan.data().favorites || []) favorites[String(id)] = true;
        }
      }
    } catch (e) {
      console.error("flight: failed to load factions/favorites:", e);
      return;
    }

    if (!apiKey) {
      console.log("flight: no active faction key available");
      return;
    }

    // ── 2) Fetch YATA foreign stock export (all countries/items) ──
    let yata = null;
    try {
      const res = await fetch("https://yata.yt/api/v1/travel/export/");
      yata = await res.json();
    } catch (e) {
      console.error("flight: YATA fetch failed:", e);
    }
    if (!yata || !yata.stocks) {
      console.warn("flight: YATA unavailable this run; aborting");
      return;
    }

    const itemLoc = {}; // id -> { name, country, cost, qty, updated }
    for (const [code, c] of Object.entries(yata.stocks)) {
      const country = YATA_COUNTRY[code] || code;
      if (!YATA_COUNTRY[code]) console.warn("flight: unknown YATA country code:", code);
      for (const s of c.stocks || []) {
        const id = String(s.id);
        const qty = s.quantity != null ? s.quantity : (s.qty || 0);
        itemLoc[id] = { name: s.name, country, cost: s.cost || 0, qty, updated: c.update || now };
      }
    }

    // ── 3) One call prices the whole board: market_value for every item ──
    const marketValues = {};
    try {
      const res = await fetch(`https://api.torn.com/torn/?selections=items&key=${apiKey}`);
      const d = await res.json();
      if (!d.error && d.items) {
        for (const [id, it] of Object.entries(d.items)) marketValues[id] = it.market_value || 0;
      } else if (d.error) {
        console.error("flight: torn/items error:", d.error);
      }
    } catch (e) {
      console.error("flight: torn/items fetch failed:", e);
    }

    // ── 4) Roll full-board history (all foreign items) + compute stats ──
    const histRef = db.collection("travel_market").doc("history");
    const histDoc = await histRef.get();
    const prevHist = histDoc.exists ? histDoc.data().items || {} : {};
    const newHist = {}; // rebuilt fresh each run so vanished items are pruned
    const board = {};

    for (const [id, loc] of Object.entries(itemLoc)) {
      const mv = marketValues[id] || 0;
      const h = Array.isArray(prevHist[id]) ? prevHist[id].slice() : [];
      if (loc.cost) h.push({ t: now, c: loc.cost, q: loc.qty || 0, m: mv });
      while (h.length > BOARD_HIST_CAP) h.shift();
      newHist[id] = h;

      const st = computeCostStats(h);
      const flow = computeFlowStats(h);
      // "Becoming valuable" = margin (market_value − foreign cost) trending up.
      const marginNow = mv && loc.cost ? mv - loc.cost : 0;
      const ref = h.find((p) => (now - p.t) >= 24 * 3600) || h[0];
      const marginRef = ref && ref.m ? ref.m - ref.c : marginNow;
      const marginTrendPct = marginRef
        ? Math.round(((marginNow - marginRef) / Math.abs(marginRef)) * 1000) / 10
        : 0;

      board[id] = {
        name: loc.name,
        country: loc.country,
        cost: loc.cost,
        qty: loc.qty,
        marketValue: mv,
        updated: loc.updated,
        costLow: st.costLow,
        costMedian: st.costMedian,
        volatilityPct: st.volatilityPct,
        inStockRate: st.inStockRate,
        samples: st.samples,
        marginTrendPct,
        depletionPerMin: flow.depletionPerMin,
        restockIntervalMin: flow.restockIntervalMin,
        restockSize: flow.restockSize,
      };
    }

    await histRef.set({ items: newHist, lastPoll: now });
    await db.collection("travel_market").doc("board").set({ items: board, lastPoll: now });
    console.log(`flight: board built — ${Object.keys(board).length} foreign items`);

    // ── 5) Precise pricing + 7d reliability for favorites only ──
    const favIds = Object.keys(favorites).filter((id) => itemLoc[id]);
    if (favIds.length === 0) {
      console.log("flight: no favorites to price precisely");
      return;
    }

    const itemsRef = db.collection("travel_market").doc("items");
    const prevDoc = await itemsRef.get();
    const prev = prevDoc.exists ? prevDoc.data().items || {} : {};
    const out = {};
    let apiCalls = 0;

    for (const id of favIds) {
      const loc = itemLoc[id] || {};
      const p = prev[id] || {};

      let sellBazaar = p.sellBazaar || 0;
      let sellItemMarket = p.sellItemMarket || 0;
      let sellPoll = p.sellPoll || 0;
      try {
        const res = await fetch(
          `https://api.torn.com/market/${id}?selections=bazaar,itemmarket&key=${apiKey}`
        );
        const md = await res.json();
        apiCalls++;
        if (!md.error) {
          const bz = (md.bazaar || []).map((x) => x.cost).filter(Boolean);
          const im = (md.itemmarket || []).map((x) => x.cost).filter(Boolean);
          if (bz.length) sellBazaar = Math.min(...bz);
          if (im.length) sellItemMarket = Math.min(...im);
          sellPoll = now;
        } else {
          console.error(`flight: market error for item ${id}:`, md.error);
        }
      } catch (e) {
        console.error(`flight: market fetch failed for item ${id}:`, e);
      }

      const hist = Array.isArray(p.hist) ? p.hist.slice() : [];
      if (loc.cost) hist.push({ t: now, c: loc.cost, q: loc.qty || 0 });
      while (hist.length > TRAVEL_MARKET_HIST_CAP) hist.shift();

      out[id] = {
        name: loc.name,
        country: loc.country,
        sellBazaar,
        sellItemMarket,
        sellPoll,
        hist,
        ...computeCostStats(hist),
      };
    }

    await itemsRef.set({ items: out, lastPoll: now, apiCalls });
    console.log(`flight: priced ${favIds.length} favorites (${apiCalls} market calls)`);
  }
);


// ══════════════════════════════════════════════════════════════
//  STOCK POLLER — runs every 5 minutes (YATA only, no Torn key)
//  Captures foreign stock at YATA's native cadence to give the fly
//  window a finer depletion/restock estimate than the 15-min board.
//  Cheap: one YATA request + one Firestore doc per run.
// ══════════════════════════════════════════════════════════════
exports.collectStock = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "UTC",
    retryCount: 1,
    memory: "256MiB",
  },
  async (event) => {
    const now = Math.floor(Date.now() / 1000);

    let yata = null;
    try {
      const res = await fetch("https://yata.yt/api/v1/travel/export/");
      yata = await res.json();
    } catch (e) {
      console.error("stock: YATA fetch failed:", e);
      return;
    }
    if (!yata || !yata.stocks) {
      console.warn("stock: YATA unavailable this run");
      return;
    }

    const flowRef = db.collection("travel_market").doc("flow");
    const prevDoc = await flowRef.get();
    const prev = prevDoc.exists ? prevDoc.data().items || {} : {};
    const out = {};

    for (const [, c] of Object.entries(yata.stocks)) {
      const updated = c.update || now;
      for (const s of c.stocks || []) {
        const id = String(s.id);
        const qty = s.quantity != null ? s.quantity : (s.qty || 0);
        const p = prev[id] || {};
        const hist = Array.isArray(p.hist) ? p.hist.slice() : [];
        const last = hist[hist.length - 1];
        // Dedupe to YATA's real observation time — only append when the
        // country's stock timestamp actually advanced.
        if (!last || updated > last.t) hist.push({ t: updated, q: qty });
        while (hist.length > STOCK_HIST_CAP) hist.shift();

        const flow = computeFlowStats(hist);
        out[id] = {
          qty,
          updated,
          hist,
          depletionPerMin: flow.depletionPerMin,
          restockIntervalMin: flow.restockIntervalMin,
          restockSize: flow.restockSize,
          flowSamples: flow.flowSamples,
        };
      }
    }

    await flowRef.set({ items: out, lastPoll: now });
    console.log(`stock: flow updated for ${Object.keys(out).length} items`);
  }
);


// ══════════════════════════════════════════════════════════════
//  CLEANUP — runs weekly
//  Deletes user docs that have been factionless for 30+ days.
//  This is hygiene only — Firestore rules already block their access
//  the moment factionId is null. Users can re-register at any time.
// ══════════════════════════════════════════════════════════════
exports.cleanupStaleUsers = onSchedule(
  {
    schedule: "every 168 hours",
    timeZone: "UTC",
    retryCount: 1,
    memory: "256MiB",
  },
  async (event) => {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - 30 * 24 * 60 * 60;

    const staleSnap = await db
      .collection("users")
      .where("factionId", "==", null)
      .where("leftFactionAt", "<", cutoff)
      .get();

    if (staleSnap.empty) {
      console.log("No stale factionless users to clean up");
      return;
    }

    const batch = db.batch();
    staleSnap.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    console.log(`Deleted ${staleSnap.size} stale factionless user(s)`);
  }
);


// ══════════════════════════════════════════════════════════════
//  IMMEDIATE WAR POLL — Firestore-triggered on war_tracking/config
//  When a faction starts (or switches) opponent tracking, poll the
//  opponent right away so the UI shows fresh intel in seconds instead
//  of waiting up to 15 min for collectActivity. Only fires on a real
//  start/switch, and writes war_tracking/status (never config) so there
//  is no trigger loop.
// ══════════════════════════════════════════════════════════════
exports.onWarConfigChange = onDocumentWritten(
  {
    document: "factions/{factionId}/war_tracking/config",
    memory: "256MiB",
  },
  async (event) => {
    const after = event.data?.after?.data();
    if (!after || !after.active) return;

    const opponentFactionId = after.opponentFactionId;
    if (!opponentFactionId) return;

    // Only poll on a genuine start or opponent switch — not on unrelated
    // config writes (e.g. stopping, which sets active:false and returns above).
    const before = event.data?.before?.data() || {};
    if (before.active && Number(before.opponentFactionId) === Number(opponentFactionId)) return;

    const factionId = event.params.factionId;
    const configDoc = await db
      .collection("factions")
      .doc(factionId)
      .collection("internal")
      .doc("config")
      .get();
    if (!configDoc.exists) return;
    const apiKey = decryptApiKey(configDoc.data().apiKey);

    const factionRef = db.collection("factions").doc(factionId);
    const now = Math.floor(Date.now() / 1000);
    try {
      await pollOpponents(factionRef, apiKey, opponentFactionId, now);
      console.log(`Immediate war poll: faction ${factionId} vs ${opponentFactionId}`);
    } catch (e) {
      console.error(`Immediate war poll failed for ${factionId}:`, e);
    }
  }
);


// ══════════════════════════════════════════════════════════════
//  WAR RAPID POLL — runs every minute
//  During an active war, when an opponent is within ~8 min of a
//  hospital release or a landing, rapid-poll that faction so we catch
//  bag-vs-lapse (and their live presence) at ~1-min resolution instead
//  of every 15 min. Does NOTHING when nobody is near a transition, so
//  it barely touches the API. War-time only → effectively $0.
// ══════════════════════════════════════════════════════════════
exports.warRapidPoll = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "UTC",
    retryCount: 0,
    memory: "256MiB",
  },
  async (event) => {
    const now = Math.floor(Date.now() / 1000);
    const NEAR = 8 * 60; // seconds before an expiry we start rapid-polling

    // NOTE: reads faction configs each run; fine at current scale. If the
    // faction count grows large, back this with an active-war index.
    let factionsSnap;
    try {
      factionsSnap = await db.collection("factions").get();
    } catch (e) {
      console.error("warRapidPoll: failed to list factions:", e);
      return;
    }

    for (const fdoc of factionsSnap.docs) {
      const factionId = fdoc.id;
      try {
        const warCfg = await fdoc.ref.collection("war_tracking").doc("config").get();
        if (!warCfg.exists || !warCfg.data().active) continue;
        const opponentFactionId = warCfg.data().opponentFactionId;
        if (!opponentFactionId) continue;

        const statusDoc = await fdoc.ref.collection("war_tracking").doc("status").get();
        if (!statusDoc.exists) continue;
        const opponents = statusDoc.data().opponents || {};

        let hot = false;
        for (const opp of Object.values(opponents)) {
          if (opp.travelState === "hospital" && opp.statusUntil) {
            const rem = opp.statusUntil - now;
            if (rem <= NEAR && rem > -90) { hot = true; break; }
          }
          if (opp.travelState === "returning" && opp.flightEstimates && opp.returnDepartedAt) {
            const rem = opp.flightEstimates.airstrip - (now - opp.returnDepartedAt);
            if (rem <= NEAR && rem > -90) { hot = true; break; }
          }
        }
        if (!hot) continue;

        const configDoc = await fdoc.ref.collection("internal").doc("config").get();
        if (!configDoc.exists) continue;
        const apiKey = decryptApiKey(configDoc.data().apiKey);
        await pollOpponents(fdoc.ref, apiKey, opponentFactionId, now);
        console.log(`warRapidPoll: rapid-polled faction ${factionId} (near-expiry opponent)`);
      } catch (e) {
        console.error(`warRapidPoll failed for ${factionId}:`, e);
      }
    }
  }
);


// ══════════════════════════════════════════════════════════════
//  RAPID RETURN WATCHER — Firestore-triggered
//  Listens on factions/{factionId}/war_tracking/status
// ══════════════════════════════════════════════════════════════
exports.watchReturning = onDocumentWritten(
  {
    document: "factions/{factionId}/war_tracking/status",
    memory: "256MiB",
  },
  async (event) => {
    const data = event.data?.after?.data();
    if (!data) return;

    const now = Math.floor(Date.now() / 1000);
    const factionId = event.params.factionId;

    // Guard against infinite loop
    if (data.lastRapidPoll && (now - data.lastRapidPoll) < 10) return;

    const opponents = data.opponents || {};
    const RAPID_WINDOW = 2 * 60;
    const hotIds = [];

    for (const [id, opp] of Object.entries(opponents)) {
      if (opp.travelState !== "returning") continue;
      if (!opp.returnDepartedAt || !opp.flightEstimates) continue;

      const elapsed = now - opp.returnDepartedAt;
      const airstripRemaining = opp.flightEstimates.airstrip - elapsed;
      const standardRemaining = opp.flightEstimates.standard - elapsed;

      if (airstripRemaining <= RAPID_WINDOW && standardRemaining > -60) {
        hotIds.push(id);
      }
    }

    if (hotIds.length === 0) return;

    // Get API key for this faction
    const configDoc = await db
      .collection("factions")
      .doc(factionId)
      .collection("internal")
      .doc("config")
      .get();

    if (!configDoc.exists) return;
    const apiKey = decryptApiKey(configDoc.data().apiKey);

    let updated = false;

    for (const id of hotIds) {
      try {
        const res = await fetch(
          `https://api.torn.com/user/${id}?selections=profile&key=${apiKey}`
        );
        const userData = await res.json();
        if (userData.error) continue;

        const statusDesc = userData.status?.description || "";
        const statusState = userData.status?.state || "";
        const prev = opponents[id];

        let newTravelState = prev.travelState;
        if (
          statusState === "Okay" ||
          (!statusDesc.includes("Traveling") && !statusDesc.includes("Returning") &&
           statusState !== "Abroad" && statusState !== "Hospital" && statusState !== "Jail")
        ) {
          newTravelState = "okay";
        }

        if (newTravelState !== prev.travelState) {
          opponents[id] = {
            ...prev,
            travelState: newTravelState, statusDesc, statusState,
            departedAt: null, returnDepartedAt: null, flightEstimates: null,
            lastUpdated: now,
          };
          updated = true;

          const warRef = db.collection("factions").doc(factionId).collection("war_tracking");
          await warRef.doc("events").set(
            {
              events: FieldValue.arrayUnion({
                memberId: id, name: prev.name,
                from: prev.travelState, to: newTravelState,
                destination: prev.lastKnownDestination,
                timestamp: now, rapid: true,
              }),
            },
            { merge: true }
          );

          console.log(`Rapid catch: ${prev.name} landed! (${factionId})`);
        }
      } catch (e) {
        console.error(`Rapid poll failed for ${id}:`, e);
      }
    }

    if (updated) {
      await db
        .collection("factions")
        .doc(factionId)
        .collection("war_tracking")
        .doc("status")
        .set({ opponents, lastRapidPoll: now }, { merge: true });
    }
  }
);