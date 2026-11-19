import { PlatformSetting } from "../../models/PlatformSetting";

/**
 * Live USD → INR rate for turning Groq's dollar prices into rupees. Fetched
 * from free, keyless sources at most every 12 hours, saved in the platform
 * settings so a restart (or an outage of the source) keeps the last good rate.
 */
export interface FxRate {
  rate: number;
  /** Date the source says the rate is for. */
  asOf: string;
  source: string;
  fetchedAt: string;
}

const REFRESH_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 15 * 60 * 1000;
/** A rate outside this band is a bad answer, not a real market move. */
const SANE = (r: unknown): r is number => typeof r === "number" && r > 50 && r < 200;

const SOURCES: { name: string; url: string; read: (j: any) => { rate: unknown; asOf: string } }[] = [
  {
    name: "ExchangeRate-API (open.er-api.com)",
    url: "https://open.er-api.com/v6/latest/USD",
    read: (j) => ({ rate: j?.rates?.INR, asOf: j?.time_last_update_unix ? new Date(j.time_last_update_unix * 1000).toISOString() : new Date().toISOString() }),
  },
  {
    name: "Frankfurter (ECB reference rate)",
    url: "https://api.frankfurter.dev/v1/latest?from=USD&to=INR",
    read: (j) => ({ rate: j?.rates?.INR, asOf: j?.date ? `${j.date}T00:00:00.000Z` : new Date().toISOString() }),
  },
];

let current: FxRate | null = null;
let loaded = false;
let lastTry = 0;
let inFlight: Promise<FxRate | null> | null = null;

async function fetchFromSources(): Promise<FxRate | null> {
  for (const s of SOURCES) {
    try {
      const res = await fetch(s.url, { signal: AbortSignal.timeout(6000), headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const { rate, asOf } = s.read(await res.json());
      if (SANE(rate)) return { rate: Math.round(rate * 10000) / 10000, asOf, source: s.name, fetchedAt: new Date().toISOString() };
    } catch {
      // try the next source
    }
  }
  return null;
}

/** Fetch now (admin "refresh" button, or when the saved rate is old). Keeps the old rate if every source fails. */
export async function refreshUsdToInr(): Promise<FxRate | null> {
  if (inFlight) return inFlight;
  lastTry = Date.now();
  inFlight = (async () => {
    const fresh = await fetchFromSources();
    if (fresh) {
      current = fresh;
      await PlatformSetting.updateOne({ key: "global" }, { $set: { fxRate: fresh } }, { upsert: true }).catch(() => undefined);
    }
    return current;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * The last known live rate, straight away. Starts a background refresh when
 * it's older than 12 hours, so pricing a call never waits on the network
 * (except the very first time, when nothing is known yet).
 */
export async function liveUsdToInr(): Promise<FxRate | null> {
  if (!loaded) {
    loaded = true;
    const doc = await PlatformSetting.findOne({ key: "global" }, { fxRate: 1 }).lean();
    const saved = (doc as { fxRate?: FxRate } | null)?.fxRate;
    if (saved && SANE(saved.rate)) current = saved;
    if (!current) return refreshUsdToInr();
  }
  const age = current ? Date.now() - new Date(current.fetchedAt).getTime() : Infinity;
  if (age > REFRESH_MS && Date.now() - lastTry > RETRY_MS) void refreshUsdToInr();
  return current;
}
