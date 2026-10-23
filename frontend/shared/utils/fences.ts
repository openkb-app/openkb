/**
 * Fence components: a code fence whose info string names one renders as that
 * component, on the read page, in chat answers and in the editor.
 *
 * Each is a directory `fences/<language>/` in any Nuxt layer, collected by
 * `modules/fences.ts`. See docs/fence-components.md.
 * - `fence.ts`: its {@link FenceOptions}.
 * - `Fence.vue`: draws the source in the browser ({@link FenceProps}).
 * - `server.ts`, optional: renders into the SSR HTML and checks agent writes
 *   ({@link FenceServer}).
 */
import { fences } from '#okb-fences'

/** What a `fence.ts` default-exports. */
export interface FenceOptions {
  /** The block menu entry. */
  label: string
  description: string
  icon: string
  /** The language picker's name for the source, e.g. "Mermaid". */
  languageLabel: string
  /** The source a block inserted from the block menu starts with. */
  template: string
  /** For agents: what to write this fence for, e.g. "a diagram, in Mermaid syntax". */
  agentHint: string
}

export interface FenceDefinition extends FenceOptions {
  /** The info string that selects it: its directory name. */
  language: string
}

/** A refused source. Line and column are 1-based; 0 where it names no place. */
export interface FenceError {
  message: string
  line: number
  column: number
}

/** One fence rendered on the server: trusted HTML, or why there is none. */
export interface FenceRender {
  html?: string
  error?: FenceError
}

/** What a `server.ts` exports. */
export interface FenceServer {
  /**
   * Renders for the SSR HTML. The HTML is inserted as is: escaping the source
   * is the fence's job. `idPrefix` keeps two fences' element ids apart.
   */
  render?: (source: string, context: { idPrefix: string }) => FenceRender
  /** Why an agent's source is refused, or null. */
  check?: (source: string) => FenceError | null
}

/** The props `Fence.vue` gets. It emits `error` with a {@link FenceError} or null after each draw. */
export interface FenceProps {
  source: string
  /** What `server.ts` rendered. */
  html?: string
  /** The editor: redraws on every change, at the read view's size. */
  preview?: boolean
}

/** The tag a fence component's node renders under (`CustomFence`). */
export const FENCE_TAG = 'fence'

/** Every fence component, by language. */
export const FENCES: readonly FenceDefinition[] = fences

/** The fence component an info string selects. Only the first word counts. */
export function fenceFor(info: string | null | undefined): FenceDefinition | undefined {
  const language = (info ?? '').trim().split(/\s+/)[0]?.toLowerCase()
  return language ? FENCES.find(fence => fence.language === language) : undefined
}

/** Any thrown value as a {@link FenceError}; `line` and `column` are kept where it has them. */
export function fenceError(err: unknown): FenceError {
  const e = err as { message?: unknown, line?: unknown, column?: unknown }
  return {
    message: typeof e?.message === 'string' ? e.message : String(err),
    line: typeof e?.line === 'number' ? e.line : 0,
    column: typeof e?.column === 'number' ? e.column : 0,
  }
}

/** "Line 3, column 8: …", or the message alone where it names no place. */
export function describeFenceError(error: FenceError): string {
  return error.line > 0 ? `Line ${error.line}, column ${error.column}: ${error.message}` : error.message
}
