import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("healthz returns ok", async () => {
  const res = await SELF.fetch("https://x/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

it("migrations create all tables", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents','keys','messages','blocks','audit_log')"
  ).all();
  expect(results).toHaveLength(5);
});
