import { describe, it, expect } from 'vitest'
import { isOwnNodePath, parseNodeAddress, parseNodeId } from './node-address'

describe('parseNodeAddress', () => {
  it('reads /node/<nid> and /node/<nid>/edit, with or without a trailing slash', () => {
    expect(parseNodeAddress('/node/39')).toEqual({ nid: 39, edit: false })
    expect(parseNodeAddress('/node/39/')).toEqual({ nid: 39, edit: false })
    expect(parseNodeAddress('/node/39/edit')).toEqual({ nid: 39, edit: true })
    expect(parseNodeAddress('/node/39/edit/')).toEqual({ nid: 39, edit: true })
  })

  it('reads no other address', () => {
    for (const path of ['/node/39/revisions', '/node/0', '/node/x', '/node', '/a/node/39', '/node/39/edit/more']) {
      expect(parseNodeAddress(path)).toBeNull()
    }
  })
})

describe('parseNodeId', () => {
  it('reads a positive integer in digits', () => {
    expect(parseNodeId('39')).toBe(39)
  })

  it('reads nothing else', () => {
    for (const segment of [undefined, '', '0', '-1', '0x10', '1e3', '3.5', ' 39', '99999999999999999999']) {
      expect(parseNodeId(segment)).toBeNull()
    }
  })
})

describe('isOwnNodePath', () => {
  it('tells a page without an alias', () => {
    expect(isOwnNodePath('/node/39', 39)).toBe(true)
    expect(isOwnNodePath('/demo-wiki/authoring-workflow', 39)).toBe(false)
  })
})
