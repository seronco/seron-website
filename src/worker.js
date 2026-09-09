const TONCENTER = "https://toncenter.com/api/v3";
const MASTER_ADDRESS = "EQAlozhNpK1FGhZJQo8cN86WIQ1K_5nzUTIqn3HNTiP4MOI2";
const DISTRIBUTOR_ADDRESS = "EQAJOJWmLdrRBrFL-zARX6AwJZlTqExazjFD4zHhs6iz_ZtH";

const LOCKED_ALLOCATION = 31812000000000000n;
const TOTAL_PERIODS = 69;
const MAX_HEAD_AGE_SECONDS = 180;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=30",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function parseNum(entry) {
  if (!entry || entry.type !== "num" || typeof entry.value !== "string") {
    throw new Error("Malformed TVM numeric stack entry");
  }
  return BigInt(entry.value);
}

async function tonFetch(path, env, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");

  // Recommended: configure as a Cloudflare Worker Secret.
  if (env.TONCENTER_API_KEY) {
    headers.set("X-API-Key", env.TONCENTER_API_KEY);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(`${TONCENTER}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`TONCenter HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function runGetter(address, method, stack, env) {
  const result = await tonFetch("/runGetMethod", env, {
    method: "POST",
    body: JSON.stringify({ address, method, stack }),
  });

  if (!result || result.exit_code !== 0 || !Array.isArray(result.stack)) {
    throw new Error(`${method}: getter failed`);
  }
  return result.stack;
}

async function getState(env) {
  // Head first: proves Mainnet and gives canonical chain time.
  const head = await tonFetch("/masterchainInfo", env);
  const last = head?.last;
  if (!last) throw new Error("Missing masterchain head");

  const globalId = Number(last.global_id);
  const headTime = Number(last.gen_utime);
  const headSeqno = Number(last.seqno);
  const now = Math.floor(Date.now() / 1000);

  if (globalId !== -239) throw new Error("Not TON Mainnet");
  if (!Number.isInteger(headTime) || headTime <= 0) throw new Error("Invalid head time");
  if (Math.abs(now - headTime) > MAX_HEAD_AGE_SECONDS) throw new Error("Stale masterchain head");

  const [jettonStack, releasedStack, periodStack] = await Promise.all([
    runGetter(MASTER_ADDRESS, "get_jetton_data", [], env),
    runGetter(DISTRIBUTOR_ADDRESS, "get_released_amount", [], env),
    runGetter(
      DISTRIBUTOR_ADDRESS,
      "get_period_at",
      [{ type: "num", value: String(headTime) }],
      env
    ),
  ]);

  const totalSupply = parseNum(jettonStack[0]);
  const released = parseNum(releasedStack[0]);
  const periodRaw = Number(parseNum(periodStack[0]));

  if (totalSupply !== 33000000000000000n) {
    throw new Error("Unexpected total supply");
  }
  if (released < 0n || released > LOCKED_ALLOCATION) {
    throw new Error("Released amount out of range");
  }
  if (!Number.isInteger(periodRaw) || periodRaw < 0 || periodRaw > TOTAL_PERIODS) {
    throw new Error("Period out of range");
  }

  const locked = LOCKED_ALLOCATION - released;
  const remaining = Math.max(0, TOTAL_PERIODS - periodRaw);

  return {
    status: "ok",
    network: "mainnet",
    globalId,
    head: {
      seqno: headSeqno,
      genUtime: headTime,
    },
    values: {
      totalSupplyBaseUnits: totalSupply.toString(),
      releasedBaseUnits: released.toString(),
      lockedBaseUnits: locked.toString(),
      currentPeriod: periodRaw,
      periodsRemaining: remaining,
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
          "allow": "GET",
        });
      }

      try {
        return json(await getState(env));
      } catch (error) {
        // Fail closed: never substitute hardcoded/stale blockchain values.
        return json(
          {
            status: "unavailable",
            network: "mainnet",
            error: "chain_data_unavailable",
          },
          503,
          { "cache-control": "no-store" }
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
