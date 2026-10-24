import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.ts"],
    // PGlite full-chain suites (082+ and 085–087) exceed Vitest's 5s default
    // on CI runners; the prior local green suite used an amplified timeout.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Real-Postgres chain suites (create + drop a DB per file) OOM a worker when
    // several of them run in the same fork alongside other full-chain PGlite
    // files. Cap concurrency so the full suite finishes without a silent exit.
    pool: "forks",
    maxWorkers: 4,
    fileParallelism: true,
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
    },
    clearMocks: true,
  },
});
