import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

// Every build knows its version (package.json) and commit, so the app can tell admins when a newer release is out
// (src/updates.ts). Bump the version with `npm version minor` (or patch) and push the tag to publish a release.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const commit = (() => {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
})();

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __APP_COMMIT__: JSON.stringify(commit) },
  // `npm run deploy -- <instance>` points this at the instance's generated config (scripts/tenant.mjs).
  // Otherwise (local dev) it's wrangler.jsonc.
  plugins: [react(), cloudflare({ configPath: process.env.TASKIVITIES_WRANGLER_CONFIG || undefined })],
});
