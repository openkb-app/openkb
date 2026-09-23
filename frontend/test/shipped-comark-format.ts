import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AllowedHtml, AttrRule } from '~~/shared/utils/comark-tree'

const RECIPES = new URL('../../recipes/', import.meta.url)

// The core recipe holds the format; a published tree ships install-state's
// flattened copy of it instead, with a byte-identical `allowed_html`.
const FORMAT_PATHS = [
  'openkb_recipe_core/config/filter.format.comark.yml',
  'install-state/config/filter.format.comark.yml',
].map(path => fileURLToPath(new URL(path, RECIPES)))

/** The shipped format file, or a throw naming every path looked at. */
function formatPath(): string {
  const found = FORMAT_PATHS.find(path => existsSync(path))
  if (!found) throw new Error(`no shipped comark text format: none of ${FORMAT_PATHS.join(', ')} exists`)
  return found
}

/**
 * The shipped `allowed_html` setting, read the way `filter_html` reads it: a
 * bare attribute takes any value, a quoted one lists the values it accepts.
 */
export function shippedAllowedHtml(): AllowedHtml {
  const yaml = readFileSync(formatPath(), 'utf8')
  const setting = /allowed_html: '(.*)'/.exec(yaml)?.[1] ?? ''
  // Core adds these to every tag, whatever the setting says.
  const listed: AllowedHtml = { '*': { lang: true, dir: { ltr: true, rtl: true } } }
  for (const [, tag, attributes] of setting.matchAll(/<([a-z][a-z0-9]*)((?:[^>"]|"[^"]*")*)>/g)) {
    const rules: Record<string, AttrRule> = {}
    for (const [, name, values] of (attributes ?? '').matchAll(/([a-zA-Z][\w:.*-]*)(?:="([^"]*)")?/g)) {
      rules[name!] = values === undefined
        ? true
        : Object.fromEntries(values.split(/\s+/).filter(Boolean).map(value => [value, true]))
    }
    listed[tag!] = rules
  }
  return listed
}
