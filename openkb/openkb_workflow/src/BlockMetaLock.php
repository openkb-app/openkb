<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow;

use Drupal\Core\Lock\LockBackendInterface;
use Symfony\Component\HttpKernel\Exception\ServiceUnavailableHttpException;

/**
 * Per-page hold around field_block_meta writes.
 *
 * Several requests write the review metadata as load-mutate-save on one JSON
 * field — a checkpoint's presave attribution, the checkpoint a sign-off rides
 * on — and two overlapping would silently drop each other's facts (a lost
 * credit makes its writer an eligible approver of their own text). Core's
 * changed check does not cover a programmatic state-only save, so the writers
 * are ordered here: one hold per page, re-entrant for a nested sidecar
 * write, refused with a 503 rather than raced (a refused checkpoint loses
 * nothing — the edits stay in the session and ride the next one). Callers read
 * their working copy inside the hold.
 */
final class BlockMetaLock {

  /**
   * The lock name's prefix; the page's node id completes it.
   */
  private const PREFIX = 'openkb_workflow:block_meta:';

  /**
   * How long a hold stays valid without being released.
   *
   * Long enough for the slowest writer — a checkpoint, which deserializes a
   * document, validates an entity and writes a revision — and short enough that
   * a process killed mid-write does not wedge a page for a working day.
   */
  private const HOLD_SECONDS = 30.0;

  /**
   * How long one wait for a busy lock blocks before looking again.
   */
  private const WAIT_SECONDS = 5;

  /**
   * How many times a busy lock is waited for before the request is refused.
   */
  private const WAIT_ROUNDS = 4;

  /**
   * Nesting depth per lock name, so an inner writer keeps the outer hold.
   *
   * A request may write the sidecar twice — and the two must be one hold:
   * releasing at the end of the inner one would open the window in the middle
   * of the outer one.
   *
   * @var array<string, int>
   */
  private array $depth = [];

  public function __construct(
    private readonly LockBackendInterface $lock,
  ) {}

  /**
   * Runs a sidecar write with exclusive hold of the page.
   *
   * @param int $nid
   *   The page's node id.
   * @param callable $write
   *   The load-mutate-save to run under the hold.
   *
   * @return mixed
   *   Whatever `$write` returned.
   *
   * @throws \Symfony\Component\HttpKernel\Exception\ServiceUnavailableHttpException
   *   When the page's sidecar stayed busy for the whole wait.
   */
  public function exclusive(int $nid, callable $write): mixed {
    $name = self::PREFIX . $nid;
    if (($this->depth[$name] ?? 0) > 0) {
      $this->depth[$name]++;
      try {
        return $write();
      }
      finally {
        $this->depth[$name]--;
      }
    }

    $this->acquire($name);
    $this->depth[$name] = 1;
    try {
      return $write();
    }
    finally {
      $this->depth[$name]--;
      if ($this->depth[$name] === 0) {
        unset($this->depth[$name]);
        $this->lock->release($name);
      }
    }
  }

  /**
   * Takes the hold, waiting for a busy one.
   *
   * @param string $name
   *   The lock name.
   *
   * @throws \Symfony\Component\HttpKernel\Exception\ServiceUnavailableHttpException
   *   When it stayed busy.
   */
  private function acquire(string $name): void {
    for ($round = 0; $round <= self::WAIT_ROUNDS; $round++) {
      if ($this->lock->acquire($name, self::HOLD_SECONDS)) {
        return;
      }
      $this->lock->wait($name, self::WAIT_SECONDS);
    }
    throw new ServiceUnavailableHttpException(
      NULL,
      'Another write to this page is still in progress. Try again.',
    );
  }

}
