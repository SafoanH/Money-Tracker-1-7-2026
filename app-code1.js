import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/** ===========================
 *  SUPABASE CONFIG (YOUR VALUES)
 *  =========================== */
const SUPABASE_URL = "https://zbiutjrfcpzfndvwosfe.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8xY3RQcA_JXtBH36iLQpUQ_Yr2ROeey";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/** ===========================
 *  PAY RATE
 *  =========================== */
const HOURLY_RATE = 25.26;
const RATE_PER_SECOND = HOURLY_RATE / 3600;

/** ===========================
 *  STATE
 *  =========================== */
let intervalId = null;
let currentUser = null;

// What we store per user
let state = {
  running: false,
  useManual: false,
  startTimeMs: null,
  manualNowMs: null,
};

// Throttle cloud saves (avoid writing every second)
let cloudSaveCounter = 0;
const CLOUD_SAVE_EVERY_SECONDS = 30; // saves about every 30s while running

/** ===========================
 *  DOM HELPERS
 *  =========================== */
const $ = (id) => document.getElementById(id);

function setMoney(val) {
  $("money").innerText = "$" + val.toFixed(2);
}

function setStatus(msg) {
  $("status").innerText = msg;
}

function setAuthStatus(msg) {
  $("authStatus").innerText = msg;
}

function showAuthGate() {
  $("authGate").style.display = "block";
  $("trackerApp").style.display = "none";
}

function showTracker() {
  $("authGate").style.display = "none";
  $("trackerApp").style.display = "block";
}

/** ===========================
 *  TIME HELPERS
 *  =========================== */
// supports "HH:MM" or "HH:MM:SS"
function timeStrToMs(str) {
  const parts = str.split(":").map(Number);
  const h = parts[0] ?? 0;
  const m = parts[1] ?? 0;
  const s = parts[2] ?? 0;
  const d = new Date();
  d.setHours(h, m, s, 0);
  return d.getTime();
}

function msToTimeStr(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// HARD STOP: 2:20 PM
function getWorkEndMs() {
  const d = new Date();
  d.setHours(14, 20, 0, 0);
  return d.getTime();
}

function nowMs() {
  if (!state.useManual) return Date.now();

  if (state.manualNowMs == null) {
    state.manualNowMs = timeStrToMs($("manualNow").value);
  }
  return state.manualNowMs;
}

function computeEarned(now) {
  if (!state.startTimeMs) return 0;

  const end = getWorkEndMs();
  const effectiveNow = Math.min(now, end);
  const elapsedSeconds = (effectiveNow - state.startTimeMs) / 1000;

  return Math.max(0, elapsedSeconds) * RATE_PER_SECOND;
}

/** ===========================
 *  SUPABASE STORAGE
 *  Table: tracker_state(user_id uuid pk, state jsonb, updated_at timestamptz)
 *  =========================== */
async function loadCloudState() {
  if (!currentUser) return false;

  const { data, error } = await supabase
    .from("tracker_state")
    .select("state")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error) {
    console.warn("loadCloudState:", error.message);
    return false;
  }

  if (data?.state) {
    state = { ...state, ...data.state };
    return true;
  }
  return false;
}

async function saveCloudState() {
  if (!currentUser) return;

  const { error } = await supabase
    .from("tracker_state")
    .upsert({
      user_id: currentUser.id,
      state,
      updated_at: new Date().toISOString(),
    });

  if (error) console.warn("saveCloudState:", error.message);
}

/** ===========================
 *  UI SYNC / RESTORE
 *  =========================== */
function syncUIFromState() {
  if ($("useManual")) $("useManual").checked = !!state.useManual;

  if ($("manualNow")) {
    if (state.manualNowMs != null) {
      $("manualNow").value = msToTimeStr(state.manualNowMs);
    } else {
      // Keep whatever user typed if no saved manual time
      // but ensure it's a valid HH:MM:SS string
      if (!$("manualNow").value) $("manualNow").value = "08:00:00";
    }
  }
}

// Called after load/sign-in to enforce end time + render
async function restoreAndRender() {
  syncUIFromState();

  const end = getWorkEndMs();
  const current = nowMs();

  // If we are past end time, freeze and stop
  if (state.startTimeMs && current >= end) {
    state.running = false;
    if (state.useManual) state.manualNowMs = end;

    setMoney(computeEarned(end));
    setStatus("Workday ended at 2:20 PM — final saved.");

    stopInterval();
    await saveCloudState();
    return;
  }

  // Normal render
  setMoney(computeEarned(current));

  if (state.running) {
    setStatus(
      state.useManual
        ? `RUNNING (manual) — now ${new Date(current).toLocaleTimeString()}`
        : `RUNNING — now ${new Date(current).toLocaleTimeString()}`
    );
    startInterval();
  } else {
    setStatus("Ready.");
    stopInterval();
  }
}

/** ===========================
 *  TICK LOOP
 *  =========================== */
async function finalizeAtEnd(end) {
  state.running = false;
  if (state.useManual) state.manualNowMs = end;

  setMoney(computeEarned(end));
  setStatus("Workday ended at 2:20 PM — final saved.");

  stopInterval();
  await saveCloudState();
}

function tick() {
  if (!currentUser || !state.running) return;

  const end = getWorkEndMs();

  // If manual mode, advance by 1 second
  if (state.useManual) {
    state.manualNowMs = nowMs() + 1000;
    $("manualNow").value = msToTimeStr(state.manualNowMs);
  }

  const current = nowMs();

  // HARD STOP at 2:20 PM
  if (current >= end) {
    finalizeAtEnd(end);
    return;
  }

  setMoney(computeEarned(current));
  setStatus(
    state.useManual
      ? `RUNNING (manual) — now ${new Date(current).toLocaleTimeString()}`
      : `RUNNING — now ${new Date(current).toLocaleTimeString()}`
  );

  // Throttled cloud saves
  cloudSaveCounter++;
  if (cloudSaveCounter >= CLOUD_SAVE_EVERY_SECONDS) {
    cloudSaveCounter = 0;
    saveCloudState();
  }
}

/** ===========================
 *  INTERVAL HELPERS
 *  =========================== */
function startInterval() {
  if (intervalId) return;
  intervalId = setInterval(tick, 1000);
}

function stopInterval() {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}

/** ===========================
 *  TRACKER CONTROLS (AUTH REQUIRED)
 *  =========================== */
window.start = async function start() {
  if (!currentUser) return;

  state.useManual = $("useManual").checked;

  if (state.useManual) {
    state.manualNowMs = timeStrToMs($("manualNow").value || "08:00:00");
  } else {
    state.manualNowMs = null;
  }

  const current = nowMs();
  const end = getWorkEndMs();

  if (current >= end) {
    // Can't start after end; freeze
    await finalizeAtEnd(end);
    return;
  }

  state.running = true;
  state.startTimeMs = current;

  cloudSaveCounter = 0;
  await saveCloudState();

  await restoreAndRender(); // renders + starts interval
};

window.stop = async function stop() {
  if (!currentUser) return;

  state.running = false;
  stopInterval();
  setStatus("Stopped.");
  await saveCloudState();
};

window.resetAll = async function resetAll() {
  if (!currentUser) return;

  stopInterval();
  cloudSaveCounter = 0;

  state = {
    running: false,
    useManual: false,
    startTimeMs: null,
    manualNowMs: null,
  };

  $("useManual").checked = false;
  $("manualNow").value = "08:00:00";

  setMoney(0);
  setStatus("Reset.");
  await saveCloudState();
};

window.applyManualNow = async function applyManualNow() {
  if (!currentUser) return;

  if (!$("useManual").checked) {
    setStatus("Enable manual time first.");
    return;
  }

  state.useManual = true;
  state.manualNowMs = timeStrToMs($("manualNow").value || "08:00:00");

  const end = getWorkEndMs();
  if (state.manualNowMs >= end) {
    // clamp to end + finalize if running
    state.manualNowMs = end;
    $("manualNow").value = msToTimeStr(end);

    if (state.running) {
      await finalizeAtEnd(end);
      return;
    }
  }

  setMoney(computeEarned(nowMs()));
  setStatus("Manual time applied.");
  await saveCloudState();
};

/** ===========================
 *  AUTH
 *  =========================== */
window.signUp = async function signUp() {
  const email = ($("email").value || "").trim();
  const password = $("password").value || "";

  const { error } = await supabase.auth.signUp({ email, password });
  if (error) {
    setAuthStatus("Sign up error: " + error.message);
    return;
  }

  setAuthStatus("Signed up! Now sign in.");
};

window.signIn = async function signIn() {
  const email = ($("email").value || "").trim();
  const password = $("password").value || "";

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    setAuthStatus("Sign in error: " + error.message);
    return;
  }

  currentUser = data.user;
  setAuthStatus("Signed in as: " + currentUser.email);

  showTracker();

  // Load state from cloud and restore UI
  await loadCloudState();
  await restoreAndRender();
};

window.signOut = async function signOut() {
  await supabase.auth.signOut();

  // Lock immediately
  currentUser = null;

  // Stop any running timer on the client side
  stopInterval();
  intervalId = null;

  // Optional: don’t delete cloud state; it stays saved for next login
  showAuthGate();
  setAuthStatus("Not signed in.");
};

/** ===========================
 *  INIT
 *  =========================== */
document.addEventListener("DOMContentLoaded", async () => {
  // Check existing session
  const { data } = await supabase.auth.getUser();

  if (data?.user) {
    currentUser = data.user;
    setAuthStatus("Signed in as: " + currentUser.email);
    showTracker();

    await loadCloudState();
    await restoreAndRender();
  } else {
    currentUser = null;
    showAuthGate();
    setAuthStatus("Not signed in.");
  }

  // React to auth changes
  supabase.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user) {
      currentUser = session.user;
      setAuthStatus("Signed in as: " + currentUser.email);
      showTracker();

      await loadCloudState();
      await restoreAndRender();
    } else {
      currentUser = null;
      stopInterval();
      showAuthGate();
      setAuthStatus("Not signed in.");
    }
  });
});

