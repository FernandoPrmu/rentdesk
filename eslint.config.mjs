import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // The shadcn registry ships `import { cn } from "cn"`; components must use the
  // project's utils alias (components.json "utils": "@/lib/utils"). Only
  // src/lib/utils.ts may import the package. After `shadcn add`, fix the import.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/utils.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "cn", message: 'Import cn from "@/lib/utils" (the project alias), not the "cn" package.' }] },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated files:
    "public/sw.js",
    "public/swe-worker-*.js",
    "src/types/db.ts",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
