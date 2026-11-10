import { computed, type ComputedRef } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import type { EditorHandler } from '@nuxt/ui'

/** What a toolbar asks a handler about an item: active, disabled, executable. */
type StateQuestion = EditorHandler['isActive']

/**
 * Answers a state question through one computed per editor and item.
 *
 * Tiptap's editor state is a single ref that changes with every transaction.
 * A computed passes on only a changed answer, so a toolbar reading it
 * re-renders when a button's state changes and not on every keystroke.
 */
function answeredThroughComputed(question: StateQuestion): StateQuestion {
  const answers = new WeakMap<Editor, WeakMap<object, ComputedRef<boolean>>>()
  return (editor, item) => {
    if (typeof item !== 'object' || item === null) return question(editor, item)
    let ofEditor = answers.get(editor)
    if (!ofEditor) answers.set(editor, ofEditor = new WeakMap())
    let answer = ofEditor.get(item)
    if (!answer) ofEditor.set(item, answer = computed(() => question(editor, item)))
    return answer.value
  }
}

/** Wraps the state questions of every handler; `execute` stays as it is. */
export function handlersAnsweringThroughComputeds<Handlers extends Record<string, EditorHandler>>(handlers: Handlers): Handlers {
  return Object.fromEntries(Object.entries(handlers).map(([kind, handler]) => [kind, {
    ...handler,
    canExecute: answeredThroughComputed(handler.canExecute),
    isActive: answeredThroughComputed(handler.isActive),
    isDisabled: handler.isDisabled && answeredThroughComputed(handler.isDisabled),
  }])) as Handlers
}
