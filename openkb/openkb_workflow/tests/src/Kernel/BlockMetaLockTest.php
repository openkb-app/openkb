<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_workflow\Kernel;

use Drupal\Core\Lock\DatabaseLockBackend;
use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_workflow\BlockMetaLock;
use Symfony\Component\HttpKernel\Exception\ServiceUnavailableHttpException;

/**
 * The hold that keeps two sidecar writes from carrying each other away.
 *
 * Pinned against the REAL database lock backend, instantiated directly —
 * KernelTestBase swaps the container's lock service for NullLockBackend, so
 * the container one proves nothing. A second backend instance has its own
 * owner id and behaves as another request; what it can or cannot acquire is
 * the observable truth about the hold.
 *
 * @group openkb_workflow
 */
final class BlockMetaLockTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = ['system'];

  /**
   * The lock name the hold takes for a page.
   */
  private static function lockName(int $nid): string {
    return 'openkb_workflow:block_meta:' . $nid;
  }

  /**
   * A lock backend owned by "another request".
   */
  private function foreignBackend(): DatabaseLockBackend {
    return new DatabaseLockBackend($this->container->get('database'));
  }

  /**
   * The hold under test, on the real backend.
   */
  private function blockMetaLock(): BlockMetaLock {
    return new BlockMetaLock($this->foreignBackend());
  }

  /**
   * The exclusion is per page: one page never waits on another.
   */
  public function testTheHoldIsPerPage(): void {
    $foreign = $this->foreignBackend();
    $this->assertTrue($foreign->acquire(self::lockName(7)));

    $lock = $this->blockMetaLock();
    $ran = FALSE;
    $lock->exclusive(8, function () use (&$ran): void {
      $ran = TRUE;
    });

    $this->assertTrue($ran, 'Page 8 never waited on page 7.');
  }

  /**
   * Nested writers are one hold, not two.
   *
   * A request may write the sidecar twice. Releasing at the end of the inner
   * one would open the window in the middle of the outer one.
   */
  public function testNestedWritersShareOneHold(): void {
    $lock = $this->blockMetaLock();
    $foreign = $this->foreignBackend();
    $heldAfterInner = NULL;

    $lock->exclusive(7, function () use ($lock, $foreign, &$heldAfterInner): void {
      $lock->exclusive(7, fn () => NULL);
      $heldAfterInner = !$foreign->acquire(self::lockName(7));
    });

    $this->assertTrue($heldAfterInner, 'The inner writer did not release the outer hold.');
    $this->assertTrue($foreign->acquire(self::lockName(7)), 'The outer writer released it.');
  }

  /**
   * A write that throws still releases — nothing wedges the page.
   */
  public function testFailedWriteReleasesTheHold(): void {
    $lock = $this->blockMetaLock();

    try {
      $lock->exclusive(7, fn () => throw new \RuntimeException('validation said no'));
      $this->fail("The exception is the caller's to handle; the hold does not swallow it.");
    }
    catch (\RuntimeException) {
    }

    $this->assertTrue($this->foreignBackend()->acquire(self::lockName(7)), 'The hold came free.');
  }

  /**
   * A hold that never comes free refuses the request instead of racing it.
   *
   * Going ahead anyway is the silent loss; a 503 is a caller's problem, and
   * every caller of this endpoint retries. Real waiting: this test spends the
   * hold's full patience (~20s) against a lock another owner keeps.
   */
  public function testWriteThatCannotTakeTheHoldIsRefused(): void {
    $foreign = $this->foreignBackend();
    $this->assertTrue($foreign->acquire(self::lockName(7), 120.0));

    $lock = $this->blockMetaLock();
    $ran = FALSE;

    $this->expectException(ServiceUnavailableHttpException::class);
    try {
      $lock->exclusive(7, function () use (&$ran): void {
        $ran = TRUE;
      });
    }
    finally {
      $this->assertFalse($ran, 'The write never ran, so it never clobbered anything.');
    }
  }

  /**
   * The site wires the hold up, and every sidecar writer is handed it.
   */
  public function testTheSiteWiresTheHoldUp(): void {
    $this->enableModules([
      'user', 'field', 'filter', 'text', 'node', 'options', 'taxonomy',
      'serialization', 'file', 'jsonapi', 'path', 'path_alias', 'consumers', 'simple_oauth',
      'simple_oauth_personal_consumers', 'openkb_space_access', 'openkb_agent',
      'openkb_workflow',
    ]);
    $this->assertInstanceOf(BlockMetaLock::class, $this->container->get('openkb_workflow.block_meta_lock'));
  }

}
