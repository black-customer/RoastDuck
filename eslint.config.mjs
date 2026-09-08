import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: import.meta.dirname,
  recommendedConfig: js.configs.recommended,
});

export default defineConfig([
  ...compat.config({ extends: ["next/core-web-vitals", "next/typescript"] }),
  globalIgnores([
    ".next/**",
      ".next-desktop/**",
      ".next-e2e/**",
    "out/**",
    "dist/**",
    "mobile/dist/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "data/**",
    ".publish/**",
    "android/**",
    "next-env.d.ts",
  ]),
]);
