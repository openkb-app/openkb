<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space_access\Functional;

use Drupal\Tests\BrowserTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\openkb_space\Entity\Space;

/**
 * A space collection is answered per reader, cache or no cache.
 *
 * The collection is narrowed in SQL by
 * openkb_space_access_query_openkb_space_access_alter(), which has nowhere to
 * put cacheability, and the per-space access results that would carry it are
 * absent when the narrowing leaves nothing. The account variance therefore has
 * to be declared on the collection itself, or a reader with no spaces poisons
 * the cache for everyone.
 *
 * @group openkb_space_access
 */
final class SpaceCollectionCacheTest extends BrowserTestBase {

  use RecipeConfigTrait;

  /**
   * The collection URL both accounts ask for — identical, or they never share.
   */
  private const COLLECTION = '/jsonapi/openkb_space/openkb_space';

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'node',
    'field',
    'text',
    'filter',
    'options',
    'path',
    'openkb_space',
    'serialization',
    'jsonapi',
    // The cache the bug lived in: without it nothing is stored and every read
    // recomputes, which is precisely the state the test must not rely on.
    'dynamic_page_cache',
    'openkb_space_access',
  ];

  /**
   * {@inheritdoc}
   */
  protected $defaultTheme = 'stark';

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig([
      'field.storage.openkb_space.field_moderation',
      'field.field.openkb_space.openkb_space.field_moderation',
    ]);
    $this->rebuildAll();
  }

  /**
   * A member reads their spaces after an anonymous request cached the answer.
   */
  public function testAnonymousReadDoesNotBlankTheMemberCollection(): void {
    $member = $this->drupalCreateUser();
    $space = Space::create([
      'label' => 'Product Handbook',
      'read_access' => 'members_only',
      'members' => [['target_id' => $member->id()]],
    ]);
    $space->save();

    // A logged-out visitor asks first — the request that poisoned the entry.
    $this->drupalGet(self::COLLECTION);
    $this->assertSession()->statusCodeEquals(200);
    $this->assertStringNotContainsString('Product Handbook', $this->getSession()->getPage()->getContent());

    // The member asks the same question and gets their own answer.
    $this->drupalLogin($member);
    $this->drupalGet(self::COLLECTION);
    $this->assertSession()->statusCodeEquals(200);
    $this->assertStringContainsString('Product Handbook', $this->getSession()->getPage()->getContent());
  }

  /**
   * Two accounts alike in roles but not in rosters do not share an answer.
   */
  public function testRostersSeparateAccountsOfEqualPermissions(): void {
    $insider = $this->drupalCreateUser();
    $outsider = $this->drupalCreateUser();
    $space = Space::create([
      'label' => 'Team Wiki',
      'read_access' => 'members_only',
      'members' => [['target_id' => $insider->id()]],
    ]);
    $space->save();

    $this->drupalLogin($outsider);
    $this->drupalGet(self::COLLECTION);
    $this->assertStringNotContainsString('Team Wiki', $this->getSession()->getPage()->getContent());

    $this->drupalLogin($insider);
    $this->drupalGet(self::COLLECTION);
    $this->assertStringContainsString('Team Wiki', $this->getSession()->getPage()->getContent());
  }

}
