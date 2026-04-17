const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

export type NoteInfo = {
  noteName: string
  octave: number
  cents: number
  targetHz: number
  midi: number
}

export const A4_HZ = 440

// Convert a frequency (Hz) to its nearest equal-temperament semitone.
// `cents` is signed: -50..+50 (negative = flat, positive = sharp).
export function frequencyToNote(freq: number, a4Hz: number = A4_HZ): NoteInfo | null {
  if (!Number.isFinite(freq) || freq <= 0) return null

  const noteFloat = 69 + 12 * Math.log2(freq / a4Hz)
  const midi = Math.round(noteFloat)
  const cents = (noteFloat - midi) * 100

  if (midi < 0 || midi > 127) return null

  const noteName = NOTE_NAMES[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  const targetHz = a4Hz * Math.pow(2, (midi - 69) / 12)

  return { noteName, octave, cents, targetHz, midi }
}

// Unicode bar meter for G2 display. Returns a fixed-width string like:
//   "|----------*----------|"
// Width is the number of cells (odd recommended so that center aligns).
export function buildCentsMeter(cents: number, width: number = 21): string {
  const clamped = Math.max(-50, Math.min(50, cents))
  const center = Math.floor(width / 2)
  const pos = Math.round(center + (clamped / 50) * center)
  const safe = Math.max(0, Math.min(width - 1, pos))

  let out = ''
  for (let i = 0; i < width; i++) {
    if (i === 0) {
      out += '|'
    } else if (i === width - 1) {
      out += '|'
    } else if (i === safe) {
      out += '*'
    } else if (i === center) {
      out += '+'
    } else {
      out += '-'
    }
  }
  return out
}
