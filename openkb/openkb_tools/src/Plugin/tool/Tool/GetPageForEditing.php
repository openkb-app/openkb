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
 * Reads the working copy, as the live editing session holds it.
 *
 * Executed by the frontend server; see {@see SessionToolBase}. This is the
 * read ADR 0009 names as session-bound: the working copy is behind the
 * document for as long as somebody has the page open, so the answer has to
 * come from the room rather than from a revision.
 *
 * The read half of the write loop, and the only tool that serves the `expect`
 * tokens `openkb_update_blocks` refuses stale writes against. Reading what is
 * published is {@see GetPage}, in Drupal.
 */
#[Tool(
  id: 'openkb_get_page_for_editing',
  label: new TranslatableMarkup('Get page for editing'),
  description: new TranslatableMarkup('Read a knowledge-base page\'s working copy — the revision updateFields and updateBlocks write, including edits a live editing session has taken and not yet committed. Answers the same `.md` wire format the published read does, plus the two things an edit needs: "versions", the block version each write op sends back as its "expect", and "status", where the page stands editorially for your account. Use this before writing, and to read your own writes back. To read the page as it stands published — to answer a question or to cite it — use tool_api__get_page instead.'),
  operation: ToolOperation::Read,
  destructive: FALSE,
  input_definitions: [
    'path' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Path'),
      description: new TranslatableMarkup('The page path, as tool_api__get_page and tool_api__search_pages report it. When the reader means the page they have open, the caller context carries its path as "path".'),
      constraints: ['Length' => ['min' => 1]],
    ),
  ],
  output_definitions: [
    'page' => new MapInputDefinition(
      label: new TranslatableMarkup('Page'),
      description: new TranslatableMarkup('The working copy: "path", "title", "frontmatter", "markdown" (carrying the `{#b-…}` block ids updateBlocks writes by), "versions" (block id → its current version, the `expect` a write sends back) and, for an account that may edit, "status".'),
    ),
  ],
)]
final class GetPageForEditing extends SessionToolBase {}
