const TONCENTER_V2 = "https://toncenter.com/api/v2";
const MASTER_ADDRESS = "EQAlozhNpK1FGhZJQo8cN86WIQ1K_5nzUTIqn3HNTiP4MOI2";
const DISTRIBUTOR_ADDRESS = "EQAJOJWmLdrRBrFL-zARX6AwJZlTqExazjFD4zHhs6iz_ZtH";
const EXPECTED_TOTAL_SUPPLY = 33000000000000000n;
const LOCKED_ALLOCATION = 31812000000000000n;
const TOTAL_PERIODS = 69;
const PERIOD_SECONDS = 31536000;
const GENESIS_UTC_SECONDS = Date.parse("2026-09-09T06:33:00Z") / 1000;
const STATE_CACHE_SECONDS = 86400;
const REQUEST_PREFIX = "presale-request:";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function parseV2Num(entry) {
  let value;
  if (Array.isArray(entry) && entry.length >= 2 && entry[0] === "num") value = entry[1];
  else if (entry && entry.type === "num") value = entry.value;
  else throw new Error("Malformed TVM numeric stack entry");
  return BigInt(value);
}

async function tonFetch(path, env, init = {}) {
  if (!env.TONCENTER_API_KEY) throw new Error("TONCENTER_API_KEY is not configured");

  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  headers.set("X-API-Key", env.TONCENTER_API_KEY);
  if (init.body) headers.set("content-type", "application/json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${TONCENTER_V2}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`TONCenter HTTP ${response.status}`);
    const body = await response.json();
    if (!body || body.ok !== true) throw new Error("TONCenter returned not-ok");
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function getMasterSupply(env) {
  const result = await tonFetch(`/getTokenData?address=${encodeURIComponent(MASTER_ADDRESS)}`, env);
  if (!result || result.address !== MASTER_ADDRESS || result.contract_type !== "jetton_master") {
    throw new Error("Unexpected Master response");
  }
  return BigInt(result.total_supply);
}

async function runGetter(address, method, env) {
  const result = await tonFetch("/runGetMethod", env, {
    method: "POST",
    body: JSON.stringify({ address, method, stack: [] }),
  });
  if (!result || result.exit_code !== 0 || !Array.isArray(result.stack)) {
    throw new Error(`${method}: getter failed`);
  }
  return result.stack;
}

function currentPeriodAt(nowSeconds) {
  if (nowSeconds < GENESIS_UTC_SECONDS) return 0;
  return Math.min(TOTAL_PERIODS, Math.floor((nowSeconds - GENESIS_UTC_SECONDS) / PERIOD_SECONDS));
}

async function getState(env) {
  const totalSupply = await getMasterSupply(env);
  const releasedStack = await runGetter(DISTRIBUTOR_ADDRESS, "get_released_amount", env);
  const released = parseV2Num(releasedStack[0]);

  if (totalSupply !== EXPECTED_TOTAL_SUPPLY) throw new Error("Unexpected total supply");
  if (released < 0n || released > LOCKED_ALLOCATION) throw new Error("Released amount out of range");

  const nowSeconds = Math.floor(Date.now() / 1000);
  const currentPeriod = currentPeriodAt(nowSeconds);

  return {
    status: "ok",
    network: "mainnet",
    globalId: -239,
    source: "toncenter-mainnet",
    readAt: nowSeconds,
    cacheTtlSeconds: STATE_CACHE_SECONDS,
    schedule: {
      genesisUtc: "2026-09-09T06:33:00Z",
      periodSeconds: PERIOD_SECONDS,
      totalPeriods: TOTAL_PERIODS,
    },
    values: {
      totalSupplyBaseUnits: totalSupply.toString(),
      releasedBaseUnits: released.toString(),
      lockedBaseUnits: (LOCKED_ALLOCATION - released).toString(),
      currentPeriod,
      periodsRemaining: Math.max(0, TOTAL_PERIODS - currentPeriod),
    },
  };
}

async function getCachedStateResponse(request, env, ctx) {
  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("x-seron-cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  const data = await getState(env);
  const fresh = new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${STATE_CACHE_SECONDS}`,
      "x-content-type-options": "nosniff",
      "x-seron-cache": "MISS",
    },
  });

  ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
  return fresh;
}

function validTonAddress(address) {
  if (typeof address !== "string") return false;
  return /^-?1:[0-9a-fA-F]{64}$/.test(address) ||
    /^0:[0-9a-fA-F]{64}$/.test(address) ||
    /^[EU]Q[A-Za-z0-9_-]{46}$/.test(address);
}

async function storePresaleRequest(request, env) {
  if (!env.PRESALE_REQUESTS) {
    return json({ status: "unavailable", error: "request_store_not_configured" }, 503);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ status: "error", error: "invalid_json" }, 400); }

  const address = String(body?.address || "").trim();
  if (!validTonAddress(address)) return json({ status: "error", error: "invalid_ton_address" }, 400);

  const key = REQUEST_PREFIX + address.toLowerCase();
  let existing = null;
  try { existing = await env.PRESALE_REQUESTS.get(key, "json"); } catch {}

  if (!existing) {
    const record = { address, submittedAt: new Date().toISOString(), status: "REQUESTED" };
    await env.PRESALE_REQUESTS.put(key, JSON.stringify(record));
  }

  return json({ status: "ok", requestStatus: "received" }, 200);
}

async function listPresaleRequests(request, env) {
  if (!env.PRESALE_REQUESTS || !env.PRESALE_ADMIN_TOKEN) return json({ status: "unavailable" }, 503);

  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.PRESALE_ADMIN_TOKEN}`) {
    return json({ status: "error", error: "unauthorized" }, 401);
  }

  const found = [];
  let cursor;
  do {
    const page = await env.PRESALE_REQUESTS.list({ prefix: REQUEST_PREFIX, cursor });
    for (const key of page.keys) {
      const rec = await env.PRESALE_REQUESTS.get(key.name, "json");
      if (rec) found.push(rec);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && found.length < 5000);

  found.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  return json({ status: "ok", count: found.length, requests: found });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/docs" || url.pathname === "/docs/") {
      const u = new URL(request.url);
      u.pathname = "/docs/index.html";
      return env.ASSETS.fetch(new Request(u, request));
    }

    if (url.pathname === "/api/seron-state") {
      if (request.method !== "GET") return json({ status: "error", error: "method_not_allowed" }, 405, { allow: "GET" });
      try {
        return await getCachedStateResponse(request, env, ctx);
      } catch (error) {
        console.error("SERON state read failed:", error?.message || String(error));
        return json({ status: "unavailable", network: "mainnet", error: "chain_data_unavailable" }, 503);
      }
    }

    if (url.pathname === "/api/presale-request") {
      if (request.method !== "POST") return json({ status: "error", error: "method_not_allowed" }, 405, { allow: "POST" });
      return storePresaleRequest(request, env);
    }

    if (url.pathname === "/api/admin/presale-requests") {
      if (request.method !== "GET") return json({ status: "error", error: "method_not_allowed" }, 405, { allow: "GET" });
      return listPresaleRequests(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
