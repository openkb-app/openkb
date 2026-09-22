<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;

/**
 * Who may view, update, delete and create a space.
 *
 * Six actors (administrator, manager, member, viewer, outsider, anonymous)
 * against members-only, all-users and disabled spaces.
 *
 * @group openkb_space
 */
final class SpaceAccessTest extends KernelTestBase {

  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'options',
    'path_alias',
    'path',
    'views',
    'openkb_space',
  ];

  /**
   * Holds the administer permission.
   */
  private UserInterface $admin;
  /**
   * On the managers roster.
   */
  private UserInterface $manager;
  /**
   * On the members roster.
   */
  private UserInterface $member;
  /**
   * On the viewers roster.
   */
  private UserInterface $viewer;
  /**
   * Signed in, on no roster.
   */
  private UserInterface $outsider;
  /**
   * Not signed in.
   */
  private UserInterface $anonymous;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->admin = $this->createUser(['administer openkb_space'], 'admin');
    $this->manager = $this->createUser([], 'manager');
    $this->member = $this->createUser([], 'member');
    $this->viewer = $this->createUser([], 'viewer');
    $this->outsider = $this->createUser([], 'outsider');
    $this->anonymous = User::getAnonymousUser();
  }

  /**
   * View: roster or all users, never anonymous; disabled means managers only.
   */
  public function testViewFollowsRosterReadAccessAndStatus(): void {
    $membersOnly = $this->space([]);
    $this->assertAccess($membersOnly, 'view',
      [$this->admin, $this->manager, $this->member, $this->viewer],
      [$this->outsider, $this->anonymous]);

    $allUsers = $this->space(['read_access' => SpaceInterface::ALL_USERS]);
    $this->assertAccess($allUsers, 'view',
      [$this->admin, $this->manager, $this->member, $this->viewer, $this->outsider],
      [$this->anonymous]);

    $disabled = $this->space(['read_access' => SpaceInterface::ALL_USERS, 'status' => FALSE]);
    $this->assertAccess($disabled, 'view',
      [$this->admin, $this->manager],
      [$this->member, $this->viewer, $this->outsider, $this->anonymous]);
  }

  /**
   * A roster-dependent answer varies by user and by the space itself.
   */
  public function testAnswersAreCacheablePerUserAndSpace(): void {
    $space = $this->space([]);
    $result = $space->access('view', $this->member, TRUE);
    $this->assertTrue($result->isAllowed());
    $this->assertContains('user', $result->getCacheContexts());
    $this->assertContains('user.permissions', $result->getCacheContexts());
    $this->assertContains('openkb_space:' . $space->id(), $result->getCacheTags());

    $bypass = $space->access('delete', $this->admin, TRUE);
    $this->assertTrue($bypass->isAllowed());
    $this->assertSame(['user.permissions'], $bypass->getCacheContexts());
  }

  /**
   * Update: managers, whatever the status.
   */
  public function testManagersUpdate(): void {
    foreach ([TRUE, FALSE] as $status) {
      $this->assertAccess($this->space(['status' => $status]), 'update',
        [$this->admin, $this->manager],
        [$this->member, $this->viewer, $this->outsider, $this->anonymous]);
    }
  }

  /**
   * Delete and every revision operation: administrators only.
   */
  public function testDeleteAndRevisionsAreTheAdministrators(): void {
    $space = $this->space([]);
    $first = $space->getRevisionId();
    $space->set('label', 'Renamed')->save();
    $everyoneElse = [$this->manager, $this->member, $this->viewer, $this->outsider, $this->anonymous];
    foreach (['delete', 'view all revisions', 'view revision'] as $operation) {
      $this->assertAccess($space, $operation, [$this->admin], $everyoneElse);
    }
    $older = $this->container->get('entity_type.manager')->getStorage('openkb_space')->loadRevision($first);
    foreach (['revert', 'delete revision'] as $operation) {
      $this->assertAccess($older, $operation, [$this->admin], $everyoneElse);
    }
  }

  /**
   * Create: the permission, or administer.
   */
  public function testCreateNeedsThePermission(): void {
    $handler = $this->container->get('entity_type.manager')->getAccessControlHandler('openkb_space');
    $creator = $this->createUser(['create openkb_space'], 'creator');
    $this->assertTrue($handler->createAccess(NULL, $creator));
    $this->assertTrue($handler->createAccess(NULL, $this->admin));
    $this->assertFalse($handler->createAccess(NULL, $this->outsider));
    $this->assertFalse($handler->createAccess(NULL, $this->anonymous));
  }

  /**
   * The owner is put on the managers roster on the first save, once.
   */
  public function testTheOwnerJoinsTheManagersOnce(): void {
    $space = Space::create(['label' => 'Mine', 'uid' => $this->outsider->id()]);
    $space->save();
    $this->assertTrue($space->isOnRoster(SpaceInterface::MANAGERS, $this->outsider));

    $space->save();
    $this->assertCount(1, $space->get(SpaceInterface::MANAGERS));

    $listed = Space::create([
      'label' => 'Listed already',
      'uid' => $this->outsider->id(),
      SpaceInterface::MANAGERS => [$this->outsider->id()],
    ]);
    $listed->save();
    $this->assertCount(1, $listed->get(SpaceInterface::MANAGERS));
  }

  /**
   * A space owned by the administrator, with one user on each roster.
   */
  private function space(array $values): SpaceInterface {
    $space = Space::create($values + [
      'label' => 'Space',
      'uid' => $this->admin->id(),
      SpaceInterface::MANAGERS => [$this->manager->id()],
      SpaceInterface::MEMBERS => [$this->member->id()],
      SpaceInterface::VIEWERS => [$this->viewer->id()],
    ]);
    $space->save();
    return $space;
  }

  /**
   * Asserts an operation is allowed for some accounts and denied for the rest.
   *
   * @param \Drupal\openkb_space\SpaceInterface $space
   *   The space, or one of its revisions.
   * @param string $operation
   *   The entity operation.
   * @param \Drupal\user\UserInterface[] $allowed
   *   Accounts the operation is allowed for.
   * @param \Drupal\user\UserInterface[] $denied
   *   Accounts the operation is denied for.
   */
  private function assertAccess(SpaceInterface $space, string $operation, array $allowed, array $denied): void {
    foreach ($allowed as $account) {
      $this->assertTrue($space->access($operation, $account), "$operation allowed for {$account->getAccountName()}");
    }
    foreach ($denied as $account) {
      $this->assertFalse($space->access($operation, $account), "$operation denied for {$account->getAccountName()}");
    }
  }

}
