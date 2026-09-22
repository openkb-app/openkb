<?php

declare(strict_types=1);

namespace Drupal\openkb_tools\Plugin\tool\Tool;

use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\openkb_tools\SessionToolBase;
use Drupal\tool\Attribute\Tool;
use Drupal\tool\Tool\ToolOperation;
use Drupal\tool\TypedData\InputDefinition;
use Drupal\tool\TypedData\ListInputDefinition;
use Drupal\tool\TypedData\MapInputDefinition;

/**
 * Says what has happened in the live editing session since the last call.
 *
 * Executed by the frontend server; see {@see SessionToolBase}. It is the most
 * session-bound tool there is: every event it answers is derived from the
 * Y.Doc the frontend holds — the conversations, the settled blocks, the peers'
 * awareness — none of which Drupal sees until a checkpoint.
 *
 * The description below is the chat's. The MCP tool of the same name carries
 * its own, which is about the loop an agent runs (ADR 0009).
 */
#[Tool(
  id: 'openkb_wait_for_changes',
  label: new TranslatableMarkup('Wait for changes'),
  description: new TranslatableMarkup('Ask what has happened in the knowledge-base page since you last asked, and be answered at once — nothing here waits. The first call only marks the point in time and reports nothing; call it again later and it reports what happened in between. Every answer carries a "cursor": pass it to the next call and that call resumes from there. Three kinds of event: "comments" (a thread opened, answered or resolved — read it and answer with commentOnBlock), "blocks" (a block somebody finished editing, reported once it settles rather than per keystroke) and "presence" (who is in the page and which block they are in — never write into a block somebody is in). A "session" event says the editors have left. Events are only collected while somebody is watching the page, so a page nobody has open reports nothing, no matter what happened on it earlier; "editors" says how many people have it open, which is how "nobody is here" and "nothing has happened" stay different answers. Asking joins the live editing session, so it needs the same write access as updateBlocks.'),
  operation: ToolOperation::Write,
  destructive: FALSE,
  input_definitions: [
    'path' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Path'),
      description: new TranslatableMarkup('The page path, as getPageForEditing and tool_api__search_pages report it.'),
      constraints: ['Length' => ['min' => 1]],
    ),
    'cursor' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Cursor'),
      description: new TranslatableMarkup('Where to resume, from the previous answer. Left off, the answer starts from now and reports nothing.'),
      required: FALSE,
    ),
    'kinds' => new ListInputDefinition(
      label: new TranslatableMarkup('Kinds'),
      description: new TranslatableMarkup('Which kinds to ask about — "comments", "blocks", "presence"; all of them by default.'),
      item_definition: new InputDefinition(
        data_type: 'string',
        label: new TranslatableMarkup('Kind'),
        description: new TranslatableMarkup('One of "comments", "blocks" or "presence".'),
      ),
      required: FALSE,
    ),
  ],
  output_definitions: [
    'result' => new MapInputDefinition(
      label: new TranslatableMarkup('Result'),
      description: new TranslatableMarkup('"events", what happened in order; "cursor", where the next call resumes; "editors", how many people have the page open; and "restarted" / "dropped", set when the log could not serve the cursor and the page needs re-reading.'),
    ),
  ],
)]
final class WaitForChanges extends SessionToolBase {

  /**
   * {@inheritdoc}
   *
   * A chat turn holds no request open, so the session answers with whatever
   * it has since the cursor. There is no input to say otherwise.
   */
  protected function sessionToolArguments(array $values): array {
    return $values + ['timeoutSec' => 0];
  }

}
