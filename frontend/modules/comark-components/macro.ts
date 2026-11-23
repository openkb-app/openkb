/**
 * The `defineComarkComponent()` macro: read its literal argument off an SFC,
 * and the Vite plugin that removes the call before Vue compiles the SFC.
 */
import { basename } from 'node:path'
import ts from 'typescript'
import type { Plugin } from 'vite'
import { parse } from 'vue/compiler-sfc'
import type { ComarkComponentMeta } from '../../shared/utils/comark-components.ts'

/** The macro's name in a component's `<script setup>`. */
export const COMARK_COMPONENT_MACRO = 'defineComarkComponent'

/** A literal value of the macro's argument. */
type LiteralValue = string | number | boolean | { [key: string]: LiteralValue }

/** The macro's statement in an SFC: its offsets in the SFC, its argument and the script's AST. */
interface MacroCall {
  start: number
  end: number
  argument: ts.Expression | undefined
  sourceFile: ts.SourceFile
}

/** Collects the macro's call expressions in a node and below it. */
function collectMacroCallExpressions(node: ts.Node, calls: ts.CallExpression[]): ts.CallExpression[] {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === COMARK_COMPONENT_MACRO) {
    calls.push(node)
  }
  ts.forEachChild(node, child => {
    collectMacroCallExpressions(child, calls)
  })
  return calls
}

/**
 * Finds the macro's statement in an SFC, or null without one.
 * Throws, naming the file, unless it is one top-level statement of `<script setup>`.
 */
function findComarkComponentMacroCall(source: string, file: string): MacroCall | null {
  if (!source.includes(COMARK_COMPONENT_MACRO)) {
    return null
  }
  const { script, scriptSetup } = parse(source, { filename: file }).descriptor
  const blocks = [script, scriptSetup].filter(block => block !== null)
  const found = blocks.flatMap((block) => {
    const sourceFile = ts.createSourceFile(file, block.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    return collectMacroCallExpressions(sourceFile, []).map(call => ({ call, block, sourceFile }))
  })
  if (found.length === 0) {
    return null
  }
  const [{ call, block, sourceFile }] = found as [typeof found[number]]
  const isTopLevelStatement = ts.isExpressionStatement(call.parent) && call.parent.parent === sourceFile
  if (found.length > 1 || block !== scriptSetup || !isTopLevelStatement) {
    throw new Error(`${basename(file)}: ${COMARK_COMPONENT_MACRO}() is called once, as a top-level statement of <script setup>`)
  }
  return {
    start: block.loc.start.offset + call.parent.getStart(sourceFile),
    end: block.loc.start.offset + call.parent.getEnd(),
    argument: call.arguments[0],
    sourceFile,
  }
}

/** Evaluates a literal expression: strings, numbers, booleans and objects of them. */
function evaluateLiteral(node: ts.Expression, sourceFile: ts.SourceFile, component: string): LiteralValue {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text)
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return node.kind === ts.SyntaxKind.TrueKeyword
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries = node.properties.map((property) => {
      const isPlain = ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      if (!isPlain || property.name.text === '__proto__') {
        throw new Error(`${component}: ${COMARK_COMPONENT_MACRO}() takes a literal object; \`${property.getText(sourceFile)}\` is not a plain property`)
      }
      return [property.name.text, evaluateLiteral(property.initializer, sourceFile, component)] as const
    })
    return Object.fromEntries(entries)
  }
  throw new Error(`${component}: ${COMARK_COMPONENT_MACRO}() takes a literal object; \`${node.getText(sourceFile)}\` is not a literal`)
}

/**
 * Reads the argument of a component's `defineComarkComponent()` call, or null
 * without one. Throws, naming the component, on a non-literal argument.
 */
export function readComarkComponentMacro(source: string, file: string): ComarkComponentMeta | null {
  const call = findComarkComponentMacroCall(source, file)
  if (!call) {
    return null
  }
  const component = basename(file, '.vue')
  const value = call.argument ? evaluateLiteral(call.argument, call.sourceFile, component) : undefined
  if (typeof value !== 'object') {
    throw new Error(`${component}: ${COMARK_COMPONENT_MACRO}() takes a literal object`)
  }
  return value as ComarkComponentMeta
}

/**
 * Replaces the macro's statement with a `;` and blanks, keeping every line where
 * it was; the `;` keeps the statements around it apart.
 */
export function removeComarkComponentMacro(source: string, file: string): string {
  const call = findComarkComponentMacroCall(source, file)
  if (!call) {
    return source
  }
  const blanked = source.slice(call.start + 1, call.end).replace(/[^\n]/g, ' ')
  return `${source.slice(0, call.start)};${blanked}${source.slice(call.end)}`
}

/** A comark component's file: `<Name>.vue` in `components/comark/` or its `inline/` folder. */
const COMARK_COMPONENT_FILE = /\/components\/comark\/(?:inline\/)?[A-Z]\w*\.vue$/

/**
 * Vite plugin: takes the macro out of every SFC before Vue compiles it, so it
 * costs nothing at runtime. Throws, naming the file, on a call outside a
 * comark component.
 */
export function comarkComponentMacroVitePlugin(): Plugin {
  return {
    name: 'okb-comark-component-macro',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.vue') || !code.includes(COMARK_COMPONENT_MACRO)) {
        return
      }
      const stripped = removeComarkComponentMacro(code, id)
      if (stripped === code) {
        return
      }
      if (!COMARK_COMPONENT_FILE.test(id)) {
        throw new Error(`${id}: ${COMARK_COMPONENT_MACRO}() is for a comark component, a <Name>.vue in components/comark/ or its inline/ folder`)
      }
      return { code: stripped, map: null }
    },
  }
}
