import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.ts"],
    // Live tests write real, permanent records to Irys mainnet. They are opt-in.
    exclude: process.env.LYRA_LIVE_TESTS ? [] : ["test/live.test.ts"],
    testTimeout: 60_000,
  },
});
