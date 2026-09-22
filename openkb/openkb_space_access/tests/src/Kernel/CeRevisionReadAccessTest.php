<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Tests\openkb_agent\Traits\CollabClientTrait;
use Drupal\user\UserInterface;
use Symfony\Component\HttpFoundation\Response;

/**
 * Who reads a page's live revision, working copy and revisions.
 *
 * A pinning suite: roster seat × page state × carrier, three custom-elements
 * reads per row — `/node/{nid}`, `/node/{nid}/latest` and
 * `/node/{nid}/revisions/{vid}/view`.
 *
 * The read path rests on one rule: a `Latest version` task appears only where
 * the account may read the forward draft, so `/latest` is never asked for
 * blind and a reader without the task reads the published revision — where
 * JSON:API `?resourceVersion=rel:working-copy` answers 403 for the same
 * account ({@see \Drupal\Tests\openkb_jsonapi\Kernel\WorkingCopyReadTest}).
 * `Edit` is the same signal for update access.
 *
 * ## Carriers
 *
 * A session cookie, an agent token, and the collaboration server's
 * client-credentials token. An agent token answers as its owner, so it is
 * carried only for the administrator, the seat where the scope ceiling
 * changes the answer: `bypass node access` is named by no agent scope, so the
 * token reads the space as an outsider does.
 *
 * ## Why one canonical read per test method
 *
 * The local task manager memoizes its built tasks per route name for the life
 * of the container, which a kernel test keeps across requests. The first
 * canonical read in a test method is therefore the only one whose tasks
 * describe the account and page under test.
 *
 * @group openkb_space_access
 */
final class CeRevisionReadAccessTest extends OpenkbRequestKernelTestBase {

  use CollabClientTrait;

  /**
   * The tasks this suite reads; the rest of the row is Drupal's own.
   */
  private const TASKS_UNDER_TEST = ['Edit', 'Latest version'];

  /**
   * The body of the default revision.
   */
  private const PUBLISHED_BODY = 'Published body.';

  /**
   * The body of the forward draft.
   */
  private const DRAFT_BODY = 'Draft body.';

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'metatag',
    'token',
    'custom_elements',
    'lupus_ce_renderer',
    // The collaboration server's permission, and the schema its resources
    // inherit.
    'openkb_schema',
    'openkb_collab_api',
  ];

  /**
   * A space only its roster may read, so an outsider is really outside.
   */
  private SpaceInterface $space;

  /**
   * The accounts under test, keyed by seat.
   *
   * @var \Drupal\user\UserInterface[]
   */
  private array $seats = [];

  /**
   * The pages under test, keyed by page state.
   *
   * @var \Drupal\node\NodeInterface[]
   */
  private array $pages = [];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->importRecipeConfig($this->kbModerationConfigNames());
    $this->importRecipeConfig($this->agentConfigNames());
    $this->importRecipeConfig($this->agentModerationConfigNames());
    $this->importRecipeConfig($this->collabClientConfigNames());
    $this->importRecipeConfig($this->kbCeDisplayConfigNames());
    $this->installConfig(['simple_oauth', 'simple_oauth_personal_consumers']);
    $this->applyAgentScopeSettings();
    $this->installOauthKeys();
    $this->container->get('router.builder')->rebuild();

    $this->space = Space::create([
      'label' => 'Handbook',
      'read_access' => 'members_only',
      'field_moderation' => 0,
    ]);
    $this->space->save();

    $this->seats = [
      'manager' => $this->seatOn(SpaceInterface::MANAGERS),
      'member' => $this->seatOn(SpaceInterface::MEMBERS),
      'viewer' => $this->seatOn(SpaceInterface::VIEWERS),
      'outsider' => $this->createUser($this->recipeGrantedPermissions('authenticated')),
      'admin' => $this->createUser([
        ...$this->recipeGrantedPermissions('authenticated'),
        'bypass node access',
      ]),
      'collab server' => $this->createUser([
        ...$this->recipeGrantedPermissions('authenticated'),
        'use collaboration api',
      ]),
    ];

    // Authored by nobody under test: the seat is the whole answer, and an
    // owner would bring permissions of their own into the row.
    $author = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $this->pages = [
      'published' => $this->createPage($author, 'published'),
      'with draft' => $this->createPage($author, 'published'),
      'never published' => $this->createPage($author, 'draft'),
    ];
    $this->addForwardDraft($this->pages['with draft']);
  }

  /**
   * One row of the matrix: what this carrier and seat read of this page.
   *
   * @dataProvider reads
   */
  public function testCeRead(
    string $carrier,
    string $seat,
    string $state,
    int $canonical_status,
    array $tasks,
    int $latest_status,
    int $revision_status,
  ): void {
    [$user, $headers] = $this->carry($carrier, $seat);
    $page = $this->pages[$state];

    $canonical = $this->read($this->canonicalPath($page), $user, $headers);
    $this->assertSame($canonical_status, $canonical->getStatusCode(), (string) $canonical->getContent());
    $this->assertSame($tasks, $this->tasksUnderTest($canonical));

    $latest = $this->read($this->latestPath($page), $user, $headers);
    $this->assertSame($latest_status, $latest->getStatusCode(), (string) $latest->getContent());

    // The premise of the read path: the two reads carry different revisions,
    // and the canonical one never leaks the draft.
    if ($state === 'with draft' && $canonical_status === 200) {
      $this->assertSame(self::PUBLISHED_BODY, $this->body($canonical));
      if ($latest_status === 200) {
        $this->assertSame(self::DRAFT_BODY, $this->body($latest));
      }
    }

    $revision = $this->read($this->newestRevisionPath($page), $user, $headers);
    $this->assertSame($revision_status, $revision->getStatusCode(), (string) $revision->getContent());
  }

  /**
   * The whole matrix, as carrier and seat share three answers between them.
   *
   * Each profile is `state => [canonical status, tasks, /latest status,
   * newest-revision status]`.
   */
  public static function reads(): array {
    // Manager, member, administrator: update access in the space, so the
    // forward draft is theirs to read and both tasks are offered.
    $editor = [
      'published' => [200, ['Edit'], 403, 200],
      'with draft' => [200, ['Edit', 'Latest version'], 200, 200],
      'never published' => [200, ['Edit'], 403, 200],
    ];
    // Viewer: reads the space, writes nothing. The published revision and an
    // unpublished default revision come through on `view any unpublished
    // content`; only the forward draft is refused.
    $reader = [
      'published' => [200, [], 403, 200],
      'with draft' => [200, [], 403, 403],
      'never published' => [200, [], 403, 200],
    ];
    // Off the roster of a members-only space: 404 rather than 403
    // everywhere, so no answer confirms the page is there
    // (HideInvisibleSpaceSubscriber).
    $outsider = array_fill_keys(
      ['published', 'with draft', 'never published'],
      [404, [], 404, 404],
    );

    $matrix = [
      'cookie' => [
        'manager' => $editor,
        'member' => $editor,
        'viewer' => $reader,
        'outsider' => $outsider,
        'admin' => $editor,
      ],
      // A token reads as its owner, capped at the scopes' permissions, so only
      // the seat the cap changes is worth its own rows: no agent scope names
      // `bypass node access`, and the space rosters carry the administrator
      // nowhere, so their token reads the space as an outsider.
      'agent' => [
        'admin' => $outsider,
      ],
      // `use collaboration api` buys view and update in every space, without a
      // roster seat (ADR 0001).
      'collab' => [
        'collab server' => $editor,
      ],
    ];

    $rows = [];
    foreach ($matrix as $carrier => $seats) {
      foreach ($seats as $seat => $profile) {
        foreach ($profile as $state => $expected) {
          $rows["$carrier, $seat, $state"] = [$carrier, $seat, $state, ...$expected];
        }
      }
    }
    return $rows;
  }

  /**
   * The account and headers a carrier reads with.
   *
   * @return array{0: \Drupal\Core\Session\AccountInterface|null, 1: array}
   *   The account to sign in as, and the request headers.
   */
  private function carry(string $carrier, string $seat): array {
    return match ($carrier) {
      'cookie' => [$this->seats[$seat], []],
      'agent' => [NULL, $this->agentBearer($this->seats[$seat])],
      'collab' => [NULL, $this->collabBearer($this->seats[$seat])],
    };
  }

  /**
   * Reads a path in custom-elements format.
   *
   * The node access handler memoizes per account for the life of the
   * container, which separate requests do not share and this harness does.
   */
  private function read(string $path, ?AccountInterface $user, array $headers): Response {
    $this->container->get('entity_type.manager')->getAccessControlHandler('node')->resetCache();
    return $this->request($path, $user, 'GET', NULL, $headers);
  }

  /**
   * The canonical CE read path.
   */
  private function canonicalPath(NodeInterface $page): string {
    return '/node/' . $page->id() . '?_format=custom_elements&_content_format=json';
  }

  /**
   * The working-copy CE read path.
   */
  private function latestPath(NodeInterface $page): string {
    return '/node/' . $page->id() . '/latest?_format=custom_elements&_content_format=json';
  }

  /**
   * The CE read path of the page's newest revision.
   *
   * On a page carrying a forward draft that is the draft; otherwise it is the
   * default revision, which the core revision route also answers on.
   */
  private function newestRevisionPath(NodeInterface $page): string {
    $ids = $this->container->get('entity_type.manager')->getStorage('node')
      ->getQuery()
      ->accessCheck(FALSE)
      ->allRevisions()
      ->condition('nid', $page->id())
      ->sort('vid', 'DESC')
      ->range(0, 1)
      ->execute();
    $vid = (int) array_key_first($ids);
    return '/node/' . $page->id() . '/revisions/' . $vid . '/view?_format=custom_elements&_content_format=json';
  }

  /**
   * The page body a CE response carries, unwrapped as the frontend does.
   */
  private function body(Response $response): string {
    $data = Json::decode((string) $response->getContent());
    $body = $data['content']['props']['body'] ?? '';
    return (string) (is_array($body) ? ($body['value'] ?? '') : $body);
  }

  /**
   * The tasks under test a CE response carries, in the order it lists them.
   *
   * @return string[]
   *   The labels, in the order the page lists them.
   */
  private function tasksUnderTest(Response $response): array {
    $data = Json::decode((string) $response->getContent());
    $labels = array_column($data['local_tasks']['primary'] ?? [], 'label');
    return array_values(array_intersect($labels, self::TASKS_UNDER_TEST));
  }

  /**
   * An account on one of the space's rosters.
   */
  private function seatOn(string $roster): UserInterface {
    $account = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $this->space->get($roster)->appendItem(['target_id' => $account->id()]);
    $this->space->save();
    return $account;
  }

  /**
   * Builds a page in the space, seeded past validation.
   */
  private function createPage(AccountInterface $author, string $state): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Space page',
      'uid' => $author->id(),
      'moderation_state' => $state,
      'field_space' => ['target_id' => $this->space->id()],
      'field_kb_body' => ['value' => self::PUBLISHED_BODY, 'format' => 'comark'],
    ]);
    $page->save();
    return $page;
  }

  /**
   * Leaves a forward draft on a published page, the way a checkpoint does.
   */
  private function addForwardDraft(NodeInterface $page): void {
    $page->setNewRevision(TRUE);
    $page->set('moderation_state', 'draft');
    $page->set('field_kb_body', ['value' => self::DRAFT_BODY, 'format' => 'comark']);
    $page->save();
  }

}
