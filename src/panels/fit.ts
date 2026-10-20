export function fitLine(text: string, width: number): string {
  const chars = Array.from(text)
  if (chars.length <= width) return text
  return width <= 1 ? chars.slice(0, Math.max(0, width)).join('') : chars.slice(0, width - 1).join('') + '…'
}

export function fitLines(lines: string[], width: number, height: number, keep: 'top' | 'bottom'): string[] {
  const fitted = lines.map((l) => fitLine(l, width))
  if (fitted.length <= height) return fitted
  return keep === 'top' ? fitted.slice(0, height) : fitted.slice(fitted.length - height)
}
