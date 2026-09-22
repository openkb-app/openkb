<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\openkb_space_access\SpaceAccessPolicy;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\Exception\AccessDeniedHttpException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;
use Symfony\Component\HttpKernel\HttpKernelInterface;
use Symfony\Component\Yaml\Yaml;

/**
 * The space access matrix, on the config the recipe actually ships.
 *
 * Two read-access settings × four relationships to a space (outsider, viewer,
 * member, manager) across every surface that has to agree: entity access on
 * pages and on the space, the collections a listing reads, and the
 * writability of `field_space` that gates creating a page into a space.
 * A disabled space is the third setting: nobody but its managers reaches it or
 * anything in it.
 *
 * The rank that matters most here is the new middle one: a member writes the
 * space's content but does not manage the space itself, and a viewer reads but
 * writes nothing. The test users hold `edit any kb_page content` on purpose.
 * Node grants can only ever add access, so without an explicit denial that
 * permission would reach straight into a space the account may not write —
 * proving it does not is the point of the write half here.
 *
 * @group openkb_space_access
 */
final class SpaceAccessTest extends KernelTestBase {

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
    'openkb_space_access',
    // Defines `use collaboration api`. Saving a role drops the permissions no
    // installed module defines (Role::calculateDependencies()), so without this
    // the two cases below would assert against a permission nobody holds. It
    // also carries the commit resource, whose container definition needs the
    // JSON:API and review-model services present.
    'serialization',
    // JSON:API autowires a file upload handler, so file comes with it.
    'file',
    'jsonapi',
    // openkb_agent depends on these: its consent screen reads the account's
    // own clients through simple_oauth_personal_consumers. Saving an account
    // makes simple_oauth read its tokens, which loads consumers — and a
    // consumer carries an image field.
    'image',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'openkb_agent',
    'openkb_workflow',
    'openkb_schema',
    'openkb_collab_api',
  ];

  /**
   * A members-only space: readable to its roster only.
   */
  private SpaceInterface $membersOnly;

  /**
   * An all-users space: readable to every signed-in user.
   */
  private SpaceInterface $allUsers;

  /**
   * The page in the members-only space.
   */
  private NodeInterface $membersOnlyPage;

  /**
   * The page in the all-users space.
   */
  private NodeInterface $allUsersPage;

  /**
   * A never-published page in the members-only space.
   */
  private NodeInterface $unpublishedPage;

  /**
   * A forward draft: an unpublished pending revision of a published page.
   */
  private NodeInterface $forwardDraft;

  /**
   * On the members-only space's viewer roster — reads, writes nothing.
   */
  private UserInterface $viewer;

  /**
   * On the members-only space's member roster — writes, does not manage.
   */
  private UserInterface $member;

  /**
   * On the members-only space's manager roster — writes and manages.
   */
  private UserInterface $manager;

  /**
   * On no roster at all.
   */
  private UserInterface $outsider;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    // simple_oauth reads a user's clients and tokens whenever the account is
    // saved.
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
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

    // What the recipe hands `authenticated`, minus what no module loaded here
    // defines: content_moderation is absent, so `view any unpublished content`
    // and the transitions fall out.
    $role = Role::create(['id' => 'kb_user', 'label' => 'KB user']);
    foreach ($this->recipeGrantedPermissions('authenticated') as $permission) {
      $role->grantPermission($permission);
    }
    $role->save();

    $this->viewer = $this->createUser('viewer', $role->id());
    $this->member = $this->createUser('member', $role->id());
    $this->manager = $this->createUser('manager', $role->id());
    $this->outsider = $this->createUser('outsider', $role->id());

    $this->membersOnly = $this->createSpace('Secret Ops', [
      'read_access' => 'members_only',
      'viewers' => [['target_id' => $this->viewer->id()]],
      'members' => [['target_id' => $this->member->id()]],
      'managers' => [['target_id' => $this->manager->id()]],
    ]);
    $this->allUsers = $this->createSpace('General', [
      'read_access' => 'all_users',
      'managers' => [['target_id' => $this->manager->id()]],
    ]);

    $this->membersOnlyPage = $this->createPage('Secret runbook', $this->membersOnly);
    $this->allUsersPage = $this->createPage('Company handbook', $this->allUsers);
    $this->unpublishedPage = $this->createPage('Draft runbook', $this->membersOnly, FALSE);
    $this->forwardDraft = $this->createForwardDraft($this->membersOnlyPage);
  }

  /**
   * A members-only space is invisible, not merely unreadable.
   */
  public function testMembersOnlySpaceIsInvisibleToOutsiders(): void {
    $this->assertFalse($this->membersOnlyPage->access('view', $this->outsider));
    $this->assertFalse($this->membersOnly->access('view', $this->outsider));

    // Every rank on the roster reads it.
    foreach ([$this->viewer, $this->member, $this->manager] as $account) {
      $this->assertTrue($this->membersOnlyPage->access('view', $account), $account->getAccountName());
      $this->assertTrue($this->membersOnly->access('view', $account), $account->getAccountName());
    }
  }

  /**
   * An all-users space is readable to everyone signed in — and nobody else.
   */
  public function testAllUsersSpaceIsReadableByEverySignedInUser(): void {
    $this->assertTrue($this->allUsersPage->access('view', $this->outsider));
    $this->assertTrue($this->allUsers->access('view', $this->outsider));

    $anonymous = User::getAnonymousUser();
    $this->assertFalse($this->allUsersPage->access('view', $anonymous));
    $this->assertFalse($this->membersOnlyPage->access('view', $anonymous));
  }

  /**
   * Managers and members write; viewers and outsiders do not.
   *
   * The member rank is the new one: it holds `update`/`delete` on the space's
   * pages, so a member is a writer — while a viewer, who reads the same
   * space, is not.
   */
  public function testManagersAndMembersWriteReadersDoNot(): void {
    // The viewer reads the space and holds `edit any kb_page content`.
    $this->assertTrue($this->membersOnlyPage->access('view', $this->viewer));
    $this->assertFalse($this->membersOnlyPage->access('update', $this->viewer));
    $this->assertFalse($this->membersOnlyPage->access('delete', $this->viewer));

    // Same for anyone in an all-users space who is not on its roster.
    $this->assertFalse($this->allUsersPage->access('update', $this->outsider));

    // The member writes the space's content.
    $this->assertTrue($this->membersOnlyPage->access('update', $this->member));
    $this->assertTrue($this->membersOnlyPage->access('delete', $this->member));

    // The manager writes it too.
    $this->assertTrue($this->membersOnlyPage->access('update', $this->manager));
    $this->assertTrue($this->membersOnlyPage->access('delete', $this->manager));
  }

  /**
   * A page can only be created into a space the account may write.
   *
   * Entity create access never sees the target space, so the gate is the
   * writability of `field_space` — which also stops a page being moved into
   * a space the account may not write. Both writer ranks pass it; a viewer does
   * not.
   */
  public function testPagesLandOnlyInWritableSpaces(): void {
    $draft = Node::create([
      'type' => 'kb_page',
      'title' => 'Draft',
      'field_type' => 'article',
      'field_space' => ['target_id' => $this->membersOnly->id()],
    ]);

    $this->assertFalse($draft->get('field_space')->access('edit', $this->viewer));
    $this->assertFalse($draft->get('field_space')->access('edit', $this->outsider));
    $this->assertTrue($draft->get('field_space')->access('edit', $this->member));
    $this->assertTrue($draft->get('field_space')->access('edit', $this->manager));
  }

  /**
   * Managing a space is its update access, and its managers hold it alone.
   *
   * A member writes the space's content but does not manage the space itself —
   * that is the line `manage space` draws. The frontend's `canManage` probes
   * exactly this, so the settings UI follows without a frontend change.
   */
  public function testOnlyManagersManageTheSpace(): void {
    $this->assertTrue($this->membersOnly->access('update', $this->manager));
    $this->assertFalse($this->membersOnly->access('update', $this->member));
    $this->assertFalse($this->membersOnly->access('update', $this->viewer));
    $this->assertFalse($this->membersOnly->access('update', $this->outsider));
  }

  /**
   * Collections answer the same as entity access, in SQL.
   *
   * The sidebar's space list, the page list and every JSON:API collection
   * are queries — a members-only space that only entity access hides would
   * still be named in all of them.
   */
  public function testCollectionsHideMembersOnlySpaces(): void {
    $this->assertSame(
      [(int) $this->allUsers->id()],
      $this->visibleSpaceIds($this->outsider),
    );
    $this->assertEqualsCanonicalizing(
      [(int) $this->membersOnly->id(), (int) $this->allUsers->id()],
      $this->visibleSpaceIds($this->viewer),
    );

    $this->assertSame(
      [(int) $this->allUsersPage->id()],
      $this->visiblePageIds($this->outsider),
    );
    $this->assertEqualsCanonicalizing(
      [(int) $this->membersOnlyPage->id(), (int) $this->allUsersPage->id()],
      $this->visiblePageIds($this->viewer),
    );
  }

  /**
   * A disabled space is its managers' alone, down to its pages.
   *
   * Disabling is how a space leaves the knowledge base without being deleted,
   * so every read surface has to drop it and everything in it at once: entity
   * access, the collections, and with them the frontend, search and the
   * listings that read from the same policy. Its managers keep working in it.
   */
  public function testDisabledSpaceHidesItsPages(): void {
    $this->assertTrue($this->allUsersPage->access('view', $this->outsider));

    $this->allUsers->setUnpublished();
    $this->allUsers->save();

    $this->assertFalse($this->reload($this->allUsersPage)->access('view', $this->outsider));
    $this->assertFalse($this->allUsers->access('view', $this->outsider));
    $this->assertNotContains((int) $this->allUsers->id(), $this->visibleSpaceIds($this->outsider));
    $this->assertNotContains((int) $this->allUsersPage->id(), $this->visiblePageIds($this->outsider));

    // Its managers still reach it — enabling it again is theirs to do.
    $this->assertTrue($this->reload($this->allUsersPage)->access('view', $this->manager));
    $this->assertTrue($this->reload($this->allUsersPage)->access('update', $this->manager));
    $this->assertTrue($this->allUsers->access('view', $this->manager));
    $this->assertContains((int) $this->allUsers->id(), $this->visibleSpaceIds($this->manager));

    // And enabling it puts everything back, in the same request.
    $this->allUsers->setPublished();
    $this->allUsers->save();
    $this->assertTrue($this->reload($this->allUsersPage)->access('view', $this->outsider));
  }

  /**
   * A roster change takes effect immediately, with no grants rebuild.
   *
   * This is the JSON:API case: a PATCH saves the space and the very next access
   * check — same request, no batch, no cron — has to answer with the new
   * roster. Grant records depend on the page's space alone, so only the
   * account's calculated permissions change, and the space's cache tags
   * invalidate those.
   */
  public function testRosterChangeIsEffectiveImmediately(): void {
    $this->assertFalse($this->membersOnlyPage->access('view', $this->outsider));

    $this->membersOnly->set('viewers', [
      ['target_id' => $this->viewer->id()],
      ['target_id' => $this->outsider->id()],
    ]);
    $this->membersOnly->save();

    $this->assertTrue($this->reload($this->membersOnlyPage)->access('view', $this->outsider));

    // And back out again: removing someone revokes their access just as fast.
    $this->membersOnly->set('viewers', [['target_id' => $this->viewer->id()]]);
    $this->membersOnly->save();

    $this->assertFalse($this->reload($this->membersOnlyPage)->access('view', $this->outsider));
  }

  /**
   * Promoting a viewer to a member grants write immediately.
   *
   * The middle rank moves across a roster field like any other; the freshness
   * guarantee that carries a read across a PATCH carries a write the same way.
   */
  public function testMemberPromotionGrantsWriteImmediately(): void {
    $this->assertFalse($this->membersOnlyPage->access('update', $this->viewer));

    $this->membersOnly->set('viewers', []);
    $this->membersOnly->set('members', [
      ['target_id' => $this->member->id()],
      ['target_id' => $this->viewer->id()],
    ]);
    $this->membersOnly->save();

    $this->assertTrue($this->reload($this->membersOnlyPage)->access('update', $this->viewer));
  }

  /**
   * A read-access flip is effective immediately, in both directions.
   */
  public function testReadAccessChangeIsEffectiveImmediately(): void {
    $this->assertFalse($this->membersOnlyPage->access('view', $this->outsider));

    $this->membersOnly->set('read_access', 'all_users');
    $this->membersOnly->save();
    $this->assertTrue($this->reload($this->membersOnlyPage)->access('view', $this->outsider));

    $this->membersOnly->set('read_access', 'members_only');
    $this->membersOnly->save();
    $this->assertFalse($this->reload($this->membersOnlyPage)->access('view', $this->outsider));
  }

  /**
   * A brand-new space is reachable by its roster immediately.
   *
   * The sibling of the two cases above, and the one that cannot be invalidated
   * by a space's own cache tags: an account's calculated permissions describe
   * the spaces that existed when they were calculated, so a space created
   * afterwards is in none of them. Without the entity type's list tag, whoever
   * is put on a new space's roster keeps being answered out of a cache from
   * before it existed — and cannot reach the space at all, in this request or
   * any later one, because the cache is persistent.
   *
   * Asserted in the order that reproduces it: the outsider's permissions are
   * calculated FIRST (against the existing spaces), and only then does the new
   * space appear.
   */
  public function testNewSpaceIsReachableByItsRosterImmediately(): void {
    // Warms the calculated permissions — the state a real account is in by the
    // time an admin creates a space for them.
    $this->assertFalse($this->membersOnlyPage->access('view', $this->outsider));

    $fresh = $this->createSpace('A space made just now', [
      'read_access' => 'members_only',
      'managers' => [['target_id' => $this->outsider->id()]],
    ]);
    $page = $this->createPage('Page in the new space', $fresh);

    $this->assertTrue($this->reload($page)->access('view', $this->outsider));
    $this->assertTrue($this->reload($page)->access('update', $this->outsider));
    $this->assertTrue($fresh->access('view', $this->outsider));
  }

  /**
   * A site administrator sees every space, on every surface.
   *
   * `bypass node access` puts every page within reach whatever space it
   * sits in, and `administer openkb_space` does the same for the spaces — an
   * administrator on no roster reading a page out of a space missing from
   * their own space list is the inconsistency this pins down.
   */
  public function testSiteAdministratorSeesEverySpace(): void {
    $role = Role::create(['id' => 'kb_admin', 'label' => 'KB admin']);
    $role->grantPermission('access content');
    $role->grantPermission('bypass node access');
    $role->grantPermission('administer openkb_space');
    $role->save();
    $admin = $this->createUser('site-admin', $role->id());

    $this->assertEqualsCanonicalizing(
      [(int) $this->membersOnly->id(), (int) $this->allUsers->id()],
      $this->visibleSpaceIds($admin),
    );
    $this->assertEqualsCanonicalizing(
      [
        (int) $this->membersOnlyPage->id(),
        (int) $this->allUsersPage->id(),
        (int) $this->unpublishedPage->id(),
      ],
      $this->visiblePageIds($admin),
    );

    $this->assertTrue($this->membersOnly->access('view', $admin));
    $this->assertTrue($this->membersOnly->access('update', $admin));
    $this->assertTrue($this->membersOnlyPage->access('view', $admin));
    $this->assertTrue($this->membersOnlyPage->access('update', $admin));
  }

  /**
   * The collaboration server writes in a space whose roster it is not on.
   *
   * It checkpoints sessions everywhere and is a member of nowhere, so the
   * roster cannot be what lets it in. What does is a permission of its own —
   * and it buys exactly view and update on the space's pages: publishing
   * stays a separate request under the acting user's credential, and the space
   * itself stays its roster's (ADR 0001).
   */
  public function testTheCollaborationApiWritesWithoutRosterMembership(): void {
    $server = $this->createUser('collab-server', $this->collabServerRole());

    $this->assertTrue($this->membersOnlyPage->access('view', $server));
    $this->assertTrue($this->membersOnlyPage->access('update', $server));
    $this->assertFalse(
      $this->membersOnly->access('view', $server),
      'It writes pages in the space, never the space itself.',
    );
    $this->assertFalse($this->membersOnly->access('update', $server));

    $this->assertFalse(
      $this->outsider->hasPermission('use collaboration api'),
      'And nothing an ordinary account holds gets it there.',
    );
    $this->assertFalse($this->membersOnlyPage->access('update', $this->outsider));
  }

  /**
   * The collaboration permission is a floor, never a ceiling.
   *
   * Defensive: a mis-granted account must not lose its seat.
   */
  public function testTheCollaborationApiKeepsTheManagersOwnRank(): void {
    $this->manager->addRole($this->collabServerRole());
    $this->manager->save();

    $this->assertTrue($this->membersOnlyPage->access('update', $this->manager));
    $this->assertTrue(
      $this->membersOnly->access('update', $this->manager),
      'A manager who also holds the collaboration permission still manages.',
    );
    $this->assertTrue(
      \Drupal::service('openkb_space_access.space_access')
        ->hasPermission($this->manager, (int) $this->membersOnly->id(), SpaceAccessPolicy::PUBLISH),
      'And still publishes — the floor buys view and update, it does not cap.',
    );
  }

  /**
   * The collaboration server role, exactly as openkb_recipe_collab ships it.
   *
   * From the shipped YAML rather than a hand-built double, so a typo'd
   * permission there is a permission nothing grants and the cases above fail
   * on it. Core drops the ones this suite's modules do not define.
   *
   * @return string
   *   The role id.
   */
  private function collabServerRole(): string {
    $this->importRecipeConfig(['user.role.collab_server']);
    return 'collab_server';
  }

  /**
   * A space with no read-access value set reads as members-only.
   */
  public function testMissingReadAccessIsMembersOnly(): void {
    $space = $this->createSpace('Unset');
    $page = $this->createPage('Unset space page', $space);

    $this->assertFalse($page->access('view', $this->outsider));
    $this->assertFalse($space->access('view', $this->outsider));
  }

  /**
   * The gate keys nothing per account.
   *
   * A `user` cache context here would key one cached response per account and,
   * being an auto-placeholder context, would make the whole ce-api read path
   * uncacheable. The gate re-runs per request ahead of dynamic_page_cache, so
   * the decision is a gate, not a variation.
   *
   * The unpublished subjects are the ones that cost the context: core's owner
   * branch adds `user` on every authenticated unpublished read, before it ever
   * compares owners. Nothing in the shipped permission set reaches it. Delete
   * is left out — `delete own` keys per user in core, whatever the gate says.
   *
   * Pages only. A space's own access is a roster decision the entity makes
   * per account, so it says so; the page read path is the one that has to
   * stay cacheable.
   */
  public function testSpaceGateAddsNoAccountVaryingCacheContext(): void {
    $subjects = [
      'members-only page' => [$this->membersOnlyPage, ['view', 'update']],
      'all-users page' => [$this->allUsersPage, ['view', 'update']],
      'unpublished page' => [$this->unpublishedPage, ['view', 'update']],
      'forward draft' => [$this->forwardDraft, ['view', 'update']],
    ];
    foreach ($subjects as $label => [$entity, $operations]) {
      foreach ($operations as $operation) {
        foreach ([$this->outsider, $this->viewer, $this->member, $this->manager] as $account) {
          \Drupal::entityTypeManager()->getAccessControlHandler($entity->getEntityTypeId())->resetCache();
          $result = $entity->access($operation, $account, TRUE);
          $this->assertNotContains('user', $result->getCacheContexts(), sprintf(
            '%s, %s, %s',
            $label,
            $operation,
            $account->getAccountName(),
          ));
        }
      }
    }
  }

  /**
   * No recipe grants a role `view own unpublished content`.
   *
   * That permission would make an unpublished read ownership-based; OpenKB
   * decides it by space seat, and core adds a bare `user` cache context to
   * every check once a role holds it.
   */
  public function testNoRecipeGrantsTheOwnerDraftPermission(): void {
    $recipes = dirname(DRUPAL_ROOT) . '/recipes';
    // A shipped role file, so the glob below cannot pass empty.
    $this->assertFileExists($recipes . '/openkb_recipe_collab/config/user.role.collab_server.yml');
    foreach (glob($recipes . '/*/config/user.role.*.yml') as $file) {
      $role = Yaml::parseFile($file);
      $this->assertNotContains('view own unpublished content', $role['permissions'], $file);
    }
    foreach (glob($recipes . '/*/recipe.yml') as $file) {
      $this->assertStringNotContainsString('view own unpublished content', file_get_contents($file), $file);
    }
  }

  /**
   * A routed page in an unreadable space answers 404, not 403.
   *
   * Everywhere else the invisibility falls out of the query filtering; the
   * routed entity is the one place Drupal has already resolved the path and
   * would otherwise confirm that it exists.
   */
  public function testAccessDenialInAnInvisibleSpaceBecomesNotFound(): void {
    \Drupal::currentUser()->setAccount($this->outsider);
    $event = $this->denialFor($this->membersOnlyPage);
    \Drupal::service('openkb_space_access.hide_invisible_space')->onException($event);
    $this->assertInstanceOf(NotFoundHttpException::class, $event->getThrowable());

    // A denial that has nothing to do with spaces keeps its own meaning: the
    // viewer reads this space, so a 403 here means something else.
    \Drupal::currentUser()->setAccount($this->viewer);
    $event = $this->denialFor($this->membersOnlyPage);
    \Drupal::service('openkb_space_access.hide_invisible_space')->onException($event);
    $this->assertInstanceOf(AccessDeniedHttpException::class, $event->getThrowable());
  }

  /**
   * An access-denied exception event for a routed entity.
   */
  private function denialFor(NodeInterface $node): ExceptionEvent {
    $request = Request::create('/' . $node->id());
    $request->attributes->set('node', $node);
    return new ExceptionEvent(
      \Drupal::service('http_kernel'),
      $request,
      HttpKernelInterface::MAIN_REQUEST,
      new AccessDeniedHttpException(),
    );
  }

  /**
   * Creates an enabled user with one role.
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
  private function createPage(string $title, SpaceInterface $space, bool $published = TRUE): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'status' => (int) $published,
      'field_type' => 'article',
      'field_space' => ['target_id' => $space->id()],
    ]);
    $page->save();
    return $page;
  }

  /**
   * Writes an unpublished pending revision and returns it.
   *
   * A non-default revision leaves the grant records alone, so the published
   * page keeps answering as before.
   */
  private function createForwardDraft(NodeInterface $page): NodeInterface {
    $storage = \Drupal::entityTypeManager()->getStorage('node');
    $draft = $storage->createRevision($page, FALSE);
    $draft->setUnpublished();
    $draft->save();
    return $draft;
  }

  /**
   * Re-reads an entity the way the next request would.
   *
   * The entity access handler keeps a static per-entity answer for the life of
   * the process; a real request starts without it. Only that static is dropped
   * here — the policy's own caches stay warm, which is exactly what the
   * freshness assertions are about.
   */
  private function reload(NodeInterface $node): NodeInterface {
    \Drupal::entityTypeManager()->getAccessControlHandler('node')->resetCache();
    $storage = \Drupal::entityTypeManager()->getStorage('node');
    $storage->resetCache([$node->id()]);
    return $storage->load($node->id());
  }

  /**
   * The space ids an account sees in a space collection.
   */
  private function visibleSpaceIds(UserInterface $account): array {
    $this->setCurrentUser($account);
    $ids = \Drupal::entityTypeManager()->getStorage('openkb_space')->getQuery()
      ->accessCheck(TRUE)
      ->execute();
    return array_values(array_map('intval', $ids));
  }

  /**
   * Creates a space.
   */
  private function createSpace(string $label, array $values = []): SpaceInterface {
    $space = Space::create(['label' => $label] + $values);
    $space->save();
    return $space;
  }

  /**
   * The page ids an account sees in a node collection.
   */
  private function visiblePageIds(UserInterface $account): array {
    $this->setCurrentUser($account);
    $ids = \Drupal::entityTypeManager()->getStorage('node')->getQuery()
      ->accessCheck(TRUE)
      ->condition('type', 'kb_page')
      ->execute();
    return array_values(array_map('intval', $ids));
  }

  /**
   * Makes an account the current user, as a request would.
   */
  private function setCurrentUser(UserInterface $account): void {
    \Drupal::currentUser()->setAccount($account);
  }

}
