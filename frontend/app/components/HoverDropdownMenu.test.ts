// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, cloneVNode, h, nextTick } from 'vue'
import HoverDropdownMenu from './HoverDropdownMenu.vue'

/**
 * The wrapper in a bare Vue app, with `UDropdownMenu` stubbed down to what the
 * hover behaviour needs from it: the trigger slot gets `aria-controls` the way
 * reka's `as-child` trigger does, and an open menu is the element that names.
 */
const MENU_ID = 'stub-menu'

/** The content props the wrapper hands the dropdown — reka's focus hooks. */
let contentProps: Record<string, (event: Event) => void> = {}

type Props = InstanceType<typeof HoverDropdownMenu>['$props']

/** The device the media query reports. Hover is off by default in happy-dom. */
function useDevice(hover: boolean): void {
  window.matchMedia = ((query: string) => ({
    media: query,
    matches: hover,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

function mount(props: Partial<Props> = {}): HTMLElement {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const app = createApp({
    render: () => h(HoverDropdownMenu, props, {
      default: () => h('button', { type: 'button', 'data-testid': 'trigger' }),
    }),
  })
  app.component('UDropdownMenu', {
    props: ['open', 'items', 'content', 'modal'],
    setup: (props, { slots }) => () => {
      contentProps = props.content ?? {}
      const trigger = slots.default?.()[0]
      return h('div', [
        trigger ? cloneVNode(trigger, { 'aria-controls': MENU_ID }) : null,
        props.open ? h('div', { id: MENU_ID, role: 'menu', tabindex: -1 }) : null,
      ])
    },
  })
  app.mount(root)
  return root
}

const menu = () => document.getElementById(MENU_ID)
/** Reka's "something outside the content was pressed", dispatched on it. */
function interactOutside(target: Element): void {
  target.addEventListener('interactOutside', event => contentProps.onInteractOutside?.(event), { once: true })
  target.dispatchEvent(new CustomEvent('interactOutside', { cancelable: true }))
}

/** Reka's cancelable "the menu is handing focus on" event. */
function closeAutoFocus(): Event {
  const event = new Event('closeAutoFocus', { cancelable: true })
  contentProps.onCloseAutoFocus?.(event)
  return event
}
const trigger = () => document.querySelector<HTMLElement>('[data-testid="trigger"]')!

function point(type: string, target: EventTarget, pointerType = 'mouse'): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType }))
}

async function settle(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  await nextTick()
}

describe('HoverDropdownMenu', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDevice(true)
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
    contentProps = {}
  })

  it('opens after the open delay when a mouse rests on the trigger', async () => {
    mount()
    point('pointerenter', trigger())
    await settle(100)
    expect(menu(), 'before the delay').toBeNull()
    await settle(100)
    expect(menu()).not.toBeNull()
  })

  it('does not open for a touch', async () => {
    mount()
    point('pointerenter', trigger(), 'touch')
    await settle(1000)
    expect(menu()).toBeNull()
  })

  it('does not open on a device without a fine pointer', async () => {
    useDevice(false)
    mount()
    point('pointerenter', trigger())
    await settle(1000)
    expect(menu()).toBeNull()
  })

  it('stays open while the pointer travels from the trigger into the menu', async () => {
    mount()
    point('pointerenter', trigger())
    await settle(150)
    point('pointerleave', trigger())
    await settle(100)
    point('pointerover', menu()!)
    await settle(1000)
    expect(menu()).not.toBeNull()
  })

  it('closes after the close delay once the pointer is on neither', async () => {
    mount()
    point('pointerenter', trigger())
    await settle(150)
    point('pointerleave', trigger())
    await settle(200)
    expect(menu(), 'before the close delay').not.toBeNull()
    await settle(200)
    expect(menu()).toBeNull()
  })

  it('keeps the menu after a click, and the pointer no longer closes it', async () => {
    mount()
    point('pointerenter', trigger())
    await settle(150)
    trigger().click()
    point('pointerleave', trigger())
    point('pointerover', document.body)
    await settle(1000)
    expect(menu()).not.toBeNull()
  })

  it('takes the focus back to the trigger when a committed menu closes', async () => {
    mount()
    point('pointerenter', trigger())
    await settle(150)
    trigger().click()
    expect(closeAutoFocus().defaultPrevented, 'the wrapper places focus itself').toBe(true)
    expect(document.activeElement).toBe(trigger())
  })

  it('leaves focus where a click outside the committed menu put it', async () => {
    mount()
    point('pointerenter', trigger())
    await settle(150)
    trigger().click()
    interactOutside(document.body)
    expect(closeAutoFocus().defaultPrevented, 'the click chose, not the menu').toBe(false)
  })

  it('leaves focus alone when a click outside closes a hover-opened menu', async () => {
    mount()
    point('pointerenter', trigger())
    await settle(150)
    // Never committed: the pointer still owns it, and the click elsewhere is
    // what chose where focus belongs.
    interactOutside(document.body)
    expect(closeAutoFocus().defaultPrevented, 'the click chose, not the menu').toBe(false)
  })

  it('reads the commit click on the trigger as its own, not as an outside one', async () => {
    mount()
    point('pointerenter', trigger())
    await settle(150)
    // Reka raises this on the pointerdown, a task before the click — and the
    // listener that keeps the menu is torn down the moment ownership drops.
    interactOutside(trigger())
    await settle(0)
    trigger().click()
    expect(closeAutoFocus().defaultPrevented, 'the menu is still the click\'s').toBe(true)
  })

  it('uses the delays it is given', async () => {
    mount({ openDelay: 400 })
    point('pointerenter', trigger())
    await settle(300)
    expect(menu(), 'before the given delay').toBeNull()
    await settle(150)
    expect(menu()).not.toBeNull()
  })
})
