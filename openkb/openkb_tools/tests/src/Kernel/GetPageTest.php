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
use Drupal\openkb_space\SpaceInterface;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use Mcp\Schema\JsonRpc\Response;

/**
 * Reading the published knowledge base, driven through Drupal's MCP endpoint.
 *
 * The tool answers under the wire name its shipped `mcp_tool_config` entity
 * gives it, `tool_api__get_page`, and its result rides in the bridge's
 * {success, message, data} envelope.
 *
 * What is under test is the read's boundary rather than its plumbing: it
 * serves the published revision and never the working copy, it answers the
 * `.md` wire format off the exposure contract rather than a field list, and it
 * serves neither `versions` nor `status` — the two things only an edit needs.
 * The `versions` case is the load-bearing one: a version is the hash of a
 * block's canonical markdown, Drupal stores whatever was written to it, and
 * {@see self::testStoredBodyIsNotWhatTheWriteSideWouldHash()} shows the two
 * disagreeing on a body Drupal itself seeds.
 *
 * @group openkb_tools
 */
final class GetPageTest extends KernelTestBase {

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
   * On the open space's member roster, and on no other.
   */
  private UserInterface $editor;

  /**
   * The space everyone signed in may read.
   */
  private SpaceInterface $open;

  /**
   * The published page in the open space.
   */
  private NodeInterface $page;

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

    // The editor's member seat on the space below is what grants the read of
    // the unpublished page, so the refusal under test is about publication,
    // not about access.
    $role = Role::create(['id' => 'kb_user', 'label' => 'KB user']);
    foreach ([
      'access content',
      'use text format comark',
    ] as $permission) {
      $role->grantPermission($permission);
    }
    $role->save();

    $this->editor = User::create(['name' => 'editor', 'status' => 1]);
    $this->editor->addRole($role->id());
    $this->editor->save();

    $this->open = Space::create([
      'label' => 'Team Wiki',
      'read_access' => 'all_users',
      'field_moderation' => FALSE,
      'members' => [['target_id' => $this->editor->id()]],
    ]);
    $this->open->save();

    $this->page = $this->page('Getting Started', $this->open, <<<'MD'
    # Getting Started {#b-title}

    The wiki everybody starts at. {#b-intro}

    ## Where things live {#b-heading}
    MD);
  }

  /**
   * The published page, as the `.md` wire format.
   *
   * The projection is the exposure contract's, in display order, and the
   * markdown carries the same values above the body — with the body's leading
   * `# ` heading gone, because the title is the page's own field.
   */
  public function testServesThePublishedPageAsTheWireFormat(): void {
    $this->setCurrentUser($this->editor);
    $page = $this->getPage('team-wiki/getting-started');

    $this->assertSame('/team-wiki/getting-started', $page['path']);
    $this->assertSame('Getting Started', $page['title']);
    $this->assertSame(
      ['type', 'summary', 'owner', 'contributors', 'tags'],
      array_keys($page['frontmatter']),
      'Frontmatter follows the form display, in its order.',
    );
    $this->assertSame('guide', $page['frontmatter']['type']);
    $this->assertSame('Where a new joiner starts.', $page['frontmatter']['summary']);
    $this->assertSame(
      ['id' => $this->editor->uuid(), 'label' => 'editor'],
      $page['frontmatter']['owner'],
      'A reference is the {id, label} pair the wire format is made of.',
    );
    $this->assertSame([], $page['frontmatter']['contributors'], 'An empty multi-value field is a list.');

    $this->assertStringStartsWith("---\ntype: guide\n", $page['markdown']);
    $this->assertStringContainsString("\n---\n\nThe wiki everybody starts at. {#b-intro}", $page['markdown']);
    $this->assertStringNotContainsString('# Getting Started', $page['markdown']);
  }

  /**
   * A path anchored on a block reads the page the block sits in.
   *
   * `openkb_search_pages` cites a section by anchoring the page path on the
   * block it opens on, so that is the address an agent carries over from a
   * hit.
   */
  public function testAnAnchoredPathReadsThePage(): void {
    $this->setCurrentUser($this->editor);

    $this->assertSame(
      '/team-wiki/getting-started',
      $this->getPage('team-wiki/getting-started#b-intro')['path'],
    );
  }

  /**
   * The body reads as text, not as the serializer's entities (ADR 0014).
   *
   * The editor HTML-encodes `&`, `<` and `>` in every text node, so the stored
   * body carries the entities. A tool is where that spelling stops — code
   * excepted, which the serializer leaves verbatim.
   */
  public function testTheBodyIsHandedOverAsPlainCharacters(): void {
    $this->page->set('field_kb_body', [
      'value' => "# Getting Started {#b-title}\n\n"
      . "Wiki &amp; AI, 5 &lt; 6, &lt;span&gt;x&lt;/span&gt; {#b-intro}\n\n"
      . "```\ncode &amp; fence\n```\n",
      'format' => 'comark',
    ]);
    $this->page->save();

    $this->setCurrentUser($this->editor);
    $page = $this->getPage('team-wiki/getting-started');

    $this->assertStringContainsString(
      'Wiki & AI, 5 < 6, <span>x</span> {#b-intro}',
      $page['markdown'],
    );
    $this->assertStringContainsString(
      "```\ncode &amp; fence\n```",
      $page['markdown'],
      'Code is the serializer verbatim.',
    );
  }

  /**
   * The working copy is invisible here, however recent it is.
   *
   * The split OKB-174 draws: the working copy is the editing surface's, and
   * this tool has no input that would ask for it.
   */
  public function testTheWorkingCopyIsNeverServed(): void {
    $this->page->setNewRevision();
    $this->page->set('moderation_state', 'draft');
    $this->page->set('field_kb_body', [
      'value' => "Rewritten in the draft. {#b-intro}\n",
      'format' => 'comark',
    ]);
    $this->page->save();

    $this->setCurrentUser($this->editor);
    $page = $this->getPage('team-wiki/getting-started');

    $this->assertStringContainsString('The wiki everybody starts at.', $page['markdown']);
    $this->assertStringNotContainsString('Rewritten in the draft.', $page['markdown']);

    $tool = $this->tool($this->buildServer(), 'tool_api__get_page');
    $this->assertSame(['path'], array_keys($tool->inputSchema['properties']));
  }

  /**
   * A page with no published revision is reported as not found.
   */
  public function testPageWithNoPublishedRevisionIsNotFound(): void {
    $unpublished = $this->page('Not Ready Yet', $this->open, "A start. {#b-1}\n", 'draft');
    $this->setCurrentUser($this->editor);

    $refusal = $this->call($this->buildServer(), 'tool_api__get_page', [
      'path' => 'team-wiki/not-ready-yet',
    ]);
    $this->assertInstanceOf(Response::class, $refusal);
    $this->assertTrue($refusal->result->isError);
    $this->assertStringContainsString('No published page', $refusal->result->content[0]->text);
    $this->assertFalse($unpublished->isPublished());
  }

  /**
   * A space the caller is not on answers the same as a path nobody uses.
   *
   * Which of the two it is would say whether a page exists behind a space the
   * caller may not read.
   */
  public function testSpaceTheCallerCannotReadIsReportedAsNotFound(): void {
    $closed = Space::create([
      'label' => 'Secret Ops',
      'read_access' => 'members_only',
      'field_moderation' => FALSE,
    ]);
    $closed->save();
    $this->page('Runbook', $closed, "On-call steps. {#b-1}\n");

    $this->setCurrentUser($this->editor);
    foreach (['secret-ops/runbook', 'team-wiki/no-such-page'] as $path) {
      $refusal = $this->call($this->buildServer(), 'tool_api__get_page', ['path' => $path]);
      $this->assertInstanceOf(Response::class, $refusal);
      $this->assertTrue($refusal->result->isError, $path);
      $this->assertStringContainsString('No published page', $refusal->result->content[0]->text);
    }
  }

  /**
   * Neither `versions` nor `status` is served, and that is the design.
   *
   * A version is a write token and a status is the working copy's standing;
   * this read can precede neither a write nor a publish. Asserted on the
   * advertised output schema as well as on the result, so the omission is a
   * contract rather than a value that happened to be absent.
   */
  public function testServesNoWriteTokenAndNoEditorialStanding(): void {
    $this->setCurrentUser($this->editor);
    $tool = $this->tool($this->buildServer(), 'tool_api__get_page');

    $this->assertSame(
      ['path', 'title', 'title_block_id', 'frontmatter', 'markdown'],
      array_keys($tool->outputSchema['properties']['data']['properties']),
    );
    $this->assertTrue($tool->annotations->readOnlyHint);
    $this->assertTrue($tool->annotations->idempotentHint);
    $this->assertFalse($tool->annotations->destructiveHint);

    $page = $this->getPage('team-wiki/getting-started');
    $this->assertArrayNotHasKey('versions', $page);
    $this->assertArrayNotHasKey('status', $page);
  }

  /**
   * The descriptions separate what this read gives from what it does not.
   *
   * Block ids are in the markdown, so a model can name a block off this read
   * alone; the version that `expect` takes is not, and the description has to
   * say so and name the tool that answers it — an absent key teaches nothing.
   */
  public function testDescriptionsSeparateBlockIdsFromBlockVersions(): void {
    $this->setCurrentUser($this->editor);
    $tool = $this->tool($this->buildServer(), 'tool_api__get_page');

    $this->assertStringContainsString('no `versions` map', $tool->description);
    $this->assertStringContainsString('getPageForEditing', $tool->description);

    $markdown = $tool->outputSchema['properties']['data']['properties']['markdown'];
    $this->assertStringContainsString('{#b-', $markdown['description']);
    $this->assertStringContainsString('updateBlocks', $markdown['description']);
  }

  /**
   * Why no `versions`: what Drupal stores is not what a write would hash.
   *
   * A block version is the hash of the block's *canonical* markdown, and
   * canonical is what the frontend's comark serializer spells — there is no
   * such serializer in PHP (the `comark` module here indexes and searches, it
   * does not write markdown). Drupal stores whatever a write left, and its own
   * `tool_api__create_page` seeds a body whose first block is the title as a
   * `# ` heading. The write side drops that heading, so the block it carries
   * is not a block any write can name. Hashing the stored bytes here would
   * hand an agent an `expect` token for a block that does not exist on the
   * side that checks it.
   */
  public function testStoredBodyIsNotWhatTheWriteSideWouldHash(): void {
    $stored = (string) $this->page->get('field_kb_body')->value;
    $this->assertStringContainsString('{#b-title}', $stored, 'Drupal stores the title as a block.');

    $this->setCurrentUser($this->editor);
    $page = $this->getPage('team-wiki/getting-started');
    $this->assertStringNotContainsString(
      '{#b-title}',
      $page['markdown'],
      'The read drops it, so a version taken off the stored bytes would name a block nothing else has.',
    );
  }

  /**
   * The title heading's id is answered, though its line is not served.
   *
   * A `search_pages` hit on the page's lead section names that block, so an
   * agent has to be able to tell which block the citation meant.
   */
  public function testTheTitleBlockIdIsAnswered(): void {
    $this->setCurrentUser($this->editor);

    $this->assertSame('b-title', $this->getPage('team-wiki/getting-started')['title_block_id']);
  }

  /**
   * A title heading no write has spelled an id into answers none.
   */
  public function testTheTitleHeadingWithNoIdAnswersNoTitleBlock(): void {
    $this->page('Plain', $this->open, "# Plain\n\nStraight into it. {#b-first}");
    $this->setCurrentUser($this->editor);

    $page = $this->getPage('team-wiki/plain');
    $this->assertSame('', $page['title_block_id']);
    $this->assertStringNotContainsString('# Plain', $page['markdown']);
  }

  /**
   * A body that opens on a block of its own has no title block to answer.
   */
  public function testBodyWithNoTitleHeadingAnswersNoTitleBlock(): void {
    $this->page('Headless', $this->open, 'Straight into it. {#b-first}');
    $this->setCurrentUser($this->editor);

    $page = $this->getPage('team-wiki/headless');
    $this->assertSame('', $page['title_block_id']);
    $this->assertStringContainsString('Straight into it. {#b-first}', $page['markdown']);
  }

  /**
   * The projection follows the form display, with no field list in the tool.
   */
  public function testFrontmatterFollowsTheExposureContract(): void {
    $display = $this->container->get('entity_type.manager')
      ->getStorage('entity_form_display')
      ->load('node.kb_page.frontmatter');
    $display->removeComponent('field_tags')->save();

    $this->setCurrentUser($this->editor);
    $page = $this->getPage('team-wiki/getting-started');

    $this->assertSame(['type', 'summary', 'owner', 'contributors'], array_keys($page['frontmatter']));
    $this->assertStringNotContainsString('tags:', $page['markdown']);
  }

  /**
   * Calls the read tool and returns the payload under its envelope.
   *
   * @return array<string, mixed>
   *   The page.
   */
  private function getPage(string $path): array {
    $response = $this->call($this->buildServer(), 'tool_api__get_page', ['path' => $path]);
    $this->assertInstanceOf(Response::class, $response);
    $this->assertFalse(
      $response->result->isError,
      $response->result->isError ? $response->result->content[0]->text : '',
    );
    return $response->result->structuredContent['data'];
  }

  /**
   * Creates one page in a space.
   */
  private function page(string $title, SpaceInterface $space, string $body, string $state = 'published'): NodeInterface {
    $node = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'uid' => $this->editor->id(),
      'field_space' => ['target_id' => $space->id()],
      'field_type' => 'guide',
      'field_summary' => 'Where a new joiner starts.',
      'field_owner' => ['target_id' => $this->editor->id()],
      'field_kb_body' => ['value' => $body, 'format' => 'comark'],
      'moderation_state' => $state,
    ]);
    $node->save();
    return $node;
  }

}
