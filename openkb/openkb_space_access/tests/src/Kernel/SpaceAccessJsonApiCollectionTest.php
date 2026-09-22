<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Kernel;

use Drupal\Core\Cache\CacheableMetadata;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\jsonapi\Access\TemporaryQueryGuard;
use Drupal\jsonapi\Query\EntityCondition;
use Drupal\jsonapi\Query\EntityConditionGroup;
use Drupal\jsonapi\Query\Filter;
use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;

/**
 * What a filtered JSON:API node collection lists, per space relationship.
 *
 * A filtered collection is secured twice: by the `node_access` query tag — the
 * grants realm, which \Drupal\Tests\openkb_space_access\Kernel\SpaceAccessTest
 * covers — and by a second condition built from
 * hook_jsonapi_ENTITY_TYPE_filter_access(), ANDed on top. The second one is
 * the reason a space's editors could not open a draft: core describes the
 * default grant there, "published, or your own", which no realm fits inside,
 * so every unpublished page dropped out of every filtered collection
 * regardless of the grants. The editor hydrates through exactly such a
 * collection (nid → page), so the editor session 404'd on any draft.
 *
 * The realm has to stay the only answer, in both directions: a space's editors
 * see their drafts, and nobody else does — including an account holding
 * `view any unpublished content`, which is a site-wide permission the realm
 * deliberately overrides.
 *
 * @group openkb_space_access
 */
final class SpaceAccessJsonApiCollectionTest extends KernelTestBase {

  use RecipeConfigTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'filter',
    'text',
    'node',
    'options',
    'path_alias',
    'path',
    'openkb_space',
    'serialization',
    'file',
    'jsonapi',
    'openkb_space_access',
  ];

  /**
   * The space the pages below live in.
   */
  private SpaceInterface $space;

  /**
   * An unpublished page — a draft, which is what an editor opens.
   */
  private NodeInterface $draft;

  /**
   * A published page in the same space.
   */
  private NodeInterface $published;

  /**
   * On the space's manager roster.
   */
  private UserInterface $manager;

  /**
   * On the space's viewer roster: a reader, not a writer.
   */
  private UserInterface $viewer;

  /**
   * On no roster, and holding `view any unpublished content`.
   */
  private UserInterface $outsider;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['filter', 'node']);

    $this->importRecipeConfig([
      'node.type.kb_page',
      'field.storage.node.field_type',
      'field.storage.node.field_space',
      'field.field.node.kb_page.field_type',
      'field.field.node.kb_page.field_space',
    ]);

    // User 1 is the superuser and bypasses everything; burn it on a
    // placeholder so no account under test inherits that.
    User::create(['name' => 'superuser'])->save();

    $role = Role::create(['id' => 'kb_user', 'label' => 'KB user']);
    foreach ([
      'access content',
      'create kb_page content',
      'edit any kb_page content',
      // The site-wide permission the realm overrides: holding it must not put
      // another space's draft in anybody's collection.
      'view any unpublished content',
    ] as $permission) {
      $role->grantPermission($permission);
    }
    $role->save();

    $this->manager = $this->createUser('editor', $role->id());
    $this->viewer = $this->createUser('member', $role->id());
    $this->outsider = $this->createUser('outsider', $role->id());

    $this->space = Space::create([
      'label' => 'General',
      'read_access' => 'all_users',
      'viewers' => [['target_id' => $this->viewer->id()]],
      'managers' => [['target_id' => $this->manager->id()]],
    ]);
    $this->space->save();

    $this->draft = $this->createPage('Draft runbook', FALSE);
    $this->published = $this->createPage('Published handbook', TRUE);
  }

  /**
   * The editor hydration path: nid → page, on a draft.
   *
   * This is the query `findKbPageByNidWithAuth()` makes to resolve the nid
   * before it reads the working copy. Without the filter-access statement it
   * comes back empty for the roster editor and the editor session reports
   * "Page unavailable".
   */
  public function testSpaceManagersFindTheirDraftsByNid(): void {
    $this->assertSame(
      [(int) $this->draft->id()],
      $this->filteredCollectionIds($this->manager, (int) $this->draft->id()),
    );
  }

  /**
   * A draft belongs to its space's editors, and to nobody else.
   *
   * The member reads the space and the outsider holds
   * `view any unpublished content`; neither is an editor, so neither gets the
   * draft. The published page is the control: it stays listed to everyone
   * who may read the space, which is what proves the drafts are missing
   * because of the realm and not because the collection is broken.
   */
  public function testDraftsAreListedToSpaceManagersOnly(): void {
    $this->assertEqualsCanonicalizing(
      [(int) $this->draft->id(), (int) $this->published->id()],
      $this->filteredCollectionIds($this->manager),
    );

    foreach (['viewer' => $this->viewer, 'outsider' => $this->outsider] as $label => $account) {
      $this->assertSame(
        [(int) $this->published->id()],
        $this->filteredCollectionIds($account),
        "$label sees the published page and no draft",
      );
    }
  }

  /**
   * A space nobody may read stays unlistable, drafts included.
   */
  public function testPrivateSpaceListsNothingToAnOutsider(): void {
    $secret = Space::create([
      'label' => 'Secret Ops',
      'read_access' => 'members_only',
      'managers' => [['target_id' => $this->manager->id()]],
    ]);
    $secret->save();
    $hidden = $this->createPage('Secret draft', FALSE, $secret);

    $this->assertContains((int) $hidden->id(), $this->filteredCollectionIds($this->manager));
    $this->assertNotContains((int) $hidden->id(), $this->filteredCollectionIds($this->viewer));
    $this->assertNotContains((int) $hidden->id(), $this->filteredCollectionIds($this->outsider));
  }

  /**
   * A draft never crosses a space boundary, editors of other spaces included.
   *
   * The filter-access statement widens every account past core's
   * published-or-own condition on kb_page collections, so this is the
   * case that has to hold on grants alone: an editor of one space gets no
   * other space's draft — not in an organization-visible space, whose
   * published pages they do list.
   */
  public function testCrossSpaceDraftsStayUnlisted(): void {
    $other_manager = $this->createUser('other_manager', 'kb_user');
    $other = Space::create([
      'label' => 'Other department',
      'read_access' => 'all_users',
      'managers' => [['target_id' => $other_manager->id()]],
    ]);
    $other->save();
    $other_draft = $this->createPage('Other-space draft', FALSE, $other);
    $other_published = $this->createPage('Other-space handbook', TRUE, $other);

    $listed = $this->filteredCollectionIds($this->manager);
    $this->assertNotContains((int) $other_draft->id(), $listed, 'a space editor gets no foreign draft');
    $this->assertContains((int) $other_published->id(), $listed, 'the foreign published page lists fine');

    $this->assertContains((int) $other_draft->id(), $this->filteredCollectionIds($other_manager));
    $this->assertNotContains((int) $this->draft->id(), $this->filteredCollectionIds($other_manager));
  }

  /**
   * The realm's widening stops at its own bundle and its own grants.
   *
   * The filter-access statement widens roster editors past core's
   * published-or-own condition — the floor under that is the grants realm:
   * a node the realm wrote no records for has no view grant when
   * unpublished, so nobody lists it. Another account's spaceless draft, and
   * even the editor's own, stay out of every collection; the published
   * control proves the bundle itself lists fine.
   */
  public function testUnpublishedNodesOutsideTheRealmStayUnlisted(): void {
    NodeType::create(['type' => 'page', 'name' => 'Page'])->save();
    $foreign_draft = Node::create([
      'type' => 'page',
      'title' => "Somebody else's draft",
      'uid' => $this->viewer->id(),
      'status' => 0,
    ]);
    $foreign_draft->save();
    $own_draft = Node::create([
      'type' => 'page',
      'title' => "The editor's own spaceless draft",
      'uid' => $this->manager->id(),
      'status' => 0,
    ]);
    $own_draft->save();
    $published = Node::create([
      'type' => 'page',
      'title' => 'Published page',
      'uid' => $this->viewer->id(),
      'status' => 1,
    ]);
    $published->save();

    foreach (['editor' => $this->manager, 'viewer' => $this->viewer, 'outsider' => $this->outsider] as $label => $account) {
      $ids = $this->filteredCollectionIds($account, NULL, 'page');
      $this->assertSame([(int) $published->id()], $ids, "$label lists only the published page");
    }
  }

  /**
   * The space landing's directory: the pages of one space.
   *
   * The frontend filters `field_space.id`, a path into the space entity. Core's
   * published-or-own fallback fits no roster, so without openkb_space's
   * filter-access statement the landing lists nothing to anybody but an
   * administrator.
   */
  public function testSpaceRelationshipFilterListsTheSpacesPages(): void {
    foreach ([
      'manager' => $this->manager,
      'viewer' => $this->viewer,
      'outsider' => $this->outsider,
    ] as $label => $account) {
      $this->assertContains(
        (int) $this->published->id(),
        $this->spaceFilteredCollectionIds($account, $this->space),
        "$label lists the published page of the space they may read",
      );
    }
  }

  /**
   * A filtered space collection is as narrow as the roster.
   *
   * The statement hands the whole answer to the `openkb_space_access` query
   * tag, and this is the case that holds it: nothing else keeps a members-only
   * space out of a collection of spaces.
   */
  public function testFilteredSpaceCollectionHidesPrivateSpaces(): void {
    $secret = Space::create([
      'label' => 'Secret Ops',
      'read_access' => 'members_only',
      'managers' => [['target_id' => $this->manager->id()]],
    ]);
    $secret->save();

    $this->assertSame(
      [(int) $this->space->id(), (int) $secret->id()],
      $this->spaceCollectionIds($this->manager),
    );
    foreach (['viewer' => $this->viewer, 'outsider' => $this->outsider] as $label => $account) {
      $this->assertSame(
        [(int) $this->space->id()],
        $this->spaceCollectionIds($account),
        "$label lists the space they may read and not the private one",
      );
    }
  }

  /**
   * The ids a filtered JSON:API collection lists to an account.
   *
   * Filtered, because the extra condition rides on the filter: the guard walks
   * the fields a filter names, and applies the base entity type's condition
   * once it has one. An unfiltered collection never reaches that code and is
   * secured by the grants alone — the editor's nid lookup is filtered, which
   * is why it was the surface that broke.
   *
   * @param \Drupal\user\UserInterface $account
   *   The account making the request.
   * @param int|null $nid
   *   Restrict to one node id, as the editor's nid lookup does. The public
   *   name is `drupal_internal__nid`; a filter reaches the query resolved to
   *   the internal path, which is what the guard walks.
   * @param string $bundle
   *   The node type the filter names.
   *
   * @return int[]
   *   Node ids, ascending.
   */
  private function filteredCollectionIds(UserInterface $account, ?int $nid = NULL, string $bundle = 'kb_page'): array {
    \Drupal::currentUser()->setAccount($account);

    $members = [new EntityCondition('type', $bundle)];
    if ($nid !== NULL) {
      $members[] = new EntityCondition('nid', (string) $nid);
    }
    $filter = new Filter(new EntityConditionGroup('AND', $members));

    return $this->guardedCollectionIds($filter);
  }

  /**
   * The ids a collection filtered by the space relationship lists.
   *
   * The path is the one JSON:API resolves `field_space.id` to, so the guard
   * walks into openkb_space and secures it the way a request does.
   *
   * @param \Drupal\user\UserInterface $account
   *   The account making the request.
   * @param \Drupal\openkb_space\SpaceInterface $space
   *   The space whose pages the filter names.
   *
   * @return int[]
   *   Node ids, ascending.
   */
  private function spaceFilteredCollectionIds(UserInterface $account, SpaceInterface $space): array {
    \Drupal::currentUser()->setAccount($account);

    return $this->guardedCollectionIds(new Filter(new EntityConditionGroup('AND', [
      new EntityCondition('type', 'kb_page'),
      new EntityCondition('field_space.entity:openkb_space.uuid', $space->uuid()),
    ])));
  }

  /**
   * The space ids a filtered space collection lists to an account.
   *
   * @param \Drupal\user\UserInterface $account
   *   The account making the request.
   *
   * @return int[]
   *   Space ids, ascending.
   */
  private function spaceCollectionIds(UserInterface $account): array {
    \Drupal::currentUser()->setAccount($account);

    return $this->guardedCollectionIds(
      new Filter(new EntityConditionGroup('AND', [new EntityCondition('status', '1')])),
      'openkb_space',
    );
  }

  /**
   * Runs a filter the way EntityResource::getCollectionQuery() does.
   *
   * The filter's own condition on the query, and then the guard.
   *
   * @param \Drupal\jsonapi\Query\Filter $filter
   *   The filter to apply.
   * @param string $entity_type_id
   *   The entity type the collection lists.
   *
   * @return int[]
   *   Entity ids, ascending.
   */
  private function guardedCollectionIds(Filter $filter, string $entity_type_id = 'node'): array {
    $query = \Drupal::entityTypeManager()->getStorage($entity_type_id)->getQuery()
      ->accessCheck(TRUE);
    $query->condition($filter->queryCondition($query));

    TemporaryQueryGuard::setFieldManager(\Drupal::service('entity_field.manager'));
    TemporaryQueryGuard::setModuleHandler(\Drupal::moduleHandler());
    TemporaryQueryGuard::applyAccessControls($filter, $query, new CacheableMetadata());

    $ids = array_map('intval', array_values($query->execute()));
    sort($ids);
    return $ids;
  }

  /**
   * Creates an account holding a role.
   */
  private function createUser(string $name, string $role): UserInterface {
    $user = User::create(['name' => $name, 'status' => 1]);
    $user->addRole($role);
    $user->save();
    return $user;
  }

  /**
   * Creates a page in a space.
   */
  private function createPage(string $title, bool $published, ?SpaceInterface $space = NULL): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'status' => $published ? 1 : 0,
      'field_type' => 'article',
      'field_space' => ['target_id' => ($space ?? $this->space)->id()],
    ]);
    $page->save();
    return $page;
  }

}
