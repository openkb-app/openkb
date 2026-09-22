<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_tools\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\openkb_tools\SessionRelayModules;
use Drupal\Tests\openkb_tools\Traits\McpSurfaceTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use Mcp\Schema\JsonRpc\Response;

/**
 * Finding work in progress, driven through the MCP endpoint that serves it.
 *
 * The two kinds of unfinished work are what the tool exists for, and neither
 * is in the search index: a page nobody has published, and a published page
 * carrying a newer draft. Both are asserted here against real revisions, as is
 * the page that is finished and must not be answered.
 *
 * The gate is `update` per hit, so the roster decides the answer: an editor of
 * the space finds its drafts, a viewer of the same space finds none, and an
 * account on no roster finds none either.
 *
 * @group openkb_tools
 */
final class FindDraftsToolTest extends KernelTestBase {

  use McpSurfaceTrait;
  use RecipeConfigTrait;
  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected bool $usesSuperUserAccessPolicy = FALSE;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'filter',
    'text',
    'node',
    'options',
    'taxonomy',
    'path',
    'path_alias',
    'token',
    'pathauto',
    'workflows',
    'content_moderation',
    'openkb_schema',
    'openkb_space',
    'openkb_space_access',
    'mcp_server',
    'tool',
    'mcp_server_tool_bridge',
    'search_api',
    ...SessionRelayModules::OAUTH,
    'openkb_tools',
  ];

  /**
   * On the space's member roster: may edit its pages.
   */
  private UserInterface $editor;

  /**
   * On the same space's viewer roster: may read its pages and edit none.
   */
  private UserInterface $viewer;

  /**
   * On no roster at all.
   */
  private UserInterface $outsider;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('taxonomy_term');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('content_moderation_state');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['system', 'filter', 'node', 'pathauto', 'mcp_server']);

    $this->importRecipeConfig([
      ...$this->kbPageConfigNames(),
      ...$this->kbBodyConfigNames(),
      ...$this->kbSpaceConfigNames(),
      ...$this->kbModerationConfigNames(),
      'pathauto.pattern.kb_page',
      ...$this->mcpToolConfigNames(),
    ]);

    // User 1 is the superuser and bypasses everything; burn it on a
    // placeholder so no account under test inherits that.
    User::create(['name' => 'superuser'])->save();

    $editor = Role::create(['id' => 'kb_editor', 'label' => 'KB editor']);
    $editor->grantPermission('access content');
    $editor->grantPermission('edit any kb_page content');
    $editor->grantPermission('view any unpublished content');
    $editor->grantPermission('use text format comark');
    $editor->grantPermission('use editorial transition create_new_draft');
    $editor->save();

    $reader = Role::create(['id' => 'kb_reader', 'label' => 'KB reader']);
    $reader->grantPermission('access content');
    $reader->save();

    $this->editor = $this->userWithRole('editor', $editor->id());
    $this->viewer = $this->userWithRole('viewer', $reader->id());
    $this->outsider = $this->userWithRole('outsider', $reader->id());

    Space::create([
      'label' => 'Team Wiki',
      'read_access' => 'members_only',
      'field_moderation' => TRUE,
      'members' => [['target_id' => $this->editor->id()]],
      'viewers' => [['target_id' => $this->viewer->id()]],
    ])->save();

    Space::create([
      'label' => 'Open Notes',
      'read_access' => 'members_only',
      'field_moderation' => TRUE,
      'members' => [['target_id' => $this->editor->id()]],
    ])->save();
  }

  /**
   * Both kinds of unfinished work are answered; finished work is not.
   */
  public function testAnswersUnpublishedPagesAndForwardDrafts(): void {
    $this->page('Roadmap draft', 'Team Wiki', published: FALSE);
    $this->draftOver($this->page('Roadmap 2026', 'Team Wiki', published: TRUE));
    $this->page('Roadmap archive', 'Team Wiki', published: TRUE);

    $this->setCurrentUser($this->editor);
    $drafts = $this->findDrafts(['title' => 'Roadmap']);

    // Which pages are answered and as what, not in which order — the order is
    // testAnswersNewestFirst().
    $states = array_column($drafts, 'state', 'title');
    ksort($states);
    $this->assertSame(
      ['Roadmap 2026' => 'published-with-draft', 'Roadmap draft' => 'draft'],
      $states,
      'A published page whose newest revision is the published one is finished work.',
    );
    $hit = $drafts[array_search('Roadmap draft', array_column($drafts, 'title'), TRUE)];
    $this->assertSame(
      ['path', 'title', 'space', 'state', 'changed', 'author'],
      array_keys($hit),
    );
    $this->assertSame('/team-wiki/roadmap-draft', $hit['path']);
    $this->assertSame('team-wiki', $hit['space']);
    $this->assertSame('editor', $hit['author']);
    $this->assertNotSame('', $hit['changed']);
  }

  /**
   * The title matched is the newest revision's, not the published one's.
   */
  public function testMatchesTheTitleTheDraftCarries(): void {
    $node = $this->page('Old name', 'Team Wiki', published: TRUE);
    $this->draftOver($node, 'Renamed in the draft');

    $this->setCurrentUser($this->editor);

    $this->assertSame(
      ['Renamed in the draft'],
      array_column($this->findDrafts(['title' => 'Renamed']), 'title'),
    );
    $this->assertSame([], $this->findDrafts(['title' => 'Old name']));
  }

  /**
   * A space narrows the answer to the pages inside it.
   */
  public function testTheSpaceNarrowsTheAnswer(): void {
    $this->page('Onboarding notes', 'Team Wiki', published: FALSE);
    $this->page('Onboarding plan', 'Open Notes', published: FALSE);

    $this->setCurrentUser($this->editor);

    $this->assertSame(
      ['Onboarding plan'],
      array_column($this->findDrafts(['title' => 'Onboarding', 'space' => 'open-notes']), 'title'),
    );
    $this->assertCount(2, $this->findDrafts(['title' => 'Onboarding']));
  }

  /**
   * The space narrows in the query, so its drafts survive the cap.
   *
   * More drafts than one call answers, all newer, all in the other space: a
   * filter applied to the answered page instead of to the query would report
   * the Open Notes draft as not existing.
   */
  public function testTheSpaceNarrowsBeforeTheCap(): void {
    $buried = $this->page('Onboarding plan', 'Open Notes', published: FALSE);
    $this->changedAt($buried, 1000);
    for ($i = 0; $i < 21; $i++) {
      $this->changedAt($this->page("Onboarding note $i", 'Team Wiki', published: FALSE), 2000 + $i);
    }

    $this->setCurrentUser($this->editor);

    $this->assertSame(
      ['Onboarding plan'],
      array_column($this->findDrafts(['title' => 'Onboarding', 'space' => 'open-notes']), 'title'),
    );
  }

  /**
   * A slug no space carries is refused by name, not answered as "none".
   */
  public function testAnUnknownSpaceIsRefused(): void {
    $this->page('Onboarding notes', 'Team Wiki', published: FALSE);
    $this->setCurrentUser($this->editor);

    $response = $this->call($this->buildServer(), 'tool_api__find_drafts', [
      'title' => 'Onboarding',
      'space' => 'no-such-space',
    ]);
    $this->assertInstanceOf(Response::class, $response);
    $this->assertTrue($response->result->isError);
    $this->assertStringContainsString('No space "no-such-space"', $response->result->content[0]->text);
  }

  /**
   * The newest draft comes first.
   */
  public function testAnswersNewestFirst(): void {
    $this->changedAt($this->page('Release oldest', 'Team Wiki', published: FALSE), 1000);
    $this->changedAt($this->page('Release middle', 'Team Wiki', published: FALSE), 3000);
    $this->changedAt($this->page('Release newest', 'Team Wiki', published: FALSE), 5000);

    $this->setCurrentUser($this->editor);

    $this->assertSame(
      ['Release newest', 'Release middle', 'Release oldest'],
      array_column($this->findDrafts(['title' => 'Release']), 'title'),
    );
  }

  /**
   * Drafts written in the same second still come back in one fixed order.
   */
  public function testDraftsTiedOnTheChangedTimeAreOrderedByRevision(): void {
    $this->changedAt($this->page('Tied first', 'Team Wiki', published: FALSE), 4000);
    $this->changedAt($this->page('Tied second', 'Team Wiki', published: FALSE), 4000);
    $this->changedAt($this->page('Tied third', 'Team Wiki', published: FALSE), 4000);

    $this->setCurrentUser($this->editor);

    $this->assertSame(
      ['Tied third', 'Tied second', 'Tied first'],
      array_column($this->findDrafts(['title' => 'Tied']), 'title'),
    );
  }

  /**
   * Only pages the caller may edit are answered.
   *
   * The viewer reads the space and writes nothing in it; the outsider holds no
   * seat at all. Neither is told a draft exists — and the published page with a
   * draft on it is the load-bearing case: the viewer may read that one, so the
   * `update` gate is the only thing keeping it out of the answer.
   */
  public function testAnswersOnlyPagesTheCallerMayEdit(): void {
    $this->page('Roadmap draft', 'Team Wiki', published: FALSE);
    $this->draftOver($this->page('Roadmap 2026', 'Team Wiki', published: TRUE));

    foreach (['viewer' => $this->viewer, 'outsider' => $this->outsider] as $who => $account) {
      $this->setCurrentUser($account);
      $this->assertSame([], $this->findDrafts(['title' => 'Roadmap']), $who);
    }
  }

  /**
   * The tool is advertised with the schemas and hints clients read.
   */
  public function testIsAdvertisedWithSchemasAndHints(): void {
    $this->setCurrentUser($this->editor);
    $tool = $this->tool($this->buildServer(), 'tool_api__find_drafts');

    $this->assertSame(['title', 'space'], array_keys($tool->inputSchema['properties']));
    $this->assertSame(['title'], $tool->inputSchema['required']);
    $this->assertTrue($tool->annotations->readOnlyHint);
  }

  /**
   * Calls the tool and returns the hits under the bridge's envelope.
   *
   * @return array<int, array<string, string>>
   *   The drafts.
   */
  private function findDrafts(array $arguments): array {
    $response = $this->call($this->buildServer(), 'tool_api__find_drafts', $arguments);
    $this->assertInstanceOf(Response::class, $response);
    $this->assertFalse(
      $response->result->isError,
      $response->result->isError ? $response->result->content[0]->text : '',
    );
    return $response->result->structuredContent['data']['drafts'];
  }

  /**
   * One page in a space, published or not.
   */
  private function page(string $title, string $space, bool $published): NodeInterface {
    $spaces = $this->container->get('entity_type.manager')->getStorage('openkb_space')
      ->loadByProperties(['label' => $space]);
    $node = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'uid' => $this->editor->id(),
      'field_space' => ['target_id' => reset($spaces)->id()],
      'field_kb_body' => ['value' => "# $title\n\nA body. {#b-seed}\n"],
      'moderation_state' => $published ? 'published' : 'draft',
    ]);
    $node->setRevisionUserId($this->editor->id());
    $node->save();
    return $node;
  }

  /**
   * Stamps a node's newest revision with a changed time.
   */
  private function changedAt(NodeInterface $node, int $timestamp): void {
    $node->setChangedTime($timestamp);
    $node->setNewRevision(FALSE);
    $node->save();
  }

  /**
   * A draft revision on top of a published page, leaving it published.
   */
  private function draftOver(NodeInterface $node, ?string $title = NULL): void {
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    // Not the loaded object: content_moderation asks storage for the default
    // revision, and mutating this one in place would unpublish the live page.
    $draft = $storage->createRevision($node, FALSE);
    if ($title !== NULL) {
      $draft->setTitle($title);
    }
    $draft->set('moderation_state', 'draft');
    $draft->setRevisionUserId($this->editor->id());
    $draft->save();
  }

  /**
   * A user holding one role.
   */
  private function userWithRole(string $name, string $role): UserInterface {
    $user = User::create(['name' => $name, 'status' => 1]);
    $user->addRole($role);
    $user->save();
    return $user;
  }

}
