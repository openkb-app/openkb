<?php

declare(strict_types=1);

namespace Drupal\openkb_media_library\Ajax;

use Drupal\Core\Ajax\CommandInterface;

/**
 * AJAX command carrying the selected media UUIDs to the editor page.
 *
 * The command handler (js/selection.js, loaded with the dialog libraries)
 * dispatches them as an `okb:media-selected` CustomEvent on `document`;
 * the editor listens and inserts the corresponding `::image` embeds.
 */
final class MediaSelectionCommand implements CommandInterface {

  /**
   * Constructs the command.
   *
   * @param string[] $uuids
   *   UUIDs of the selected media entities.
   */
  public function __construct(
    private readonly array $uuids,
  ) {}

  /**
   * {@inheritdoc}
   */
  public function render(): array {
    return [
      'command' => 'okbMediaSelected',
      'uuids' => $this->uuids,
    ];
  }

}
