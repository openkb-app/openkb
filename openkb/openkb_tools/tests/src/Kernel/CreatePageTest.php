<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_tools\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\field\Entity\FieldConfig;
use Drupal\filter\Entity\FilterFormat;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\openkb_tools\SessionRelayModules;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\node\Entity\Node;
use Drupal\openkb_space\Entity\Space;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use Mcp\Schema\JsonRpc\Error;
use Mcp\Schema\JsonRpc\Response;
use Mcp\Schema\Request\CallToolRequest;
use Mcp\Schema\Request\ListToolsRequest;
use Mcp\Server;
use Mcp\Server\Handler\Request\CallToolHandler;
use Mcp\Server\Handler\Request\ListToolsHandler;
use Mcp\Server\Session\SessionInterface;

/**
 * Creating a page, driven through the MCP endpoint that serves it.
 *
 * The tool is a Tool API plugin carried to /mcp by `mcp_server_tool_bridge`,
 * so it answers under the wire name the shipped `mcp_tool_config` entity gives
 * it, `tool_api__create_page`, and its result rides in the bridge's
 * {success, message, data} envelope.
 *
 * The properties under test are the ones a caller cannot check for itself: that
 * the write gate is the same map the space listing answers from, that the page
 * lands
 * unpublished whatever the space's moderation policy says, and that the path it
 * reports is the one actually generated.
 *
 * The scope gate is tested as the permission it names: `agent:write:create`
 * carries `create kb_page content` and nothing else, so an account without
 * that permission is exactly a token without the scope.
 *
 * @group openkb_tools
 */
final class CreatePageTest extends KernelTestBase {

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
   * On the moderated space's member roster.
   */
  private UserInterface $author;

  /**
   * On the same rosters, but holding no create permission.
   */
  private UserInterface $reader;

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

    $author = Role::create(['id' => 'kb_author', 'label' => 'KB author']);
    $author->grantPermission('access content');
    $author->grantPermission('create kb_page content');
    $author->grantPermission('use text format comark');
    $author->grantPermission('use editorial transition create_new_draft');
    $author->save();

    $reader = Role::create(['id' => 'kb_reader', 'label' => 'KB reader']);
    $reader->grantPermission('access content');
    $reader->save();

    $this->author = $this->userWithRole('author', $author->id());
    $this->reader = $this->userWithRole('reader', $reader->id());

    // Three spaces, one relationship each: writable and moderated, writable and
    // wiki-style, and one the accounts may only read.
    $this->space('Team Wiki', TRUE, ['members' => $this->rosterOf($this->author, $this->reader)]);
    $this->space('Open Notes', FALSE, ['members' => $this->rosterOf($this->author, $this->reader)]);
    $this->space('Reference', TRUE, ['viewers' => $this->rosterOf($this->author, $this->reader)]);
  }

  /**
   * A create lands a draft at the generated path, with one addressable block.
   *
   * The seeded block is what the no-`body` design stands on: the caller's first
   * `updateBlocks` anchors on a block id, and the leading `# <title>` never
   * reaches the read projection, though its own id does. Both space kinds are
   * covered because moderation is the space's property and not this tool's —
   * the two answer alike, and what differs is only what the draft then owes.
   */
  public function testCreatesDraftWithOneAddressableBlock(): void {
    $this->setCurrentUser($this->author);
    $cases = [
      'team-wiki' => ['Getting Started', '/team-wiki/getting-started'],
      'open-notes' => ['Wiki Style', '/open-notes/wiki-style'],
    ];

    foreach ($cases as $slug => [$title, $path]) {
      $result = $this->createPage(['title' => $title, 'space' => $slug]);

      $this->assertSame($path, $result['path']);
      $this->assertSame($title, $result['title']);
      $this->assertSame($slug, $result['space']);
      $this->assertFalse($result['published']);

      $node = Node::load($result['nid']);
      $this->assertNotNull($node);
      $this->assertFalse($node->isPublished(), 'A created page is a draft.');
      $this->assertSame('draft', $node->get('moderation_state')->value);
      $this->assertSame((int) $this->author->id(), (int) $node->getOwnerId());
      // The reported path is the generated alias, not a guess.
      $this->assertSame(
        $result['path'],
        $this->container->get('path_alias.manager')->getAliasByPath('/node/' . $result['nid']),
      );

      $this->assertMatchesRegularExpression('/^b-[0-9a-f]{8}$/', $result['block']);
      $body = (string) $node->get('field_kb_body')->value;
      preg_match_all('/\{#([\w-]+)\}/', $body, $ids);
      // The title heading carries the lead section's block, the anchor a
      // citation of that section lands on; the placeholder carries its own.
      $this->assertMatchesRegularExpression("/^# $title \{#b-[0-9a-f]{8}\}\n/", $body);
      $this->assertCount(2, $ids[1]);
      $this->assertNotSame($ids[1][0], $ids[1][1]);
      $this->assertSame($result['block'], $ids[1][1], 'The result named the placeholder block.');
    }
  }

  /**
   * The body is written in the format the body field configures.
   *
   * Nothing here names one: retargeting the field is the whole change a site
   * makes to author its bodies in another format.
   */
  public function testWritesTheFieldsConfiguredFormat(): void {
    FilterFormat::create(['format' => 'plain', 'name' => 'Plain', 'filters' => []])->save();
    FieldConfig::loadByName('node', 'kb_page', 'field_kb_body')
      ->setSetting('allowed_formats', ['plain'])
      ->save();

    $this->setCurrentUser($this->author);
    $result = $this->createPage(['title' => 'Other Format', 'space' => 'team-wiki']);

    $this->assertSame('plain', Node::load($result['nid'])->get('field_kb_body')->format);
  }

  /**
   * A space the caller may not write to is refused, and nothing is created.
   *
   * A space it may only read and one nobody named are refused alike: the
   * refusal says what to do next, not what exists.
   */
  public function testRefusesSpaceTheCallerMayNotWriteTo(): void {
    $this->setCurrentUser($this->author);

    foreach (['reference', 'no-such-space'] as $slug) {
      $refusal = $this->callTool('tool_api__create_page', ['title' => 'Not Here', 'space' => $slug]);

      $this->assertTrue($refusal->result->isError, $slug);
      $this->assertStringContainsString('tool_api__list_spaces', $refusal->result->content[0]->text);
    }
    $this->assertSame([], $this->nodeIds(), 'Nothing was created.');
  }

  /**
   * The tool is advertised with the schemas and hints clients read.
   */
  public function testIsAdvertisedWithSchemasAndHints(): void {
    $this->setCurrentUser($this->author);
    $tool = $this->tool($this->buildServer(), 'tool_api__create_page');

    $this->assertSame(['title', 'space'], array_keys($tool->inputSchema['properties']));
    $this->assertSame(['title', 'space'], $tool->inputSchema['required']);
    $this->assertNotNull($tool->outputSchema);
    $this->assertSame(
      ['path', 'nid', 'title', 'space', 'block', 'published'],
      array_keys($tool->outputSchema['properties']['data']['properties']),
    );
    $this->assertFalse($tool->annotations->readOnlyHint);
    $this->assertFalse($tool->annotations->destructiveHint);
    $this->assertFalse($tool->annotations->idempotentHint);
  }

  /**
   * An account that may not create is refused, and writes nothing.
   *
   * The gate is the permission `agent:write:create` names, so an account
   * without it is exactly a token without the scope. Access is enforced when
   * the tool executes, not when it is listed (ADR 0009), so the tool is
   * advertised to it all the same.
   */
  public function testRefusesAnAccountThatMayNotCreate(): void {
    $this->setCurrentUser($this->reader);
    $server = $this->buildServer();

    $this->assertContains('tool_api__create_page', $this->toolNames($server));

    $refusal = $this->call($server, 'tool_api__create_page', [
      'title' => 'Not Mine',
      'space' => 'team-wiki',
    ]);
    $this->assertInstanceOf(Response::class, $refusal);
    $this->assertTrue($refusal->result->isError);
    $this->assertSame([], $this->nodeIds());
  }

  /**
   * Calls the create tool and returns the payload under its envelope.
   *
   * @return array<string, mixed>
   *   The result.
   */
  private function createPage(array $arguments): array {
    $response = $this->callTool('tool_api__create_page', $arguments);
    $this->assertFalse(
      $response->result->isError,
      $response->result->isError ? $response->result->content[0]->text : '',
    );
    return $response->result->structuredContent['data'];
  }

  /**
   * Calls one tool on a server built for the current account.
   */
  private function callTool(string $name, array $arguments): Response {
    $result = $this->call($this->buildServer(), $name, $arguments);
    $this->assertInstanceOf(Response::class, $result);
    return $result;
  }

  /**
   * Every node that exists, so a refusal can be shown to have written nothing.
   *
   * @return array<int|string, string>
   *   The node ids.
   */
  private function nodeIds(): array {
    return $this->container->get('entity_type.manager')->getStorage('node')
      ->getQuery()->accessCheck(FALSE)->execute();
  }

  /**
   * Creates one space.
   */
  private function space(string $name, bool $moderated, array $roster): void {
    Space::create([
      'label' => $name,
      'read_access' => 'all_users',
      'field_moderation' => $moderated,
    ] + $roster)->save();
  }

  /**
   * A roster field value referencing the given accounts.
   */
  private function rosterOf(UserInterface ...$users): array {
    return array_map(static fn (UserInterface $user): array => ['target_id' => $user->id()], $users);
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

  /**
   * Builds the server as the current account sees it.
   */
  private function buildServer(): Server {
    return $this->container->get('mcp_server.server.factory')->create();
  }

  /**
   * The tools tools/list reports.
   *
   * @return string[]
   *   The names.
   */
  private function toolNames(Server $server): array {
    return array_map(static fn ($tool): string => $tool->name, $this->tools($server));
  }

  /**
   * One advertised tool, by name.
   */
  private function tool(Server $server, string $name): object {
    foreach ($this->tools($server) as $tool) {
      if ($tool->name === $name) {
        return $tool;
      }
    }
    $this->fail(sprintf('Tool "%s" is not advertised.', $name));
  }

  /**
   * Everything tools/list advertises.
   *
   * @return object[]
   *   The tools.
   */
  private function tools(Server $server): array {
    return $this->handler($server, ListToolsHandler::class)->handle(
      ListToolsRequest::fromArray(['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list']),
      $this->createMock(SessionInterface::class),
    )->result->tools;
  }

  /**
   * Sends one tools/call and returns whatever the SDK answers.
   */
  private function call(Server $server, string $name, array $arguments): Response|Error {
    return $this->handler($server, CallToolHandler::class)->handle(
      CallToolRequest::fromArray([
        'jsonrpc' => '2.0',
        'id' => 1,
        'method' => 'tools/call',
        'params' => ['name' => $name, 'arguments' => $arguments],
      ]),
      $this->createMock(SessionInterface::class),
    );
  }

  /**
   * Reflects into the built server for one of its request handlers.
   *
   * The SDK exposes no accessor for them.
   *
   * @param \Mcp\Server $server
   *   The built server.
   * @param class-string $class
   *   The handler class to find.
   */
  private function handler(Server $server, string $class): object {
    $protocol = (new \ReflectionProperty($server, 'protocol'))->getValue($server);
    foreach ((new \ReflectionProperty($protocol, 'requestHandlers'))->getValue($protocol) as $handler) {
      if ($handler instanceof $class) {
        return $handler;
      }
    }
    $this->fail($class . ' not found in server protocol.');
  }

}
