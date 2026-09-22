<?php

declare(strict_types=1);

namespace Drupal\openkb_media_library;

use Drupal\Core\Ajax\AjaxResponse;
use Drupal\Core\Ajax\CloseModalDialogCommand;
use Drupal\Core\Access\AccessResult;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\media_library\MediaLibraryOpenerInterface;
use Drupal\media_library\MediaLibraryState;
use Drupal\openkb_media_library\Ajax\MediaSelectionCommand;

/**
 * Media library opener for the decoupled editor.
 *
 * The editor page loads Drupal's dialog libraries (via the assets endpoint,
 * see EditorAssetsController) and opens the standard media-library dialog
 * in-page through Drupal.ajax against the media_library.ui route. "Insert
 * selected" submits the library's selection form via AJAX as usual; this
 * opener answers it with a command that dispatches the selected media UUIDs
 * as a DOM CustomEvent — the editor listens and inserts `::image` embeds —
 * and closes the dialog.
 */
final class MediaLibraryEditorOpener implements MediaLibraryOpenerInterface {

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * {@inheritdoc}
   *
   * Delegates to entity access, like core's MediaLibraryFieldWidgetOpener:
   * whoever may edit the target page may pick media for it. The nid
   * travels in the server-built opener parameters (hash-protected, see
   * MediaLibraryState), so the check automatically tracks every current
   * and future node-access rule — no parallel permission model.
   */
  public function checkAccess(MediaLibraryState $state, AccountInterface $account) {
    $parameters = $state->getOpenerParameters();
    if (empty($parameters['nid'])) {
      return AccessResult::forbidden('nid parameter is missing.')->addCacheableDependency($state);
    }
    $node = $this->entityTypeManager->getStorage('node')->load($parameters['nid']);
    if (!$node) {
      return AccessResult::forbidden('The target node does not exist.')->addCacheableDependency($state);
    }
    return $node->access('update', $account, TRUE)->addCacheableDependency($state);
  }

  /**
   * {@inheritdoc}
   */
  public function getSelectionResponse(MediaLibraryState $state, array $selected_ids) {
    $uuids = [];
    foreach ($this->entityTypeManager->getStorage('media')->loadMultiple($selected_ids) as $media) {
      $uuids[] = $media->uuid();
    }
    $response = new AjaxResponse();
    $response->addCommand(new MediaSelectionCommand($uuids));
    $response->addCommand(new CloseModalDialogCommand());
    return $response;
  }

}
