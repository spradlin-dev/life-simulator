import { defineConfig } from 'vite'

// GitHub Pages serves project sites under a repo-named subpath; every asset
// URL must carry it.
export default defineConfig({
  base: '/life-simulator/',
})
