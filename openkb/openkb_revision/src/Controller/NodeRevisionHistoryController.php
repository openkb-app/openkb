<?php

declare(strict_types=1);

namespace Drupal\openkb_revision\Controller;

use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Datetime\DateFormatterInterface;
use Drupal\Core\Entity\Controller\VersionHistoryController;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Language\LanguageManagerInterface;
use Drupal\Core\Pager\PagerManagerInterface;
use Drupal\Core\Render\RendererInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\custom_elements\CustomElement;
use Drupal\node\NodeInterface;

/**
 * Serves a node's revision history as custom elements.
 *
 * Extends core's version-history controller and replaces only its render step:
 * core builds an admin table, this builds elements. Which revisions there are,
 * in what order, in which language and how many per page all stay core's —
 * ::loadRevisions() and its pager, not a query of ours.
 *
 * Read-only. Reverting is a write and stays with the surfaces that own writes.
 */
final class NodeRevisionHistoryController extends VersionHistoryController {

  public function __construct(
    EntityTypeManagerInterface $entity_type_manager,
    LanguageManagerInterface $language_manager,
    DateFormatterInterface $date_formatter,
    RendererInterface $renderer,
    private readonly PagerManagerInterface $pagerManager,
  ) {
    parent::__construct($entity_type_manager, $language_manager, $date_formatter, $renderer);
  }

  /**
   * Requires read access to the node, beside core's revision permission.
   *
   * A route requirement running next to `_entity_access: node.view all
   * revisions` (mode ALL, so the two are ANDed). Core answers that operation on
   * the revision permission alone — NodeAccessControlHandler allows as soon as
   * the account holds `view <bundle> revisions`, without consulting node
   * grants — and this site grants it to every authenticated user. Node grants
   * are what a space is (openkb_space_access), so without this an account
   * outside a private space could read its pages' editing record. Added to
   * the core route too, which closes Drupal's own overview as well.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The node, as resolved by the route.
   * @param \Drupal\Core\Session\AccountInterface $account
   *   The account the route is checked for.
   *
   * @return \Drupal\Core\Access\AccessResultInterface
   *   Whether this account may read the node at all.
   */
  public static function readable(NodeInterface $node, AccountInterface $account): AccessResultInterface {
    return $node->access('view', $account, TRUE);
  }

  /**
   * Renders one node's revision history, newest first.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The node, as resolved by the route.
   *
   * @return \Drupal\custom_elements\CustomElement
   *   The history element.
   */
  public function history(NodeInterface $node): CustomElement {
    /** @var \Drupal\node\NodeStorageInterface $storage */
    $storage = $this->entityTypeManager->getStorage($node->getEntityTypeId());
    $latest_vid = (int) $storage->getLatestRevisionId($node->id());

    $element = CustomElement::create('node-revision-history');
    $element->setAttribute('nid', (int) $node->id());
    $element->setAttribute('title', $node->label());
    // Drupal's alias for the node, so one side owns its URL.
    $element->setAttribute('nodeUrl', $node->toUrl()->toString());

    $shown = 0;
    foreach ($this->loadRevisions($node) as $revision) {
      assert($revision instanceof NodeInterface);
      $element->addSlotFromCustomElement('revisions', $this->revisionElement($revision, $latest_vid));
      $shown++;
    }

    // What the page window left out, counted by core's pager. Every editing
    // session checkpoints into a revision, so a list that ended silently at the
    // window would read as a node edited fifty times.
    $element->setAttribute('shown', $shown);
    $element->setAttribute('total', $this->pagerManager->getPager()?->getTotalItems() ?? $shown);

    // Any write to the node writes a revision. Varies by account: the author
    // names and the access that got the reader here both do.
    $element->addCacheTags($node->getCacheTags());
    $element->addCacheContexts(['user']);

    return $element;
  }

  /**
   * One revision, as a row of the history.
   *
   * `current` and `published` are two facts and a node routinely has them on
   * two revisions — that is what a forward draft is.
   *
   * @param \Drupal\node\NodeInterface $revision
   *   The revision to describe.
   * @param int $latest_vid
   *   The newest revision's id — the working copy the editing surfaces open.
   *
   * @return \Drupal\custom_elements\CustomElement
   *   The revision element.
   */
  private function revisionElement(NodeInterface $revision, int $latest_vid): CustomElement {
    $element = CustomElement::create('node-revision');
    $element->setAttribute('vid', (int) $revision->getRevisionId());
    // ISO 8601 in UTC; the frontend renders it in the reader's own zone.
    $element->setAttribute('created', $this->dateFormatter->format((int) $revision->getRevisionCreationTime(), 'custom', 'c', 'UTC'));
    $element->setAttribute('author', $revision->getRevisionUser()?->getDisplayName());
    // Empty is a fact, not a placeholder: no message means no line.
    $element->setAttribute('log', trim((string) $revision->getRevisionLogMessage()) ?: NULL);
    $element->setAttribute('state', $revision->hasField('moderation_state')
      ? (string) $revision->get('moderation_state')->value
      : NULL);
    $element->setAttribute('current', (int) $revision->getRevisionId() === $latest_vid);
    // The revision readers are being served, which is core's own definition of
    // the default revision — and only live while the node is published.
    $element->setAttribute('published', $revision->isDefaultRevision() && $revision->isPublished());

    return $element;
  }

}
