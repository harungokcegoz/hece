const wrap = (code: string) => (s: string) => `\x1b[${code}m${s}\x1b[0m`

export const color = {
  dim: wrap('2'),
  bold: wrap('1'),
  green: wrap('32'),
  yellow: wrap('33'),
  red: wrap('31'),
  cyan: wrap('36'),
  boldYellow: wrap('1;33'),
  boldRed: wrap('1;31'),
  boldCyan: wrap('1;36'),
}

export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
