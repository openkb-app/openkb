<?php

declare(strict_types=1);

namespace Drupal\openkb_collab_api\Controller;

use Drupal\Component\Serialization\Json;
use Drupal\content_moderation\ModerationInformationInterface;
use Drupal\Core\Session\AccountSwitcherInterface;
use Drupal\user\UserInterface;
use Drupal\jsonapi\Controller\EntityResource;
use Drupal\jsonapi\JsonApiResource\JsonApiDocumentTopLevel;
use Drupal\jsonapi\JsonApiResource\ResourceObject;
use Drupal\jsonapi\JsonApiResource\ResourceObjectData;
use Drupal\jsonapi\ResourceResponse;
use Drupal\jsonapi\ResourceType\ResourceType;
use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;
use Drupal\openkb_workflow\PageRevisionsTrait;
use Drupal\openkb_workflow\BlockAttribution;
use Drupal\openkb_workflow\CollabServerIdentity;
use Drupal\openkb_workflow\PendingReviewException;
use Drupal\openkb_workflow\BlockMetaLock;
use Drupal\openkb_collab_api\StaleCommitException;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * The write surface for collaborative checkpoints and the `.md` PUT.
 *
 * Endpoint: POST /openkb/node/{node}/commit with a JSON body of
 * `{"attributes": {…}, "relationships": {…}}` — the JSON:API `data` fragment
 * shape the frontend's commit payload extenders produce.
 *
 * A payload may name `based_on_changed`, the working copy's `changed` it was
 * assembled against. Drupal is where that is judged: the lock below orders
 * writers, it does not tell a stale one from a current one, so a commit built
 * on content somebody has since replaced is refused 409 rather than applied
 * over them. See ::refuseStaleCommit().
 *
 * Why this is not a plain JSON:API PATCH: `kb_page` is moderated, so a
 * checkpoint writes a forward draft — a revision that is latest but not
 * default. JSON:API refuses every subsequent write on such an entity
 * (\Drupal\jsonapi\Controller\EntityResource::patchIndividual(), "Updating a
 * resource object that has a working copy is not yet supported",
 * https://www.drupal.org/project/drupal/issues/2795279), which caps a collab
 * session at one checkpoint per page. That guard protects a real hazard,
 * not just an unfinished feature: JSON:API bases the new revision on the
 * **default** revision, so a checkpoint sending only the fields it saw change
 * would silently revert everything an earlier checkpoint wrote into the
 * forward draft.
 *
 * So this resource owns the revision base: it applies the payload to the
 * **latest** revision, which makes a partial payload merge onto the working
 * copy instead of onto the published revision. It also owns the moderation
 * state a commit lands in — see ::commitState(). Everything else — document
 * deserialization, attribute and relationship application (including
 * target-UUID resolution), per-field PATCH access, entity validation, and both
 * the success and the error document — is core's, inherited from
 * `jsonapi.entity_resource`.
 *
 * Access: `node.update` entity access plus the session CSRF token (route
 * requirements), then core's per-field PATCH access, then entity validation.
 *
 * A checkpoint may also state the sign-offs its peers made during the window.
 * Drupal records them while it computes the sidecar this save writes
 * (\Drupal\openkb_workflow\BlockAttribution::projected()); one the review
 * rules turn down comes back in the response's `review` meta and the commit
 * stands.
 *
 * A collaboration-server checkpoint names the user acting through it, and the
 * request switches to that user for the write — see ::actingUser(). Page
 * access, per-field PATCH access, the moderation transition check and presave
 * attribution then all run as them. The route's own access ran at
 * kernel.request against the carrier, so the page is asked again after the
 * switch.
 *
 * Scope: `kb_page` only. Entity access already keeps any other bundle safe,
 * but this is the knowledge-base commit surface and nothing else routes
 * through it — an explicit contract beats an incidentally-safe one.
 */
class CommitResource extends EntityResource {

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
   * The only bundle this endpoint commits.
   */
  private const BUNDLE = 'kb_page';

  /**
   * The state every content write lands in. See ::commitState.
   */
  private const CONTENT_WRITE_STATE = 'draft';

  /**
   * The review sidecar, which no payload may carry. See ::buildDocument().
   */
  private const SIDECAR_FIELD = 'field_block_meta';

  /**
   * The revision's own label, which only a revision has. See ::statesOnly().
   */
  private const REVISION_LOG_FIELD = 'revision_log';

  /**
   * The optimistic-concurrency token. See ::refuseStaleCommit().
   */
  private const BASED_ON_FIELD = 'based_on_changed';

  /**
   * Moderation lookup, or NULL where content_moderation is not installed.
   *
   * @var \Drupal\content_moderation\ModerationInformationInterface|null
   */
  private ?ModerationInformationInterface $moderationInformation = NULL;

  /**
   * The sidecar this write will produce, and the publish gate over it.
   *
   * See ::setReviewGate().
   */
  private BlockAttribution $blockAttribution;

  /**
   * The sidecar's one-writer-at-a-time hold. See ::setBlockMetaLock().
   */
  private BlockMetaLock $blockMetaLock;

  /**
   * Whether this write is a session checkpoint. See ::setCollabServer().
   *
   * @var \Drupal\openkb_workflow\CollabServerIdentity
   */
  private CollabServerIdentity $collabServer;

  /**
   * Becomes the acting user for the write. See ::actingUser().
   */
  private AccountSwitcherInterface $accountSwitcher;

  /**
   * Setter injection for the collaboration server's credential.
   *
   * By the same mechanism as the setters below: the constructor is core's.
   *
   * @param \Drupal\openkb_workflow\CollabServerIdentity $collab_server
   *   Whether this write is the collaboration server checkpointing a session.
   * @param \Drupal\Core\Session\AccountSwitcherInterface $account_switcher
   *   Becomes the user the checkpoint names.
   */
  public function setCollabServer(CollabServerIdentity $collab_server, AccountSwitcherInterface $account_switcher): void {
    $this->collabServer = $collab_server;
    $this->accountSwitcher = $account_switcher;
  }

  /**
   * Setter injection for the sidecar's write lock.
   *
   * By the same mechanism as the setters below: the constructor is core's.
   *
   * @param \Drupal\openkb_workflow\BlockMetaLock $block_meta_lock
   *   The sidecar's one-writer-at-a-time hold.
   */
  public function setBlockMetaLock(BlockMetaLock $block_meta_lock): void {
    $this->blockMetaLock = $block_meta_lock;
  }

  /**
   * Setter injection for the optional content_moderation service.
   *
   * The constructor is core's, inherited untouched so its argument list stays
   * in step with `jsonapi.entity_resource` — hence a setter, wired in
   * openkb_agent.services.yml.
   *
   * @param \Drupal\content_moderation\ModerationInformationInterface|null $moderation_information
   *   The moderation information service, if content_moderation is installed.
   */
  public function setModerationInformation(?ModerationInformationInterface $moderation_information): void {
    $this->moderationInformation = $moderation_information;
  }

  /**
   * Setter injection for the publish gate.
   *
   * By the same mechanism as the one above.
   *
   * @param \Drupal\openkb_workflow\BlockAttribution $block_attribution
   *   The sidecar this write will produce, and the publish gate over it.
   */
  public function setReviewGate(BlockAttribution $block_attribution): void {
    $this->blockAttribution = $block_attribution;
  }

  /**
   * Writes one revision from a commit payload.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page, as resolved by the route (its default revision).
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   *
   * @return \Drupal\jsonapi\ResourceResponse
   *   The written revision as a JSON:API document.
   */
  public function commit(NodeInterface $node, Request $request): ResourceResponse {
    if ($node->bundle() !== self::BUNDLE) {
      // 404 rather than 403: for anything but a kb_page this endpoint does
      // not exist, and saying so reveals nothing about the node.
      throw new NotFoundHttpException(sprintf('The commit endpoint only accepts %s nodes.', self::BUNDLE));
    }

    // A checkpoint is a sidecar writer too — presave attribution stamps
    // `field_block_meta` from the value this revision was loaded with — so it
    // takes the same hold as the other two, and reads inside it.
    return $this->blockMetaLock->exclusive((int) $node->id(), fn (): ResourceResponse => $this->writeAs($node, $request));
  }

  /**
   * The write, performed as the user the checkpoint names. See ::commit().
   *
   * The switch is unwound whatever the write does — a stale refusal, a pending
   * review, a validation failure and a success all leave the request back on
   * the account it authenticated as.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page, as resolved by the route (its default revision).
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   *
   * @return \Drupal\jsonapi\ResourceResponse
   *   The written revision as a JSON:API document.
   */
  private function writeAs(NodeInterface $node, Request $request): ResourceResponse {
    $acting = $this->actingUser();
    if ($acting === NULL) {
      return $this->write($node, $request);
    }
    $this->accountSwitcher->switchTo($acting);
    try {
      // The route asked the carrier, at kernel.request. This asks the account
      // the write is actually made by, which is the one answerable for it.
      $access = $node->access('update', NULL, TRUE);
      if (!$access->isAllowed()) {
        throw new AccessDeniedHttpException(sprintf('%s may not update this page.', $acting->getAccountName()));
      }
      return $this->write($node, $request);
    }
    finally {
      $this->accountSwitcher->switchBack();
    }
  }

  /**
   * The account this write is performed as, or NULL for the request's own.
   *
   * The collaboration server is trusted (ADR 0001): it holds the acting user's
   * session, so its statement decides the account. Believed on its own
   * connection alone — the `collab` scope is client-credentials only, so no
   * cookie session and no agent token reaches this. An agent token is not the
   * collaboration client, so no switch happens and the write is the token
   * owner's.
   *
   * A blocked account is not switched to; the write stays the carrier's.
   *
   * @return \Drupal\user\UserInterface|null
   *   The account to become.
   */
  private function actingUser(): ?UserInterface {
    $uid = $this->collabServer->actingUid();
    if ($uid === NULL) {
      return NULL;
    }
    $account = $this->entityTypeManager->getStorage('user')->load($uid);
    return $account instanceof UserInterface && $account->isActive() ? $account : NULL;
  }

  /**
   * The commit itself, with the sidecar held and the account settled.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page, as resolved by the route (its default revision).
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   *
   * @return \Drupal\jsonapi\ResourceResponse
   *   The written revision as a JSON:API document.
   */
  private function write(NodeInterface $node, Request $request): ResourceResponse {
    $resource_type = $this->resourceTypeRepository->get($node->getEntityTypeId(), $node->bundle());
    $entity = $this->freshWorkingCopy($node);
    $payload = $this->payload($request);
    $this->refuseStaleCommit($entity, $payload);
    $document = $this->buildDocument($resource_type, $entity, $payload);

    $parsed_entity = $this->deserialize($resource_type, $this->documentRequest($request, $document), JsonApiDocumentTopLevel::class);

    $field_names = array_map(
      [$resource_type, 'getInternalName'],
      array_merge(array_keys($document['data']['attributes']), array_keys($document['data']['relationships'])),
    );
    foreach ($field_names as $field_name) {
      $this->updateEntityField($resource_type, $parsed_entity, $entity, $field_name);
    }

    $base = $this->baseRevision($entity);
    $state = $this->commitState($entity, $base, $field_names);
    if ($state !== NULL) {
      $entity->set('moderation_state', $state);
      $field_names[] = 'moderation_state';
    }
    // Asked once the state is on the entity: the sidecar pass branches on it,
    // so the answer the client gets is the one presave will record.
    $review = $this->blockAttribution->signOffs($entity);
    $this->refusePublicationUnderReview($entity);

    // The fields this commit is answerable for — those the payload wrote, plus
    // the moderation state whenever this resource decided it, so the workflow's
    // transition check always runs on a state it set. Everything outside the
    // set is filtered out for the reason core filters it: a pre-existing
    // violation elsewhere — the classic one being a reference whose target was
    // deleted after the fact — would otherwise wedge every future commit behind
    // data the editor cannot even see.
    static::validate($entity, array_values(array_unique($field_names)));

    if ($base !== NULL && $review['approved'] === [] && $this->statesOnly($entity, $base, $field_names, $payload)) {
      // A delivery: the window the write it follows could not state (ADR
      // 0001). It says who wrote the revision already stored and moves nothing
      // else, so it is booked onto that revision, the way every other fact
      // about one is. That also leaves `changed` alone — the token a live
      // session reads to tell somebody else's edit from its own bookkeeping.
      //
      // Such a save states it is syncing, the only way past
      // content_moderation's forced new revision, and a syncing save is one
      // presave attribution skips — so the stamp it came to make is taken
      // here. Its label is dropped: a log belongs to the revision it names.
      $this->blockAttribution->attribute($entity);
      $entity->setRevisionLogMessage($base->getRevisionLogMessage());
      $this->saveStateOnly($entity);
    }
    else {
      // Every other commit is a revision, whatever the bundle's default is:
      // the revision list is the editor's history lane. And it counts as one
      // whatever it moved — core drops a revision from every history, this
      // app's and Drupal's own, unless a stored field changed, and a publish
      // moves only `moderation_state`, which is computed.
      $entity->setNewRevision(TRUE);
      $entity->setRevisionTranslationAffected(TRUE);
      $entity->setRevisionTranslationAffectedEnforced(TRUE);
      $entity->setRevisionCreationTime($this->time->getRequestTime());
      $entity->setRevisionUserId((int) $this->user->id());
      // The session's optimistic-concurrency token is `changed`, so it has to
      // advance on every commit even when only a reference moved.
      $entity->setChangedTime($this->time->getRequestTime());
      $this->logSignOffs($entity, $review['approved']);
      $entity->save();
    }

    $primary_data = new ResourceObjectData([ResourceObject::createFromEntity($resource_type, $entity)], 1);
    return $this->buildWrappedResponse($primary_data, $request, $this->getIncludes($request, $primary_data), 200, [], NULL, ['review' => $review]);
  }

  /**
   * Refuses a commit assembled against a revision the page has moved past.
   *
   * `changed` on the working copy is the token: every content commit advances
   * it, so a payload naming an older one was built from text this write would
   * overwrite. Run inside the sidecar hold and before the payload is applied,
   * so a refusal writes nothing.
   *
   * The check is on the token, not on the caller — everything reaching this
   * method is guarded. A payload carrying no token is not checked: the
   * moderation actions commit a judgement about whatever the working copy is
   * now (a state, a revision log) and read no content to overwrite.
   *
   * Granularity is the token's limit: `changed` counts whole seconds, so an
   * external write landing in the same second as the revision a payload was
   * built on is indistinguishable from it.
   *
   * @param \Drupal\node\NodeInterface $entity
   *   The working copy this write would be made on.
   * @param array $payload
   *   The decoded request body.
   *
   * @throws \Drupal\openkb_collab_api\StaleCommitException
   *   When the token names a revision older than the working copy.
   */
  private function refuseStaleCommit(NodeInterface $entity, array $payload): void {
    $token = $payload[self::BASED_ON_FIELD] ?? NULL;
    if ($token === NULL) {
      return;
    }
    if (!is_int($token) && !(is_string($token) && ctype_digit($token))) {
      throw new BadRequestHttpException(sprintf('"%s" must be a Unix timestamp.', self::BASED_ON_FIELD));
    }
    $actual = (int) $entity->getChangedTime();
    if ((int) $token !== $actual) {
      throw new StaleCommitException((int) $token, $actual);
    }
  }

  /**
   * Whether this commit only states who wrote the revision it is written on.
   *
   * A checkpoint can arrive with text Drupal already holds: an agent wrote the
   * shared document under its own token (a token states nothing, ADR 0001), or
   * an earlier checkpoint's response was lost. Such a write is bookkeeping
   * about the revision it follows, so it makes no revision of its own — and
   * the revision list is the editor's history lane. The revision log stays out
   * of the comparison; it labels a revision, and this write makes none.
   *
   * @param \Drupal\node\NodeInterface $entity
   *   The revision being written, with the payload already applied.
   * @param \Drupal\node\NodeInterface $base
   *   The stored revision this write is made on top of.
   * @param string[] $written_fields
   *   The fields the payload wrote, plus the state this resource decided.
   * @param array $payload
   *   The decoded request body.
   *
   * @return bool
   *   TRUE when the commit states a session and moves nothing else.
   */
  private function statesOnly(NodeInterface $entity, NodeInterface $base, array $written_fields, array $payload): bool {
    return isset($payload['session']) && !$this->moves($entity, $base, $written_fields);
  }

  /**
   * Whether this commit moves any field it wrote.
   *
   * The revision log stays out of the comparison: it labels a revision, and a
   * commit that moves nothing makes none.
   *
   * @param \Drupal\node\NodeInterface $entity
   *   The revision being written, with the payload already applied.
   * @param \Drupal\node\NodeInterface|null $base
   *   The stored revision this write is made on top of, or NULL for none.
   * @param string[] $written_fields
   *   The fields the payload wrote.
   *
   * @return bool
   *   TRUE when a stored field differs from the base.
   */
  private function moves(NodeInterface $entity, ?NodeInterface $base, array $written_fields): bool {
    if ($base === NULL) {
      return TRUE;
    }
    foreach ($written_fields as $name) {
      if ($name !== self::REVISION_LOG_FIELD && !$entity->get($name)->equals($base->get($name))) {
        return TRUE;
      }
    }
    return FALSE;
  }

  /**
   * The moderation state this commit lands in, or NULL to leave it alone.
   *
   * Content lands as a draft; a payload naming `moderation_state` says what it
   * wants and answers to ::refusePublicationUnderReview() for it (ADR
   * 0003/0004). A commit that moves no content decides nothing, so a sign-off
   * leaves a live page live and a draft a draft.
   *
   * @param \Drupal\node\NodeInterface $entity
   *   The revision being written, with the payload already applied.
   * @param \Drupal\node\NodeInterface|null $base
   *   The stored revision this write is made on top of.
   * @param string[] $written_fields
   *   The fields the payload wrote.
   *
   * @return string|null
   *   The state to set, or NULL to keep the entity's own.
   */
  private function commitState(NodeInterface $entity, ?NodeInterface $base, array $written_fields): ?string {
    if (in_array('moderation_state', $written_fields, TRUE)
      || $this->moderationInformation === NULL
      || !$this->moderationInformation->isModeratedEntity($entity)) {
      return NULL;
    }
    return $this->moves($entity, $base, $written_fields) ? self::CONTENT_WRITE_STATE : NULL;
  }

  /**
   * Labels the revision with the sign-offs it carries.
   *
   * The versions tab is where a reader tells an edit from a review, so a
   * revision that only records sign-offs has to say so in words.
   *
   * @param \Drupal\node\NodeInterface $entity
   *   The revision being written.
   * @param list<array{item: string, step: string, uid: int}> $approved
   *   The sign-offs this commit recorded.
   */
  private function logSignOffs(NodeInterface $entity, array $approved): void {
    if ($approved === []) {
      return;
    }
    $counts = [];
    foreach ($approved as $sign_off) {
      $counts[$sign_off['step']][$sign_off['uid']] ??= 0;
      $counts[$sign_off['step']][$sign_off['uid']]++;
    }
    $names = $this->accountNames(array_merge(...array_values(array_map('array_keys', $counts))));
    $sentences = [];
    foreach ($counts as $step => $by_uid) {
      foreach ($by_uid as $uid => $count) {
        $sentences[] = sprintf('Signed off %d change(s) (%s) by %s', $count, $step, $names[$uid] ?? ('uid ' . $uid));
      }
    }
    $log = trim((string) $entity->getRevisionLogMessage());
    $entity->setRevisionLogMessage(trim($log . ' ' . implode('. ', $sentences) . '.'));
  }

  /**
   * The display names of the accounts that signed off.
   *
   * @param int[] $uids
   *   The account ids.
   *
   * @return array<int, string>
   *   Account id => display name.
   */
  private function accountNames(array $uids): array {
    $names = [];
    foreach ($this->entityTypeManager->getStorage('user')->loadMultiple(array_unique($uids)) as $uid => $account) {
      $names[(int) $uid] = (string) $account->getDisplayName();
    }
    return $names;
  }

  /**
   * Refuses a write that would publish blocks still waiting for review.
   *
   * Asks whether the page is ready, not who the writer is, and asks it in
   * every space: a wiki space enforces fewer steps, not none. Judged on the
   * revision this write produces — sign-offs this very checkpoint states
   * included — through the same BlockAttribution::publicationHold() the
   * OkbPendingReview constraint uses, so the two cannot disagree.
   *
   * @param \Drupal\node\NodeInterface $entity
   *   The revision about to be written, with the payload applied.
   *
   * @throws \Drupal\openkb_workflow\PendingReviewException
   *   When any enforced step is still pending on any block.
   */
  private function refusePublicationUnderReview(NodeInterface $entity): void {
    $blockers = $this->blockAttribution->publicationHold($entity);
    if ($blockers !== []) {
      throw new PendingReviewException($blockers);
    }
  }

  /**
   * The decoded request body.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request.
   *
   * @return array
   *   The payload.
   */
  private function payload(Request $request): array {
    $payload = Json::decode((string) $request->getContent());
    if (!is_array($payload)) {
      throw new BadRequestHttpException('Request body must be {"attributes": {…}, "relationships": {…}}.');
    }
    return $payload;
  }

  /**
   * The commit payload as the JSON:API document core's deserializer speaks.
   *
   * The wire format stays the bare `{attributes, relationships}` fragment the
   * commit pipeline's extenders produce: `type` and `id` are not the client's
   * to choose here — the route already resolved which page is being written
   * — so they are filled in from the resolved entity rather than demanded from
   * the caller.
   *
   * @param \Drupal\jsonapi\ResourceType\ResourceType $resource_type
   *   The resource type being written.
   * @param \Drupal\node\NodeInterface $entity
   *   The revision being written.
   * @param array $payload
   *   The decoded request body.
   *
   * @return array
   *   The JSON:API document.
   */
  private function buildDocument(ResourceType $resource_type, NodeInterface $entity, array $payload): array {
    $attributes = $payload['attributes'] ?? [];
    $relationships = $payload['relationships'] ?? [];
    if (!is_array($attributes) || !is_array($relationships)) {
      throw new BadRequestHttpException('"attributes" and "relationships" must be objects.');
    }
    // The review sidecar is not the client's to send. Per-field access already
    // refuses it (openkb_workflow_entity_field_access()); dropping it here
    // means a commit carrying one still writes its content instead of 403-ing
    // on a field the editor never meant to touch.
    unset($attributes[self::SIDECAR_FIELD]);

    return [
      'data' => [
        'type' => $resource_type->getTypeName(),
        'id' => $entity->uuid(),
        'attributes' => $attributes,
        'relationships' => $relationships,
      ],
    ];
  }

  /**
   * A request carrying the document, for the inherited deserializer.
   *
   * ::deserialize() reads the body off the request, and a Symfony request's
   * content cannot be rewritten in place — hence a throwaway one holding the
   * assembled document. Nothing else about it is read.
   *
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The incoming request.
   * @param array $document
   *   The JSON:API document to carry.
   *
   * @return \Symfony\Component\HttpFoundation\Request
   *   The request to deserialize from.
   */
  protected function documentRequest(Request $request, array $document): Request {
    return Request::create(
      $request->getUri(),
      $request->getMethod(),
      [],
      [],
      [],
      $request->server->all(),
      Json::encode($document),
    );
  }

}
