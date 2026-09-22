<?php

declare(strict_types=1);

namespace Drupal\openkb_jsonapi\Controller;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Controller\ControllerBase;
use Drupal\Core\Entity\EntityRepositoryInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_workflow\PageRevisionsTrait;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * Moves a page to another space.
 *
 * Endpoint: POST /openkb/node/{node}/space with `{"space": "<space-uuid>"}`.
 *
 * Placement is not editorial content: a space is the organizational unit an
 * page lives in, which is why it is context rather than a frontmatter field
 * (OKB-63) and why moving is a deliberate action of its own. That distinction
 * decides the whole shape of this resource, because neither existing write path
 * can express it:
 *
 * - `POST /openkb/node/{node}/commit` drafts every payload that names no
 *   moderation state. On a published page the reassignment would then live
 *   in a forward draft only, and every default-revision reader — the sidebar,
 *   the space landing page, search — would keep showing the page in the
 *   space it just left.
 * - A JSON:API PATCH is refused outright as soon as a forward draft exists
 *   (core #2795279), which is the normal state of a page somebody has been
 *   editing.
 *
 * So this resource writes `field_space` **in place** on the default revision
 * and on the forward draft when one exists: no new revision, no
 * moderation-state change, no body touched, and both revisions agree on where
 * the page lives.
 * The saves are marked as syncing, which is core's own signal for a change that
 * is not an editorial update — it is what keeps content_moderation from forcing
 * a new revision and from re-deciding which revision is default.
 *
 * `changed` still advances (ChangedItem bumps it for any modified entity), so
 * an open editing session sees an external change and offers a reload. That is
 * the honest outcome: the page did move underneath the session.
 *
 * Access: `node.update` entity access plus the session CSRF token (route
 * requirements), then `field_space` field-edit access, then validation of the
 * reference itself. Rights on the *target* space are OKB-88's to add.
 */
final class PageSpaceResource extends ControllerBase {

  use PageRevisionsTrait;

  /**
   * {@inheritdoc}
   */
  protected function revisionStorage(): NodeStorageInterface {
    /** @var \Drupal\node\NodeStorageInterface $storage */
    $storage = $this->entityTypeManager->getStorage('node');
    return $storage;
  }

  /**
   * The only bundle this endpoint moves.
   */
  private const BUNDLE = 'kb_page';

  /**
   * Constructs the resource.
   *
   * @param \Drupal\Core\Entity\EntityRepositoryInterface $entityRepository
   *   Resolves the target space by UUID — the identifier the decoupled
   *   frontend addresses spaces with.
   * @param \Drupal\Core\Entity\EntityTypeManagerInterface $entity_type_manager
   *   The revision reads go through its node storage.
   */
  public function __construct(
    private readonly EntityRepositoryInterface $entityRepository,
    EntityTypeManagerInterface $entity_type_manager,
  ) {
    $this->entityTypeManager = $entity_type_manager;
  }

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self($container->get('entity.repository'), $container->get('entity_type.manager'));
  }

  /**
   * Reassigns one page's space.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page, as resolved by the route (its default revision).
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request carrying `{"space": "<space-uuid>"}`.
   *
   * @return \Symfony\Component\HttpFoundation\JsonResponse
   *   The page's new placement.
   */
  public function move(NodeInterface $node, Request $request): JsonResponse {
    if ($node->bundle() !== self::BUNDLE) {
      // 404 rather than 403: for anything but a kb_page this endpoint does
      // not exist, and saying so reveals nothing about the node.
      throw new NotFoundHttpException(sprintf('The space endpoint only accepts %s nodes.', self::BUNDLE));
    }
    if (!$node->hasField('field_space')) {
      throw new NotFoundHttpException('This page has no space field.');
    }
    if (!$node->get('field_space')->access('edit')) {
      throw new AccessDeniedHttpException('You may not change this page\'s space.');
    }

    $space = $this->resolveSpace($request);

    foreach ($this->revisionsToWrite($node) as $revision) {
      $revision->set('field_space', ['target_id' => $space->id()]);
      $this->assertValidPlacement($revision);
      $this->saveStateOnly($revision);
    }

    return new JsonResponse([
      'nid' => (int) $node->id(),
      'space' => [
        'id' => $space->uuid(),
        'name' => $space->label(),
      ],
    ]);
  }

  /**
   * The revisions a move has to write.
   *
   * The default revision is what every listing reads, and the forward draft —
   * when the page has one — is what the editor is working in and what
   * becomes default on the next publish. Both carry the placement or the move
   * un-does itself the moment the draft lands.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page's default revision, as resolved by the route.
   *
   * @return \Drupal\node\NodeInterface[]
   *   The revisions to write, default revision first.
   */
  private function revisionsToWrite(NodeInterface $node): array {
    $working_copy = $this->workingCopy($node);
    return $working_copy === $node ? [$node] : [$node, $working_copy];
  }

  /**
   * The target space named by the payload.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request carrying the payload.
   *
   * @return \Drupal\openkb_space\SpaceInterface
   *   The target space.
   */
  private function resolveSpace(Request $request): SpaceInterface {
    $payload = Json::decode((string) $request->getContent());
    $uuid = is_array($payload) ? ($payload['space'] ?? NULL) : NULL;
    if (!is_string($uuid) || $uuid === '') {
      throw new BadRequestHttpException('Request body must be {"space": "<space-uuid>"}.');
    }

    $space = $this->entityRepository->loadEntityByUuid('openkb_space', $uuid);
    if (!$space instanceof SpaceInterface) {
      throw new NotFoundHttpException(sprintf('No space with UUID %s.', $uuid));
    }
    return $space;
  }

  /**
   * Rejects a placement the field itself would not accept.
   *
   * Only `field_space` is validated: a violation elsewhere — the classic one
   * being a reference whose target was deleted after the fact — is not this
   * move's to answer for, and validating the whole page would wedge every
   * future move behind data the editor cannot see.
   *
   * @param \Drupal\node\NodeInterface $revision
   *   The revision about to be saved.
   */
  private function assertValidPlacement(NodeInterface $revision): void {
    $violations = $revision->get('field_space')->validate();
    if ($violations->count() > 0) {
      throw new UnprocessableEntityHttpException((string) $violations->get(0)->getMessage());
    }
  }

}
