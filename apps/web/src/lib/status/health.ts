// The keeper's and the maker's health snapshots (services/keeper/src/health.ts,
// services/maker/src/health.ts), reduced to the fields the status page shows. The app fetches them
// through its own route (/api/health/<service>) because the services' /health endpoints send no CORS
// headers; the route passes on only these fields, each checked for type and length.

export type ServiceName = "keeper" | "maker";

export interface LastAction {
  at?: string;
  market?: string;
  action?: string;
  status?: string;
  hash?: string;
  url?: string;
}

export interface JobView {
  lastRunAt?: string;
  lastActionAt?: string;
  lastAction?: LastAction;
  lastError?: string;
  lastErrorAt?: string;
}

export interface ServiceHealthView {
  service: ServiceName;
  /** False when no health URL is set for this deployment. */
  configured: boolean;
  /** True when the endpoint answered with JSON. */
  reachable: boolean;
  error?: string;
  updatedAt?: string;
  lastCycleAt?: string;
  enabled?: boolean;
  address?: string;
  network?: string;
  /** MON, as the service wrote it ("12.5"). */
  monBalance?: string;
  lowBalance?: boolean;
  lastError?: string;
  lastErrorAt?: string;
  /** Maker only. */
  lastQuoteAt?: string;
  openOrders?: number;
  /** Keeper only: per job. */
  jobs?: Record<string, JobView>;
}

const MAX = 300;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, MAX) : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined;
/** A MON amount as the services write it (viem's formatEther, like "12.5"). */
const decimal = (v: unknown): string | undefined =>
  typeof v === "string" && /^\d{1,30}(\.\d{1,18})?$/.test(v) ? v : undefined;
const url = (v: unknown): string | undefined => {
  const s = str(v);
  return s && /^https:\/\/[^\s]+$/.test(s) ? s : undefined;
};

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function action(v: unknown): LastAction | undefined {
  if (!v || typeof v !== "object") return undefined;
  const a = v as Record<string, unknown>;
  const out = compact({
    at: str(a.at),
    market: str(a.market),
    action: str(a.action),
    status: str(a.status),
    hash: typeof a.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(a.hash) ? a.hash : undefined,
    url: url(a.url),
  });
  return Object.keys(out).length > 0 ? out : undefined;
}

const KEEPER_JOBS = ["discover", "graduate", "claims", "settle", "void", "payouts"] as const;

/** Only the known fields, each checked. Anything else in the service's JSON is dropped. */
export function sanitizeHealth(service: ServiceName, raw: unknown): ServiceHealthView {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      service,
      configured: true,
      reachable: false,
      error: "The health endpoint did not send a JSON object.",
    };
  }
  const h = raw as Record<string, unknown>;
  const view: ServiceHealthView = compact({
    service,
    configured: true,
    reachable: true,
    updatedAt: str(h.updatedAt),
    lastCycleAt: str(h.lastCycleAt),
    enabled: bool(h.enabled),
    address: str(service === "keeper" ? h.keeper : h.maker),
    network: str(h.network),
    monBalance: decimal(h.monBalance),
    lowBalance: bool(h.lowBalance),
    lastError: str(h.lastError),
    lastErrorAt: str(h.lastErrorAt),
    lastQuoteAt: service === "maker" ? str(h.lastQuoteAt) : undefined,
    openOrders: service === "maker" ? int(h.openOrders) : undefined,
  });
  if (service === "keeper" && h.jobs && typeof h.jobs === "object") {
    const jobs: Record<string, JobView> = {};
    for (const name of KEEPER_JOBS) {
      const j = (h.jobs as Record<string, unknown>)[name];
      if (!j || typeof j !== "object") continue;
      const r = j as Record<string, unknown>;
      jobs[name] = compact({
        lastRunAt: str(r.lastRunAt),
        lastActionAt: str(r.lastActionAt),
        lastAction: action(r.lastAction),
        lastError: str(r.lastError),
        lastErrorAt: str(r.lastErrorAt),
      });
    }
    view.jobs = jobs;
  }
  return view;
}

/** The health URL for a service, from the build-time public variables (or the server-only names). */
export function healthUrl(service: ServiceName, env: Record<string, string | undefined>): string | undefined {
  const raw =
    service === "keeper"
      ? (env.NEXT_PUBLIC_KEEPER_HEALTH_URL ?? env.KEEPER_HEALTH_URL)
      : (env.NEXT_PUBLIC_MAKER_HEALTH_URL ?? env.MAKER_HEALTH_URL);
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Fetches and sanitizes one service's health. Never throws. */
export async function fetchServiceHealth(
  service: ServiceName,
  target: string | undefined,
  fetchImpl: Fetch = fetch,
  timeoutMs = 6_000,
): Promise<ServiceHealthView> {
  if (!target) return { service, configured: false, reachable: false };
  try {
    const res = await fetchImpl(target, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok)
      return { service, configured: true, reachable: false, error: `The endpoint answered ${res.status}.` };
    const text = await res.text();
    if (text.length > 500_000) {
      return { service, configured: true, reachable: false, error: "The endpoint sent too much data." };
    }
    return sanitizeHealth(service, JSON.parse(text));
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      service,
      configured: true,
      reachable: false,
      error: timedOut ? "The endpoint did not answer in time." : "The endpoint could not be reached.",
    };
  }
}
