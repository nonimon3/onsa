#!/usr/bin/env node
// Generate a PNG QR for the given URL. Default: GitHub Pages URL of onsa.
//   node scripts/qr-png.mjs [url] [outfile]

import qr from 'qr-image'
import { createWriteStream } from 'node:fs'
import { resolve } from 'node:path'

const url = process.argv[2] ?? 'https://nonimon3.github.io/onsa/'
const out = resolve(process.argv[3] ?? 'onsa-qr.png')

const png = qr.image(url, { type: 'png', size: 12, margin: 2 })
const stream = createWriteStream(out)
png.pipe(stream)
stream.on('finish', () => {
  process.stdout.write(`QR saved: ${out}\nURL: ${url}\n`)
})
