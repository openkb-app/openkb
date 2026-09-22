import { getKbPage, type KbPage } from '../kb-read'
import { PATH_DESCRIPTION, toProjectionSchema } from './schemas'
import { projectThreads, THREAD_SCHEMA } from './comment-threads'
import { answered, refused, type JsonSchema, type KbTool } from './types'

/**
 * Reads the working copy — the revision the write tools act on.
 *
 * It goes over the same read path `GET /api/kb/<path>/draft.md` uses
 * (`server/utils/kb-read.ts`), so an agent sees exactly what that endpoint
 * serves, plus the moderation standing the editor chrome renders from. The
 * published page is Drupal's own `tool_api__get_page` (ADR 0009).
 */
export function getPageForEditingTool(frontmatterSchema: JsonSchema): KbTool {
  return {
    name: 'getPageForEditing',
    description:
      "Read a knowledge-base page's WORKING COPY by path — the revision "
      + 'updateFields and updateBlocks write, including edits a live editing '
      + 'session has taken and not yet committed. Returns the page once, as the '
      + '`.md` wire format — a YAML frontmatter block of the exposed fields '
      + 'above the canonical body — with the fields also given structured, plus '
      + 'the two things an edit needs: `versions`, the block version each write '
      + 'op sends back as its `expect`, and `status`, where the page stands '
      + 'editorially for your account. `status` is served only to an account '
      + 'that may edit, so a page that comes back without it is one you may read '
      + 'and not change. To read the page as it stands PUBLISHED — to answer a '
      + 'question or to cite it — call tool_api__get_page instead.\n\n'
      + '`comments` is what the editors are saying about the blocks — open '
      + 'threads, resolved ones only if you ask. Read them before you rewrite '
      + 'anything: a thread is somebody telling you what this block still needs, '
      + 'and commentOnBlock is how you answer one. To work on the page WHILE a '
      + 'human edits it, call waitForChanges next and loop on it: act on '
      + '`comments` addressed to you, on `blocks` only where your instructions '
      + 'say to, and never write into a block somebody is in.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_DESCRIPTION },
        includeResolved: {
          type: 'boolean',
          description:
            'Also serve the conversations an editor has marked done. Off by '
            + 'default: a resolved thread is settled, and acting on one re-opens '
            + 'a question somebody closed.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        title: { type: 'string' },
        // Derived from GET /openkb/schema — the exposure contract, not a
        // hardcoded field list. Tracks the frontmatter form display.
        frontmatter: toProjectionSchema(frontmatterSchema),
        markdown: {
          type: 'string',
          description:
            'The whole page: the frontmatter block above the body, carrying the '
            + '`{#b-…}` block ids updateBlocks writes by.',
        },
        versions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            "Block id → that block's current version. Pass one back as an "
            + 'updateBlocks `expect` to have the write refused if the block '
            + 'changed in the meantime. Ids are in any read of the page; these '
            + 'versions are in this one only.',
        },
        status: {
          type: 'object',
          description:
            'Where the page stands editorially, answered for your account. '
            + 'Present only when you may edit the page — a reader has no '
            + 'editorial standing to report — so its presence is what tells '
            + 'you the page is writable.',
          properties: {
            draft_exists: {
              type: 'boolean',
              description:
                'A draft sits on top of the published page: what is live is '
                + 'behind what this tool reads.',
            },
            blocks_pending: {
              type: 'integer',
              description:
                'How many blocks of the working copy still need a human '
                + 'sign-off.',
            },
            can_publish: {
              type: 'boolean',
              description:
                'Whether YOU may publish the working copy right now: you hold '
                + 'the transition, there is something to publish, and no block '
                + 'is still waiting for sign-off. Another editor\'s answer can '
                + 'differ, so state it as yours.',
            },
          },
          required: ['draft_exists', 'blocks_pending', 'can_publish'],
          additionalProperties: false,
        },
        comments: {
          type: 'array',
          description:
            'Open conversations about this page\'s blocks, oldest first '
            + '(resolved ones only with `includeResolved`). Served, like '
            + '`status`, only to an account that may edit the page. Answer one '
            + 'with commentOnBlock. A thread whose `assignee` names your account '
            + 'and your agent label was handed to you in particular — do those '
            + 'first.',
          items: THREAD_SCHEMA,
        },
      },
      required: ['path', 'title', 'frontmatter', 'markdown', 'versions'],
      additionalProperties: false,
    },
    async run(args, { event }) {
      const path = args.path
      if (typeof path !== 'string' || path === '') {
        return refused('getPageForEditing requires a non-empty "path" string.')
      }
      let page: KbPage | null
      try {
        page = await getKbPage(event, path, {
          version: 'working-copy',
          withStatus: true,
          withComments: true,
        })
      }
      catch (err) {
        // Every reader meets this refusal, so it names the state and the way
        // on rather than the status the read path answered with.
        if ((err as { statusCode?: number }).statusCode !== 403) throw err
        return refused(
          `This page is read-only for you: editing "${path}" needs a seat with `
          + 'write access in its space. Read it with tool_api__get_page.',
        )
      }
      if (!page) return refused(`No page found at path "${path}".`)
      const { comments, ...rest } = page
      const threads = comments ? projectThreads(comments, args.includeResolved === true) : undefined
      return answered(page.markdown, {
        ...rest,
        ...(threads ? { comments: threads } : {}),
      })
    },
  }
}
