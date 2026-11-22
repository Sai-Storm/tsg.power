import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Libraries go into their own files: they change rarely, so browsers keep them
// cached across app updates, and pages are loaded on demand (see App.jsx).
const vendorChunks = {
  react: ['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler'],
  supabase: ['@supabase'],
  query: ['@tanstack'],
  icons: ['lucide-react'],
};

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0' },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const path = id.split('\\').join('/');
          if (!path.includes('/node_modules/')) return undefined;
          for (const [chunk, packages] of Object.entries(vendorChunks)) {
            if (packages.some(name => path.includes(`/node_modules/${name}/`))) return chunk;
          }
          return 'vendor';
        },
      },
    },
  },
});
