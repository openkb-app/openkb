<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_revision\Functional;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\Tests\BrowserTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use GuzzleHttp\RequestOptions;

/**
 * The one history fact only a real commit can make.
 *
 * The list, its order, its markers and who may read it are the commit-less
 * half of this history, seeded with ->save() and asserted in a kernel test
 * (\Drupal\Tests\openkb_revision\Kernel\NodeRevisionHistoryTest). What stays
 * here is the row a plain save cannot produce: publishing an already-published
 * page writes a revision no stored field can tell from its parent, and the
 * commit route marks it *Live* so the list does not drop it. That marking is
 * the commit route's own doing, over its session-cookie + CSRF carrier, so it
 * is a browser test.
 *
 * @group openkb_revision
 * @see \Drupal\Tests\openkb_revision\Kernel\NodeRevisionHistoryTest
 */
final class NodeRevisionHistoryTest extends BrowserTestBase {

  use RecipeConfigTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'node',
    'field',
    'text',
    'filter',
    'options',
    'taxonomy',
    'media',
    'path',
    'workflows',
    'content_moderation',
    'jsonapi',
    'serialization',
    'basic_auth',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    // The response is assembled by the CE renderer, not by this module — so the
    // test asks for it the way the frontend does rather than asserting on a
    // CustomElement object no consumer ever sees.
    'metatag',
    'custom_elements',
    'lupus_ce_renderer',
    'openkb_agent',
    'openkb_workflow',
    // The Live marker asserted here is written by the commit route.
    'openkb_schema',
    'openkb_collab_api',
    'openkb_revision',
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
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->importRecipeConfig($this->kbModerationConfigNames());
    $this->rebuildAll();
  }

  /**
   * A commit that moved nothing at all is still a row — and it is the live one.
   *
   * Publishing an already-published page writes a revision no stored field
   * can tell from its parent (`moderation_state` is computed), and core leaves
   * such a revision out of every history. That revision is the default one, so
   * without the commit route marking it the list drops the row carrying *Live*
   * — the one fact the page exists to show.
   */
  public function testCommitThatMovedNothingKeepsTheLiveRevision(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'published', 'First cut.');

    $response = $this->commit($page, $editor, ['moderation_state' => 'published']);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());

    $content = $this->readHistory($page, $editor);

    $this->assertSame(2, $content['props']['total']);
    $live = $content['slots']['revisions'][0];
    $this->assertTrue($live['props']['current']);
    $this->assertTrue($live['props']['published']);
    // And it is the only one: the revision it superseded published nothing any
    // more, so the mark stays on one row.
    $this->assertFalse($content['slots']['revisions'][1]['props']['published']);
  }

  /**
   * A user carrying exactly the recipe's authenticated grants.
   */
  private function createEditor(): AccountInterface {
    return $this->drupalCreateUser($this->recipeGrantedPermissions('authenticated'));
  }

  /**
   * Builds a page, seeded past validation.
   *
   * Direct ->save() skips entity validation, so seeding needs no transition
   * permission — the permissions under test are the reader's.
   */
  private function createPage(string|int $uid, string $state, string $log): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Space page',
      'uid' => $uid,
      'moderation_state' => $state,
      'field_kb_body' => ['value' => 'Body.', 'format' => 'comark'],
      'revision_uid' => $uid,
      'revision_log' => $log,
    ]);
    $page->save();
    return $page;
  }

  /**
   * Writes one revision the way the app writes them: the commit route.
   *
   * Its carrier is the editing session's cookie plus the session CSRF token,
   * the only write authentication the route takes.
   */
  private function commit(NodeInterface $page, AccountInterface $user, array $attributes) {
    $this->drupalLogin($user);
    return $this->getHttpClient()->post(
      $this->buildUrl('/openkb/node/' . $page->id() . '/commit'),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::COOKIES => $this->getSessionCookies(),
        RequestOptions::HEADERS => [
          'Content-Type' => 'application/json',
          'X-CSRF-Token' => $this->drupalGet('session/token'),
        ],
        RequestOptions::JSON => ['attributes' => $attributes],
      ]
    );
  }

  /**
   * Reads the history as the given user, asserting it was served.
   *
   * @return array
   *   The `content` half of the CE response.
   */
  private function readHistory(NodeInterface $page, AccountInterface $user): array {
    $this->drupalLogin($user);
    $response = $this->getHttpClient()->get(
      $this->buildUrl('/node/' . $page->id() . '/revisions', [
        'query' => [
          '_format' => 'custom_elements',
          '_content_format' => 'json',
        ],
      ]),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::COOKIES => $this->getSessionCookies(),
      ]
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
    return Json::decode((string) $response->getBody())['content'];
  }

}
