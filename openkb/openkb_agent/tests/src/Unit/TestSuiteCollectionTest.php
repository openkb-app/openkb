<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Unit;

use PHPUnit\Framework\TestCase;

/**
 * Every test directory in the custom trees is reached by a testsuite glob.
 *
 * The suites in `phpunit.xml.dist` name directories by glob, so a test class
 * that moves to a path no glob reaches is not reported as missing — it is
 * simply never collected, and the suite stays green while covering less.
 *
 * @group openkb_agent
 */
final class TestSuiteCollectionTest extends TestCase {

  /**
   * The trees whose modules ship the tests the suites are meant to run.
   */
  private const TREES = ['openkb', 'web/modules/custom'];

  /**
   * The test kinds the suites split by.
   */
  private const KINDS = ['Unit', 'Kernel', 'Functional'];

  /**
   * Asserts each discovered test directory against the configured globs.
   */
  public function testEveryTestDirectoryIsCollected(): void {
    $root = $this->repositoryRoot();
    $collected = $this->globbedDirectories($root);
    $this->assertNotEmpty($collected, 'phpunit.xml.dist names no test directories at all.');

    foreach ($this->testDirectories($root) as $directory) {
      $this->assertContains(
        $directory,
        $collected,
        "$directory holds tests no phpunit.xml.dist testsuite glob reaches, so they never run. Add a <directory> covering it.",
      );
    }
  }

  /**
   * Every `tests/src/<kind>` directory under the custom trees, at any depth.
   *
   * @return string[]
   *   Repository-relative paths.
   */
  private function testDirectories(string $root): array {
    $found = [];
    foreach (self::TREES as $tree) {
      $iterator = new \RecursiveIteratorIterator(
        new \RecursiveDirectoryIterator("$root/$tree", \FilesystemIterator::SKIP_DOTS),
        \RecursiveIteratorIterator::SELF_FIRST,
      );
      foreach ($iterator as $path => $info) {
        if (!$info->isDir()) {
          continue;
        }
        $relative = substr($path, strlen($root) + 1);
        if (preg_match('#/tests/src/(' . implode('|', self::KINDS) . ')$#', $relative)) {
          $found[] = $relative;
        }
      }
    }
    return $found;
  }

  /**
   * The directories the testsuite globs actually resolve to.
   *
   * @return string[]
   *   Repository-relative paths.
   */
  private function globbedDirectories(string $root): array {
    $config = new \DOMDocument();
    $config->load("$root/phpunit.xml.dist");
    $resolved = [];
    foreach ((new \DOMXPath($config))->query('//testsuites/testsuite/directory') as $node) {
      $pattern = ltrim(trim($node->textContent), './');
      foreach (glob("$root/$pattern", GLOB_ONLYDIR) ?: [] as $path) {
        $resolved[] = substr($path, strlen($root) + 1);
      }
    }
    return $resolved;
  }

  /**
   * The repository root: the nearest ancestor holding the phpunit config.
   *
   * Walked up from __DIR__, so this test keeps working wherever it is moved to.
   */
  private function repositoryRoot(): string {
    for ($directory = __DIR__; $directory !== dirname($directory); $directory = dirname($directory)) {
      if (file_exists("$directory/phpunit.xml.dist")) {
        return $directory;
      }
    }
    $this->fail('No phpunit.xml.dist in any ancestor of ' . __DIR__ . '.');
  }

}
