<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_collab_api\Functional;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_space_access\SpaceAccessPolicy;
use Drupal\Tests\BrowserTestBase;
use Drupal\Tests\openkb_agent\Traits\CollabClientTrait;
use GuzzleHttp\RequestOptions;
use Psr\Http\Message\ResponseInterface;

/**
 * Agent-token writes to the commit route, over real OAuth.
 *
 * An agent's checkpoint is a forward draft in every space, whatever that
 * space asks of review — the live page never moves on it. The cookie-carried
 * policy cases live in the kernel twin
 * (\Drupal\Tests\openkb_collab_api\Kernel\SpaceModerationCommitTest).
 *
 * @group openkb_collab_api
 */
final class SpaceModerationCommitTest extends BrowserTestBase {

  use CollabClientTrait;

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
    // The recipe grants media permissions to authenticated; core media must be
    // enabled for recipeGrantedPermissions('authenticated') to resolve them.
    'media',
    // The recipe grants 'create url aliases' (in-app creation writes the
    // page's alias); path defines it, so it must be enabled for
    // recipeGrantedPermissions('authenticated') to resolve.
    'path',
    'workflows',
    'content_moderation',
    'jsonapi',
    'serialization',
    'basic_auth',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'openkb_agent',
    'openkb_workflow',
    'openkb_collab_api',
    'openkb_space',
    'openkb_space_access',
  ];

  /**
   * {@inheritdoc}
   */
  protected $defaultTheme = 'stark';

  /**
   * A space that asks for no review of its own.
   */
  private SpaceInterface $wiki;

  /**
   * On the space's roster; the account the agent statement credits.
   */
  private AccountInterface $editor;

  /**
   * The account the collaboration client's checkpoints act as.
   */
  private AccountInterface $collabServer;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    // The review sidecar, so an agent write raises its step and the wiki-space
    // agent-draft policy has something to read.
    $this->importRecipeConfig($this->kbReviewConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    // Moderation depends on the kb_page node type existing first.
    $this->importRecipeConfig($this->kbModerationConfigNames());
    // The collaboration client's identity, which its checkpoints arrive on.
    $this->importRecipeConfig($this->collabClientConfigNames());
    $this->setUpKeys();
    $this->config('jsonapi.settings')->set('read_only', FALSE)->save();
    $this->rebuildAll();

    $this->editor = $this->drupalCreateUser($this->recipeGrantedPermissions('authenticated'));
    // The account the collaboration client acts as. Access only — what makes
    // its statement worth reading is the connection (ADR 0001).
    $this->collabServer = $this->drupalCreateUser([
      ...$this->recipeGrantedPermissions('authenticated'),
      SpaceAccessPolicy::COLLABORATION,
    ]);
    $this->wiki = $this->createSpace('Scratchpad', FALSE);
  }

  /**
   * A wiki space still holds an agent write back for review (ADR 0003).
   *
   * A wiki space asks for no review — except of text an agent wrote,
   * while the space keeps the agent step on (its default). The write lands as a
   * forward draft — the live page does not move — until a human signs it off.
   * The signal is the witnessed writer set, not the carrier: the same editor
   * cookie carries it.
   */
  public function testWikiSpaceDraftsAnAgentWrite(): void {
    $page = $this->createPublishedPage($this->wiki);
    $published_vid = $page->getRevisionId();

    $response = $this->writeAgentCheckpoint($page, 'Agent draft. {#b-1}', 'b-1');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
    $this->assertSame(
      'draft',
      Json::decode((string) $response->getBody())['data']['attributes']['moderation_state'],
    );

    // The live page has not moved: the agent text is a draft awaiting review.
    $default = $this->reload($page);
    $this->assertTrue($default->isPublished());
    $this->assertSame('Published body.', $default->get('field_kb_body')->value);
    $this->assertSame($published_vid, $default->getRevisionId());
  }

  /**
   * The agent-review knob never decides the landing state.
   *
   * With the step off the agent's write needs no approval — but it still
   * lands as a draft: nothing publishes unless somebody asked (ADR 0003),
   * and an agent's content write asks for nothing.
   */
  public function testAgentWriteDraftsEvenWithReviewOff(): void {
    $this->wiki->set('field_agent_review', 0)->save();
    $page = $this->createPublishedPage($this->wiki);
    $published_vid = $page->getRevisionId();

    $response = $this->writeAgentCheckpoint($page, 'Agent text. {#b-1}', 'b-1');
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
    $this->assertSame(
      'draft',
      Json::decode((string) $response->getBody())['data']['attributes']['moderation_state'],
    );

    $default = $this->reload($page);
    $this->assertSame($published_vid, $default->getRevisionId(), 'The live revision held.');
    $this->assertStringNotContainsString('Agent text.', (string) $default->get('field_kb_body')->value);
  }

  /**
   * Creates a space with the test editor on its roster.
   */
  private function createSpace(string $name, bool $moderated): SpaceInterface {
    $space = Space::create([
      'label' => $name,
      'read_access' => 'all_users',
      'field_moderation' => $moderated ? 1 : 0,
      'managers' => [['target_id' => $this->editor->id()]],
    ]);
    $space->save();
    return $space;
  }

  /**
   * Builds a Published page in a space, seeded past validation.
   */
  private function createPublishedPage(SpaceInterface $space): NodeInterface {
    return $this->createPage($space, 'published');
  }

  /**
   * Builds a page in a space, in the given state.
   *
   * Direct ->save() skips entity validation, so seeding needs no transition
   * permission — the permissions under test are the request's, not the
   * fixture's.
   */
  private function createPage(SpaceInterface $space, string $state): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Space page',
      'uid' => $this->editor->id(),
      'moderation_state' => $state,
      'field_space' => ['target_id' => $space->id()],
      'field_kb_body' => ['value' => 'Published body.', 'format' => 'comark'],
    ]);
    $page->save();
    return $page;
  }

  /**
   * Sends a checkpoint whose witnessed writer set names an agent.
   *
   * On the collaboration client's own connection — the only one Drupal reads a
   * statement on (ADR 0001) — carrying a `session` block that says the editor
   * wrote the block via an agent. That `via` entry is what raises the agent
   * step, and the account carrying the write is not the editor at all, so this
   * pins that the state decision reads the witnessed set rather than the
   * caller.
   *
   * @param \Drupal\node\NodeInterface $page
   *   The page to write to.
   * @param string $body
   *   The comark body to write, carrying the block id.
   * @param string $block_id
   *   The id of the block the statement credits.
   *
   * @return \Psr\Http\Message\ResponseInterface
   *   The raw response.
   */
  private function writeAgentCheckpoint(NodeInterface $page, string $body, string $block_id): ResponseInterface {
    return $this->getHttpClient()->post(
      $this->buildUrl('/openkb/node/' . $page->id() . '/commit'),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::HEADERS => [
          'Content-Type' => 'application/json',
        ] + $this->collabBearerOverHttp($this->collabServer),
        RequestOptions::JSON => [
          'attributes' => ['field_kb_body' => ['value' => $body, 'format' => 'comark']],
          'session' => [
            'blocks' => [$block_id => [['uid' => (int) $this->editor->id(), 'via' => 'Claude']]],
          ],
        ],
      ]
    );
  }

  /**
   * Re-reads the page's default revision from storage.
   */
  private function reload(NodeInterface $page): NodeInterface {
    /** @var \Drupal\node\NodeStorageInterface $storage */
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache();
    /** @var \Drupal\node\NodeInterface $node */
    $node = $storage->load($page->id());
    return $node;
  }

}
