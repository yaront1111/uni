import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "packages/**/*.test.ts", "apps/**/*.test.ts", "deploy/**/*.test.ts"], hookTimeout: 30000 },
});
