#!/usr/bin/env node
// Waits for the Vite dev server to accept connections, then prints an Even Hub QR
// pointing to the LAN-reachable URL.
//
// Usage (run after vite is starting):
//   node scripts/qr.mjs               -> HTTP QR
//   USE_HTTPS=1 node scripts/qr.mjs   -> HTTPS QR
//
// Normally invoked via `npm run start` / `npm run start:https`.

import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'

const PORT = 5173
const HTTPS = process.env.USE_HTTPS === '1' || process.env.USE_HTTPS === 'true'

function pickLanIp() {
  // If user overrides, respect it.
  if (process.env.LAN_IP) return process.env.LAN_IP

  const interfaces = os.networkInterfaces()
  const virtualNameHints = /vEthernet|VirtualBox|VMware|Docker|WSL|Hyper-V|Loopback|Npcap/i

  // Score each v4 address: lower = better.
  // 0 = 192.168.x.x on a non-virtual adapter (best: typical home LAN)
  // 1 = 10.x.x.x on a non-virtual adapter
  // 2 = 172.16-31.x.x on a non-virtual adapter
  // +10 = virtual adapter name detected (penalty)
  const scored = []

  for (const [name, list] of Object.entries(interfaces)) {
    if (!list) continue
    const virtualPenalty = virtualNameHints.test(name) ? 10 : 0
    for (const iface of list) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      let base
      if (iface.address.startsWith('192.168.')) base = 0
      else if (iface.address.startsWith('10.')) base = 1
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(iface.address)) base = 2
      else base = 5
      scored.push({ name, address: iface.address, score: base + virtualPenalty })
    }
  }

  scored.sort((a, b) => a.score - b.score)
  return scored[0]?.address ?? 'localhost'
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.createConnection({ port, host })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) {
          reject(new Error(`dev server did not open ${host}:${port} within ${timeoutMs}ms`))
        } else {
          setTimeout(tryOnce, 400)
        }
      })
    }
    tryOnce()
  })
}

async function main() {
  const ip = pickLanIp()
  const scheme = HTTPS ? 'https' : 'http'
  const url = `${scheme}://${ip}:${PORT}/`

  process.stdout.write(`\n[onsa] waiting for dev server on ${ip}:${PORT}...\n`)
  try {
    await waitForPort(PORT)
  } catch (err) {
    console.error('[onsa] ' + err.message)
    process.exit(1)
  }

  process.stdout.write('\n========================================\n')
  process.stdout.write(`  Even Hub アプリでこの QR をスキャン\n`)
  process.stdout.write(`  URL: ${url}\n`)
  process.stdout.write('========================================\n\n')

  const args = [
    'evenhub',
    'qr',
    HTTPS ? '--https' : '--http',
    '--ip', ip,
    '--port', String(PORT),
  ]

  const child = spawn('npx', args, {
    stdio: 'inherit',
    shell: true,
  })

  await new Promise((resolve) => child.on('exit', resolve))

  process.stdout.write('\n[onsa] QR 表示完了。サーバーはこのまま稼働中です。終了する場合は Ctrl+C。\n')
  process.stdout.write('[onsa] 再表示したい場合は別ターミナルで `npm run _qr` を実行してください。\n\n')

  // Keep the process alive so concurrently -k does not tear down the dev server.
  process.stdin.resume()
}

main().catch((err) => {
  console.error('[onsa] qr script failed:', err)
  process.exit(1)
})
