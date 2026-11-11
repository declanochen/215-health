// Pulls one summary row per day from the Google Health API for The 215 Log.
//
// Usage:  node sync/fetch.mjs --start 2026-10-12 --end 2026-11-11 [--out out/health.json]
//   --end is exclusive. Dates are America/New_York calendar days.
//
// Credentials (never stored in this repo):
//   Local Mac: read from ~/.google-health-mcp/ (written by `google-health-mcp-unofficial setup/auth`).
//   Cloud:     GOOGLE_HEALTH_CLIENT_ID, GOOGLE_HEALTH_CLIENT_SECRET and GOOGLE_HEALTH_REFRESH_TOKEN
//              environment variables. A throwaway token file is created in a temp folder.
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const TZ = "America/New_York";
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));

const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const localToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

const end = isDate(args.end) ? args.end : addDays(localToday(), 1);
const start = isDate(args.start) ? args.start : addDays(end, -8);
if (start >= end) { console.error("start must be before end"); process.exit(2); }

// Cloud mode: build a temporary token file from the refresh token.
if (process.env.GOOGLE_HEALTH_REFRESH_TOKEN) {
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  const p = join(dir, "run.tokens.json");
  writeFileSync(p, JSON.stringify({ access_token: "expired", expires_at: 1, token_type: "Bearer", refresh_token: process.env.GOOGLE_HEALTH_REFRESH_TOKEN.trim() }), { mode: 0o600 });
  process.env.GOOGLE_HEALTH_TOKEN_PATH = p;
  process.env.GOOGLE_HEALTH_REDIRECT_URI ||= "http://127.0.0.1:3000/callback";
}
process.env.GOOGLE_HEALTH_CACHE = "false";

const { getConfig } = await import("google-health-mcp-unofficial/dist/services/config.js");
const { GoogleHealthClient } = await import("google-health-mcp-unofficial/dist/services/google-health-client.js");
const client = new GoogleHealthClient(getConfig());

const days = {};
const row = date => (days[date] ||= { date });
const inRange = date => date >= start && date < end;
const ymd = d => d && d.year ? `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}` : null;
const num = v => (v === undefined || v === null || v === "" ? null : Number(v));
const secs = v => (typeof v === "string" && v.endsWith("s") ? Number(v.slice(0, -1)) : null);
const errors = [];

async function rollup(dataType, pick) {
  // Some types (total-calories) cap a rollup request at 14 days, so ask in 14-day chunks.
  for (let s = start; s < end; s = addDays(s, 14)) {
    const e = addDays(s, 14) < end ? addDays(s, 14) : end;
    try {
      const res = await client.dailyRollup({ dataType, startDate: s, endDate: e, timezone: TZ, pageSize: 14 });
      for (const p of res.rollupDataPoints || []) {
        const date = ymd(p.civilStartTime && p.civilStartTime.date);
        if (date && inRange(date)) pick(row(date), p);
      }
    } catch (err) { errors.push(`${dataType} ${s}: ${String(err.message || err).slice(0, 160)}`); }
  }
}

// Lists come back newest first for daily types; stop once a page is entirely older than `start`.
async function list(dataType, dateOf, pick, maxPages = 30) {
  try {
    let pageToken;
    for (let i = 0; i < maxPages; i++) {
      const res = await client.listDataPoints({ dataType, pageSize: 500, pageToken });
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
  } catch (e) { errors.push(`${dataType}: ${String(e.message || e).slice(0, 160)}`); }
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
  const off = secs(iv.endUtcOffset) || 0;
  return new Date(Date.parse(iv.endTime) + off * 1000).toISOString().slice(0, 10);
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
