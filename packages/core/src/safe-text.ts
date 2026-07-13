function isUnsafeTextCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
}

export function hasUnsafeTextCharacter(value: string): boolean {
  return [...value].some(isUnsafeTextCharacter)
}

export function oneLine(value: string, maxLength: number): string {
  const clean = [...value]
    .map((character) => (isUnsafeTextCharacter(character) ? ' ' : character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1)}…`
}
