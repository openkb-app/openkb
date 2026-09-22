<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Kernel;

use Drupal\Core\Cache\CacheableMetadata;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\openkb_space_access\SpaceAccessMap;
use Drupal\openkb_space_access\SpaceAccessPolicy;
use Drupal\openkb_space\Entity\Space;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;

/**
 * What each kind of account is told about where it may work.
 *
 * The map is the answer an agent acts on before it writes anything, so the
 * thing under test is not "does it list spaces" but "does the level it reports
 * match the write that would follow". Every relationship to a space that grants
 * access differently is here — the three roster ranks, the account on no roster
 * in an all-users space, the permission holders who sit on no roster at all
 * (the site administrator and the collaboration server), and anonymous.
 *
 * @group openkb_space_access
 */
final class SpaceAccessMapTest extends KernelTestBase {

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
    // the collaboration server would hold nothing. Its commit resource needs
    // the JSON:API and review-model services in the container, its join gate
    // the schema builder.
    'serialization',
    'file',
    // The consumer entity carries an image field, and jsonapi builds a
    // resource type for every field it finds before the router can be built.
    'image',
    'jsonapi',
    // openkb_agent depends on these: its consent screen reads the account's
    // own clients through simple_oauth_personal_consumers.
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'openkb_agent',
    'openkb_workflow',
    'openkb_schema',
    'openkb_collab_api',
  ];

  /**
   * The map under test.
   */
  private SpaceAccessMap $map;

  /**
   * On the members-only space's viewer roster.
   */
  private UserInterface $viewer;

  /**
   * On the members-only space's member roster.
   */
  private UserInterface $member;

  /**
   * On the members-only space's manager roster.
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
    // simple_oauth reads a user's tokens whenever the account is saved.
    $this->installEntitySchema('oauth2_token');
    $this->installEntitySchema('node');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['filter', 'node', 'system']);

    $this->importRecipeConfig($this->kbSpaceConfigNames());

    // User 1 is the superuser and bypasses everything; burn it on a
    // placeholder so no account under test inherits that.
    User::create(['name' => 'superuser'])->save();

    $role = Role::create(['id' => 'kb_user', 'label' => 'KB user']);
    $role->grantPermission('access content');
    $role->save();

    $this->viewer = $this->createUser('viewer', [$role->id()]);
    $this->member = $this->createUser('member', [$role->id()]);
    $this->manager = $this->createUser('manager', [$role->id()]);
    $this->outsider = $this->createUser('outsider', [$role->id()]);

    Space::create([
      'label' => 'Secret Ops',
      'description' => 'Runbooks for the on-call rotation.',
      'read_access' => 'members_only',
      'field_moderation' => TRUE,
      'viewers' => [['target_id' => $this->viewer->id()]],
      'members' => [['target_id' => $this->member->id()]],
      'managers' => [['target_id' => $this->manager->id()]],
    ])->save();

    Space::create([
      'label' => 'Team Wiki',
      'description' => 'Everything everyone may read.',
      'read_access' => 'all_users',
      'field_moderation' => FALSE,
      'managers' => [['target_id' => $this->manager->id()]],
    ])->save();

    $this->map = $this->container->get(SpaceAccessMap::class);
  }

  /**
   * Each roster rank is reported as the level it actually grants.
   */
  public function testRosterRanksMapToLevels(): void {
    $this->assertSame(
      ['secret-ops' => SpaceAccessMap::MANAGE, 'team-wiki' => SpaceAccessMap::MANAGE],
      $this->levels($this->manager),
    );
    // A member writes the space's content but does not administer the space,
    // which is exactly the distinction an agent has to be told about.
    $this->assertSame(
      ['secret-ops' => SpaceAccessMap::WRITE, 'team-wiki' => SpaceAccessMap::READ],
      $this->levels($this->member),
    );
    $this->assertSame(
      ['secret-ops' => SpaceAccessMap::READ, 'team-wiki' => SpaceAccessMap::READ],
      $this->levels($this->viewer),
    );
  }

  /**
   * A space the account cannot read is absent, not listed as unreadable.
   */
  public function testUnreadableSpacesAreNotListed(): void {
    $this->assertSame(['team-wiki' => SpaceAccessMap::READ], $this->levels($this->outsider));
    $this->assertSame([], $this->levels(User::getAnonymousUser()));
  }

  /**
   * The permission holders who sit on no roster still get an answer.
   *
   * Both are the reason the map is computed from the access policy rather than
   * read off the rosters: neither appears on one, and a roster-derived listing
   * would tell a site administrator it may work nowhere.
   */
  public function testPermissionHoldersAreAnswered(): void {
    $administrator = $this->createUser('administrator', [$this->roleWith('bypass', SpaceAccessPolicy::BYPASS)]);
    $this->assertSame(
      ['secret-ops' => SpaceAccessMap::MANAGE, 'team-wiki' => SpaceAccessMap::MANAGE],
      $this->levels($administrator),
    );

    // The collaboration server writes in every space and manages none.
    $collaboration = $this->createUser('collaboration', [$this->roleWith('collab', SpaceAccessPolicy::COLLABORATION)]);
    $this->assertSame(
      ['secret-ops' => SpaceAccessMap::WRITE, 'team-wiki' => SpaceAccessMap::WRITE],
      $this->levels($collaboration),
    );
  }

  /**
   * The `access` filter is a minimum, so a higher level still qualifies.
   */
  public function testAccessFilterIsMinimumNotEquality(): void {
    $this->assertSame(
      ['secret-ops', 'team-wiki'],
      $this->slugs($this->manager, ['access' => SpaceAccessMap::WRITE]),
    );
    $this->assertSame(
      ['secret-ops'],
      $this->slugs($this->member, ['access' => SpaceAccessMap::WRITE]),
    );
    $this->assertSame([], $this->slugs($this->viewer, ['access' => SpaceAccessMap::WRITE]));
    $this->assertSame([], $this->slugs($this->member, ['access' => SpaceAccessMap::MANAGE]));
  }

  /**
   * The `q` filter matches name and description, never widening the answer.
   */
  public function testQueryFilterMatchesNameAndDescription(): void {
    $this->assertSame(['team-wiki'], $this->slugs($this->manager, ['q' => 'wiki']));
    $this->assertSame(['team-wiki'], $this->slugs($this->manager, ['q' => 'TEAM']));
    // Description text, on the space the outsider cannot read — a match does
    // not make it visible.
    $this->assertSame(['secret-ops'], $this->slugs($this->manager, ['q' => 'on-call']));
    $this->assertSame([], $this->slugs($this->outsider, ['q' => 'on-call']));
    $this->assertSame([], $this->slugs($this->manager, ['q' => 'nothing matches this']));
  }

  /**
   * The two filters compose rather than replacing one another.
   */
  public function testFiltersCompose(): void {
    $this->assertSame(
      [],
      $this->slugs($this->member, ['q' => 'wiki', 'access' => SpaceAccessMap::WRITE]),
    );
    $this->assertSame(
      ['secret-ops'],
      $this->slugs($this->member, ['q' => 'ops', 'access' => SpaceAccessMap::WRITE]),
    );
  }

  /**
   * A slug the map reports resolves back through the space's path alias.
   */
  public function testSlugResolvesBackToItsSpace(): void {
    $spaces = $this->container->get('entity_type.manager')->getStorage('openkb_space');
    $wiki = $spaces->getBySlug('team-wiki');
    $this->assertSame('Team Wiki', $wiki?->label());
    $this->assertSame('team-wiki', $wiki?->getSlug());

    $this->assertNull($spaces->getBySlug('no-such-space'));
    $this->assertNull($spaces->getBySlug(''));

    // A rename moves the alias, and the slug with it.
    // The save drops storage's loaded-spaces cache, so nothing resets by hand.
    $wiki->set('label', 'Team Handbook')->save();
    $this->assertNull($spaces->getBySlug('team-wiki'));
    $this->assertSame('Team Handbook', $spaces->getBySlug('team-handbook')?->label());
  }

  /**
   * Entries carry the space's own description and review policy.
   */
  public function testEntriesDescribeTheSpace(): void {
    $spaces = $this->map->list($this->manager);
    $this->assertSame([
      'slug' => 'secret-ops',
      'name' => 'Secret Ops',
      'description' => 'Runbooks for the on-call rotation.',
      'access' => SpaceAccessMap::MANAGE,
      'moderated' => TRUE,
    ], $spaces[0]);
    $this->assertFalse($spaces[1]['moderated']);
  }

  /**
   * The answer says it varies by account and by the set of spaces.
   *
   * The vocabulary's list tag is the one a space that does not exist yet can be
   * described by: without it, an account added to a roster on a space created
   * later keeps answering out of a cache computed before it existed. The `user`
   * context has to be added by hand — the access policy declares it, but the
   * processor strips its persistent contexts on the way out.
   */
  public function testCacheabilityCoversTheAccountAndTheSpaceList(): void {
    $cacheability = new CacheableMetadata();
    $this->map->list($this->member, [], $cacheability);

    $this->assertContains('user', $cacheability->getCacheContexts());
    $this->assertContains('openkb_space_list', $cacheability->getCacheTags());
  }

  /**
   * A roster change is reflected without anything clearing a cache by hand.
   */
  public function testRosterChangeChangesTheAnswer(): void {
    $this->assertSame(SpaceAccessMap::READ, $this->levels($this->viewer)['secret-ops']);

    $space = $this->container->get('entity_type.manager')
      ->getStorage('openkb_space')
      ->loadByProperties(['label' => 'Secret Ops']);
    $space = reset($space);
    $space->set('members', [['target_id' => $this->viewer->id()]])->save();

    $this->assertSame(SpaceAccessMap::WRITE, $this->levels($this->viewer)['secret-ops']);
  }

  /**
   * Levels by slug, for an account.
   */
  private function levels(mixed $account): array {
    return array_column($this->map->list($account), 'access', 'slug');
  }

  /**
   * Slugs of a filtered listing, in order.
   */
  private function slugs(mixed $account, array $filters): array {
    return array_column($this->map->list($account, $filters), 'slug');
  }

  /**
   * A user holding the given roles.
   */
  private function createUser(string $name, array $roles): UserInterface {
    $user = User::create(['name' => $name, 'status' => 1]);
    foreach ($roles as $role) {
      $user->addRole($role);
    }
    $user->save();
    return $user;
  }

  /**
   * A role granting one permission.
   */
  private function roleWith(string $id, string $permission): string {
    $role = Role::create(['id' => $id, 'label' => $id]);
    $role->grantPermission('access content');
    $role->grantPermission($permission);
    $role->save();
    return $role->id();
  }

}
