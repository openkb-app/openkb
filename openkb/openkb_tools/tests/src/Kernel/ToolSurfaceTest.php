<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_tools\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\openkb_tools\SessionRelayModules;
use Drupal\Tests\openkb_tools\Traits\McpSurfaceTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\mcp_server_tool_bridge\Entity\McpToolConfig;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space_access\SpaceAccessMap;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use Mcp\Schema\JsonRpc\Response;

/**
 * What Drupal's MCP endpoint offers, and what happens when it is called.
 *
 * The endpoint is the whole agent surface, and the tools reach it as Tool API
 * plugins carried by `mcp_server_tool_bridge`, one per enabled
 * `mcp_tool_config` entity and named `tool_api__<id>` on the wire. So two
 * properties are under test: the shipped entities are what put a tool there at
 * all, and a tool answers for the caller it ran as — access is enforced when
 * the tool executes, not when it is listed (ADR 0009). The forbidden probe is
 * the load-bearing case for the second: it is advertised like any other tool
 * and its body must stay unreachable.
 *
 * @group openkb_tools
 */
final class ToolSurfaceTest extends KernelTestBase {

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
    'path_alias',
    'path',
    'openkb_schema',
    'openkb_space',
    'openkb_space_access',
    'mcp_server',
    'tool',
    'mcp_server_tool_bridge',
    'search_api',
    ...SessionRelayModules::OAUTH,
    'openkb_agent',
    'openkb_tools',
    'openkb_tools_test',
  ];

  /**
   * On the members-only space's member roster.
   */
  private UserInterface $member;

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
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['system', 'filter', 'node', 'mcp_server']);

    $this->importRecipeConfig([
      ...$this->kbSpaceConfigNames(),
      ...$this->mcpToolConfigNames(),
    ]);
    // Test-only, so it is not among the shipped entities.
    McpToolConfig::create([
      'id' => 'forbidden_probe',
      'tool_id' => 'openkb_forbidden_probe',
      'status' => TRUE,
    ])->save();

    // User 1 is the superuser and bypasses everything; burn it on a
    // placeholder so no account under test inherits that.
    User::create(['name' => 'superuser'])->save();

    $role = Role::create(['id' => 'kb_user', 'label' => 'KB user']);
    $role->grantPermission('access content');
    $role->save();

    $this->member = $this->userWithRole('member', $role->id());
    $this->outsider = $this->userWithRole('outsider', $role->id());

    Space::create([
      'label' => 'Secret Ops',
      'description' => 'Runbooks for the on-call rotation.',
      'read_access' => 'members_only',
      'field_moderation' => TRUE,
      'members' => [['target_id' => $this->member->id()]],
    ])->save();

    Space::create([
      'label' => 'Team Wiki',
      'description' => 'Everything everyone may read.',
      'read_access' => 'all_users',
      'field_moderation' => FALSE,
    ])->save();
  }

  /**
   * A forbidden tool is advertised, and its body is still never reached.
   */
  public function testForbiddenToolIsAdvertisedAndRefusedAtCall(): void {
    $this->setCurrentUser($this->member);
    $server = $this->buildServer();

    $this->assertContains('tool_api__forbidden_probe', $this->toolNames($server));

    $result = $this->call($server, 'tool_api__forbidden_probe', []);
    $this->assertInstanceOf(Response::class, $result);
    $this->assertTrue($result->result->isError, 'A denied call is an error, not a success-shaped refusal.');
    $this->assertFalse(
      $this->container->get('state')->get('openkb_tools_test.probe_ran', FALSE),
      'A tool whose checkAccess() forbids must not execute.',
    );
  }

  /**
   * Anonymous is offered the tools and refused by every one of them.
   */
  public function testAnonymousIsRefusedByEveryTool(): void {
    $this->setCurrentUser(User::getAnonymousUser());
    $server = $this->buildServer();

    $this->assertContains('tool_api__list_spaces', $this->toolNames($server));

    $result = $this->call($server, 'tool_api__list_spaces', []);
    $this->assertInstanceOf(Response::class, $result);
    $this->assertTrue($result->result->isError);
  }

  /**
   * Only a tool with an enabled mcp_tool_config entity reaches the endpoint.
   */
  public function testTheShippedConfigDecidesWhatReachesTheEndpoint(): void {
    $this->setCurrentUser($this->member);
    $this->assertSame(
      [
        'tool_api__create_page',
        'tool_api__find_drafts',
        'tool_api__forbidden_probe',
        'tool_api__get_page',
        'tool_api__list_assignments',
        'tool_api__list_spaces',
        'tool_api__search_pages',
      ],
      $this->sortedToolNames(),
    );

    McpToolConfig::load('list_spaces')->setStatus(FALSE)->save();
    $this->assertSame(
      [
        'tool_api__create_page',
        'tool_api__find_drafts',
        'tool_api__forbidden_probe',
        'tool_api__get_page',
        'tool_api__list_assignments',
        'tool_api__search_pages',
      ],
      $this->nextRequestToolNames(),
      'A disabled entity takes its tool off the endpoint.',
    );
  }

  /**
   * The page search advertises the type argument, so a client can send one.
   */
  public function testSearchPagesIsAdvertisedWithItsTypeArgument(): void {
    $this->setCurrentUser($this->member);
    $tool = $this->tool($this->buildServer(), 'tool_api__search_pages');

    $this->assertSame(['q', 'type'], array_keys($tool->inputSchema['properties']));
    $this->assertSame(['q'], $tool->inputSchema['required'] ?? []);
    $this->assertStringContainsString('type', $tool->description);
    // What a hit carries is SearchPagesToolTest's; the advertised output
    // schema describes the hit list and not the shape of one hit.
    $this->assertSame('array', $tool->outputSchema['properties']['data']['properties']['hits']['type']);
  }

  /**
   * The space listing is advertised with the schemas and hints clients read.
   */
  public function testListSpacesIsAdvertisedWithSchemasAndHints(): void {
    $this->setCurrentUser($this->member);
    $tool = $this->tool($this->buildServer(), 'tool_api__list_spaces');

    $this->assertSame(['q', 'access'], array_keys($tool->inputSchema['properties']));
    $this->assertSame(
      [SpaceAccessMap::READ, SpaceAccessMap::WRITE, SpaceAccessMap::MANAGE],
      $tool->inputSchema['properties']['access']['enum'],
    );
    $this->assertNotNull($tool->outputSchema);
    $this->assertSame('array', $tool->outputSchema['properties']['data']['properties']['spaces']['type']);
    $this->assertTrue($tool->annotations->readOnlyHint);
    $this->assertTrue($tool->annotations->idempotentHint);
    $this->assertFalse($tool->annotations->destructiveHint);
  }

  /**
   * The listing is the calling account's own, and honours the filters.
   */
  public function testListingAnswersForTheCallingAccount(): void {
    $this->setCurrentUser($this->member);
    $this->assertSame(
      [
        ['secret-ops', SpaceAccessMap::WRITE],
        ['team-wiki', SpaceAccessMap::READ],
      ],
      $this->listSpaces([]),
    );
    $this->assertSame([['secret-ops', SpaceAccessMap::WRITE]], $this->listSpaces(['access' => 'write']));
    $this->assertSame([['team-wiki', SpaceAccessMap::READ]], $this->listSpaces(['q' => 'wiki']));

    // Same tool, same call, different account — the space it may not read is
    // absent rather than listed as unreadable.
    $this->setCurrentUser($this->outsider);
    $this->assertSame([['team-wiki', SpaceAccessMap::READ]], $this->listSpaces([]));
  }

  /**
   * Runs the space listing and reduces its result to slug/level pairs.
   *
   * @return array<int, array{0: string, 1: string}>
   *   One pair per listed space.
   */
  private function listSpaces(array $arguments): array {
    $result = $this->call($this->buildServer(), 'tool_api__list_spaces', $arguments);
    $this->assertInstanceOf(Response::class, $result);
    $this->assertFalse(
      $result->result->isError,
      $result->result->isError ? $result->result->content[0]->text : '',
    );

    return array_map(
      static fn (array $space): array => [$space['slug'], $space['access']],
      $result->result->structuredContent['data']['spaces'],
    );
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
   * Every advertised tool name, on a freshly built server, sorted.
   *
   * @return string[]
   *   The names.
   */
  private function sortedToolNames(): array {
    $names = $this->toolNames($this->buildServer());
    sort($names);
    return $names;
  }

  /**
   * The advertised tool names a request after this one would see.
   *
   * The plugin manager memoizes its definitions for the life of the process,
   * so only dropping that copy — and not the cache backend behind it — shows
   * whether saving the entity invalidated the cached definitions.
   *
   * @return string[]
   *   The names, sorted.
   */
  private function nextRequestToolNames(): array {
    $manager = $this->container->get('plugin.manager.mcp_server.tool');
    (new \ReflectionProperty($manager, 'definitions'))->setValue($manager, NULL);
    return $this->sortedToolNames();
  }

}
