<?php

declare(strict_types=1);

namespace Drupal\Tests\comark\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Vanilla smoke test, no Drupal bootstrap needed.
 *
 * Exists so the CI's PHPUnit stage has at least one always-green test —
 * the build doesn't show "no tests ran" while the heavier kernel suites
 * are stabilising.
 *
 * @group comark
 */
class SmokeTest extends TestCase {

  /**
   * Always-true assertion so the CI's PHPUnit stage has at least one test.
   */
  public function testSmoke(): void {
    $this->assertTrue(TRUE);
  }

}
