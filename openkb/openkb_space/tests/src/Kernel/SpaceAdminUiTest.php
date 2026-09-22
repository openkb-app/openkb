<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space\Kernel;

use Drupal\Core\Form\FormState;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Session\AnonymousUserSession;
use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\user\UserInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\Session\Session;
use Symfony\Component\HttpFoundation\Session\Storage\MockArraySessionStorage;

/**
 * The backend pages: add, edit, delete, the Revisions tab and the listing.
 *
 * Pages are read by handing a signed-in Request to the HTTP kernel; forms
 * are submitted through the form builder.
 *
 * @group openkb_space
 */
final class SpaceAdminUiTest extends KernelTestBase {

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
   * On the managers roster of the space under test.
   */
  private UserInterface $manager;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installConfig(['system', 'user', 'openkb_space']);
    $this->container->get('router.builder')->rebuild();
    $this->admin = $this->createUser(['administer openkb_space'], 'admin');
    $this->manager = $this->createUser([], 'manager');
  }

  /**
   * Add, edit with a log message, the Revisions tab, delete.
   */
  public function testAddEditRevisionsAndDelete(): void {
    $add = $this->get('/openkb-space/add', $this->admin);
    $this->assertSame(200, $add->getStatusCode());
    $this->assertStringContainsString('name="label[0][value]"', (string) $add->getContent());
    $this->assertSame(403, $this->get('/openkb-space/add', $this->manager)->getStatusCode());

    $this->setCurrentUser($this->admin);
    $this->submit('add', Space::create([]), [
      'label' => [['value' => 'Handbook']],
      'read_access' => SpaceInterface::ALL_USERS,
    ]);
    $space = $this->spaceNamed('Handbook');
    $this->assertSame((int) $this->admin->id(), (int) $space->getOwnerId());
    $this->assertTrue($space->isOnRoster(SpaceInterface::MANAGERS, $this->admin));
    $this->assertTrue($space->isOpenToAllUsers());

    $space->set(SpaceInterface::MANAGERS, [$this->admin->id(), $this->manager->id()])->save();
    $edit = $this->get("/openkb-space/{$space->id()}/edit", $this->manager);
    $this->assertSame(200, $edit->getStatusCode());
    $this->assertStringContainsString('name="revision_log[0][value]"', (string) $edit->getContent());
    $this->assertStringNotContainsString('name="revision"', (string) $edit->getContent());

    $this->setCurrentUser($this->manager);
    $this->submit('edit', $space, [
      'label' => [['value' => 'Team handbook']],
      'revision_log' => [['value' => 'Renamed for the team']],
    ]);
    $space = $this->spaceNamed('Team handbook');
    $this->assertSame((int) $this->manager->id(), (int) $space->getRevisionUserId());

    $revisions = $this->get("/openkb-space/{$space->id()}/revisions", $this->admin);
    $this->assertSame(200, $revisions->getStatusCode());
    $this->assertStringContainsString('Renamed for the team', (string) $revisions->getContent());
    $this->assertStringContainsString('manager', (string) $revisions->getContent());
    $this->assertSame(403, $this->get("/openkb-space/{$space->id()}/revisions", $this->manager)->getStatusCode());

    $this->assertSame(403, $this->get("/openkb-space/{$space->id()}/delete", $this->manager)->getStatusCode());
    $this->assertSame(200, $this->get("/openkb-space/{$space->id()}/delete", $this->admin)->getStatusCode());
    $this->setCurrentUser($this->admin);
    $this->submit('delete', $space, ['confirm' => 1]);
    $this->assertNull(Space::load($space->id()));
  }

  /**
   * A name whose URL is taken is refused on the form, and nothing is saved.
   */
  public function testTakenNameIsRefusedOnTheAddForm(): void {
    Space::create(['label' => 'Handbook'])->save();

    $this->setCurrentUser($this->admin);
    $form_state = $this->runForm('add', Space::create([]), [
      'label' => [['value' => 'Handbook']],
      'read_access' => SpaceInterface::MEMBERS_ONLY,
    ]);

    $errors = $form_state->getErrors();
    $on_name = array_filter($errors, static fn (string $key): bool => str_starts_with($key, 'label'), ARRAY_FILTER_USE_KEY);
    $this->assertCount(1, $errors);
    $this->assertCount(1, $on_name);
    $this->assertStringContainsString('already in use', (string) reset($on_name));

    $storage = $this->container->get('entity_type.manager')->getStorage('openkb_space');
    $storage->resetCache();
    $this->assertCount(1, $storage->loadByProperties(['label' => 'Handbook']));
  }

  /**
   * The listing is the administrator's and filters by title, owner and date.
   */
  public function testListingFiltersByTitleAndOwner(): void {
    Space::create(['label' => 'Runbooks by admin', 'uid' => $this->admin->id()])->save();
    Space::create(['label' => 'Handbook by manager', 'uid' => $this->manager->id()])->save();

    $this->assertSame(403, $this->get('/admin/content/space', $this->manager)->getStatusCode());

    $all = $this->get('/admin/content/space', $this->admin);
    $this->assertSame(200, $all->getStatusCode());
    $this->assertStringContainsString('Runbooks by admin', (string) $all->getContent());
    $this->assertStringContainsString('Handbook by manager', (string) $all->getContent());
    $this->assertStringContainsString('name="label"', (string) $all->getContent());
    $this->assertStringContainsString('name="uid"', (string) $all->getContent());
    $this->assertStringContainsString('name="created"', (string) $all->getContent());

    $byTitle = (string) $this->get('/admin/content/space', $this->admin, ['label' => 'Runbook'])->getContent();
    $this->assertStringContainsString('Runbooks by admin', $byTitle);
    $this->assertStringNotContainsString('Handbook by manager', $byTitle);

    $byOwner = (string) $this->get('/admin/content/space', $this->admin, ['uid' => "manager ({$this->manager->id()})"])->getContent();
    $this->assertStringContainsString('Handbook by manager', $byOwner);
    $this->assertStringNotContainsString('Runbooks by admin', $byOwner);
  }

  /**
   * Handles a signed-in GET through the HTTP kernel.
   */
  private function get(string $path, AccountInterface $account, array $query = []): Response {
    $request = Request::create($path, 'GET', $query);
    // Under CLI the session middleware keeps the request's own session, so a
    // session carrying the uid plus the session cookie is the whole sign-in.
    $session = new Session(new MockArraySessionStorage());
    $session->set('uid', (int) $account->id());
    $request->setSession($session);
    $request->cookies->set($this->container->get('session_configuration')->getOptions($request)['name'], $session->getId());

    $response = $this->container->get('http_kernel')->handle($request);
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
    return $response;
  }

  /**
   * Submits one of the entity's forms as the current user; it has to pass.
   */
  private function submit(string $operation, SpaceInterface $space, array $values): void {
    $this->assertSame([], $this->runForm($operation, $space, $values)->getErrors());
  }

  /**
   * Runs one of the entity's forms as the current user.
   */
  private function runForm(string $operation, SpaceInterface $space, array $values): FormState {
    $form = $this->container->get('entity_type.manager')->getFormObject('openkb_space', $operation)->setEntity($space);
    // Naming the button is what makes its own submit handlers run.
    $values['op'] = $operation === 'delete' ? 'Delete' : 'Save';
    $form_state = (new FormState())->setValues($values);
    $this->container->get('form_builder')->submitForm($form, $form_state);
    return $form_state;
  }

  /**
   * The one space with this label, freshly loaded.
   */
  private function spaceNamed(string $label): SpaceInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('openkb_space');
    $storage->resetCache();
    $spaces = $storage->loadByProperties(['label' => $label]);
    $this->assertCount(1, $spaces);
    return reset($spaces);
  }

}
