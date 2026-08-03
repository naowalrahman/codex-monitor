/**
 * Bundled custom probe: `http`, endpoint readiness.
 *
 * Install: copy this file into `$(codex-monitor home)/probes/` and restart
 * Codex. Then create monitors with conditions like:
 *
 *   { "type": "http",
 *     "url": "http://localhost:8000/health",
 *     "expect_status": 200,            // optional; default: any 2xx
 *     "body_matches": "\"ready\": ?true",  // optional regex
 *     "request_timeout_seconds": 10 }  // optional
 *
 * This lives outside the core because it is pure sampling. It keeps no state
 * between checks, so it is fully expressible as a `command` condition over
 * curl. It exists as a probe for environments without curl and to keep the
 * predicates declarative. Custom probes own their condition's validation and
 * defaults; the engine passes the condition object through untouched.
 */
const MAX_BODY = 256 * 1024;

export default {
  type: "http",
  create: (cond) => {
    if (typeof cond.url !== "string") throw new Error("http condition requires a 'url' string");
    const method = cond.method ?? "GET";
    const timeoutMs = (cond.request_timeout_seconds ?? 10) * 1000;
    const bodyRe = cond.body_matches ? new RegExp(cond.body_matches, "m") : undefined;
    const expected =
      cond.expect_status === undefined
        ? undefined
        : Array.isArray(cond.expect_status)
          ? cond.expect_status
          : [cond.expect_status];

    return {
      defaultPoll: { interval_seconds: 2, max_interval_seconds: 30 },
      async check() {
        try {
          const res = await fetch(cond.url, {
            method,
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "follow",
          });
          const statusOk = expected ? expected.includes(res.status) : res.ok;
          if (!statusOk) {
            void res.body?.cancel();
            return { status: "pending", detail: `HTTP ${res.status}` };
          }
          if (bodyRe) {
            const body = (await res.text()).slice(0, MAX_BODY);
            const hit = bodyRe.exec(body);
            return hit
              ? { status: "satisfied", detail: `HTTP ${res.status}, body matched: ${hit[0].slice(0, 200)}` }
              : { status: "pending", detail: `HTTP ${res.status}, body does not match yet` };
          }
          void res.body?.cancel();
          return { status: "satisfied", detail: `HTTP ${res.status}` };
        } catch (err) {
          return { status: "pending", detail: `request failed: ${err.message}` };
        }
      },
    };
  },
};
