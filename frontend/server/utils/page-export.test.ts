import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrintHtmlSources } from './print-html'
import { exportPageHtml } from './page-export'
import { makeEvent } from '../test-support/h3'

/**
 * The export's access and wiring: which version renders, for whom, and which
 * URLs it fetches as the reader. The HTML itself is print-html's to pin.
 */

const fetchCePage = vi.fn()
vi.mock('./drupal', () => ({
  fetchCePage: (...args: unknown[]) => fetchCePage(...args),
  drupalBaseUrl: () => 'http://drupal:8080',
  publicDrupalBaseUrl: () => 'https://drupal.example',
}))

const buildPrintHtml = vi.fn()
vi.mock('./print-html', async original => ({
  ...await original<typeof import('./print-html')>(),
  buildPrintHtml: (sources: PrintHtmlSources) => buildPrintHtml(sources),
}))

const localFetch = vi.fn(async () => new Response('css'))
vi.mock('nitropack/runtime', () => ({
  useNitroApp: () => ({ localFetch }),
}))

/** What fetchCePage answers for the page. */
function cePage(canEdit: boolean, hasDraft: boolean) {
  return { page: { nid: 7, path: '/general/probe' }, props: {}, canEdit, hasDraft }
}

/** A request with a session cookie whose own render answers `status`. */
function exportEvent(status = 200) {
  const rendered: Array<{ path: string, init: RequestInit }> = []
  const event = makeEvent(
    { 'cookie': 'SESSabc=1', 'host': 'kb.example', 'x-forwarded-proto': 'https' },
    { path: '/api/kb/general/probe.html' },
  )
  return Object.assign(event, {
    rendered,
    fetch: async (path: string, init: RequestInit) => {
      rendered.push({ path, init })
      return new Response('<html></html>', { status })
    },
  })
}

describe('exportPageHtml', () => {
  beforeEach(() => {
    fetchCePage.mockReset()
    buildPrintHtml.mockReset().mockResolvedValue('<!DOCTYPE html>')
  })

  it('404s for a page the reader may not see', async () => {
    fetchCePage.mockResolvedValue(null)
    await expect(exportPageHtml(exportEvent(), 'general/probe', 'default')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('renders the published page as the reader, as a download', async () => {
    fetchCePage.mockResolvedValue(cePage(false, true))
    const event = exportEvent()
    expect(await exportPageHtml(event, 'general/probe', 'default')).toBe('<!DOCTYPE html>')
    expect(event.rendered[0]?.path).toBe('/general/probe')
    expect(event.rendered[0]?.init.headers).toEqual({ 'Accept': 'text/html', 'x-okb-export-render': expect.any(String) })
    expect(buildPrintHtml.mock.calls[0]?.[0]).toMatchObject({ pageUrl: 'https://kb.example/general/probe' })
    expect(event.sent).toMatchObject({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename="probe.html"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
  })

  it('403s the working copy for a reader who may not edit', async () => {
    fetchCePage.mockResolvedValue(cePage(false, true))
    await expect(exportPageHtml(exportEvent(), 'general/probe', 'working-copy')).rejects.toMatchObject({ statusCode: 403 })
  })

  it('renders an editor\'s working copy from the latest version, or the page without a draft', async () => {
    fetchCePage.mockResolvedValue(cePage(true, true))
    const withDraft = exportEvent()
    await exportPageHtml(withDraft, 'general/probe', 'working-copy')
    expect(withDraft.rendered[0]?.path).toBe('/node/7/latest')

    fetchCePage.mockResolvedValue(cePage(true, false))
    const withoutDraft = exportEvent()
    await exportPageHtml(withoutDraft, 'general/probe', 'working-copy')
    expect(withoutDraft.rendered[0]?.path).toBe('/general/probe')
  })

  it('fails as unavailable when the render does not answer with the page', async () => {
    fetchCePage.mockResolvedValue(cePage(false, false))
    await expect(exportPageHtml(exportEvent(302), 'general/probe', 'default')).rejects.toMatchObject({ statusCode: 503 })
  })

  it('fetches only page files, from Drupal\'s internal address, with the reader\'s session', async () => {
    fetchCePage.mockResolvedValue(cePage(false, false))
    await exportPageHtml(exportEvent(), 'general/probe', 'default')
    const { fetchFile } = buildPrintHtml.mock.calls[0]![0] as PrintHtmlSources
    const fetched: Array<{ url: string, init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      fetched.push({ url, init })
      return new Response('png')
    })

    expect(await fetchFile('https://remote.example/x.png')).toBeNull()
    expect(await fetchFile('https://drupal.example/user/1')).toBeNull()
    expect(await fetchFile('https://drupal.example/system/files/images/x.png')).not.toBeNull()
    expect(fetched).toHaveLength(1)
    expect(fetched[0]?.url).toBe('http://drupal:8080/system/files/images/x.png')
    expect(fetched[0]?.init).toMatchObject({ headers: { Cookie: 'SESSabc=1' }, redirect: 'manual', signal: expect.any(AbortSignal) })
    vi.unstubAllGlobals()
  })

  it('fetches its own stylesheets in process, without the reader\'s credentials', async () => {
    fetchCePage.mockResolvedValue(cePage(false, false))
    await exportPageHtml(exportEvent(), 'general/probe', 'default')
    const { fetchAsset } = buildPrintHtml.mock.calls[0]![0] as PrintHtmlSources
    await fetchAsset('/_nuxt/entry.css')
    expect(localFetch).toHaveBeenCalledWith('/_nuxt/entry.css', {
      headers: { 'Accept': 'text/css,*/*', 'Accept-Encoding': 'identity' },
    })
  })
})
