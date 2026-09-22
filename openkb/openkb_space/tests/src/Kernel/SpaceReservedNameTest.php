<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_space\Entity\Space;

/**
 * No space can take a page of the site over.
 *
 * A space's name is its URL, so a name that cleans to a path the site already
 * answers at would serve the space instead. Drupal's own routes are asked of
 * the router; the frontend's are a list, and this holds that list to the
 * routes the frontend ships.
 *
 * @group openkb_space
 */
final class SpaceReservedNameTest extends KernelTestBase {

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
   * Every top-level path the frontend serves is refused as a space name.
   *
   * @dataProvider frontendRoutes
   */
  public function testFrontendRouteIsRefused(string $segment): void {
    $violations = Space::create(['label' => $segment])->validate();

    $this->assertCount(1, $violations, "expected /$segment to be refused");
    $this->assertSame('label', $violations->get(0)->getPropertyPath());
    $this->assertStringContainsString('reserved for a system page', (string) $violations->get(0)->getMessage());
  }

  /**
   * The first path segment of every Nuxt page and Nitro route.
   */
  public static function frontendRoutes(): array {
    $segments = [];
    foreach (['frontend/app/pages', 'frontend/server/routes'] as $dir) {
      foreach (scandir(dirname(DRUPAL_ROOT) . '/' . $dir) ?: [] as $entry) {
        // A catch-all or a dynamic segment answers at no fixed path.
        if (str_starts_with($entry, '.') || str_starts_with($entry, '[')) {
          continue;
        }
        $segment = explode('.', $entry)[0];
        if ($segment !== 'index') {
          $segments[$segment] = [$segment];
        }
      }
    }
    // A scan that found nothing would pass every assertion below it.
    if (count($segments) < 10) {
      throw new \RuntimeException('The frontend route scan came up short: ' . count($segments));
    }
    return $segments;
  }

  /**
   * A Drupal route is refused without being listed anywhere.
   */
  public function testDrupalRouteIsRefused(): void {
    // `/admin` is on no list; the router is what refuses it.
    $violations = Space::create(['label' => 'Admin'])->validate();

    $this->assertCount(1, $violations);
    $this->assertSame('label', $violations->get(0)->getPropertyPath());
    $this->assertStringContainsString('reserved for a system page', (string) $violations->get(0)->getMessage());
  }

  /**
   * The word that stands for every space is no space's name.
   *
   * The chat's scope travels as a slug or `all`, so a space at `/all` would be
   * offered as the whole knowledge base and widen what it was picked to narrow.
   */
  public function testEverySpaceWordIsRefused(): void {
    $violations = Space::create(['label' => 'All'])->validate();

    $this->assertCount(1, $violations);
    $this->assertSame('label', $violations->get(0)->getPropertyPath());
  }

  /**
   * A name no page of the site answers at is free.
   */
  public function testAnOrdinaryNameIsFree(): void {
    $this->assertCount(0, Space::create(['label' => 'Team Wiki'])->validate());
  }

}
