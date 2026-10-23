import type { FenceOptions } from '#shared/utils/fences'

/** A diagram: a ```` ```mermaid ```` fence, drawn by Pele (pele.run). See docs/diagrams.md. */
export default {
  label: 'Diagram',
  description: 'Flowchart, sequence and more, in Mermaid syntax',
  icon: 'i-lucide-workflow',
  languageLabel: 'Mermaid',
  template: 'flowchart LR\n  A[Start] --> B[Done]',
  agentHint: 'a diagram, in Mermaid syntax',
} satisfies FenceOptions
