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

it("pages carry SEO metadata on the public origin", async () => {
  for (const path of ["/", "/samp"]) {
    const res = await w.fetch(path);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Secure Agent Messaging Protocol");
    expect(text).toContain(`<link rel="canonical" href="https://agent-mailbox.fezone.tw${path}">`);
    expect(text).toContain("application/ld+json");
    expect(text).not.toContain("{{");
  }
});

it("robots.txt and sitemap.xml point at the public origin", async () => {
  const robots = await w.fetch("/robots.txt");
  expect(robots.headers.get("content-type")).toContain("text/plain");
  const body = await robots.text();
  expect(body).toContain("Disallow: /mcp");
  expect(body).toContain("Sitemap: https://agent-mailbox.fezone.tw/sitemap.xml");
  const sitemap = await w.fetch("/sitemap.xml");
  expect(sitemap.headers.get("content-type")).toContain("xml");
  expect(await sitemap.text()).toContain("<loc>https://agent-mailbox.fezone.tw/samp</loc>");
});

it("without PUBLIC_ORIGIN the request origin is used", async () => {
  const bare = await startWorker({ PUBLIC_ORIGIN: "" });
  expect(await (await bare.fetch("/robots.txt")).text()).toMatch(/Sitemap: https?:\/\/x\/sitemap\.xml/);
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
