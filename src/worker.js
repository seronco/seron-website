const TONCENTER_V2 = "https://toncenter.com/api/v2";
const MASTER_ADDRESS = "EQAlozhNpK1FGhZJQo8cN86WIQ1K_5nzUTIqn3HNTiP4MOI2";
const DISTRIBUTOR_ADDRESS = "EQAJOJWmLdrRBrFL-zARX6AwJZlTqExazjFD4zHhs6iz_ZtH";

const EXPECTED_TOTAL_SUPPLY = 33000000000000000n; // 33,000,000 SERON, 9 decimals
const LOCKED_ALLOCATION = 31812000000000000n;     // 31,812,000 SERON
const TOTAL_PERIODS = 69;
const PERIOD_SECONDS = 31536000;                   // exactly 365 days
const GENESIS_UTC_SECONDS = Date.parse("2026-09-09T06:33:00Z") / 1000;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseV2Num(entry) {
  // TON HTTP API v2 uses ["num","0x..."]; tolerate typed-object form defensively.
  let value;
  if (Array.isArray(entry) && entry.length >= 2 && entry[0] === "num") value = entry[1];
  else if (entry && entry.type === "num") value = entry.value;
  else throw new Error("Malformed TVM numeric stack entry");

  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Malformed TVM numeric value");
  }
  return BigInt(value);
}

async function tonFetch(path, env, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (env.TONCENTER_API_KEY) headers.set("X-API-Key", env.TONCENTER_API_KEY);

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
  const elapsed = nowSeconds - GENESIS_UTC_SECONDS;
  return Math.min(TOTAL_PERIODS, Math.floor(elapsed / PERIOD_SECONDS));
}

async function getState(env) {
  // One page request triggers one state read. No polling/timer exists.
  // Without an API key TONCenter documents a low request-rate allowance,
  // so the two read-only getters are intentionally sequential.
  const jettonStack = await runGetter(MASTER_ADDRESS, "get_jetton_data", env);

  if (!env.TONCENTER_API_KEY) await sleep(1100);

  const releasedStack = await runGetter(
    DISTRIBUTOR_ADDRESS,
    "get_released_amount",
    env
  );

  const totalSupply = parseV2Num(jettonStack[0]);
  const released = parseV2Num(releasedStack[0]);

  if (totalSupply !== EXPECTED_TOTAL_SUPPLY) {
    throw new Error("Unexpected total supply");
  }
  if (released < 0n || released > LOCKED_ALLOCATION) {
    throw new Error("Released amount out of range");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const currentPeriod = currentPeriodAt(nowSeconds);
  const periodsRemaining = Math.max(0, TOTAL_PERIODS - currentPeriod);
  const locked = LOCKED_ALLOCATION - released;

  return {
    status: "ok",
    network: "mainnet",
    globalId: -239,
    source: "toncenter-mainnet",
    readAt: nowSeconds,
    schedule: {
      genesisUtc: "2026-09-09T06:33:00Z",
      periodSeconds: PERIOD_SECONDS,
      totalPeriods: TOTAL_PERIODS,
    },
    values: {
      totalSupplyBaseUnits: totalSupply.toString(),
      releasedBaseUnits: released.toString(),
      lockedBaseUnits: locked.toString(),
      currentPeriod,
      periodsRemaining,
    },
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/docs" || url.pathname === "/docs/") {
      const docsUrl = new URL(request.url);
      docsUrl.pathname = "/docs/index.html";
      return env.ASSETS.fetch(new Request(docsUrl, request));
    }

    if (url.pathname === "/api/seron-state") {
      if (request.method !== "GET") {
        return json({ status: "error", error: "method_not_allowed" }, 405, {
          allow: "GET",
        });
      }

      try {
        return json(await getState(env));
      } catch (error) {
        // Public response stays generic; detailed provider errors are not exposed.
        console.error("SERON state read failed:", error?.message || String(error));
        return json(
          {
            status: "unavailable",
            network: "mainnet",
            error: "chain_data_unavailable",
          },
          503
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
