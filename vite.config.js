import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * GitHub Pages project sites are served from /<repo>/, and getting `base`
 * wrong is the single most common way this deploy fails — every asset 404s
 * and the service worker never registers.
 *
 * So don't hand-maintain it. GitHub Actions sets GITHUB_REPOSITORY to
 * "owner/repo", which is all we need. Rename the repo and this still works.
 *
 * Override with VITE_BASE if you ever serve from somewhere else
 * (a custom domain or a user site both want '/').
 */
const repo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.VITE_BASE || (repo ? `/${repo}/` : '/');

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
