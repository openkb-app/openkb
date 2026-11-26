import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AllowedHtml, AttrRule } from '~~/shared/utils/comark-tree'

// A copy of recipes/openkb_recipe_core/config/filter.format.comark.yml; CI
// fails when the two differ (scripts/check-frontend-copies.sh).
const FORMAT_PATH = fileURLToPath(new URL('./filter.format.comark.yml', import.meta.url))

/**
 * The shipped `allowed_html` setting, read the way `filter_html` reads it: a
 * bare attribute takes any value, a quoted one lists the values it accepts.
 */
export function shippedAllowedHtml(): AllowedHtml {
  const yaml = readFileSync(FORMAT_PATH, 'utf8')
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
