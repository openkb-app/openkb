<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Functional;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Session\AccountInterface;
use Drupal\Tests\BrowserTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\simple_oauth\Functional\SimpleOauthTestTrait;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_workflow\PageBlocks;
use Drupal\openkb_space_access\SpaceAccessPolicy;
use GuzzleHttp\RequestOptions;
use Psr\Http\Message\ResponseInterface;

/**
 * The stack the review-model suites exercise, on the config the recipe ships.
 *
 * The trust properties under test are properties of the *whole* write path —
 * route access, per-field access, presave, entity validation — so every suite
 * drives real HTTP requests against the shipped configuration rather than
 * calling services directly. What differs between them is only which surface
 * they knock on; the site, the page and the readers of the sidecar are the
 * same, and live here.
 */
abstract class ReviewTestBase extends BrowserTestBase {

  use RecipeConfigTrait;
  use SimpleOauthTestTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'node',
    'field',
    'text',
    'filter',
    'options',
    'taxonomy',
    // The recipe grants permissions defined by these modules to the roles
    // under test, so recipeGrantedPermissions() only resolves with them on.
    'media',
    'path',
    'workflows',
    'content_moderation',
    'jsonapi',
    'serialization',
    'basic_auth',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'openkb_agent',
    'openkb_workflow',
    'openkb_jsonapi',
    'openkb_space',
    'openkb_space_access',
  ];

  /**
   * {@inheritdoc}
   */
  protected $defaultTheme = 'stark';

  /**
   * The suite's default space, created on first use. See ::space().
   */
  private ?SpaceInterface $space = NULL;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbReviewConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->importRecipeConfig($this->kbModerationConfigNames());
    $this->importRecipeConfig($this->agentConfigNames());
    $this->importRecipeConfig($this->agentModerationConfigNames());
    $this->applyAgentScopeSettings();
    $this->setUpKeys();

    // Mirrors the recipe's config action — the editing surfaces read and write
    // revisions over JSON:API, whose routes exist only with read_only off.
    $this->config('jsonapi.settings')->set('read_only', FALSE)->save();
    $this->rebuildAll();
  }

  /**
   * A space with the given policy.
   *
   * @param bool $moderated
   *   Whether edits in it go through review, or publish wiki-style with none.
   * @param \Drupal\Core\Session\AccountInterface ...$editors
   *   The accounts on its editor roster.
   *
   * @return \Drupal\openkb_space\SpaceInterface
   *   The saved space.
   */
  protected function createSpace(bool $moderated = TRUE, AccountInterface ...$editors): SpaceInterface {
    $space = Space::create([
      'label' => $moderated ? 'Moderated space' : 'Wiki space',
      'read_access' => 'all_users',
      'field_moderation' => $moderated,
      'managers' => array_map(static fn (AccountInterface $e): array => ['target_id' => $e->id()], $editors),
    ]);
    $space->save();
    return $space;
  }

  /**
   * The suite's default space — moderated, and every editor it made is in it.
   *
   * @return \Drupal\openkb_space\SpaceInterface
   *   The space.
   */
  protected function space(): SpaceInterface {
    return $this->space ??= $this->createSpace();
  }

  /**
   * An account holding what the recipe grants `authenticated`, in the space.
   *
   * Space membership is not what these suites are about — update access inside
   * a space is its editor roster (openkb_space_access), so every account they
   * write with has to be on it before anything else can be asserted.
   *
   * @return \Drupal\Core\Session\AccountInterface
   *   The account.
   */
  protected function createEditor(): AccountInterface {
    return $this->createEditorWith([]);
  }

  /**
   * The collaboration server: an editor this site believes about writer sets.
   *
   * An ordinary account with one permission more — which is the whole of what
   * separates a checkpoint from a browser save (ADR 0001).
   *
   * @return \Drupal\Core\Session\AccountInterface
   *   The account.
   */
  protected function createCollabServer(): AccountInterface {
    return $this->createEditorWith([SpaceAccessPolicy::COLLABORATION]);
  }

  /**
   * An account holding the recipe's grants plus whatever else it is given.
   *
   * @param string[] $extra
   *   Further permissions.
   *
   * @return \Drupal\Core\Session\AccountInterface
   *   The account, on the default space's roster.
   */
  protected function createEditorWith(array $extra): AccountInterface {
    $permissions = $this->recipeGrantedPermissions('authenticated');
    $account = $this->drupalCreateUser(array_unique([...$permissions, ...$extra]));
    $space = $this->space();
    $space->get(SpaceInterface::MANAGERS)->appendItem(['target_id' => $account->id()]);
    $space->save();
    return $account;
  }

  /**
   * A published page with the given body and a settled review history.
   *
   * Direct ->save() skips entity validation, so no transition permission is
   * needed to seed it. Presave runs on the seed like on any write and flags
   * its blocks; the flags are then cleared, so the page stands for content
   * that has already been through review and every assertion downstream is
   * about the write the test itself makes. A fresh page's own flags are the
   * publish gate's business, and are asserted there.
   *
   * @param string|int $uid
   *   The owning account's id.
   * @param string $body
   *   The comark body.
   * @param \Drupal\openkb_space\SpaceInterface|null $space
   *   The space it belongs to; a moderated one is created when none is given.
   *
   * @return \Drupal\node\NodeInterface
   *   The saved page.
   */
  protected function createPage(string|int $uid, string $body, ?SpaceInterface $space = NULL): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Collab page',
      'uid' => $uid,
      'moderation_state' => 'published',
      'field_space' => ($space ?? $this->space())->id(),
      'field_kb_body' => ['value' => $body, 'format' => 'comark'],
    ]);
    $page->save();
    $page->set('field_block_meta', NULL);
    $page->setNewRevision(FALSE);
    $page->save();
    return $page;
  }

  /**
   * The block model, as the site wires it.
   *
   * @return \Drupal\openkb_workflow\PageBlocks
   *   The service.
   */
  protected function pageBlocks(): PageBlocks {
    return $this->container->get('openkb_workflow.page_blocks');
  }

  /**
   * The node storage, with its static cache cleared.
   *
   * @return \Drupal\node\NodeStorageInterface
   *   The node storage.
   */
  protected function nodeStorage(): NodeStorageInterface {
    /** @var \Drupal\node\NodeStorageInterface $storage */
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache();
    return $storage;
  }

  /**
   * The page's latest revision, default or not — what the editor works on.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page.
   *
   * @return \Drupal\node\NodeInterface
   *   The latest revision.
   */
  protected function workingCopy(NodeInterface $page): NodeInterface {
    $storage = $this->nodeStorage();
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $storage->loadRevision($storage->getLatestRevisionId($page->id()));
    return $latest;
  }

  /**
   * The stored review sidecar of the page's working copy.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page.
   *
   * @return array<string, array>
   *   Block id => the block's sidecar entry.
   */
  protected function sidecar(NodeInterface $page): array {
    return $this->pageBlocks()->decode($this->workingCopy($page)->get('field_block_meta')->value);
  }

  /**
   * How many revisions the page has.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page.
   *
   * @return int
   *   The revision count.
   */
  protected function revisionCount(NodeInterface $page): int {
    return count($this->nodeStorage()->getQuery()
      ->accessCheck(FALSE)
      ->allRevisions()
      ->condition('nid', $page->id())
      ->execute());
  }

  /**
   * POSTs a commit payload as the given user.
   *
   * The production carrier is the editing session's own cookie plus the
   * session CSRF token — the route accepts no other write authentication, so
   * testing it any other way would prove nothing about the real path.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to write to.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the request authenticates as.
   * @param array $payload
   *   The commit payload.
   * @param array $headers
   *   Extra request headers, e.g. the collaboration server's credential.
   *
   * @return \Psr\Http\Message\ResponseInterface
   *   The raw response.
   */
  protected function postCommit(NodeInterface $page, AccountInterface $user, array $payload, array $headers = []): ResponseInterface {
    return $this->postAsSession('/openkb/node/' . $page->id() . '/commit', $user, $payload, $headers);
  }

  /**
   * Writes a body checkpoint, as the collab session sends one.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to write to.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the request authenticates as.
   * @param string $body
   *   The comark body.
   * @param string|null $state
   *   The moderation state to send, or NULL to omit it — which is what a
   *   content checkpoint does.
   *
   * @return \Psr\Http\Message\ResponseInterface
   *   The raw response.
   */
  protected function writeBody(
    NodeInterface $page,
    AccountInterface $user,
    string $body,
    ?string $state = NULL,
  ): ResponseInterface {
    $attributes = ['field_kb_body' => ['value' => $body, 'format' => 'comark']];
    if ($state !== NULL) {
      $attributes['moderation_state'] = $state;
    }
    return $this->postCommit($page, $user, ['attributes' => $attributes]);
  }

  /**
   * An agent credential owned by the given account, and its bearer token.
   *
   * The real thing: a personal consumer under the recipe's scope ceiling,
   * exchanged for an access token over the client_credentials grant. A request
   * carrying it acts as the owner, and \Drupal\openkb_agent\ActingIdentity
   * resolves it as that owner acting *through* an agent.
   *
   * @param \Drupal\Core\Session\AccountInterface $owner
   *   The account the agent acts for.
   * @param string $label
   *   The agent's label, which becomes the contributor's `via`.
   *
   * @return string
   *   The access token.
   */
  protected function agentToken(AccountInterface $owner, string $label = 'Claude'): string {
    $credentials = $this->container->get('simple_oauth_personal_consumers.manager')->create($owner, $label);
    $response = $this->getHttpClient()->post($this->buildUrl('/oauth/token'), [
      RequestOptions::FORM_PARAMS => [
        'grant_type' => 'client_credentials',
        'client_id' => $credentials->clientId,
        'client_secret' => $credentials->secret,
      ],
    ]);
    $payload = $this->decode($response);
    $this->assertArrayHasKey('access_token', $payload, (string) $response->getBody());
    return $payload['access_token'];
  }

  /**
   * PATCHes the page over JSON:API under an agent's bearer token.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to write to.
   * @param string $token
   *   The bearer token.
   * @param array $attributes
   *   The attributes to write.
   *
   * @return \Psr\Http\Message\ResponseInterface
   *   The raw response.
   */
  protected function patchAsAgent(NodeInterface $page, string $token, array $attributes): ResponseInterface {
    return $this->getHttpClient()->patch(
      $this->buildUrl('/jsonapi/node/kb_page/' . $page->uuid()),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::HEADERS => [
          'Authorization' => 'Bearer ' . $token,
          'Content-Type' => 'application/vnd.api+json',
          'Accept' => 'application/vnd.api+json',
        ],
        RequestOptions::JSON => [
          'data' => [
            'type' => 'node--kb_page',
            'id' => $page->uuid(),
            'attributes' => $attributes,
          ],
        ],
      ]
    );
  }

  /**
   * Settles a block's review step, as a fixture rather than through a surface.
   *
   * A sign-off's own path is the checkpoint statement
   * (\Drupal\openkb_collab_api\Controller\CommitResource), and the rules it
   * answers to are covered where it lives. A suite that only needs a settled
   * block to get at what it is actually testing writes one here.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page.
   * @param string $id
   *   The block to settle.
   * @param \Drupal\Core\Session\AccountInterface $reviewer
   *   The account the sign-off is recorded for.
   * @param string $step
   *   The step to settle.
   */
  protected function signOff(
    NodeInterface $page,
    string $id,
    AccountInterface $reviewer,
    string $step = PageBlocks::STEP_PEER,
  ): void {
    $working = $this->workingCopy($page);
    $blocks = $this->pageBlocks()->decode($working->get('field_block_meta')->value);
    $blocks[$id] = $this->pageBlocks()->approve(
      $blocks[$id],
      $step,
      (int) $reviewer->id(),
      $reviewer->getAccountName(),
      \Drupal::time()->getRequestTime(),
      (int) $working->getRevisionId(),
    );
    $working->set('field_block_meta', $this->pageBlocks()->encode($blocks));
    $working->setSyncing(TRUE);
    $working->setNewRevision(FALSE);
    $working->save();
  }

  /**
   * PATCHes the page over plain JSON:API, under the user's own credentials.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to write to.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the request authenticates as.
   * @param array $attributes
   *   The attributes to write.
   *
   * @return \Psr\Http\Message\ResponseInterface
   *   The raw response.
   */
  protected function patchPage(
    NodeInterface $page,
    AccountInterface $user,
    array $attributes,
  ): ResponseInterface {
    return $this->getHttpClient()->patch(
      $this->buildUrl('/jsonapi/node/kb_page/' . $page->uuid()),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::AUTH => [$user->getAccountName(), $user->passRaw],
        RequestOptions::HEADERS => [
          'Content-Type' => 'application/vnd.api+json',
          'Accept' => 'application/vnd.api+json',
        ],
        RequestOptions::JSON => [
          'data' => [
            'type' => 'node--kb_page',
            'id' => $page->uuid(),
            'attributes' => $attributes,
          ],
        ],
      ]
    );
  }

  /**
   * POSTs JSON to an OpenKB route under the user's session cookie and token.
   *
   * @param string $path
   *   The route path.
   * @param \Drupal\Core\Session\AccountInterface $user
   *   The account the request authenticates as.
   * @param array $payload
   *   The JSON body.
   * @param array $headers
   *   Extra request headers, e.g. the collaboration server's credential.
   *
   * @return \Psr\Http\Message\ResponseInterface
   *   The raw response.
   */
  protected function postAsSession(string $path, AccountInterface $user, array $payload, array $headers = []): ResponseInterface {
    $this->drupalLogin($user);
    $token = $this->drupalGet('session/token');
    return $this->getHttpClient()->post(
      $this->buildUrl($path),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::COOKIES => $this->getSessionCookies(),
        RequestOptions::HEADERS => $headers + [
          'Content-Type' => 'application/json',
          'X-CSRF-Token' => $token,
        ],
        RequestOptions::JSON => $payload,
      ]
    );
  }

  /**
   * The decoded body of a response, for the assertions that read it.
   *
   * @param \Psr\Http\Message\ResponseInterface $response
   *   The response.
   *
   * @return array
   *   The decoded document.
   */
  protected function decode(ResponseInterface $response): array {
    $decoded = Json::decode((string) $response->getBody());
    return is_array($decoded) ? $decoded : [];
  }

}
