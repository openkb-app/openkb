import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveNodePath } from './node-path'
import { makeEvent, stubFetch } from '../test-support/h3'

/** A `kb_page` CE read of node 39 with a given path prop. */
function cePage(path: unknown) {
  return { content: { element: 'node-kb-page', props: { nid: 39, uuid: 'u-39', title: 'Authoring workflow', path, body: '' } } }
}

beforeEach(() => {
  vi.stubGlobal('useRuntimeConfig', () => ({ drupalBaseUrl: 'http://drupal.test/' }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveNodePath', () => {
  it("answers the page's path off its live read, under the visitor's session", async () => {
    const calls = stubFetch({ '/ce-api/node/39': { body: cePage('/demo-wiki/authoring-workflow') } })

    expect(await resolveNodePath(makeEvent({ Cookie: 'SESS=visitor' }), 39)).toBe('/demo-wiki/authoring-workflow')
    expect(calls.map(call => call.url)).toEqual(['http://drupal.test/ce-api/node/39'])
    expect(new Headers(calls[0]!.init.headers).get('cookie')).toBe('SESS=visitor')
  })

  it('answers the node address for a page without an alias', async () => {
    stubFetch({ '/ce-api/node/39': { body: cePage('') } })

    expect(await resolveNodePath(makeEvent(), 39)).toBe('/node/39')
  })

  it("gives a visitor who may not read the page Drupal's refusal, and no path", async () => {
    stubFetch({ '/ce-api/node/39': { status: 403 } })
    await expect(resolveNodePath(makeEvent(), 39)).rejects.toMatchObject({ statusCode: 403 })

    stubFetch({ '/ce-api/node/39': { status: 404 } })
    await expect(resolveNodePath(makeEvent(), 39)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('answers 404 for a node that is no page', async () => {
    stubFetch({ '/ce-api/node/39': { body: { content: { element: 'drupal-markup', props: {} } } } })

    await expect(resolveNodePath(makeEvent(), 39)).rejects.toMatchObject({ statusCode: 404 })
  })
})
