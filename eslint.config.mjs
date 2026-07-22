import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
  ]),
  // D6 — Proibição de importação direta de API concreta de provider.
  // Nenhum módulo fora da camada de providers e da camada de entrega pode
  // importar a API concreta de um provider específico.
  // @see ADR-MSG-001 D6, DLB-001 §9
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      // Exempt: providers and delivery layers are the ONLY authorized consumers.
      "src/lib/whatsapp/providers/**",
      "src/lib/whatsapp/delivery/**",
      // Known violators — to be removed as each call-site is migrated.
      "src/app/api/whatsapp/config/route.ts",
      "src/app/api/whatsapp/config/verify-registration/route.ts",
      "src/app/api/whatsapp/media/\\[mediaId\\]/route.ts",
      "src/app/api/whatsapp/templates/submit/route.ts",
      "src/app/api/whatsapp/templates/\\[id\\]/route.ts",
      "src/app/api/whatsapp/webhook/route.ts",
      "src/lib/flows/validate.ts",
      "src/lib/whatsapp/meta-api.resumable.test.ts",
      "src/lib/whatsapp/registration.test.ts",
      "src/lib/whatsapp/template-header-handle.test.ts",
      "src/lib/whatsapp/template-header-handle.ts",
      "src/lib/whatsapp/template-lifecycle.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/whatsapp/meta-api"],
              message:
                "meta-api is provider-internal. Import via providers/index.ts or delivery/ instead (D6).",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
