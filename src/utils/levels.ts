/**
 * Suggestions only. The field stays free text so unusual categories, secret
 * stages and blue-coin routes are not locked out by a dropdown.
 */
const WORLDS = [
  'Bianco Hills',
  'Ricco Harbor',
  'Gelato Beach',
  'Pinna Park',
  'Sirena Beach',
  'Noki Bay',
  'Pianta Village',
]

export const LEVEL_SUGGESTIONS: string[] = [
  'Delfino Plaza',
  ...WORLDS.flatMap((world) => Array.from({ length: 8 }, (_, i) => `${world} ${i + 1}`)),
  'Corona Mountain',
]

/** Short codes Moonshine uses in filenames, e.g. BH3 -> Bianco Hills 3. */
const CODES: Record<string, string> = {
  BH: 'Bianco Hills',
  RH: 'Ricco Harbor',
  GB: 'Gelato Beach',
  PP: 'Pinna Park',
  SB: 'Sirena Beach',
  NB: 'Noki Bay',
  PV: 'Pianta Village',
  DP: 'Delfino Plaza',
  CM: 'Corona Mountain',
}

export function expandLevelCode(code: string): string | null {
  const match = /^([A-Za-z]{2})(\d{1,2})?$/.exec(code.trim())
  if (!match) return null
  const world = CODES[match[1].toUpperCase()]
  if (!world) return null
  return match[2] ? `${world} ${Number(match[2])}` : world
}
