import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@skill-designer/engine": path.join(root, "packages/engine/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    coverage: { enabled: false }
  }
});
