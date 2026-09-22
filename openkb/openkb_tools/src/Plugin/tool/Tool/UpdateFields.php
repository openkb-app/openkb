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
 * Writes frontmatter fields into a page's draft.
 *
 * Executed by the frontend server; see {@see SessionToolBase}. The write lands
 * in the page's collaborative session, so the field shapes it accepts are the
 * site's frontmatter exposure contract (`GET /openkb/schema`) rather than
 * anything fixed here.
 */
#[Tool(
  id: 'openkb_update_fields',
  label: new TranslatableMarkup('Update fields'),
  description: new TranslatableMarkup("Update frontmatter fields of a knowledge-base page's draft. Only the fields you pass are touched; the body is left alone. The edit is applied inside the page's collaborative editing session, so a human with the page open sees it arrive live. It does not publish — read it back with getPageForEditing."),
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
    'fields' => new MapInputDefinition(
      label: new TranslatableMarkup('Fields'),
      description: new TranslatableMarkup("Field keys to write, with their new values. The keys and shapes are the site's frontmatter exposure contract, which the tool advertises in full where it runs."),
    ),
  ],
  output_definitions: [
    'result' => new MapInputDefinition(
      label: new TranslatableMarkup('Result'),
      description: new TranslatableMarkup('What the editing session did: "ok", "nid", "entry", "observers" and "applied" on acceptance; "message" and "errors" on a refusal, which writes nothing.'),
    ),
  ],
)]
final class UpdateFields extends SessionToolBase {}
