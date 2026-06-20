/**
 * Local-only Pulse event helpers.
 *
 * The public repo ships with no backend analytics. These helpers keep the app
 * code simple while preserving a tiny local play counter used only for return
 * timing math. Forks can replace `track` with their own consent-based analytics.
 */

const STORE_KEY = "pulse.beacon.v1";
const DAY_MS = 86_400_000;
const ROTATE_AFTER_MS = 30 * DAY_MS;

interface BeaconState {
  deviceId: string;
  firstSeen: string;
  lastPlayed?: string;
  plays: number;
}

export interface ReturnInfo {
  isReturn: boolean;
  isD1Return: boolean;
  daysSinceFirstSeen: number;
  hoursSinceLastPlayed: number | null;
  plays: number;
}

export function computeReturnInfo(state: BeaconState, nowIso: string): ReturnInfo {
  const now = Date.parse(nowIso);
  const first = Date.parse(state.firstSeen);
  const last = state.lastPlayed ? Date.parse(state.lastPlayed) : null;
  const hoursSince = last != null ? (now - last) / 3_600_000 : null;
  const utcDay = (t: number) => Math.floor(t / DAY_MS);
  return {
    isReturn: last != null && utcDay(last) < utcDay(now),
    isD1Return: hoursSince != null && hoursSince >= 12 && hoursSince <= 48,
    daysSinceFirstSeen: Math.round(((now - first) / DAY_MS) * 10) / 10,
    hoursSinceLastPlayed: hoursSince != null ? Math.round(hoursSince * 10) / 10 : null,
    plays: state.plays,
  };
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

function loadState(): BeaconState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || "null") as BeaconState | null;
    if (raw && raw.deviceId && raw.firstSeen) {
      if (Date.now() - Date.parse(raw.firstSeen) <= ROTATE_AFTER_MS) return raw;
    }
  } catch {
    /* corrupt/private mode -> fresh */
  }
  return { deviceId: randomId(), firstSeen: new Date().toISOString(), plays: 0 };
}

function saveState(s: BeaconState): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* private mode: non-fatal */
  }
}

export function track(event: string, props: Record<string, unknown> = {}): void {
  void event;
  void props;
  // Public build: intentionally no remote analytics.
}

export function trackPlay(props: Record<string, unknown> = {}): void {
  void props;
  const s = loadState();
  computeReturnInfo(s, new Date().toISOString());
  s.lastPlayed = new Date().toISOString();
  s.plays += 1;
  saveState(s);
}
