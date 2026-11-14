import { defineConfig } from "vitest/config";

// Tests run in Node and drive the built worker (`worker-build --release`) inside Miniflare over HTTP.
export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    globalSetup: ["./test/global-setup.ts"],
  },
});
