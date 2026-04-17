import { defineConfig, loadEnv } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// `base` is set for GitHub Pages so assets resolve under /onsa/.
// For local dev (`npm run dev`) Vite still serves from `/`.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const useHttps = env.VITE_HTTPS === '1' || env.VITE_HTTPS === 'true'

  return {
    base: command === 'build' ? '/onsa/' : '/',
    plugins: useHttps ? [basicSsl()] : [],
    server: {
      host: true,
      port: 5173,
    },
  }
})
