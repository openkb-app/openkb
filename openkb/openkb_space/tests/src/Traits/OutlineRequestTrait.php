<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space\Traits;

use Drupal\Component\Serialization\Json;
use Drupal\node\Entity\Node;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\user\UserInterface;
use Symfony\Component\HttpFoundation\Response;

/**
 * The fixture behind `PUT /openkb/space/{openkb_space}/outline`.
 *
 * Restructuring is decided in two modules — the space holds it to its
 * managers, `openkb_space_access` widens it — so both suites build the same
 * rosters, pages and requests.
 */
trait OutlineRequestTrait {

  /**
   * The relationships to a space, keyed by the name they report under.
   *
   * @var \Drupal\user\UserInterface[]
   */
  protected array $accounts = [];

  /**
   * One account per rank, on the permissions the recipe grants everyone.
   */
  protected function createRosterAccounts(): void {
    $permissions = $this->recipeGrantedPermissions('authenticated');
    foreach (['viewer', 'member', 'manager'] as $rank) {
      $this->accounts[$rank] = $this->createUser($permissions, $rank);
    }
    $this->accounts['admin'] = $this->createUser(
      [...$permissions, 'bypass node access', 'administer openkb_space'],
      'admin',
    );
  }

  /**
   * A space carrying the three rosters.
   *
   * @param string $name
   *   The space name.
   * @param bool|null $moderated
   *   The review setting, or NULL to leave the field unwritten.
   *
   * @return \Drupal\openkb_space\SpaceInterface
   *   The space.
   */
  protected function createSpace(string $name, ?bool $moderated = NULL): SpaceInterface {
    $values = [
      'label' => $name,
      'read_access' => 'all_users',
      'viewers' => [['target_id' => $this->accounts['viewer']->id()]],
      'members' => [['target_id' => $this->accounts['member']->id()]],
      'managers' => [['target_id' => $this->accounts['manager']->id()]],
    ];
    if ($moderated !== NULL) {
      $values['field_moderation'] = $moderated;
    }
    $space = Space::create($values);
    $space->save();
    return $space;
  }

  /**
   * A page of a space, addressable in its tree.
   */
  protected function createPage(SpaceInterface $space, string $title): string {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'uid' => $this->accounts['manager']->id(),
      'status' => 1,
      'field_space' => ['target_id' => $space->id()],
    ]);
    $page->save();
    return $page->uuid();
  }

  /**
   * The space as storage holds it now.
   */
  protected function reloadSpace(SpaceInterface $space): SpaceInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('openkb_space');
    $storage->resetCache();
    return $storage->load($space->id());
  }

  /**
   * The tree a space's field holds, decoded.
   */
  protected function storedTree(SpaceInterface $space): array {
    return (array) Json::decode((string) ($this->reloadSpace($space)->get('outline')->value ?? '')) ?: [];
  }

  /**
   * PUTs a tree as the given account.
   */
  protected function put(SpaceInterface $space, ?UserInterface $user, array $payload): Response {
    return $this->request(
      '/openkb/space/' . $space->id() . '/outline',
      $user,
      'PUT',
      $payload,
      // Generator and validator share the session_manager.metadata_bag
      // service in-process, so this token is the one the route accepts.
      ['X-CSRF-Token' => $this->container->get('csrf_token')->get('rest')],
    );
  }

}
