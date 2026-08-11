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

  // Write status
  await warRef.doc("status").set({
    opponents,
    opponentFactionId,
    opponentFactionName: factionData.name || "Unknown",
    lastPoll: now,
    memberCount: Object.keys(opponents).length,
    travelingCount: travelingIds.length,
    apiCallsUsed: 1 + travelingIds.length,
  });

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