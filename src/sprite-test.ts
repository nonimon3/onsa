import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'

// --------------------------------------------------------------------------
// Test parameters
// --------------------------------------------------------------------------

const IMG_W = 80
const IMG_H = 80
const POS_A = { x: 50, y: 50 }
const POS_B = { x: 300, y: 150 }
const IMG_ID = 10
const LABEL_ID = 1
const CAPTURE_ID = 2

// --------------------------------------------------------------------------
// State / UI refs
// --------------------------------------------------------------------------

let bridge: EvenAppBridge | null = null
let imageBase64: string = ''
let pngByteCount = 0

const statusEl = document.getElementById('status')!
const logEl = document.getElementById('log')!
const previewEl = document.getElementById('preview') as HTMLImageElement

const btnConnect = byId<HTMLButtonElement>('btn-connect')
const btnLoad = byId<HTMLButtonElement>('btn-load')
const btnMoveB = byId<HTMLButtonElement>('btn-move-b')
const btnMoveA = byId<HTMLButtonElement>('btn-move-a')
const btnReupload = byId<HTMLButtonElement>('btn-re-upload')

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

function status(text: string): void {
  statusEl.textContent = text
}

function log(text: string): void {
  const ts = new Date().toLocaleTimeString()
  const prev = logEl.textContent ?? ''
  logEl.textContent = `[${ts}] ${text}\n` + prev
  console.log(`[sprite-test] ${text}`)
}

// --------------------------------------------------------------------------
// Create test sprite as a 80x80 PNG with a white X on black background
// --------------------------------------------------------------------------

function makeSpritePng(): string {
  const canvas = document.createElement('canvas')
  canvas.width = IMG_W
  canvas.height = IMG_H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, IMG_W, IMG_H)
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.moveTo(8, 8); ctx.lineTo(IMG_W - 8, IMG_H - 8)
  ctx.moveTo(IMG_W - 8, 8); ctx.lineTo(8, IMG_H - 8)
  ctx.stroke()
  // Border for visibility
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, IMG_W - 2, IMG_H - 2)
  const dataUrl = canvas.toDataURL('image/png')
  previewEl.src = dataUrl
  const base64 = dataUrl.split(',')[1]
  pngByteCount = Math.ceil(base64.length * 3 / 4)
  return base64
}

// --------------------------------------------------------------------------
// Bridge operations
// --------------------------------------------------------------------------

async function renderInitialPage(): Promise<void> {
  if (!bridge) throw new Error('bridge not ready')

  const label = new TextContainerProperty({
    containerID: LABEL_ID,
    containerName: 'sprite-test-label',
    content: 'Sprite persistence test — Step 1: initial page',
    xPosition: 8,
    yPosition: 0,
    width: 560,
    height: 32,
    isEventCapture: 0,
  })

  const image = new ImageContainerProperty({
    containerID: IMG_ID,
    containerName: 'sprite-test-image',
    xPosition: POS_A.x,
    yPosition: POS_A.y,
    width: IMG_W,
    height: IMG_H,
  })

  const capture = new ListContainerProperty({
    containerID: CAPTURE_ID,
    containerName: 'sprite-test-capture',
    itemContainer: new ListItemContainerProperty({
      itemCount: 1,
      itemWidth: 1,
      isItemSelectBorderEn: 0,
      itemName: [' '],
    }),
    isEventCapture: 1,
    xPosition: 0,
    yPosition: 280,
    width: 1,
    height: 1,
  })

  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: [label],
    imageObject: [image],
    listObject: [capture],
  }))
  log('createStartUpPageContainer OK (image container at POS_A, no pixels yet)')
}

async function uploadImageData(): Promise<void> {
  if (!bridge) throw new Error('bridge not ready')
  if (!imageBase64) imageBase64 = makeSpritePng()

  const update = new ImageRawDataUpdate({
    containerID: IMG_ID,
    containerName: 'sprite-test-image',
    imageData: imageBase64,
  })

  const result = await bridge.updateImageRawData(update)
  log(`updateImageRawData OK (${pngByteCount} bytes), result=${JSON.stringify(result ?? null)}`)
}

async function moveTo(pos: { x: number; y: number }, note: string): Promise<void> {
  if (!bridge) throw new Error('bridge not ready')

  const label = new TextContainerProperty({
    containerID: LABEL_ID,
    containerName: 'sprite-test-label',
    content: `Sprite test — ${note} (no pixel resend)`,
    xPosition: 8,
    yPosition: 0,
    width: 560,
    height: 32,
    isEventCapture: 0,
  })

  const image = new ImageContainerProperty({
    containerID: IMG_ID,
    containerName: 'sprite-test-image',
    xPosition: pos.x,
    yPosition: pos.y,
    width: IMG_W,
    height: IMG_H,
  })

  const capture = new ListContainerProperty({
    containerID: CAPTURE_ID,
    containerName: 'sprite-test-capture',
    itemContainer: new ListItemContainerProperty({
      itemCount: 1,
      itemWidth: 1,
      isItemSelectBorderEn: 0,
      itemName: [' '],
    }),
    isEventCapture: 1,
    xPosition: 0,
    yPosition: 280,
    width: 1,
    height: 1,
  })

  await bridge.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: 3,
    textObject: [label],
    imageObject: [image],
    listObject: [capture],
  }))
  log(`rebuildPageContainer OK → moved image to (${pos.x}, ${pos.y}). Check G2: ${note}`)
}

// --------------------------------------------------------------------------
// Wire buttons
// --------------------------------------------------------------------------

btnConnect.addEventListener('click', async () => {
  btnConnect.disabled = true
  status('Connecting to Even bridge...')
  try {
    bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<EvenAppBridge>((_, rej) =>
        window.setTimeout(() => rej(new Error('bridge timeout 4s')), 4000)),
    ])
    log('bridge ready')
    await renderInitialPage()
    imageBase64 = makeSpritePng()  // also sets preview
    log(`sprite PNG generated (${pngByteCount} bytes base64-decoded)`)
    status('Step 1 OK — 次の "2. 画像データを送信" を押してください。G2 の位置 A に X が出るはず。')
    btnLoad.disabled = false
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log(`CONNECT FAILED: ${msg}`)
    status(`Connect failed: ${msg}`)
    btnConnect.disabled = false
  }
})

btnLoad.addEventListener('click', async () => {
  btnLoad.disabled = true
  status('Uploading image data...')
  try {
    await uploadImageData()
    status('Step 2 OK — G2 の位置 A (50, 50) に X が見えますか? 見えたら "3. 位置 B へ移動" を押してください。')
    btnMoveB.disabled = false
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log(`LOAD FAILED: ${msg}`)
    status(`Load failed: ${msg}`)
    btnLoad.disabled = false
  }
})

btnMoveB.addEventListener('click', async () => {
  btnMoveB.disabled = true
  status('Rebuilding page with image at POS_B (NO pixel data resend)...')
  try {
    await moveTo(POS_B, 'moved to B at (300, 150)')
    status('Step 3 終了 — G2 で X が (300, 150) に出ていれば **データ保持アリ** (スプライト方式成立)。真っ黒なら消えた (データ再送必要)。')
    btnMoveA.disabled = false
    btnReupload.disabled = false
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log(`MOVE B FAILED: ${msg}`)
    status(`Move B failed: ${msg}`)
    btnMoveB.disabled = false
  }
})

btnMoveA.addEventListener('click', async () => {
  btnMoveA.disabled = true
  status('Rebuilding page with image back at POS_A (NO pixel data resend)...')
  try {
    await moveTo(POS_A, 'moved back to A at (50, 50)')
    status('Step 4 終了 — X が元の位置に戻って見えるか確認してください。')
    btnMoveA.disabled = false
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log(`MOVE A FAILED: ${msg}`)
    status(`Move A failed: ${msg}`)
    btnMoveA.disabled = false
  }
})

btnReupload.addEventListener('click', async () => {
  btnReupload.disabled = true
  status('Re-uploading image data as a baseline...')
  try {
    await uploadImageData()
    status('Step 5 終了 — 再送後に X が見えれば、updateImageRawData 自体は機能してる (再送なしケースが消えたなら、やはりデータ保持なし)。')
    btnReupload.disabled = false
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log(`REUPLOAD FAILED: ${msg}`)
    status(`Reupload failed: ${msg}`)
    btnReupload.disabled = false
  }
})

// Pre-generate preview so the user sees what sprite will look like
makeSpritePng()
log('Sprite test page loaded. Click "1. Connect G2" to begin.')
