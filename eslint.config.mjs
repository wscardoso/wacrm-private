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
  // IMP-CRYPTO-001 RC1.3 §4.1/§6 step 5 — regression guard for the
  // pre-cutover (no Binding Context) encrypt/decrypt/isLegacyFormat pair.
  // Every whatsapp_config and ad_account_credentials call site has
  // completed its domain cutover (Phase 3.1/3.2); this rule fails CI if a
  // regressed call site re-imports the legacy pair outside the explicit
  // allow-list below (the flag-gated fallback sites, and the tests that
  // exercise the legacy pair directly).
  // @see docs/implementation/IMP-CRYPTO-001.md §8 Risk Register
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    ignores: [
      // Defines the pair — not an import.
      "src/lib/whatsapp/encryption.ts",
      // Exercises the pre-cutover pair directly as part of its test coverage.
      "src/lib/whatsapp/encryption.test.ts",
      // Constructs a legacy-format fixture to assert decryptWithBindingContext
      // still reads pre-migration ad_account_credentials ciphertext.
      "src/lib/enrichment/credential-resolver.test.ts",
      // Flag-gated fallback: encryptWithBindingContext delegates to encrypt()
      // while WHATSAPP_CONFIG_CANONICAL_WRITE is off (IMP §6.1).
      "src/app/api/whatsapp/config/route.ts",
      "src/app/api/whatsapp/send/route.ts",
      "src/app/api/whatsapp/webhook/route.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/whatsapp/encryption",
              importNames: ["encrypt", "decrypt", "isLegacyFormat"],
              message:
                "encrypt/decrypt/isLegacyFormat are the pre-cutover, no-Binding-Context pair (IMP-CRYPTO-001 RC1.3 §3.3). Every migrated domain must use encryptWithBindingContext/decryptWithBindingContext. If this is a genuinely new, not-yet-migrated call site, add it to the ignores list here and to IMP §3.4 — do not silence this rule without a domain audit.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
