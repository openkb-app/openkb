import { describe, expect, it } from 'vitest'
import { renderStoredBody, wordsBracketsComponentsOrImagesDiffer } from './comark-render'

describe('renderStoredBody', () => {
  it('re-spells the body and keeps the title heading as stored', async () => {
    expect(await renderStoredBody('# Plan {#b-t}\n\nline one\\\nline two {#b-1}\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'))
      .toBe('# Plan {#b-t}\n\nline one  \nline two {#b-1}\n\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n')
  })

  it('leaves a body comark already wrote alone', async () => {
    const stored = '# Plan {#b-t}\n\nline one  \nline two {#b-1}\n'
    expect(await renderStoredBody(stored)).toBe(stored)
  })

  it('writes until the body reads back as itself', async () => {
    const once = await renderStoredBody('## C \\#\n')
    expect(await renderStoredBody(once)).toBe(once)
  })

  it('keeps an empty body empty', async () => {
    expect(await renderStoredBody('')).toBe('')
  })

  it('writes a tag naming no element as text, with the rest of its container', async () => {
    expect(await renderStoredBody('The note <name> shows who.\n\nNext.')).toBe('The note \\<name> shows who.\n\nNext.\n')
    expect(await renderStoredBody('You via <agent name> here.')).toBe('You via \\<agent name> here.\n')
  })

  it('reads an HTML element as the editor does: its tag dropped, its words kept (L1)', async () => {
    expect(await renderStoredBody('Press <kbd>Enter</kbd> now.')).toBe('Press Enter now.\n')
  })
})

describe('wordsBracketsComponentsOrImagesDiffer', () => {
  it('ignores markup and spacing', () => {
    expect(wordsBracketsComponentsOrImagesDiffer('Two\\\nlines **bold** {#b-1}', 'Two  \nlines __bold__ {#b-1}')).toBe(false)
  })

  it('sees a lost word, lost brackets or a doubled word', () => {
    expect(wordsBracketsComponentsOrImagesDiffer('Numbers like [1] are', 'Numbers like are')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('Numbers like [1] are', 'Numbers like 1 are')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('one two', 'one two two')).toBe(true)
  })

  it('sees a lost component or raw image, not a component written in another form', () => {
    expect(wordsBracketsComponentsOrImagesDiffer('::callout\nTip\n::', 'callout Tip')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('see :doc[Intro]{nid="1"}', 'see doc Intro nid 1')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('a <img src="x.png"> b', 'a img src x png b')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('::doc{nid="1"}\n::', ':doc{nid="1"}')).toBe(false)
    expect(wordsBracketsComponentsOrImagesDiffer('Note: at 10:30, http://x', 'Note: at 10:30, http://x')).toBe(false)
  })

  it('reads an attribute list as its entries, in any order', () => {
    expect(wordsBracketsComponentsOrImagesDiffer('::callout{#b-1 type="info"}\nTip\n::', '::callout{type="info" #b-1}\nTip\n::')).toBe(false)
    expect(wordsBracketsComponentsOrImagesDiffer('::callout{#b-1 type="info"}\n::', '::callout{#b-1 type="warning"}\n::')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('::callout{#b-1 type="info"}\n::', '::callout{type="b-1" #info}\n::')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('Text {#b-1}', 'Text b 1')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('Text {#b-1}', 'Text {.b-1}')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('Hi {#b-1 Ü}', 'Hi {#b-1}')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('see :doc[x]{nid="1" Ü}', 'see :doc[x]{nid="1"}')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('see :doc[x]{nid="1" Ü}', 'see :doc[x]{Ü nid=\'1\'}')).toBe(false)
  })

  it('keeps attribute lists and link titles apart from prose', () => {
    expect(wordsBracketsComponentsOrImagesDiffer('Hi {k="v"}', 'Hi k v')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('Text {#b-1}', 'Text {#b 1}')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('See [d](u "Docs title").', 'See [d](u) Docs title.')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('See [d](u "Docs title").', 'See [d](u){title="Docs title"}.')).toBe(false)
  })

  it('reads a mark tag its text opens and closes as often as a mark, any other as a token', () => {
    expect(wordsBracketsComponentsOrImagesDiffer('x <strong>b</strong> <u>c</u>', 'x **b** <u>c</u>')).toBe(false)
    expect(wordsBracketsComponentsOrImagesDiffer('Close with </strong> tag.', 'Close with  tag.')).toBe(true)
    expect(wordsBracketsComponentsOrImagesDiffer('Use the <em> tag.', 'Use the *tag.*')).toBe(true)
  })

  it('reads an ordered-list marker without its number', () => {
    expect(wordsBracketsComponentsOrImagesDiffer('1. a\n1. b\n> 7) c', '1. a\n2. b\n> 1. c')).toBe(false)
  })

  it('sees the same words in another order', () => {
    expect(wordsBracketsComponentsOrImagesDiffer('a <b> c\n\n- d', 'a c\n\n- d b')).toBe(true)
  })
})
