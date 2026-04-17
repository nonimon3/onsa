export type PitchResult = {
  freq: number
  rms: number
}

const SILENCE_RMS = 0.01
const MIN_FREQ = 50
const MAX_FREQ = 2000

// Time-domain autocorrelation with parabolic interpolation.
// Works well for monophonic signals (voice, guitar, flute, whistling).
// Returns -1 for freq when the signal is too quiet or no stable pitch found.
export function detectPitch(buf: Float32Array, sampleRate: number): PitchResult {
  const size = buf.length

  let rms = 0
  let mean = 0
  for (let i = 0; i < size; i++) mean += buf[i]
  mean /= size
  for (let i = 0; i < size; i++) {
    const v = buf[i] - mean
    rms += v * v
  }
  rms = Math.sqrt(rms / size)

  if (rms < SILENCE_RMS) {
    return { freq: -1, rms }
  }

  const minLag = Math.max(2, Math.floor(sampleRate / MAX_FREQ))
  const maxLag = Math.min(size - 1, Math.floor(sampleRate / MIN_FREQ))

  let bestLag = -1
  let bestCorr = 0
  let prevCorr = 0
  let rising = false

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    const n = size - lag
    for (let i = 0; i < n; i++) {
      corr += (buf[i] - mean) * (buf[i + lag] - mean)
    }
    corr /= n

    if (corr > prevCorr) {
      rising = true
    } else if (rising && corr > bestCorr) {
      bestCorr = corr
      bestLag = lag - 1
      rising = false
    }
    prevCorr = corr
  }

  if (bestLag < 0) {
    return { freq: -1, rms }
  }

  // Parabolic interpolation around the peak for sub-sample accuracy.
  const refined = refineLag(buf, mean, bestLag, size)
  if (refined <= 0) {
    return { freq: -1, rms }
  }

  return { freq: sampleRate / refined, rms }
}

function corrAt(buf: Float32Array, mean: number, lag: number, size: number): number {
  if (lag < 1 || lag >= size) return 0
  let c = 0
  const n = size - lag
  for (let i = 0; i < n; i++) {
    c += (buf[i] - mean) * (buf[i + lag] - mean)
  }
  return c / n
}

function refineLag(buf: Float32Array, mean: number, lag: number, size: number): number {
  const y0 = corrAt(buf, mean, lag - 1, size)
  const y1 = corrAt(buf, mean, lag, size)
  const y2 = corrAt(buf, mean, lag + 1, size)
  const denom = y0 - 2 * y1 + y2
  if (denom === 0) return lag
  const delta = 0.5 * (y0 - y2) / denom
  return lag + delta
}
