<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\openkb_space\Entity\Space;
use Drupal\path_alias\Entity\PathAlias;

/**
 * The space's alias: the one slug, and the rule that keeps it free.
 *
 * The alias is what the frontend links to and what the page pattern nests
 * under, so a taken URL is refused rather than numbered. A name a page of the
 * site itself answers at is `SpaceReservedNameTest`.
 *
 * @group openkb_space
 */
final class SpaceAliasTest extends KernelTestBase {

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
   * A space is reachable at its cleaned name, and a rename moves it.
   */
  public function testTheLabelIsTheAlias(): void {
    $space = Space::create(['label' => 'Team Wiki']);
    $space->save();
    $this->assertSame('/team-wiki', $this->alias($space));

    $space->set('label', 'Product Handbook')->save();
    $this->assertSame('/product-handbook', $this->alias($space));
  }

  /**
   * The slug the payloads carry is the stored alias, cleaning and all.
   *
   * Every surface reads this one value, so no two can disagree on a label.
   *
   * @dataProvider labels
   */
  public function testTheSlugIsTheAliasLastSegment(string $label, string $slug): void {
    $space = Space::create(['label' => $label]);
    // The order a JSON:API create runs in: the slug is read before the alias
    // exists, and has to answer the saved one afterwards.
    $this->assertCount(0, $space->validate());
    $this->assertSame('', $space->getSlug());
    $space->save();

    $this->assertSame('/' . $slug, $this->alias($space));
    $this->assertSame($slug, $space->getSlug());
  }

  /**
   * Names the slug has to clean.
   */
  public static function labels(): array {
    return [
      'plain' => ['Team Wiki', 'team-wiki'],
      'punctuation' => ['Product & Design!', 'product-design'],
      'umlauts' => ['Bücherei Österreich', 'bucherei-osterreich'],
      'slashes' => ['Legal / Compliance', 'legal-compliance'],
    ];
  }

  /**
   * A name whose alias another space already answers to is refused.
   */
  public function testAnAliasTakenByAnotherSpaceIsRefused(): void {
    Space::create(['label' => 'Secret Ops'])->save();

    // Not merely the same name: the alias is the name cleaned, so anything
    // that cleans alike is the same URL.
    foreach (['Secret Ops', 'secret ops', 'Secret — Ops!'] as $label) {
      $violations = Space::create(['label' => $label])->validate();
      $this->assertCount(1, $violations, "expected $label to be refused");
      $this->assertSame('label', $violations->get(0)->getPropertyPath());
      $this->assertStringContainsString('/secret-ops', (string) $violations->get(0)->getMessage());
    }

    $this->assertCount(0, Space::create(['label' => 'Product'])->validate());
  }

  /**
   * A name whose alias anything else answers to is refused.
   */
  public function testAnAliasTakenByAnExistingPageIsRefused(): void {
    PathAlias::create(['path' => '/node/1', 'alias' => '/handbook'])->save();

    $violations = Space::create(['label' => 'Handbook'])->validate();
    $this->assertCount(1, $violations);
    $this->assertSame('label', $violations->get(0)->getPropertyPath());
  }

  /**
   * A space keeps its own alias; renaming onto a taken one is refused.
   */
  public function testRenameOntoTakenAliasIsRefused(): void {
    $wiki = Space::create(['label' => 'Team Wiki']);
    $wiki->save();
    Space::create(['label' => 'Product'])->save();

    $this->assertCount(0, $wiki->validate());

    $wiki->set('label', 'Product');
    $violations = $wiki->validate();
    $this->assertCount(1, $violations);
    $this->assertSame('label', $violations->get(0)->getPropertyPath());
  }

  /**
   * A space's own alias is no page it covers, so a re-save passes.
   */
  public function testSpaceKeepsItsOwnAliasOnResave(): void {
    $space = Space::create(['label' => 'Team Wiki']);
    $space->save();

    $this->assertCount(0, $space->validate());
    $space->set('label', 'Team Wiki')->save();
    $this->assertSame('/team-wiki', $this->alias($space));
  }

  /**
   * A name that leaves no URL behind is refused on the name.
   */
  public function testNameThatCleansToNothingIsRefused(): void {
    $violations = Space::create(['label' => '!!!'])->validate();

    $this->assertCount(1, $violations);
    $this->assertSame('label', $violations->get(0)->getPropertyPath());
    $this->assertStringContainsString('gives no URL', (string) $violations->get(0)->getMessage());

    // Saved past validation it gets no alias, rather than claiming the root.
    $space = Space::create(['label' => '!!!']);
    $space->save();
    $this->assertSame('', $space->getSlug());
    $this->assertSame('/openkb-space/' . $space->id(), $this->alias($space));
  }

  /**
   * Nothing is ever parked under a numbered variant.
   */
  public function testTakenNameSavedAnywayDoesNotSuffix(): void {
    $first = Space::create(['label' => 'Team Wiki']);
    $first->save();
    $second = Space::create(['label' => 'Team Wiki']);

    $this->assertCount(1, $second->validate());

    // Saved past validation it writes the same URL rather than a numbered
    // variant of it — refusing a taken URL is validation's job.
    $second->save();
    $this->assertSame('/team-wiki', $this->alias($first));
    $this->assertSame('/team-wiki', $this->alias($second));
  }

  /**
   * The alias the storage holds for a space's canonical path.
   */
  private function alias(Space $space): string {
    return $this->container->get('path_alias.manager')
      ->getAliasByPath('/openkb-space/' . $space->id());
  }

}
