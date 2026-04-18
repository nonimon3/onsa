import { defineConfig, loadEnv } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { resolve } from 'node:path'

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
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          spriteTest: resolve(__dirname, 'sprite-test.html'),
        },
      },
    },
  }
})
