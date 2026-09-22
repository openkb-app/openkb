<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_tools\Kernel;

use Drupal\Core\Utility\FiberResumeType;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\openkb_tools\SessionRelayModules;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\mcp_server\Controller\McpServerController;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use Psr\Http\Message\ResponseInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * A tools/call carried over Drupal's MCP endpoint.
 *
 * Pins that a tool call whose handler loads an entity is answered as JSON, not
 * SSE, because the patch shields the handler from Drupal's fiber suspends. The
 * trait-based tool tests call the handlers directly and never run through
 * `Mcp\Server\Protocol`, so they do not cover this path.
 *
 * @group openkb_tools
 */
final class ToolCallTransportTest extends KernelTestBase {

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
   * The account the call is made as.
   */
  private UserInterface $editor;

  /**
   * The published page the call reads.
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

    $role = Role::create(['id' => 'kb_user', 'label' => 'KB user']);
    foreach (['access content', 'use text format comark', 'access mcp server'] as $permission) {
      $role->grantPermission($permission);
    }
    $role->save();

    $this->editor = User::create(['name' => 'editor', 'status' => 1]);
    $this->editor->addRole($role->id());
    $this->editor->save();

    $space = Space::create([
      'label' => 'Team Wiki',
      'read_access' => 'all_users',
      'field_moderation' => FALSE,
      'members' => [['target_id' => $this->editor->id()]],
    ]);
    $space->save();
    $this->page = $this->page('Getting Started', $space);

    $this->setCurrentUser($this->editor);
  }

  /**
   * A tool that loads an entity is answered as JSON, in band.
   */
  public function testEntityLoadInsideToolCallReturnsJson(): void {
    // The trigger, on its own, so the case below cannot go vacuous: loading an
    // entity suspends the running fiber, and there always is one here.
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache();
    $probe = new \Fiber(fn () => $storage->loadMultiple([$this->page->id()]));
    $this->assertSame(FiberResumeType::Immediate, $probe->start());
    $probe->resume();

    $session = $this->header($this->post('initialize', [
      'protocolVersion' => '2024-11-05',
      'capabilities' => [],
      'clientInfo' => ['name' => 'test', 'version' => '1.0'],
    ]), 'Mcp-Session-Id');
    $this->assertNotSame('', $session);

    $response = $this->post('tools/call', [
      'name' => 'tool_api__get_page',
      'arguments' => ['path' => 'team-wiki/getting-started'],
    ], $session);

    $this->assertSame('application/json', $this->header($response, 'Content-Type'));
    $this->assertInstanceOf(ResponseInterface::class, $response);

    $body = json_decode((string) $response->getBody(), TRUE, 512, JSON_THROW_ON_ERROR);
    $this->assertArrayNotHasKey('error', $body);
    $this->assertFalse($body['result']['isError'], $body['result']['content'][0]['text'] ?? '');
    $this->assertSame('Getting Started', $body['result']['structuredContent']['data']['title']);
  }

  /**
   * Posts one JSON-RPC message to the controller and returns its answer.
   *
   * @param string $method
   *   The JSON-RPC method.
   * @param array<string, mixed> $params
   *   The method parameters.
   * @param string|null $session
   *   The MCP session the message belongs to, if there is one yet.
   */
  private function post(string $method, array $params, ?string $session = NULL): Response|ResponseInterface {
    $server = ['CONTENT_TYPE' => 'application/json'];
    if ($session !== NULL) {
      $server['HTTP_MCP_SESSION_ID'] = $session;
    }
    $request = Request::create('/mcp', 'POST', [], [], [], $server, json_encode(
      ['jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => $params],
      JSON_THROW_ON_ERROR,
    ));

    return McpServerController::create($this->container)->handle(
      $request,
      $this->container->get('psr7.http_message_factory')->createRequest($request),
    );
  }

  /**
   * One header, whichever response object the controller handed back.
   *
   * A streamed answer arrives as Symfony's own response, a buffered one as
   * PSR-7.
   */
  private function header(Response|ResponseInterface $response, string $name): string {
    return $response instanceof ResponseInterface
      ? $response->getHeaderLine($name)
      : (string) $response->headers->get($name, '');
  }

  /**
   * Creates one published page in a space.
   */
  private function page(string $title, SpaceInterface $space): NodeInterface {
    $node = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'uid' => $this->editor->id(),
      'field_space' => ['target_id' => $space->id()],
      'field_type' => 'guide',
      'field_summary' => 'Where a new joiner starts.',
      'field_owner' => ['target_id' => $this->editor->id()],
      'field_kb_body' => [
        'value' => "# {$title} {#b-title}\n\nThe wiki everybody starts at. {#b-intro}\n",
        'format' => 'comark',
      ],
      'moderation_state' => 'published',
    ]);
    $node->save();
    return $node;
  }

}
