<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_ai\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\openkb_tools\SessionRelayModules;
use Drupal\Tests\openkb_tools\Traits\McpSurfaceTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\mcp_server_tool_bridge\Entity\McpToolConfig;
use Drupal\openkb_space\Entity\Space;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\vercel_ai_sdk\Service\ChatToolRegistry;

/**
 * The two consumers offer one tool set, and the chat calls it as the chatter.
 *
 * Each names the same tool its own way — `tool_api__<mcp_tool_config id>` on
 * the endpoint, `tool__<tool id>` in the chat — so parity is asserted on the
 * Tool API tool behind the name (ADR 0009). The session tools are the asserted
 * difference: the chat relays them, Drupal's own endpoint offers none.
 *
 * @group openkb_ai
 */
final class ToolParityTest extends KernelTestBase {

  use McpSurfaceTrait;
  use RecipeConfigTrait;
  use UserCreationTrait;

  /**
   * The tools Drupal executes, which both consumers offer.
   */
  private const DRUPAL_TOOLS = [
    'openkb_create_page',
    'openkb_find_drafts',
    'openkb_forbidden_probe',
    'openkb_get_page',
    'openkb_list_assignments',
    'openkb_list_spaces',
    'openkb_search_pages',
  ];

  /**
   * The tools the frontend server executes, which the chat relays to it.
   */
  private const RELAYED_TOOLS = [
    'openkb_comment_on_block',
    'openkb_get_page_for_editing',
    'openkb_update_blocks',
    'openkb_update_fields',
    'openkb_wait_for_changes',
  ];

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
    'path',
    'path_alias',
    'inline_comment',
    'key',
    ...SessionRelayModules::OAUTH,
    'ai',
    'ai_assistant_api',
    'tool',
    'tool_ai_connector',
    'vercel_ai_sdk',
    'openkb_schema',
    'openkb_space',
    'openkb_space_access',
    'mcp_server',
    'mcp_server_tool_bridge',
    'search_api',
    'search_api_opensearch',
    // The retrieval service `openkb_search_pages` runs on; without it the
    // tool cannot be built and drops off the surface it is asserted on.
    'openkb_search',
    'openkb_agent',
    'openkb_tools',
    'openkb_tools_test',
    'openkb_ai',
  ];

  /**
   * The chat's tools.
   */
  private ChatToolRegistry $chat;

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
    // placeholder so the account under test does not inherit that.
    User::create(['name' => 'superuser'])->save();
    $role = Role::create(['id' => 'kb_user', 'label' => 'KB user']);
    $role->grantPermission('access content');
    $role->save();

    $member = User::create(['name' => 'member', 'status' => 1]);
    $member->addRole($role->id());
    $member->save();

    // Saved before the account becomes current: a space's creator is its
    // admin, which would make the member a manager instead of a member.
    Space::create([
      'label' => 'Secret Ops',
      'description' => 'Runbooks for the on-call rotation.',
      'read_access' => 'members_only',
      'field_moderation' => TRUE,
      'members' => [['target_id' => $member->id()]],
    ])->save();

    $this->setCurrentUser($member);

    $this->chat = $this->container->get('vercel_ai_sdk.tool_registry');
  }

  /**
   * Both consumers offer the same Drupal-executed tools to the same account.
   *
   * The invariant ADR 0009 states. Asserted on tool ids, because the two
   * consumers name the same tool differently on the wire.
   */
  public function testTheTwoConsumersOfferTheSameTools(): void {
    $this->assertSame(self::DRUPAL_TOOLS, $this->mcpTools());
    $this->assertSame(
      self::DRUPAL_TOOLS,
      array_values(array_diff($this->chatTools(), self::RELAYED_TOOLS)),
    );
  }

  /**
   * The chat offers the session tools and Drupal's own endpoint does not.
   *
   * The asserted difference. Drupal declares every tool — that is what makes
   * one registry possible — and relays the five it cannot execute when the
   * chat calls them; an agent reaches those on the frontend's own endpoint.
   */
  public function testTheSessionToolsAreTheChatsAndNotDrupalsEndpoints(): void {
    $all = [...self::DRUPAL_TOOLS, ...self::RELAYED_TOOLS];
    sort($all);
    $this->assertSame($all, $this->declaredTools());

    $this->assertSame([], array_intersect(self::RELAYED_TOOLS, $this->mcpTools()));
    $this->assertSame([], array_diff(self::RELAYED_TOOLS, $this->chatTools()));
  }

  /**
   * Asking what changed is a chat tool, and the chat's call cannot wait.
   *
   * The declaration the chat reads has no timeout input, so nothing but the
   * relay names one and it always asks for an immediate answer.
   */
  public function testWaitingForChangesIsOfferedToTheChat(): void {
    $this->assertContains('openkb_wait_for_changes', $this->chatTools());
    $this->assertNotContains('openkb_wait_for_changes', $this->mcpTools());

    $inputs = $this->container->get('plugin.manager.tool')
      ->createInstance('openkb_wait_for_changes')
      ->getInputDefinitions();
    $this->assertSame(['path', 'cursor', 'kinds'], array_keys($inputs));
  }

  /**
   * A chat call runs as the person chatting and answers their own map.
   */
  public function testChatCallExecutesAsTheChattingAccount(): void {
    $result = $this->chat->call('tool__openkb_list_spaces', ['access' => 'write']);

    $this->assertTrue($result['data']['success'], $result['text']);
    $this->assertSame([['slug' => 'secret-ops', 'access' => 'write']], array_map(
      static fn (array $space): array => ['slug' => $space['slug'], 'access' => $space['access']],
      $result['data']['outputs']['spaces'],
    ));
    $this->assertStringContainsString('secret-ops', $result['text']);
  }

  /**
   * A refused call is a result the model reads, not an uncaught exception.
   *
   * The tool's body must stay unreached, and the turn must survive: the chat
   * has no catch around a tool round, so a refusal that threw would end the
   * turn instead of being answered.
   */
  public function testRefusedChatCallIsAnsweredNotThrown(): void {
    $result = $this->chat->call('tool__openkb_forbidden_probe', []);

    $this->assertFalse($result['data']['success']);
    $this->assertStringContainsString('Nobody may call this tool.', $result['data']['message']);
    $this->assertFalse(
      $this->container->get('state')->get('openkb_tools_test.probe_ran', FALSE),
      'A tool whose checkAccess() forbids must not execute.',
    );
  }

  /**
   * A name nobody serves is answered as a result too.
   */
  public function testUnknownChatToolIsAnsweredTheSameWay(): void {
    $result = $this->chat->call('noSuchTool', []);

    $this->assertSame([], $result['data']);
    $this->assertStringContainsString('No tool named "noSuchTool"', $result['text']);
  }

  /**
   * Every Tool API tool this site declares, sorted.
   *
   * @return string[]
   *   The tool ids.
   */
  private function declaredTools(): array {
    $ids = array_keys($this->container->get('plugin.manager.tool')->getDefinitions());
    sort($ids);
    return $ids;
  }

  /**
   * The Tool API tools Drupal's MCP endpoint advertises, sorted.
   *
   * @return string[]
   *   The tool ids behind the advertised `tool_api__<id>` names.
   */
  private function mcpTools(): array {
    $ids = [];
    foreach ($this->toolNames($this->buildServer()) as $name) {
      $config = McpToolConfig::load(substr($name, strlen('tool_api__')));
      $ids[] = $config->getToolId();
    }
    sort($ids);
    return $ids;
  }

  /**
   * The Tool API tools the chat offers the model, sorted.
   *
   * @return string[]
   *   The tool ids behind the offered `tool__<id>` function names.
   */
  private function chatTools(): array {
    $ids = array_map(
      static fn ($function): string => substr($function->getName(), strlen('tool__')),
      $this->chat->functions(),
    );
    sort($ids);
    return $ids;
  }

}
