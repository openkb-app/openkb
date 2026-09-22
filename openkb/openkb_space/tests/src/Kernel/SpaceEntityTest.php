<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\user\Entity\User;

/**
 * Defaults, the revision log and the outline's shape.
 *
 * @group openkb_space
 */
final class SpaceEntityTest extends KernelTestBase {

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
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
  }

  /**
   * Defaults on creation; a save is a revision in the saver's name.
   */
  public function testDefaultsAndRevisionLog(): void {
    $owner = $this->createUser([], 'owner');
    $editor = $this->createUser([], 'editor');

    $space = Space::create(['label' => 'General', 'uid' => $owner->id()]);
    $space->save();
    $this->assertSame(SpaceInterface::MEMBERS_ONLY, $space->get('read_access')->value);
    $this->assertFalse($space->isOpenToAllUsers());
    $this->assertTrue($space->isPublished());
    $first = $space->getRevisionId();

    // A plain save by whoever is signed in is a revision in their name.
    $this->setCurrentUser($editor);
    $space->setRevisionLogMessage('Renamed');
    $space->set('label', 'General knowledge');
    $space->save();

    $this->assertNotSame($first, $space->getRevisionId());
    $this->assertSame('Renamed', $space->getRevisionLogMessage());
    $this->assertSame((int) $editor->id(), (int) $space->getRevisionUserId());
    $storage = $this->container->get('entity_type.manager')->getStorage('openkb_space');
    $this->assertSame('General', $storage->loadRevision($first)->label());
    $revisions = $storage->getQuery()->accessCheck(FALSE)->allRevisions()->condition('id', $space->id())->execute();
    $this->assertCount(2, $revisions);

    // The next save without a message of its own does not repeat the last one.
    $space->set('label', 'General knowledge base')->save();
    $this->assertSame('', (string) $space->getRevisionLogMessage());
    $this->assertSame('Renamed', $storage->loadRevision(array_key_last($revisions))->getRevisionLogMessage());
  }

  /**
   * A space saved with a roster keeps the one it was given.
   *
   * Default content and imports name their own managers; the owner is added to
   * a roster, never substituted for it.
   */
  public function testAnExplicitRosterIsAddedToRatherThanReplaced(): void {
    $owner = $this->createUser([], 'owner');
    $other = $this->createUser([], 'other');
    $this->setCurrentUser($owner);

    $space = Space::create([
      'label' => 'Product',
      'uid' => $owner->id(),
      SpaceInterface::MANAGERS => [$other->id()],
    ]);
    $space->save();

    $this->assertSame(
      [(int) $other->id(), (int) $owner->id()],
      array_map('intval', array_column($space->get(SpaceInterface::MANAGERS)->getValue(), 'target_id')),
    );
  }

  /**
   * A save with no owner adds nobody.
   */
  public function testSaveWithoutAnOwnerAddsNoManager(): void {
    $this->setCurrentUser(User::getAnonymousUser());
    $space = Space::create(['label' => 'Imported']);
    $space->save();
    $this->assertSame([], $space->get(SpaceInterface::MANAGERS)->getValue());
  }

  /**
   * The outline field refuses anything but a well-formed tree.
   *
   * @dataProvider outlines
   */
  public function testOutlineShape(string $outline, ?string $violation): void {
    $space = Space::create(['label' => 'Tree', 'outline' => $outline]);
    $messages = [];
    foreach ($space->validate() as $item) {
      if (str_starts_with($item->getPropertyPath(), 'outline')) {
        $messages[] = (string) $item->getMessage();
      }
    }
    if ($violation === NULL) {
      $this->assertSame([], $messages);
    }
    else {
      $this->assertCount(1, $messages);
      $this->assertStringContainsString($violation, $messages[0]);
    }
  }

  /**
   * Outline values and the violation each earns, or NULL.
   */
  public static function outlines(): array {
    return [
      'empty' => ['', NULL],
      'nested' => ['[{"id":"a","children":[{"id":"b"}]},{"id":"c"}]', NULL],
      'object, not list' => ['{"id":"a"}', 'not a JSON list'],
      'entry without id' => ['[{"children":[]}]', 'non-empty string "id"'],
      'children not a list' => ['[{"id":"a","children":{"id":"b"}}]', 'must be a list'],
      'duplicate' => ['[{"id":"a"},{"id":"b","children":[{"id":"a"}]}]', 'appears more than once'],
    ];
  }

}
