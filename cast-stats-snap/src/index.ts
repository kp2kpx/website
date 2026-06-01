import { Hono } from "hono";
import { SPEC_VERSION, type SnapFunction, type SnapHandlerResult } from "@farcaster/snap";
import { registerSnapHandler } from "@farcaster/snap-hono";

// Use NEYNAR_API_DOCS as the default — free demo key for the Neynar REST API.
// Set NEYNAR_API_KEY in your deployment env for higher rate limits.
const NEYNAR_API_KEY = () => process.env.NEYNAR_API_KEY ?? "NEYNAR_API_DOCS";

interface CastStats {
  d1: number;
  w1: number;
  m1: number;
  y1: number;
  total: number;
  truncated: boolean;
  error?: string;
}

async function fetchCastStats(fid: number): Promise<CastStats> {
  const now = Math.floor(Date.now() / 1000);
  const cutoffs = {
    d1: now - 86400,
    w1: now - 86400 * 7,
    m1: now - 86400 * 30,
    y1: now - 86400 * 365,
  };

  const stats: CastStats = { d1: 0, w1: 0, m1: 0, y1: 0, total: 0, truncated: false };
  let cursor: string | undefined;
  const MAX_PAGES = 30; // max 3,000 casts examined

  for (let page = 0; page < MAX_PAGES; page++) {
    // Use the Neynar REST API — works with the NEYNAR_API_DOCS demo key
    const url = new URL("https://api.neynar.com/v2/farcaster/feed/user/casts");
    url.searchParams.set("fid", String(fid));
    url.searchParams.set("limit", "150");
    url.searchParams.set("include_replies", "false");
    if (cursor) url.searchParams.set("cursor", cursor);

    let data: {
      casts?: Array<{ timestamp: string }>;
      next?: { cursor?: string };
    };

    try {
      const res = await fetch(url.toString(), {
        headers: { "x-api-key": NEYNAR_API_KEY(), "accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { d1: 0, w1: 0, m1: 0, y1: 0, total: 0, truncated: false, error: `API ${res.status}: ${body.slice(0, 80)}` };
      }
      data = (await res.json()) as typeof data;
    } catch (e) {
      return { d1: 0, w1: 0, m1: 0, y1: 0, total: 0, truncated: false, error: String(e).slice(0, 80) };
    }

    const casts = data.casts ?? [];
    if (casts.length === 0) break;

    for (const cast of casts) {
      const ts = Math.floor(new Date(cast.timestamp).getTime() / 1000);
      stats.total++;
      if (ts >= cutoffs.y1) {
        stats.y1++;
        if (ts >= cutoffs.m1) {
          stats.m1++;
          if (ts >= cutoffs.w1) {
            stats.w1++;
            if (ts >= cutoffs.d1) stats.d1++;
          }
        }
      }
    }

    const nextCursor = data.next?.cursor;
    if (!nextCursor) break;

    // Check oldest cast on this page — if before 1 year, stop paginating
    const oldest = casts[casts.length - 1];
    const oldestTs = Math.floor(new Date(oldest.timestamp).getTime() / 1000);
    if (oldestTs < cutoffs.y1) break;

    cursor = nextCursor;
    if (page === MAX_PAGES - 1) stats.truncated = true;
  }

  return stats;
}

function fmt(n: number, truncated = false): string {
  const suffix = truncated ? "+" : "";
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k${suffix}`;
  return `${n}${suffix}`;
}

function snapBase(request: Request): string {
  const fromEnv = process.env.SNAP_PUBLIC_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const host =
    (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))
      ?.split(",")[0]
      .trim();
  const isLoopback =
    host !== undefined &&
    /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/.test(host);
  const proto =
    (request.headers.get("x-forwarded-proto") ?? "")
      .split(",")[0]
      .trim()
      .toLowerCase() || (isLoopback ? "http" : "https");
  if (host) return `${proto}://${host}`;
  return `http://localhost:${process.env.PORT ?? "3003"}`;
}

const snap: SnapFunction = async (ctx): Promise<SnapHandlerResult> => {
  const base = snapBase(ctx.request);
  const target = `${base}/`;

  // Stats page — requires a real FID from a POST
  if (ctx.action.type === "post" && ctx.action.user?.fid) {
    const fid = ctx.action.user.fid;
    let stats: CastStats;
    try {
      stats = await fetchCastStats(fid);
    } catch {
      stats = { d1: 0, w1: 0, m1: 0, y1: 0, total: 0, truncated: false };
    }

    const bars = [
      { label: "Last day", value: stats.d1 },
      { label: "Last week", value: stats.w1 },
      { label: "Last month", value: stats.m1 },
      { label: "Last year", value: stats.y1 },
      { label: "All time", value: stats.total },
    ];

    const children = stats.error
      ? ["heading", "errMsg", "refresh"]
      : ["heading", "chart", "refresh"];

    return {
      version: SPEC_VERSION,
      theme: { accent: "purple" },
      ui: {
        root: "page",
        elements: {
          page: {
            type: "stack",
            props: {},
            children,
          },
          heading: {
            type: "text",
            props: { content: "Your Cast Stats", weight: "bold" },
          },
          errMsg: {
            type: "text",
            props: { content: stats.error ?? "", size: "sm" },
          },
          chart: {
            type: "bar_chart",
            props: {
              bars,
              color: "accent",
            },
          },
          refresh: {
            type: "button",
            props: { label: stats.truncated ? "Refresh (3k+ casts, may be partial)" : "Refresh" },
            on: { press: { action: "submit", params: { target } } },
          },
        },
      },
    };
  }

  // Welcome screen — anonymous GET (or POST without FID)
  return {
    version: SPEC_VERSION,
    theme: { accent: "purple" },
    ui: {
      root: "page",
      elements: {
        page: {
          type: "stack",
          props: {},
          children: ["heading", "desc", "btn"],
        },
        heading: {
          type: "text",
          props: { content: "Cast Stats", weight: "bold" },
        },
        desc: {
          type: "text",
          props: {
            content:
              "See how many casts you've made in the last day, week, month, year, and all time.",
          },
        },
        btn: {
          type: "button",
          props: { label: "Check my stats", variant: "primary" },
          on: { press: { action: "submit", params: { target } } },
        },
      },
    },
  };
};

const app = new Hono();

registerSnapHandler(app, snap, {
  openGraph: {
    title: "Cast Stats",
    description: "Your Farcaster cast counts by day, week, month, year, and all time.",
  },
});

export default app;
