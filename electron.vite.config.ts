import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          // Two separate entry points sharing one Electron main output
          // directory: Electron's `app` process, and the Query Execution
          // Service's `utilityProcess.fork()` target (ADR 0001). Keeping
          // the utility entry a distinct rollup input (rather than a
          // dynamic import from index.ts) means `utilityProcess.fork()` in
          // index.ts can point at a plain sibling file path.
          index: resolve('src/main/index.ts'),
          'utility-entry': resolve('src/main/query-execution/utility-entry.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      // The renderer CSP is `default-src 'self'`, which blocks `data:` URIs.
      // Vite inlines assets under 4 KB as base64 by default, so brand art
      // and font subsets must stay real files.
      assetsInlineLimit: 0
    }
  }
})
