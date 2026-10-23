import type { FenceError, FenceRender } from '#shared/utils/fences'

export function check(source: string): FenceError | null {
  const lines = source.split('\n')
  const line = lines.findIndex(text => text.includes('!'))
  return line < 0 ? null : { message: 'Unexpected "!"', line: line + 1, column: lines[line]!.indexOf('!') + 1 }
}

export function render(source: string, { idPrefix }: { idPrefix: string }): FenceRender {
  const error = check(source)
  if (error) return { error }
  const text = source.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return { html: `<svg id="${idPrefix}stub"><text>${text}</text></svg>` }
}
