<?php

declare(strict_types=1);

namespace Drupal\openkb_collab_api;

use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * A commit refused because the page moved on since it was prepared.
 *
 * Carries both timestamps rather than a sentence about them: the editor has to
 * tell "somebody else wrote" from every other write failure, and the reload
 * banner reads the two values.
 * \Drupal\openkb_collab_api\EventSubscriber\StaleCommitSubscriber renders it.
 */
final class StaleCommitException extends HttpException {

  /**
   * Constructs the refusal.
   *
   * @param int $expected
   *   The `changed` the payload was prepared against.
   * @param int $actual
   *   The `changed` the working copy carries.
   */
  public function __construct(
    public readonly int $expected,
    public readonly int $actual,
  ) {
    parent::__construct(409, sprintf(
      'This commit was prepared against revision %d, but the page now stands at %d.',
      $expected,
      $actual,
    ));
  }

  /**
   * The refusal as an error document.
   *
   * @return array
   *   The response document.
   */
  public function toDocument(): array {
    return [
      'errors' => [
        [
          'status' => '409',
          'title' => 'Conflict',
          'detail' => $this->getMessage(),
          'meta' => ['expected' => $this->expected, 'actual' => $this->actual],
        ],
      ],
    ];
  }

}
