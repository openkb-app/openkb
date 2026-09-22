<?php

declare(strict_types=1);

namespace Drupal\openkb_tools\Plugin\tool\Tool;

use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\openkb_tools\SessionToolBase;
use Drupal\tool\Attribute\Tool;
use Drupal\tool\Tool\ToolOperation;
use Drupal\tool\TypedData\InputDefinition;
use Drupal\tool\TypedData\MapInputDefinition;

/**
 * Says something about one block, as the calling agent.
 *
 * Executed by the frontend server; see {@see SessionToolBase}. The message
 * rides the session document's own conversations (ADR 0006), so it appears in
 * the editor beside the human and is filed with the next checkpoint. Resolving
 * is not offered: an editor decides when their own point is settled.
 */
#[Tool(
  id: 'openkb_comment_on_block',
  label: new TranslatableMarkup('Comment on block'),
  description: new TranslatableMarkup('Say something about one block of a knowledge-base page — a reply to an open thread (pass its "threadId"), or a new thread on the block. Thread ids come from getPageForEditing\'s "comments" and from waitForChanges. The message is written as the calling account, carrying its agent label, into the page\'s collaborative session, so a human with the page open sees it at once. A thread cannot be resolved over this tool: the editor who raised the point decides when it is settled.'),
  operation: ToolOperation::Write,
  destructive: FALSE,
  input_definitions: [
    'path' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Path'),
      description: new TranslatableMarkup('The page path, as getPageForEditing and tool_api__search_pages report it. When the reader means the page they have open, the caller context carries its path as "path".'),
      required: FALSE,
    ),
    'nid' => new InputDefinition(
      data_type: 'integer',
      label: new TranslatableMarkup('Node id'),
      description: new TranslatableMarkup('Node id, as an alternative to "path".'),
      required: FALSE,
    ),
    'blockId' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Block id'),
      description: new TranslatableMarkup('The block to comment on, by the `{#b-…}` id every read of the page carries.'),
    ),
    'threadId' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Thread id'),
      description: new TranslatableMarkup('The thread to answer. Left off, a new thread is opened on the block.'),
      required: FALSE,
    ),
    'text' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Text'),
      description: new TranslatableMarkup('What to say.'),
    ),
  ],
  output_definitions: [
    'result' => new MapInputDefinition(
      label: new TranslatableMarkup('Result'),
      description: new TranslatableMarkup('What the editing session did: "ok", "nid" and "applied.comment" (the thread and message ids) on acceptance; "message" on a refusal, which writes nothing.'),
    ),
  ],
)]
final class CommentOnBlock extends SessionToolBase {}
