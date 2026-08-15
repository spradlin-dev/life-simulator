import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves project sites under a repo-named subpath; every asset
// URL and the installed app's identity must carry it.
const APP_BASE = '/life-simulator/'

export default defineConfig({
  base: APP_BASE,
  plugins: [
    VitePWA({
      // 'prompt' surfaces an update toast instead of silently reloading mid-visit
      registerType: 'prompt',
      // the manifest icon is already covered by the svg glob below
      includeManifestIcons: false,
      manifest: {
        name: 'Pip',
        short_name: 'Pip',
        description: 'A little critter that reacts to you.',
        id: APP_BASE,
        start_url: APP_BASE,
        scope: APP_BASE,
        display: 'standalone',
        background_color: '#0b1016',
        theme_color: '#16202b',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg}'],
        navigateFallback: `${APP_BASE}index.html`,
      },
    }),
  ],
})
