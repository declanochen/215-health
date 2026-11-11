// Pulls one summary row per day from the Google Health API (v4) for The 215 Log.
// No dependencies: plain Node 18+ (uses built-in fetch).
//
// Usage:  node sync/fetch.mjs --start 2026-10-12 --end 2026-11-11 [--out out/health.json]
//   --end is exclusive. Dates are the account's local calendar days (America/New_York).
//
// Credentials (never stored in this repo):
//   Env vars GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET, GOOGLE_HEALTH_REFRESH_TOKEN, or
//   on the Mac, ~/.google-health-mcp/config.json + tokens.json (written by google-health-mcp-unofficial auth).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const TZ = "America/New_York";
const API = "https://health.googleapis.com";
const args = {};
process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith("--")) args[a.slice(2)] = all[i + 1]; });

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const end = isDate(args.end) ? args.end : addDays(localToday(), 1);
const start = isDate(args.start) ? args.start : addDays(end, -8);
if (start >= end) { console.error("start must be before end"); process.exit(2); }

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }
const localDir = join(homedir(), ".google-health-mcp");
const cfg = readJson(join(localDir, "config.json")), tok = readJson(join(localDir, "tokens.json"));
const clientId = process.env.GOOGLE_HEALTH_CLIENT_ID || cfg.GOOGLE_HEALTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET || cfg.GOOGLE_HEALTH_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_HEALTH_REFRESH_TOKEN || tok.refresh_token;
const missing = [["GOOGLE_HEALTH_CLIENT_ID", clientId], ["GOOGLE_HEALTH_CLIENT_SECRET", clientSecret], ["GOOGLE_HEALTH_REFRESH_TOKEN", refreshToken]].filter(x => !x[1]).map(x => x[0]);
if (missing.length) { console.error("Missing credentials: " + missing.join(", ")); process.exit(3); }

// Exchange the refresh token for a short-lived access token.
const tr = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }).toString()
});
const tj = await tr.json().catch(() => ({}));
if (!tr.ok || !tj.access_token) {
  const msg = `token refresh failed: HTTP ${tr.status} ${tj.error || ""} ${tj.error_description || ""}`.trim();
  const result = { source: "google_health", start, end, fetchedAt: new Date().toISOString(), days: [], errors: [msg] };
  if (args.out) { mkdirSync(dirname(args.out), { recursive: true }); writeFileSync(args.out, JSON.stringify(result, null, 2)); }
  console.error(msg); process.exit(4);
}
const auth = { Authorization: `Bearer ${tj.access_token}`, Accept: "application/json" };

async function call(method, path, params, body) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { method, headers: body ? { ...auth, "Content-Type": "application/json" } : auth, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429 || r.status >= 500) { await new Promise(res => setTimeout(res, 1000 * (attempt + 1))); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(j.error && j.error.message) || "request failed"}`);
    return j;
  }
  throw new Error("HTTP retry limit");
}

const days = {};
const row = date => (days[date] ||= { date });
const inRange = date => date >= start && date < end;
const ymd = d => d && d.year ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null;
const num = v => (v === undefined || v === null || v === "" ? null : Number(v));
const secs = v => (typeof v === "string" && v.endsWith("s") ? Number(v.slice(0, -1)) : null);
const civil = s => { const [year, month, day] = s.split("-").map(Number); return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } }; };
const errors = [];

async function rollup(dataType, pick) {
  // Some types (total-calories) cap a rollup at 14 days, so ask in 14-day chunks.
  for (let s = start; s < end; s = addDays(s, 14)) {
    const e = addDays(s, 14) < end ? addDays(s, 14) : end;
    try {
      const res = await call("POST", `/v4/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`, null, { range: { start: civil(s), end: civil(e) }, windowSizeDays: 1, pageSize: 14 });
      for (const p of res.rollupDataPoints || []) {
        const date = ymd(p.civilStartTime && p.civilStartTime.date);
        if (date && inRange(date)) pick(row(date), p);
      }
    } catch (err) { errors.push(`${dataType} ${s}: ${String(err.message || err).slice(0, 160)}`); }
  }
}

// Daily lists come back newest first; stop once a whole page is older than `start`.
async function list(dataType, dateOf, pick, maxPages = 30) {
  try {
    let pageToken;
    for (let i = 0; i < maxPages; i++) {
      const res = await call("GET", `/v4/users/me/dataTypes/${dataType}/dataPoints`, { pageSize: 500, pageToken });
      const pts = res.dataPoints || [];
      let anyNewer = false;
      for (const p of pts) {
        const date = dateOf(p);
        if (!date) continue;
        if (date >= start) anyNewer = true;
        if (inRange(date)) pick(row(date), p);
      }
      pageToken = res.nextPageToken;
      if (!pageToken || (!anyNewer && pts.length && dataType !== "weight")) break;
    }
  } catch (err) { errors.push(`${dataType}: ${String(err.message || err).slice(0, 160)}`); }
}

await rollup("steps", (r, p) => { r.steps = num(p.steps && p.steps.countSum); });
await rollup("total-calories", (r, p) => { const k = p.totalCalories && p.totalCalories.kcalSum; r.calories = k == null ? null : Math.round(k); });
await rollup("active-zone-minutes", (r, p) => {
  const a = p.activeZoneMinutes || {};
  r.azm = { fatBurn: num(a.sumInFatBurnHeartZone) || 0, cardio: num(a.sumInCardioHeartZone) || 0, peak: num(a.sumInPeakHeartZone) || 0 };
});
await rollup("time-in-heart-rate-zone", (r, p) => {
  const z = {};
  for (const t of (p.timeInHeartRateZone && p.timeInHeartRateZone.timeInHeartRateZones) || []) z[t.heartRateZone] = Math.round((secs(t.duration) || 0) / 60);
  // Fitbit's MODERATE zone is the closest match to Zone 2; VIGOROUS is Zone 3 and up.
  r.zones = { light: z.LIGHT || 0, moderate: z.MODERATE || 0, vigorous: z.VIGOROUS || 0 };
});
await list("daily-resting-heart-rate", p => ymd(p.dailyRestingHeartRate && p.dailyRestingHeartRate.date),
  (r, p) => { r.rhr = num(p.dailyRestingHeartRate.beatsPerMinute); });
await list("daily-heart-rate-variability", p => ymd(p.dailyHeartRateVariability && p.dailyHeartRateVariability.date),
  (r, p) => { const v = p.dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds; r.hrv = v == null ? null : Math.round(v * 10) / 10; });
// Sleep counts toward the day you wake up (local time).
const wakeDate = p => {
  const iv = p.sleep && p.sleep.interval; if (!iv || !iv.endTime) return null;
  return new Date(Date.parse(iv.endTime) + (secs(iv.endUtcOffset) || 0) * 1000).toISOString().slice(0, 10);
};
await list("sleep", wakeDate, (r, p) => {
  const s = p.sleep, sum = s.summary || {};
  if (s.metadata && s.metadata.mainSleep === false) return;
  const st = {}; for (const x of sum.stagesSummary || []) st[x.type] = num(x.minutes);
  const asleep = num(sum.minutesAsleep);
  if (asleep == null || (r.sleepMin != null && r.sleepMin >= asleep)) return;
  r.sleepMin = asleep; r.deepMin = st.DEEP ?? null; r.remMin = st.REM ?? null; r.awakeMin = num(sum.minutesAwake);
});
// Weight: keep the latest reading of each day, in pounds.
await list("weight", p => ymd(p.weight && p.weight.sampleTime && p.weight.sampleTime.civilTime && p.weight.sampleTime.civilTime.date), (r, p) => {
  const t = p.weight.sampleTime.physicalTime || "";
  if (r._wt && r._wt >= t) return;
  r._wt = t; r.weightLb = Math.round(p.weight.weightGrams / 453.59237 * 10) / 10;
});

const out = Object.values(days).map(r => { delete r._wt; return r; }).sort((a, b) => (a.date < b.date ? -1 : 1));
const result = { source: "google_health", timezone: TZ, start, end, fetchedAt: new Date().toISOString(), days: out, errors };
const json = JSON.stringify(result, null, 2);
if (args.out) { mkdirSync(dirname(args.out), { recursive: true }); writeFileSync(args.out, json); console.log(`Wrote ${out.length} days to ${args.out}${errors.length ? ` (${errors.length} errors)` : ""}`); }
else process.stdout.write(json + "\n");
if (errors.length) console.error("Errors:\n" + errors.join("\n"));
