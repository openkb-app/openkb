/** The smallest width an image takes, in percent of the column. */
export const MIN_IMAGE_WIDTH = 10

/** An `::image` fence's `width`, `"70%"` → 70; anything else (pixels, out of range) → null. */
export function parseImageWidth(value: unknown): number | null {
  const match = typeof value === 'string' ? value.match(/^(\d{1,3})%$/) : null
  const width = match ? Number(match[1]) : NaN
  return width >= MIN_IMAGE_WIDTH && width <= 100 ? width : null
}
