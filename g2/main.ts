import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { AppActions, SetStatus } from '../_shared/app-types'
import { appendEventLog } from '../_shared/log'
import { detectPitch } from '../lib/pitch'
import { buildCentsMeter, frequencyToNote, type NoteInfo } from '../lib/notes'

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const FFT_SIZE = 2048
const DETECT_INTERVAL_MS = 80
const G2_UPDATE_INTERVAL_MS = 150
const SMOOTH_WINDOW = 3
const IN_TUNE_CENTS = 5

// G2 layout (screen: 576 x 288)
const ROW1_ID = 1  // big: note + hz
const ROW2_ID = 2  // meter + cents
const ROW3_ID = 3  // detail line
const CAPTURE_ID = 4  // hidden list for event capture

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
  audio: AudioContext | null
  analyser: AnalyserNode | null
  mediaStream: MediaStream | null
  buffer: Float32Array | null
  running: boolean
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
}

const state: OnsaState = {
  bridge: null,
  startupRendered: false,
  audio: null,
  analyser: null,
  mediaStream: null,
  buffer: null,
  running: false,
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

function buildG2Lines(note: NoteInfo | null, freq: number, rms: number): {
  row1: string
  row2: string
  row3: string
} {
  if (!note || freq <= 0) {
    return {
      row1: padRight('--      listening...', ROW1_WIDTH),
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
  const lines = buildG2Lines(null, -1, 0)

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
  const { row1, row2, row3 } = buildG2Lines(state.lastNote, state.lastFreq, state.lastRms)

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
      console.warn('[onsa] G2 update failed, will retry later', error)
    }
  }
}

// --------------------------------------------------------------------------
// Microphone + detection loop
// --------------------------------------------------------------------------

async function ensureAudio(): Promise<void> {
  if (state.audio && state.analyser && state.mediaStream) return

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  })

  const audio = new AudioContext()
  if (audio.state === 'suspended') {
    await audio.resume()
  }
  const source = audio.createMediaStreamSource(stream)
  const analyser = audio.createAnalyser()
  analyser.fftSize = FFT_SIZE
  analyser.smoothingTimeConstant = 0
  source.connect(analyser)

  state.audio = audio
  state.analyser = analyser
  state.mediaStream = stream
  state.buffer = new Float32Array(analyser.fftSize)
}

function stopAudio(): void {
  if (state.detectLoopId !== null) {
    window.clearInterval(state.detectLoopId)
    state.detectLoopId = null
  }
  if (state.g2LoopId !== null) {
    window.clearInterval(state.g2LoopId)
    state.g2LoopId = null
  }
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((t) => t.stop())
    state.mediaStream = null
  }
  if (state.audio) {
    void state.audio.close()
    state.audio = null
  }
  state.analyser = null
  state.buffer = null
  state.recentFreqs = []
  state.lastNote = null
  state.lastFreq = -1
  state.lastRms = 0
  renderBrowser(null, -1, 0)
}

function runDetectTick(): void {
  const analyser = state.analyser
  const buffer = state.buffer
  const audio = state.audio
  if (!analyser || !buffer || !audio) return

  analyser.getFloatTimeDomainData(buffer as Float32Array<ArrayBuffer>)
  const result = detectPitch(buffer, audio.sampleRate)
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

function startG2Loop(): void {
  if (state.g2LoopId !== null) return
  if (!state.bridge) return
  state.g2LoopId = window.setInterval(() => {
    if (!state.bridge || !state.startupRendered) return
    void pushG2Update(state.bridge)
  }, G2_UPDATE_INTERVAL_MS)
}

// --------------------------------------------------------------------------
// Public actions
// --------------------------------------------------------------------------

async function startListening(): Promise<boolean> {
  try {
    await ensureAudio()
  } catch (error) {
    console.error('[onsa] getUserMedia failed', error)
    state.setStatus?.('マイクへのアクセスが拒否されました。ブラウザ設定を確認してください。')
    appendEventLog('Onsa: mic permission denied or unavailable')
    return false
  }

  state.running = true
  startDetectLoop()
  if (state.bridge) {
    startG2Loop()
  }
  appendEventLog('Onsa: microphone listening')
  return true
}

function stopListening(): void {
  state.running = false
  stopAudio()
  appendEventLog('Onsa: microphone stopped')
}

export function createOnsaActions(setStatus: SetStatus): AppActions {
  state.setStatus = setStatus

  return {
    async connect() {
      setStatus('Onsa: connecting to Even bridge...')
      appendEventLog('Onsa: connect requested')

      try {
        if (!state.bridge) {
          state.bridge = await withTimeout(waitForEvenAppBridge(), 4000)
        }
        if (!state.startupRendered) {
          await renderG2Startup(state.bridge)
        }
        setStatus('Onsa: G2 接続成功。Toggle Mic でマイク開始。')
        appendEventLog('Onsa: bridge ready, page rendered')
      } catch (error) {
        console.warn('[onsa] bridge unavailable, running browser-only', error)
        setStatus('Onsa: G2 未検出。ブラウザのみで動作します。Toggle Mic で開始。')
        appendEventLog('Onsa: browser-only mode (bridge missing)')
      }

      // In either mode, automatically begin listening so the UI is immediately useful.
      const ok = await startListening()
      if (ok) {
        setStatus(
          state.bridge
            ? 'Onsa: マイク稼働中 → G2 にリアルタイム表示中'
            : 'Onsa: マイク稼働中 (ブラウザのみ)',
        )
      }
    },

    async action() {
      if (state.running) {
        stopListening()
        setStatus('Onsa: マイク停止')
        return
      }
      const ok = await startListening()
      if (ok) {
        setStatus(
          state.bridge
            ? 'Onsa: マイク稼働中 → G2 にリアルタイム表示中'
            : 'Onsa: マイク稼働中 (ブラウザのみ)',
        )
      }
    },
  }
}
