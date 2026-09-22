// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import ChatAnswerState from './ChatAnswerState.vue'
import type { Grounding, GroundingState } from '~/utils/chat-answer'
import { UNGROUNDED_EXPLANATION, UNGROUNDED_LABEL } from '~/utils/chat-answer'

/**
 * The component in a bare Vue app.
 *
 * The two Nuxt globals it uses are stubbed: what is under test is which state
 * is shown and what it offers, not how an icon or a link renders.
 */
function mount(
  props: {
    grounding: Grounding | null
    cited: number
    query?: string
    scopeName?: string | null
    error?: string | null
    loginHref?: string | null
    surface?: 'chat' | 'summary'
  },
  handlers: Record<string, () => void> = {},
) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({ render: () => h(ChatAnswerState, { ...props, ...handlers }) })
  // Render functions, not templates: the suite runs against Vue's runtime
  // build, which carries no template compiler.
  app.component('UIcon', { props: ['name'], render: () => h('span') })
  app.component('UBadge', {
    props: ['label', 'icon', 'color', 'variant', 'size'],
    setup: props => () => h('span', props.label),
  })
  // The tooltip's sentence and whether it is open, as attributes to read.
  app.component('UTooltip', {
    props: ['text', 'open'],
    setup: (props, { slots }) => () =>
      h(
        'span',
        { 'data-tooltip': props.text, 'data-tooltip-open': String(!!props.open) },
        slots.default?.(),
      ),
  })
  app.component('UAlert', {
    props: ['description', 'icon', 'color', 'variant'],
    setup: (props, { slots }) => () => h('div', [props.description, slots.actions?.()]),
  })
  // A button with a `to` is a link, as Nuxt UI renders it.
  app.component('UButton', {
    props: ['label', 'icon', 'color', 'variant', 'size', 'to'],
    setup: (props, { slots }) => () =>
      h(props.to ? 'a' : 'button', props.to ? { href: props.to } : {}, props.label ?? slots.default?.()),
  })
  app.component('NewPageButton', {
    props: ['label', 'color', 'variant', 'size'],
    setup: props => () => h('button', { 'data-testid': 'new-page-cta' }, props.label),
  })
  app.mount(root)
  return root
}

function grounding(state: GroundingState, retrieved?: number): Grounding {
  return { mode: 'grounded', state, retrieved }
}

describe('ChatAnswerState', () => {
  it('says nothing about an answer that cited its sources', () => {
    const root = mount({ grounding: grounding('grounded'), cited: 2, query: 'how do we release?' })

    expect(root.querySelector('[data-test="answer-ungrounded"]')).toBeNull()
    expect(root.querySelector('[data-test="answer-no-answer"]')).toBeNull()
  })

  it('leaves an assistant without grounding exactly as it was', () => {
    const root = mount({ grounding: null, cited: 0, query: 'what can you do?' })

    expect(root.textContent?.trim()).toBe('')
  })

  it('badges an answer that cited nothing with where it came from', () => {
    const root = mount({ grounding: grounding('ungrounded', 3), cited: 0, query: 'who are you?' })

    expect(root.querySelector('[data-test="answer-ungrounded"]')?.textContent)
      .toContain(UNGROUNDED_LABEL)
    // Sources were there to cite, so there is nothing to say about the search.
    expect(root.querySelector('[data-test="answer-searched-note"]')).toBeNull()
    expect(root.querySelector('[data-test="answer-no-answer"]')).toBeNull()
  })

  it('adds what was searched, and the ways on, when the search found nothing', () => {
    const root = mount({ grounding: grounding('ungrounded', 0), cited: 0, query: 'sourdough' })
    const note = root.querySelector('[data-test="answer-searched-note"]')

    // Badged as standing on nothing, and told what was looked through.
    expect(root.querySelector('[data-test="answer-ungrounded"]')).not.toBeNull()
    expect(note?.textContent).toContain('pages you can read')
    expect(note?.textContent).toContain('“sourdough”')
    // The same three ways on a refusal offers.
    expect(root.querySelector('[data-test="answer-rephrase"]')).not.toBeNull()
    expect(root.querySelector('[data-test="answer-search"]')).not.toBeNull()
    expect(root.querySelector('[data-testid="new-page-cta"]')).not.toBeNull()
  })

  it('says what was searched, and offers the ways on, when nothing was found', () => {
    const root = mount({ grounding: grounding('insufficient_evidence'), cited: 0, query: 'sourdough' })
    const block = root.querySelector('[data-test="answer-no-answer"]')

    // The reader is told what was looked through, and for what.
    expect(block?.textContent).toContain('pages you can read')
    expect(block?.textContent).toContain('sourdough')
    // All three ways on: edit the question, search, write the page.
    expect(root.querySelector('[data-test="answer-rephrase"]')).not.toBeNull()
    expect(root.querySelector<HTMLAnchorElement>('[data-test="answer-search"]')?.getAttribute('href'))
      .toBe('/search?q=sourdough')
    expect(root.querySelector('[data-testid="new-page-cta"]')).not.toBeNull()
    // Nothing was retrieved, so there is nothing to retry.
    expect(root.querySelector('[data-test="answer-retry"]')).toBeNull()
    expect(root.querySelector('[data-test="answer-ungrounded"]')).toBeNull()
  })

  it('caps a long question at a word, and searches for the whole of it', () => {
    const query = 'sourdough '.repeat(30).trim()
    const root = mount({ grounding: grounding('insufficient_evidence'), cited: 0, query })
    const block = root.querySelector('[data-test="answer-no-answer"]')

    const quoted = block?.textContent?.match(/“(.*)”/)?.[1] ?? ''
    // 120 characters of the question, at most, plus the ellipsis.
    expect(quoted.length).toBeLessThanOrEqual(121)
    expect(quoted.endsWith('…')).toBe(true)
    expect(query.startsWith(quoted.slice(0, -1))).toBe(true)
    // Cut between words, so the quote ends on one the reader recognises.
    expect(quoted.slice(0, -1).endsWith('sourdough')).toBe(true)

    // The reader searches for what they asked, not for the part that fit.
    const href = root.querySelector<HTMLAnchorElement>('[data-test="answer-search"]')?.getAttribute('href') ?? ''
    expect(href).toBe(`/search?q=${encodeURIComponent(query)}`)
  })

  it('cuts a single unbroken word where the cap falls', () => {
    const query = 'sourdough'.repeat(30)
    const root = mount({ grounding: grounding('insufficient_evidence'), cited: 0, query })

    const quoted = root.querySelector('[data-test="answer-no-answer"]')
      ?.textContent?.match(/“(.*)”/)?.[1] ?? ''

    expect(quoted).toBe(`${query.slice(0, 120)}…`)
  })

  it('quotes a short question whole, with no ellipsis', () => {
    const root = mount({ grounding: grounding('insufficient_evidence'), cited: 0, query: 'sourdough' })

    expect(root.querySelector('[data-test="answer-no-answer"]')?.textContent).toContain('“sourdough”')
  })

  it('offers a retry, and no search, when retrieval itself was unavailable', () => {
    const root = mount({ grounding: grounding('dependency_unavailable'), cited: 0, query: 'sourdough' })
    const block = root.querySelector('[data-test="answer-no-answer"]')

    expect(block?.textContent).toContain('Search is unavailable')
    // Searching yourself is no way on while the search is what is down.
    expect(root.querySelector('[data-test="answer-search"]')).toBeNull()
    expect(root.querySelector('[data-testid="new-page-cta"]')).toBeNull()
    expect(root.querySelector('[data-test="answer-retry"]')).not.toBeNull()
  })

  it('names the block, and adds no second live region', () => {
    const root = mount({ grounding: grounding('ungrounded', 0), cited: 0, query: 'sourdough' })
    const note = root.querySelector('[data-test="answer-searched-note"]')

    expect(note?.getAttribute('role')).toBe('group')
    expect(note?.getAttribute('aria-label')).toBe('Nothing in your knowledge base answered this')
    // The panel's own region announces the state; a second one says it twice.
    expect(root.querySelector('[aria-live]')).toBeNull()
  })

  it('explains the badge in one sentence a tap reaches', async () => {
    const root = mount({ grounding: grounding('ungrounded', 3), cited: 0, query: 'who are you?' })
    const badge = root.querySelector<HTMLButtonElement>('[data-test="answer-ungrounded"]')
    const tooltip = root.querySelector('[data-tooltip]')

    // A control, so keyboard and touch readers reach the sentence too.
    expect(badge?.tagName).toBe('BUTTON')
    expect(tooltip?.getAttribute('data-tooltip')).toBe(UNGROUNDED_EXPLANATION)
    expect(tooltip?.getAttribute('data-tooltip-open')).toBe('false')

    badge?.click()
    await nextTick()

    expect(root.querySelector('[data-tooltip]')?.getAttribute('data-tooltip-open')).toBe('true')
  })

  it('names the space the turn was scoped to in what was searched', () => {
    const root = mount({
      grounding: grounding('ungrounded', 0),
      cited: 0,
      query: 'the tower',
      scopeName: 'Team Wiki',
    })

    expect(root.querySelector('[data-test="answer-searched-note"]')?.textContent)
      .toContain('the pages you can read in the space “Team Wiki”')
  })

  it('names an outage for what it is', () => {
    const root = mount({ grounding: grounding('dependency_unavailable'), cited: 0, query: 'sourdough' })

    expect(root.querySelector('[data-test="answer-no-answer"]')?.getAttribute('aria-label'))
      .toBe('Search unavailable')
  })

  it('says why a turn was not answered, and offers the retry', () => {
    const root = mount({
      grounding: null,
      cited: 0,
      query: 'how do we release?',
      error: 'The AI backend is unavailable right now. Try again in a moment.',
    })

    expect(root.querySelector('[data-test="answer-error"]')?.textContent)
      .toContain('The AI backend is unavailable right now')
    expect(root.querySelector('[data-test="answer-retry"]')).not.toBeNull()
  })

  it('says the turn failed rather than what its grounding said', () => {
    const root = mount({
      grounding: grounding('insufficient_evidence'),
      cited: 0,
      query: 'sourdough',
      error: 'The AI backend is unavailable right now.',
    })

    expect(root.querySelector('[data-test="answer-error"]')).not.toBeNull()
    expect(root.querySelector('[data-test="answer-no-answer"]')).toBeNull()
  })

  it('asks the same question again when the failed turn is retried', () => {
    const onRetry = vi.fn()
    const root = mount(
      { grounding: null, cited: 0, query: 'sourdough', error: 'The AI backend is unavailable.' },
      { onRetry },
    )

    root.querySelector<HTMLButtonElement>('[data-test="answer-retry"]')?.click()

    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('sends a refused session to the login page instead of into a retry', () => {
    const root = mount({
      grounding: null,
      cited: 0,
      error: 'Log in to ask OpenKnowledgebase.',
      loginHref: 'https://backend.example/user/login',
    })

    expect(root.querySelector('[data-test="answer-retry"]')).toBeNull()
    expect(root.querySelector<HTMLAnchorElement>('[data-test="answer-login"]')?.href)
      .toBe('https://backend.example/user/login')
  })

  it('hands the question back to the surface that owns the composer', () => {
    const onRephrase = vi.fn()
    const root = mount(
      { grounding: grounding('insufficient_evidence'), cited: 0, query: 'sourdough' },
      { onRephrase },
    )

    root.querySelector<HTMLButtonElement>('[data-test="answer-rephrase"]')?.click()

    expect(onRephrase).toHaveBeenCalledOnce()
  })

  describe('on the search summary', () => {
    it('does not badge an answer that cited nothing', () => {
      const root = mount({
        grounding: grounding('ungrounded', 3),
        cited: 0,
        query: 'who are you?',
        surface: 'summary',
      })

      expect(root.querySelector('[data-test="answer-ungrounded"]')).toBeNull()
      expect(root.textContent?.trim()).toBe('')
    })

    it('does not say what was searched when the search found nothing', () => {
      const root = mount({
        grounding: grounding('ungrounded', 0),
        cited: 0,
        query: 'sourdough',
        surface: 'summary',
      })

      expect(root.querySelector('[data-test="answer-ungrounded"]')).toBeNull()
      expect(root.querySelector('[data-test="answer-searched-note"]')).toBeNull()
      expect(root.querySelector('[data-test="answer-rephrase"]')).toBeNull()
    })

    it('keeps a refusal, and the ways on it offers', () => {
      const root = mount({
        grounding: grounding('insufficient_evidence'),
        cited: 0,
        query: 'sourdough',
        surface: 'summary',
      })
      const block = root.querySelector('[data-test="answer-no-answer"]')

      expect(block?.textContent).toContain('pages you can read')
      expect(root.querySelector('[data-test="answer-rephrase"]')).not.toBeNull()
      expect(root.querySelector('[data-testid="new-page-cta"]')).not.toBeNull()
    })

    it('keeps an outage, and its retry', () => {
      const root = mount({
        grounding: grounding('dependency_unavailable'),
        cited: 0,
        query: 'sourdough',
        surface: 'summary',
      })

      expect(root.querySelector('[data-test="answer-no-answer"]')?.textContent)
        .toContain('Search is unavailable')
      expect(root.querySelector('[data-test="answer-retry"]')).not.toBeNull()
    })

    it('keeps a failed turn, and the login it sends a refused session to', () => {
      const failed = mount({
        grounding: null,
        cited: 0,
        error: 'The AI backend is unavailable right now.',
        surface: 'summary',
      })
      expect(failed.querySelector('[data-test="answer-error"]')).not.toBeNull()
      expect(failed.querySelector('[data-test="answer-retry"]')).not.toBeNull()

      const refused = mount({
        grounding: null,
        cited: 0,
        error: 'Log in to ask OpenKnowledgebase.',
        loginHref: 'https://backend.example/user/login',
        surface: 'summary',
      })
      expect(refused.querySelector<HTMLAnchorElement>('[data-test="answer-login"]')?.href)
        .toBe('https://backend.example/user/login')
    })
  })
})
