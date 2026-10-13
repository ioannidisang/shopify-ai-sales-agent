import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several suites boot independent PostgreSQL WASM engines. Bound parallel
    // startup to avoid CPU/memory contention on developer and small build hosts.
    maxWorkers: 2,
  },
});
