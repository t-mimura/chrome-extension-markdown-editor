import { defineConfig } from 'vite';
import { resolve, join } from 'path';
import { copyFileSync, mkdirSync, readdirSync, existsSync } from 'fs';

function chromeExtensionPlugin() {
  return {
    name: 'chrome-extension',
    closeBundle() {
      copyFileSync('manifest.json', 'dist/manifest.json');

      const iconsDir = 'dist/icons';
      if (!existsSync(iconsDir)) {
        mkdirSync(iconsDir, { recursive: true });
      }
      const publicIconsDir = 'public/icons';
      if (existsSync(publicIconsDir)) {
        for (const file of readdirSync(publicIconsDir)) {
          copyFileSync(join(publicIconsDir, file), join(iconsDir, file));
        }
      }
    },
  };
}

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: resolve(__dirname, 'landing.html'),
        editor: resolve(__dirname, 'editor.html'),
        'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === 'background/service-worker') {
            return 'background/service-worker.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [chromeExtensionPlugin()],
});
