<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Kernel;

use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\Tests\openkb_space\Traits\OutlineRequestTrait;
use Drupal\openkb_space\SpaceInterface;

/**
 * What this module adds to `PUT /openkb/space/{openkb_space}/outline`.
 *
 * The space holds restructuring to its managers (asserted in
 * \Drupal\Tests\openkb_space\Kernel\OutlineWriteTest). Three rules on top are
 * this module's: structure follows content, so a space that runs no review
 * lets every writer restructure it; a space nobody may read is not admitted to
 * exist; and every id in a tree has to be a page of that space.
 *
 * @group openkb_space_access
 */
final class OutlineRestructureTest extends OpenkbRequestKernelTestBase {

  use OutlineRequestTrait;

  /**
   * A space whose edits go through review.
   */
  private SpaceInterface $moderated;

  /**
   * A space that runs wiki-style.
   */
  private SpaceInterface $wiki;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->container->get('router.builder')->rebuild();

    $this->createRosterAccounts();
    $this->moderated = $this->createSpace('Handbook', TRUE);
    $this->wiki = $this->createSpace('Scratchpad', FALSE);
  }

  /**
   * A space that runs no review lets its writers restructure it.
   */
  public function testUnmoderatedSpaceIsRestructuredByItsWriters(): void {
    $page = $this->createPage($this->wiki, 'Notes');
    $expected = [
      'viewer' => 403,
      'member' => 200,
      'manager' => 200,
      'admin' => 200,
    ];
    foreach ($expected as $rank => $status) {
      $response = $this->put($this->wiki, $this->accounts[$rank], [
        'outline' => [['id' => $page]],
        'expect' => $this->storedTree($this->wiki),
      ]);
      $this->assertSame($status, $response->getStatusCode(), $rank . ': ' . $response->getContent());
    }
  }

  /**
   * A space whose review setting was never written is held to the manager bar.
   */
  public function testUnsetReviewSettingIsTreatedAsModerated(): void {
    $unflagged = $this->createSpace('Imported', NULL);
    $page = $this->createPage($unflagged, 'Imported page');

    $refused = $this->put($unflagged, $this->accounts['member'], [
      'outline' => [['id' => $page]],
      'expect' => [],
    ]);
    $this->assertSame(403, $refused->getStatusCode(), (string) $refused->getContent());
    $this->assertSame([], $this->storedTree($unflagged));

    $allowed = $this->put($unflagged, $this->accounts['manager'], [
      'outline' => [['id' => $page]],
      'expect' => [],
    ]);
    $this->assertSame(200, $allowed->getStatusCode(), (string) $allowed->getContent());
  }

  /**
   * A session that cannot see the space is not told it is there.
   *
   * A viewer and a member are refused with 403: the space exists and they may
   * not restructure it. Below the read line that fact is itself withheld
   * (\Drupal\openkb_space_access\EventSubscriber\HideInvisibleSpaceSubscriber),
   * so the same request answers 404.
   */
  public function testAnonymousIsNotToldTheSpaceExists(): void {
    foreach ([$this->moderated, $this->wiki] as $space) {
      $page = $this->createPage($space, 'Page in ' . $space->label());
      $response = $this->put($space, NULL, [
        'outline' => [['id' => $page]],
        'expect' => [],
      ]);
      $this->assertSame(404, $response->getStatusCode(), (string) $response->getContent());
      $this->assertSame([], $this->storedTree($space));
    }
  }

  /**
   * The membership rule is the field's, so a foreign page is a 422 here too.
   */
  public function testForeignPageIsRefusedByTheFieldConstraint(): void {
    $mine = $this->createPage($this->wiki, 'Mine');
    $theirs = $this->createPage($this->moderated, 'Theirs');

    $response = $this->put($this->wiki, $this->accounts['member'], [
      'outline' => [['id' => $mine], ['id' => $theirs]],
      'expect' => [],
    ]);
    $this->assertSame(422, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame([], $this->storedTree($this->wiki));
  }

}
