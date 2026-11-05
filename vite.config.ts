import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  // `npm run deploy -- <instance>` points this at the instance's generated config (scripts/tenant.mjs).
  // Otherwise (local dev) it's wrangler.jsonc.
  plugins: [react(), cloudflare({ configPath: process.env.TASKIVITIES_WRANGLER_CONFIG || undefined })],
});
