import { beforeAll, expect, it } from "vitest";
import { startWorker, type Worker } from "./harness";

let w: Worker;
beforeAll(async () => {
  w = await startWorker();
});

it("healthz returns ok", async () => {
  const res = await w.fetch("/healthz");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

it("root describes the service", async () => {
  const res = await w.fetch("/");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const text = await res.text();
  expect(text).toContain("/mcp");
  expect(text).toContain("/healthz");
});

it("migrations create all tables", async () => {
  const { results } = await w.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents','keys','messages','blocks','audit_log','mcp_sessions')")
    .all();
  expect(results).toHaveLength(6);
});

it("unknown paths 404", async () => {
  const res = await w.fetch("/elsewhere");
  expect(res.status).toBe(404);
  await res.text();
});
