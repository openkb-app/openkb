<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow;

use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\content_moderation\ModerationInformationInterface;
use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;
use Drupal\openkb_space_access\SpaceModerationPolicy;

/**
 * The moderation status document for one page.
 *
 * Reports what the editor chrome cannot derive: whether the page is
 * moderated, the working copy's state, whether a draft sits on the published
 * revision, whether this user may publish, and what its space enforces.
 * Read-only.
 *
 * @see \Drupal\openkb_workflow\Controller\ModerationStatusController
 * @see \Drupal\openkb_collab_api\Controller\CommitResource
 */
final class ModerationStatus {

  use PageRevisionsTrait;

  /**
   * The only bundle this reports on. Matches the commit route's contract.
   */
  public const BUNDLE = 'kb_page';

  /**
   * The state Publish transitions into.
   */
  private const PUBLISHED_STATE = 'published';

  /**
   * Fields that differ between any two revisions without the content differing.
   *
   * `status` and `moderation_state` are included: they are what a draft of the
   * same content differs by.
   */
  private const REVISION_METADATA = [
    'vid',
    'changed',
    'status',
    'moderation_state',
    'revision_timestamp',
    'revision_uid',
    'revision_log',
    'revision_default',
    'revision_translation_affected',
    'content_translation_source',
    'content_translation_outdated',
    'content_translation_changed',
  ];

  public function __construct(
    private readonly AccountInterface $currentUser,
    private readonly ?ModerationInformationInterface $moderationInformation,
    private readonly ?SpaceModerationPolicy $spaceModeration,
    private readonly ReviewPolicy $reviewPolicy,
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly PageBlocks $pageBlocks,
  ) {}

  /**
   * {@inheritdoc}
   */
  protected function revisionStorage(): NodeStorageInterface {
    /** @var \Drupal\node\NodeStorageInterface $storage */
    $storage = $this->entityTypeManager->getStorage('node');
    return $storage;
  }

  /**
   * The moderation status of one page.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page's default revision.
   *
   * @return array
   *   The status document.
   */
  public function of(NodeInterface $node): array {
    if ($this->moderationInformation === NULL
      || !$this->moderationInformation->isModeratedEntity($node)) {
      return $this->document($node, [
        'moderated' => FALSE,
        'state' => NULL,
        'hasUnpublishedChanges' => FALSE,
        'canPublish' => FALSE,
      ]);
    }

    $working_copy = $this->workingCopy($node);

    if ($this->spaceModeration !== NULL && !$this->spaceModeration->applies($node)) {
      // A wiki space asks for no review before publishing, which is what
      // `moderated` describes — not whether this page has a draft. It has
      // one whenever a save or a held publish left it there, and the chrome
      // needs both that and the right to publish it.
      $pending = ($this->moderationInformation->hasPendingRevision($node)
        && $this->differs($working_copy, $node))
        // A never-published page is a pending draft too.
        || !$node->isPublished();
      return $this->document($node, [
        'moderated' => FALSE,
        'state' => $pending ? (string) $working_copy->get('moderation_state')->value : NULL,
        'hasUnpublishedChanges' => $pending,
        'canPublish' => $this->canPublish($working_copy),
      ]);
    }

    return $this->document($node, [
      'moderated' => TRUE,
      // The working copy's state, not the default revision's: the editor
      // works on the forward draft. Without a pending draft the two are the
      // same revision.
      'state' => (string) $working_copy->get('moderation_state')->value,
      'hasUnpublishedChanges' => $this->moderationInformation->hasPendingRevision($node)
      && $this->differs($working_copy, $node),
      'canPublish' => $this->canPublish($working_copy),
    ]);
  }

  /**
   * Whether two revisions hold different content.
   *
   * A pending revision is not enough: a revert writes a draft whose content
   * equals the published revision, and neither Publish nor Revert applies to
   * it. Compares every non-computed field except the per-revision bookkeeping.
   * An unknown field is compared rather than skipped.
   *
   * @param \Drupal\node\NodeInterface $working_copy
   *   The latest revision.
   * @param \Drupal\node\NodeInterface $default
   *   The default revision.
   *
   * @return bool
   *   TRUE when their content differs.
   */
  private function differs(NodeInterface $working_copy, NodeInterface $default): bool {
    foreach ($working_copy->getFields() as $name => $field) {
      if ($field->getFieldDefinition()->isComputed() || in_array($name, self::REVISION_METADATA, TRUE)) {
        continue;
      }
      if (!$default->hasField($name)) {
        return TRUE;
      }
      if ($field->getValue() !== $default->get($name)->getValue()) {
        return TRUE;
      }
    }
    return FALSE;
  }

  /**
   * The status document, with the fields every branch answers alike.
   *
   * `hasPublishedRevision` is what Revert depends on: a never-published
   * page has nothing to restore. `reviewSteps` and `mayModerate` are
   * reported on both branches, because space moderation and the review steps
   * are independent settings. The client derives from them; it does not decide.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The default revision.
   * @param array $status
   *   The moderation-dependent fields.
   *
   * @return array
   *   The status document.
   *
   * @see \Drupal\openkb_workflow\PageBlocks::mayApprove()
   */
  private function document(NodeInterface $node, array $status): array {
    $blockers = $this->reviewBlockers($node);
    return [
      'nid' => (int) $node->id(),
      'hasPublishedRevision' => $node->isPublished(),
      'reviewSteps' => $this->reviewPolicy->enforcedSteps($node),
      'mayModerate' => $this->reviewPolicy->mayModerate($node, $this->currentUser),
      'reviewBlockers' => $blockers,
      'publishBlockedReason' => $blockers === [] ? NULL : PendingReviewException::sentence($blockers),
    ] + $status;
  }

  /**
   * The blocks a publish is still waiting for, as the working copy stands.
   *
   * What the greyed Publish button says and why it is greyed. The same
   * question BlockAttribution::publicationHold() asks of a write, asked of the
   * revision the editor is looking at, which names no state to publish yet.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page's default revision.
   *
   * @return array<string, string[]>
   *   Block id => the review steps it owes, empty when a publish may go.
   */
  private function reviewBlockers(NodeInterface $node): array {
    $working_copy = $this->workingCopy($node);
    if (!$working_copy->hasField('field_block_meta')) {
      return [];
    }
    return $this->pageBlocks->blockers(
      $this->pageBlocks->decode($working_copy->get('field_block_meta')->value),
      $this->reviewPolicy->enforcedSteps($node),
    );
  }

  /**
   * Whether the current user may publish this revision.
   *
   * Requires `node.update`, the right the commit route requires and, inside a
   * space, the editor roster. Requires a workflow transition from the working
   * copy's state to published, or the button would offer a write the
   * ModerationState constraint rejects.
   *
   * @param \Drupal\node\NodeInterface $working_copy
   *   The revision a Publish would transition.
   *
   * @return bool
   *   TRUE when this user may publish this revision.
   */
  private function canPublish(NodeInterface $working_copy): bool {
    if ($this->moderationInformation === NULL
      || !$working_copy->access('update', $this->currentUser)) {
      return FALSE;
    }

    $workflow = $this->moderationInformation->getWorkflowForEntity($working_copy);
    if ($workflow === NULL) {
      return FALSE;
    }
    $state = (string) $working_copy->get('moderation_state')->value;

    return $workflow->getTypePlugin()->hasTransitionFromStateToState($state, self::PUBLISHED_STATE);
  }

}
