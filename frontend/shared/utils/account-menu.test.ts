import { describe, it, expect } from 'vitest'
import {
  accountItemIcon,
  renderableAccountItems,
  signInItem,
  type AccountMenuItem,
} from './account-menu'

/**
 * The two shapes rest_menu_items actually serves for the `account` menu, taken
 * from the running stack. The signed-out one is the trap: core's
 * `LoginLogoutMenuLink` keeps the plugin id `user.logout` while pointing at
 * the login route, so nothing may key off the id to tell the two apart.
 */
function item(overrides: Partial<AccountMenuItem> = {}): AccountMenuItem {
  return { key: 'user.logout', title: 'Log out', relative: '/user/logout?token=abc', enabled: true, ...overrides }
}

const SIGNED_OUT = item({ title: 'Log in', relative: '/user/login' })
const MY_ACCOUNT = item({ key: 'user.page', title: 'My account', relative: '/user' })

describe('renderableAccountItems', () => {
  it('keeps Drupal order and passes through items it does not know', () => {
    const custom = item({ key: 'menu_link_content:uuid', title: 'Team handbook', relative: '/handbook' })
    expect(renderableAccountItems([custom, item()]).map(i => i.title))
      .toEqual(['Team handbook', 'Log out'])
  })

  it('keeps the account page, which the frontend renders', () => {
    expect(renderableAccountItems([MY_ACCOUNT, item()]).map(i => i.key))
      .toEqual(['user.page', 'user.logout'])
  })

  it('drops disabled links', () => {
    expect(renderableAccountItems([item({ enabled: false })])).toEqual([])
  })

  it('survives a menu that did not load', () => {
    expect(renderableAccountItems(null)).toEqual([])
    expect(renderableAccountItems(undefined)).toEqual([])
  })
})

describe('accountItemIcon', () => {
  it('reads the target, not the plugin id — both states share the id', () => {
    expect(item().key).toBe(SIGNED_OUT.key)
    expect(accountItemIcon(item())).toBe('i-lucide-log-out')
    expect(accountItemIcon(SIGNED_OUT)).toBe('i-lucide-log-in')
  })

  it('falls back for an item Drupal added', () => {
    expect(accountItemIcon(item({ relative: '/handbook' }))).toBe('i-lucide-circle-user')
  })
})

describe('signInItem', () => {
  it('finds the link that starts a session', () => {
    expect(signInItem([MY_ACCOUNT, SIGNED_OUT])).toBe(SIGNED_OUT)
  })

  it('is absent for a signed-in menu', () => {
    expect(signInItem([item()])).toBeUndefined()
  })
})
