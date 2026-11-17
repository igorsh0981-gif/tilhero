import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// ts-common в dev/test берём из исходников (dist собирается только в Docker-образе).
export default defineConfig({
  resolve: {
    alias: {
      "@tilhero/ts-common": fileURLToPath(new URL("../../packages/ts-common/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Общий Redis (DB 14): файлы изолированы префиксами ключей, но гоняем последовательно — проще отлаживать.
    fileParallelism: false,
    testTimeout: 15_000,
  },
});
