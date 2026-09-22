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
 * Edits a page's draft block by block, under optimistic concurrency.
 *
 * Executed by the frontend server; see {@see SessionToolBase}. Every op names
 * the block it acts on and the version it expects, which is what lets an agent
 * write beside a human in the same live session.
 */
#[Tool(
  id: 'openkb_update_blocks',
  label: new TranslatableMarkup('Update blocks'),
  description: new TranslatableMarkup("Edit a knowledge-base page's DRAFT block by block. Each op names its block by the `{#b-…}` id getPageForEditing returns: pass \"id\" to replace it, or \"after\"/\"before\" to insert beside it; an op naming no block lands after the one before it, and as the first op it fills a page that holds no blocks yet. Blocks you do not name are not touched. ALWAYS send \"expect\", the block version getPageForEditing reported — if a block moved, the whole call is refused and the result carries \"conflicts\" with that block's current markdown and version, so the retry needs no second read. A successful call answers \"applied.blocks\", block id → the version it holds now, which is the next op's \"expect\". The edit lands in the page's collaborative session and does not publish."),
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
    'blocks' => new ListInputDefinition(
      label: new TranslatableMarkup('Blocks'),
      description: new TranslatableMarkup('The block writes, applied in order.'),
      item_definition: new MapInputDefinition(
        label: new TranslatableMarkup('Block write'),
        description: new TranslatableMarkup('One op: "markdown" plus at most one of "id", "after" or "before", and the "expect" version of the block it names. Write comark markdown only: raw HTML is not part of the format and is not preserved; use `::callout`, `::infobox`, `::image` and `:doc` for anything beyond CommonMark.'),
      ),
    ),
  ],
  output_definitions: [
    'result' => new MapInputDefinition(
      label: new TranslatableMarkup('Result'),
      description: new TranslatableMarkup('What the editing session did: "ok", "nid", "entry", "observers" and "applied" on acceptance; "message", "errors" or "conflicts" on a refusal, which writes nothing.'),
    ),
  ],
)]
final class UpdateBlocks extends SessionToolBase {}
