<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

/**
 * Makes a missing OpenSearch a failure rather than a silent skip.
 *
 * These tests are the gate on search: the docker stack and CI both run a
 * container on the compose network, and a green run with no search coverage
 * proves nothing. Set `OKB_SKIP_OPENSEARCH_TESTS=1` to skip them deliberately.
 */
trait RequiresOpenSearchTrait {

  /**
   * Skips these tests when nothing answers, instead of failing them.
   */
  private const OPT_OUT = 'OKB_SKIP_OPENSEARCH_TESTS';

  /**
   * Stops the test unless the OpenSearch server answers.
   */
  protected function requireOpenSearch(): void {
    if ($this->serverAvailable()) {
      return;
    }
    if (getenv(self::OPT_OUT) !== FALSE) {
      $this->markTestSkipped(self::OPT_OUT . ' is set and no OpenSearch server answers.');
    }
    $this->fail('No OpenSearch server answers, so this test would prove nothing. Start the stack, or set ' . self::OPT_OUT . '=1 to skip it.');
  }

}
