import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { AppActions, SetStatus } from '../_shared/app-types'
import { appendEventLog } from '../_shared/log'
import { detectPitch } from '../lib/pitch'
import { buildCentsMeter, frequencyToNote, type NoteInfo } from '../lib/notes'

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

// G2 built-in microphone pushes signed 16-bit little-endian PCM at 16 kHz mono.
const G2_SAMPLE_RATE = 16000
const RING_SIZE = 2048  // 128 ms window at 16 kHz — fits 6+ periods of 50 Hz.

const DETECT_INTERVAL_MS = 100
const G2_UPDATE_INTERVAL_MS = 180
const SMOOTH_WINDOW = 3
const IN_TUNE_CENTS = 5

// G2 screen 576 x 288 layout
const ROW1_ID = 1
const ROW2_ID = 2
const ROW3_ID = 3
const CAPTURE_ID = 4

const ROW1_WIDTH = 40
const ROW2_WIDTH = 30
const ROW3_WIDTH = 40

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

type UiRefs = {
  noteName: HTMLElement
  noteOctave: HTMLElement
  hzValue: HTMLElement
  centsValue: HTMLElement
  targetHz: HTMLElement
  rmsValue: HTMLElement
  needle: HTMLElement
}

type OnsaState = {
  bridge: EvenAppBridge | null
  startupRendered: boolean
  unsubscribeEvents: (() => void) | null
  ring: Float32Array
  ringFilled: number
  audioOn: boolean
  detectLoopId: number | null
  g2LoopId: number | null
  recentFreqs: number[]
  lastFreq: number
  lastRms: number
  lastNote: NoteInfo | null
  lastG2Row1: string
  lastG2Row2: string
  lastG2Row3: string
  setStatus: SetStatus | null
  frameCount: number
}

const state: OnsaState = {
  bridge: null,
  startupRendered: false,
  unsubscribeEvents: null,
  ring: new Float32Array(RING_SIZE),
  ringFilled: 0,
  audioOn: false,
  detectLoopId: null,
  g2LoopId: null,
  recentFreqs: [],
  lastFreq: -1,
  lastRms: 0,
  lastNote: null,
  lastG2Row1: '',
  lastG2Row2: '',
  lastG2Row3: '',
  setStatus: null,
  frameCount: 0,
}

let uiRefs: UiRefs | null = null

// --------------------------------------------------------------------------
// Utility
// --------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)
    promise
      .then(resolve)
      .catch(reject)
      .finally(() => window.clearTimeout(t))
  })
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width)
  return s + ' '.repeat(width - s.length)
}

function smoothFreq(raw: number): number {
  if (raw <= 0) {
    state.recentFreqs = []
    return -1
  }
  state.recentFreqs.push(raw)
  if (state.recentFreqs.length > SMOOTH_WINDOW) {
    state.recentFreqs.shift()
  }
  const sorted = [...state.recentFreqs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// --------------------------------------------------------------------------
// PCM handling
// --------------------------------------------------------------------------

// The SDK says audioPcm is Uint8Array, but after JSON bridge hops it can also
// arrive as number[] or a base64-encoded string. Normalize every shape here.
function coerceToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  if (typeof value === 'string') {
    // base64
    try {
      const bin = atob(value)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      return arr
    } catch {
      return new Uint8Array(0)
    }
  }
  return new Uint8Array(0)
}

function pcmInt16LeToFloat32(pcm: Uint8Array): Float32Array {
  const sampleCount = pcm.byteLength >> 1
  if (sampleCount === 0) return new Float32Array(0)
  const view = new DataView(pcm.buffer, pcm.byteOffset, sampleCount * 2)
  const out = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768
  }
  return out
}

function appendSamplesToRing(samples: Float32Array): void {
  if (samples.length === 0) return
  const ring = state.ring
  if (samples.length >= RING_SIZE) {
    ring.set(samples.subarray(samples.length - RING_SIZE))
    state.ringFilled = RING_SIZE
    return
  }
  const shift = samples.length
  ring.copyWithin(0, shift)
  ring.set(samples, RING_SIZE - shift)
  state.ringFilled = Math.min(RING_SIZE, state.ringFilled + shift)
}

// --------------------------------------------------------------------------
// Browser UI
// --------------------------------------------------------------------------

function grabUi(): UiRefs | null {
  if (uiRefs) return uiRefs
  const noteName = document.getElementById('note-name')
  const noteOctave = document.getElementById('note-octave')
  const hzValue = document.getElementById('hz-value')
  const centsValue = document.getElementById('cents-value')
  const targetHz = document.getElementById('target-hz')
  const rmsValue = document.getElementById('rms-value')
  const needle = document.getElementById('meter-needle')
  if (!noteName || !noteOctave || !hzValue || !centsValue || !targetHz || !rmsValue || !needle) {
    return null
  }
  uiRefs = { noteName, noteOctave, hzValue, centsValue, targetHz, rmsValue, needle }
  return uiRefs
}

function renderBrowser(note: NoteInfo | null, freq: number, rms: number): void {
  const ui = grabUi()
  if (!ui) return

  if (!note || freq <= 0) {
    ui.noteName.textContent = '--'
    ui.noteOctave.textContent = ''
    ui.hzValue.textContent = '0.00'
    ui.centsValue.textContent = '0'
    ui.targetHz.textContent = '—'
    ui.rmsValue.textContent = rms.toFixed(3)
    ui.needle.style.left = '50%'
    ui.needle.classList.remove('in-tune')
    return
  }

  ui.noteName.textContent = note.noteName
  ui.noteOctave.textContent = String(note.octave)
  ui.hzValue.textContent = freq.toFixed(2)
  ui.centsValue.textContent = (note.cents >= 0 ? '+' : '') + note.cents.toFixed(0)
  ui.targetHz.textContent = note.targetHz.toFixed(2)
  ui.rmsValue.textContent = rms.toFixed(3)

  const pct = 50 + (Math.max(-50, Math.min(50, note.cents)) / 50) * 50
  ui.needle.style.left = `${pct}%`
  ui.needle.classList.toggle('in-tune', Math.abs(note.cents) <= IN_TUNE_CENTS)
}

// --------------------------------------------------------------------------
// G2 rendering
// --------------------------------------------------------------------------

function buildG2Lines(note: NoteInfo | null, freq: number, rms: number, audioOn: boolean): {
  row1: string
  row2: string
  row3: string
} {
  if (!audioOn) {
    return {
      row1: padRight('Onsa — mic off', ROW1_WIDTH),
      row2: padRight('Click to start tuning', ROW2_WIDTH),
      row3: padRight('G2 mic 16kHz / A=440', ROW3_WIDTH),
    }
  }
  if (!note || freq <= 0) {
    return {
      row1: padRight('-- listening...', ROW1_WIDTH),
      row2: padRight('|---------+---------|   --c', ROW2_WIDTH),
      row3: padRight(`RMS ${rms.toFixed(3)}`, ROW3_WIDTH),
    }
  }
  const noteLabel = `${note.noteName}${note.octave}`
  const hzLabel = `${freq.toFixed(2)} Hz`
  const row1 = padRight(`${noteLabel}    ${hzLabel}`, ROW1_WIDTH)

  const meter = buildCentsMeter(note.cents, 21)
  const centsLabel = `${note.cents >= 0 ? '+' : ''}${note.cents.toFixed(0)}c`
  const row2 = padRight(`${meter} ${centsLabel}`, ROW2_WIDTH)

  const row3 = padRight(`Target ${note.targetHz.toFixed(2)}Hz  RMS ${rms.toFixed(2)}`, ROW3_WIDTH)

  return { row1, row2, row3 }
}

async function renderG2Startup(bridge: EvenAppBridge): Promise<void> {
  const lines = buildG2Lines(null, -1, 0, state.audioOn)

  const row1 = new TextContainerProperty({
    containerID: ROW1_ID,
    containerName: 'onsa-row1',
    content: lines.row1,
    xPosition: 8,
    yPosition: 8,
    width: 560,
    height: 56,
    isEventCapture: 0,
  })

  const row2 = new TextContainerProperty({
    containerID: ROW2_ID,
    containerName: 'onsa-row2',
    content: lines.row2,
    xPosition: 8,
    yPosition: 76,
    width: 560,
    height: 48,
    isEventCapture: 0,
  })

  const row3 = new TextContainerProperty({
    containerID: ROW3_ID,
    containerName: 'onsa-row3',
    content: lines.row3,
    xPosition: 8,
    yPosition: 136,
    width: 560,
    height: 40,
    isEventCapture: 0,
  })

  const captureList = new ListContainerProperty({
    containerID: CAPTURE_ID,
    containerName: 'onsa-capture',
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
    containerTotalNum: 4,
    textObject: [row1, row2, row3],
    listObject: [captureList],
  }))

  state.startupRendered = true
  state.lastG2Row1 = lines.row1
  state.lastG2Row2 = lines.row2
  state.lastG2Row3 = lines.row3
}

async function pushG2Update(bridge: EvenAppBridge): Promise<void> {
  const { row1, row2, row3 } = buildG2Lines(state.lastNote, state.lastFreq, state.lastRms, state.audioOn)

  const updates: Array<Promise<unknown>> = []
  if (row1 !== state.lastG2Row1) {
    updates.push(bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: ROW1_ID,
      containerName: 'onsa-row1',
      contentOffset: 0,
      contentLength: ROW1_WIDTH,
      content: row1,
    })))
    state.lastG2Row1 = row1
  }
  if (row2 !== state.lastG2Row2) {
    updates.push(bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: ROW2_ID,
      containerName: 'onsa-row2',
      contentOffset: 0,
      contentLength: ROW2_WIDTH,
      content: row2,
    })))
    state.lastG2Row2 = row2
  }
  if (row3 !== state.lastG2Row3) {
    updates.push(bridge.textContainerUpgrade(new TextContainerUpgrade({
      containerID: ROW3_ID,
      containerName: 'onsa-row3',
      contentOffset: 0,
      contentLength: ROW3_WIDTH,
      content: row3,
    })))
    state.lastG2Row3 = row3
  }

  if (updates.length > 0) {
    try {
      await Promise.all(updates)
    } catch (error) {
      console.warn('[onsa] G2 update failed', error)
    }
  }
}

// --------------------------------------------------------------------------
// Audio event handling
// --------------------------------------------------------------------------

function handleEvenHubEvent(event: EvenHubEvent): void {
  if (!event.audioEvent) return
  if (!state.audioOn) return

  const raw = (event.audioEvent as { audioPcm: unknown }).audioPcm
  const pcm = coerceToUint8Array(raw)
  if (pcm.byteLength === 0) return

  const floats = pcmInt16LeToFloat32(pcm)
  appendSamplesToRing(floats)

  state.frameCount += 1
  if (state.frameCount <= 3 || state.frameCount % 100 === 0) {
    console.log(`[onsa] audio frame #${state.frameCount}, ${pcm.byteLength} bytes (${floats.length} samples)`)
  }
}

function runDetectTick(): void {
  if (!state.audioOn) return
  if (state.ringFilled < RING_SIZE) return

  const result = detectPitch(state.ring, G2_SAMPLE_RATE)
  state.lastRms = result.rms

  const smoothed = smoothFreq(result.freq)
  if (smoothed <= 0) {
    state.lastNote = null
    state.lastFreq = -1
    renderBrowser(null, -1, result.rms)
    return
  }

  const note = frequencyToNote(smoothed)
  state.lastNote = note
  state.lastFreq = smoothed
  renderBrowser(note, smoothed, result.rms)
}

function startDetectLoop(): void {
  if (state.detectLoopId !== null) return
  state.detectLoopId = window.setInterval(runDetectTick, DETECT_INTERVAL_MS)
}

function stopDetectLoop(): void {
  if (state.detectLoopId !== null) {
    window.clearInterval(state.detectLoopId)
    state.detectLoopId = null
  }
}

function startG2Loop(): void {
  if (state.g2LoopId !== null) return
  if (!state.bridge) return
  state.g2LoopId = window.setInterval(() => {
    if (!state.bridge || !state.startupRendered) return
    void pushG2Update(state.bridge)
  }, G2_UPDATE_INTERVAL_MS)
}

function stopG2Loop(): void {
  if (state.g2LoopId !== null) {
    window.clearInterval(state.g2LoopId)
    state.g2LoopId = null
  }
}

function resetAudioState(): void {
  state.ringFilled = 0
  state.ring.fill(0)
  state.recentFreqs = []
  state.lastNote = null
  state.lastFreq = -1
  state.lastRms = 0
  state.frameCount = 0
  renderBrowser(null, -1, 0)
}

// --------------------------------------------------------------------------
// Mic control
// --------------------------------------------------------------------------

async function startG2Mic(): Promise<boolean> {
  if (!state.bridge) {
    state.setStatus?.('G2 bridge 未接続です。Connect Glasses を先に実行してください。')
    appendEventLog('Onsa: mic start blocked — no bridge')
    return false
  }
  try {
    const ok = await state.bridge.audioControl(true)
    if (!ok) {
      state.setStatus?.('G2 マイクの起動に失敗しました。')
      appendEventLog('Onsa: audioControl(true) returned false')
      return false
    }
  } catch (error) {
    console.error('[onsa] audioControl(true) threw', error)
    state.setStatus?.('G2 マイクの起動エラー。コンソール確認してください。')
    return false
  }

  state.audioOn = true
  resetAudioState()
  startDetectLoop()
  startG2Loop()
  appendEventLog('Onsa: G2 microphone ON')
  return true
}

async function stopG2Mic(): Promise<void> {
  if (!state.bridge) return
  try {
    await state.bridge.audioControl(false)
  } catch (error) {
    console.warn('[onsa] audioControl(false) failed', error)
  }
  state.audioOn = false
  stopDetectLoop()
  // G2 loop is kept alive to push the "mic off" screen once.
  if (state.bridge && state.startupRendered) {
    void pushG2Update(state.bridge)
  }
  stopG2Loop()
  resetAudioState()
  appendEventLog('Onsa: G2 microphone OFF')
}

// --------------------------------------------------------------------------
// Public actions
// --------------------------------------------------------------------------

export function createOnsaActions(setStatus: SetStatus): AppActions {
  state.setStatus = setStatus

  return {
    async connect() {
      setStatus('Onsa: Even bridge 接続中...')
      appendEventLog('Onsa: connect requested')

      try {
        if (!state.bridge) {
          state.bridge = await withTimeout(waitForEvenAppBridge(), 4000)
        }
        if (!state.unsubscribeEvents) {
          state.unsubscribeEvents = state.bridge.onEvenHubEvent(handleEvenHubEvent)
        }
        if (!state.startupRendered) {
          await renderG2Startup(state.bridge)
        }
      } catch (error) {
        console.warn('[onsa] bridge unavailable', error)
        setStatus('Onsa: G2 bridge が見つかりません。Even Hub アプリから起動してください。')
        appendEventLog('Onsa: bridge missing — tuner needs G2 to run')
        return
      }

      const started = await startG2Mic()
      if (started) {
        setStatus('Onsa: G2 マイク稼働中。音を出すと音名・Hz・セントがG2に出ます。')
      }
    },

    async action() {
      if (!state.bridge) {
        setStatus('Onsa: 先に Connect Glasses を実行してください。')
        return
      }
      if (state.audioOn) {
        await stopG2Mic()
        setStatus('Onsa: G2 マイク停止')
      } else {
        const started = await startG2Mic()
        if (started) {
          setStatus('Onsa: G2 マイク稼働中')
        }
      }
    },
  }
}
