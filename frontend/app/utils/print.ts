/**
 * Text as the body of a double-quoted CSS string, safe inside a `<style>`
 * element: backslash and quote escaped, line breaks as `\A`, and `<` as a
 * code point so the text cannot close the element.
 */
export function cssString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\A ')
    .replace(/</g, '\\3C ')
}
