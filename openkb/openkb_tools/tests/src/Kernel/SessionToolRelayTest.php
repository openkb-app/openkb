<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_tools\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\Core\DefaultContent\Existing;
use Drupal\Core\DefaultContent\Finder;
use Drupal\Core\DefaultContent\Importer;
use Drupal\Core\Session\AnonymousUserSession;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\CollabClientTrait;
use Drupal\Tests\openkb_tools\SessionRelayModules;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolInterface;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use Psr\Http\Message\RequestInterface;

/**
 * A session tool called in Drupal, executed in the frontend's editing session.
 *
 * The call the frontend receives, the identity it receives it under, and that
 * nothing a session or a network answers leaves the turn with an exception
 * where it needs a result.
 *
 * @group openkb_tools
 */
final class SessionToolRelayTest extends KernelTestBase {

  use CollabClientTrait;
  use UserCreationTrait;

  /**
   * Where the frontend answers, as the setting names it.
   */
  private const ENDPOINT = 'http://frontend.example.com/api/mcp';

  /**
   * One page path, and the inputs each session tool needs to act on it.
   */
  private const CALLS = [
    'openkb_get_page_for_editing' => ['path' => 'team-wiki/getting-started'],
    'openkb_update_blocks' => [
      'path' => 'team-wiki/getting-started',
      'blocks' => [['id' => 'b-1', 'expect' => 'v1', 'markdown' => 'Shorter.']],
    ],
    'openkb_update_fields' => [
      'path' => 'team-wiki/getting-started',
      'fields' => ['field_summary' => 'A shorter summary.'],
    ],
    'openkb_comment_on_block' => [
      'path' => 'team-wiki/getting-started',
      'blockId' => 'b-1',
      'text' => 'Shortened the second paragraph.',
    ],
    'openkb_wait_for_changes' => ['path' => 'team-wiki/getting-started'],
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
    ...SessionRelayModules::OAUTH,
    'openkb_schema',
    'openkb_space',
    'openkb_space_access',
    // The endpoint falls back to this module's frontend base URL. Only the
    // module itself: its own dependencies serve the /ce-api render path, and
    // pulling them in drags the renderer stack into a kernel container.
    'lupus_decoupled_ce_api',
    'mcp_server',
    'search_api',
    'tool',
    'openkb_tools',
  ];

  /**
   * The account the chat turn runs as.
   */
  private UserInterface $editor;

  /**
   * The account the recipe's content is imported as, as a deploy does it.
   */
  private UserInterface $installer;

  /**
   * What the frontend will answer next.
   */
  private MockHandler $frontend;

  /**
   * The requests the frontend received.
   *
   * @var array
   */
  private array $sent = [];

  /**
   * DRUPAL_FRONTEND_BASE_URL as the test process inherited it.
   */
  private string|false $inheritedFrontendBaseUrl;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    // The env var outranks the configured frontend base URL, and CI runs
    // phpunit in a container that has it set.
    $this->inheritedFrontendBaseUrl = getenv('DRUPAL_FRONTEND_BASE_URL');
    putenv('DRUPAL_FRONTEND_BASE_URL');

    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['filter', 'node', 'simple_oauth', 'lupus_decoupled_ce_api', 'openkb_tools']);
    $this->installOauthKeys();
    $this->importRecipeConfig([
      'simple_oauth.oauth2_scope.agent_read',
      'simple_oauth.oauth2_scope.agent_write',
    ]);
    $this->config('openkb_tools.settings')->set('session_endpoint', self::ENDPOINT)->save();

    $this->frontend = new MockHandler();
    $stack = HandlerStack::create($this->frontend);
    $stack->push(Middleware::history($this->sent));
    $this->container->set('http_client', new Client(['handler' => $stack]));

    // User 1 is the superuser and bypasses everything; burn it on a
    // placeholder so the account under test does not inherit that.
    User::create(['name' => 'superuser'])->save();
    $this->installer = $this->createUser([], 'installer', TRUE);
    $this->editor = $this->createUser([], 'editor1');
    $this->setCurrentUser($this->editor);

    $this->importChatClient();
  }

  /**
   * {@inheritdoc}
   */
  protected function tearDown(): void {
    if ($this->inheritedFrontendBaseUrl !== FALSE) {
      putenv('DRUPAL_FRONTEND_BASE_URL=' . $this->inheritedFrontendBaseUrl);
    }
    parent::tearDown();
  }

  /**
   * Imports the chat's OAuth client from the recipe, as a deploy does.
   */
  private function importChatClient(): void {
    $this->container->get(Importer::class)->importContent(
      new Finder(dirname(DRUPAL_ROOT) . '/recipes/openkb_recipe_chat/content'),
      Existing::Skip,
      $this->installer,
    );
  }

  /**
   * The frontend is asked to run the tool, with the inputs as they were given.
   */
  public function testTheFrontendIsAskedToRunTheToolWithTheInputsAsGiven(): void {
    $applied = ['ok' => TRUE, 'applied' => ['blocks' => ['b-1' => 'v2']]];
    $this->frontend->append(self::answer('Rewrote one block.', $applied));

    $result = $this->call('openkb_update_blocks');

    $this->assertTrue($result->isSuccess(), (string) $result->getMessage());
    $this->assertSame('Rewrote one block.', (string) $result->getMessage());
    $this->assertSame(['result' => $applied], $result->getContextValues());

    $request = $this->lastRequest();
    $this->assertSame('POST', $request->getMethod());
    $this->assertSame(self::ENDPOINT, (string) $request->getUri());
    $this->assertSame([
      'jsonrpc' => '2.0',
      'id' => 1,
      'method' => 'tools/call',
      'params' => [
        'name' => 'updateBlocks',
        'arguments' => self::CALLS['openkb_update_blocks'],
      ],
    ], Json::decode((string) $request->getBody()));
  }

  /**
   * The call is made as the chatting account, through the chat's own client.
   */
  public function testTheCallIsMadeAsTheChattingAccount(): void {
    $this->frontend->append(self::answer('Read it.', ['path' => 'team-wiki/getting-started']));

    $this->call('openkb_get_page_for_editing');

    $bearer = $this->lastRequest()->getHeaderLine('Authorization');
    $this->assertStringStartsWith('Bearer ', $bearer);
    $this->assertSame((string) $this->editor->id(), $this->claim($bearer, 'sub'));

    $tokens = $this->container->get('entity_type.manager')->getStorage('oauth2_token')->loadMultiple();
    $this->assertCount(1, $tokens);
    /** @var \Drupal\simple_oauth\Entity\Oauth2TokenInterface $token */
    $token = reset($tokens);
    $this->assertSame((int) $this->editor->id(), (int) $token->get('auth_user_id')->target_id);
    $this->assertSame(
      ['agent_read', 'agent_write'],
      array_map(static fn ($scope): string => (string) $scope->id(), $token->get('scopes')->getScopes()),
    );
    $consumer = $token->get('client')->entity;
    $this->assertSame('OpenKB AI', (string) $consumer->label());
    // One system-wide client, not a person's own: nothing owns it, and the
    // unclaimed-consumer sweep only takes personal ones.
    $this->assertFalse((bool) $consumer->get('personal')->value);
    $this->assertTrue($consumer->get('user_id')->isEmpty());
    // `refresh_token` needs a refresh token nothing issues on this client, so
    // a token on it is issued here or not at all.
    $this->assertSame(['refresh_token'], array_column($consumer->get('grant_types')->getValue(), 'value'));
    // Five minutes. The clock is time(), so a second may pass under the test.
    $this->assertEqualsWithDelta(
      $this->container->get('datetime.time')->getCurrentTime() + 300,
      (int) $token->get('expire')->value,
      2,
    );
  }

  /**
   * One token serves the whole turn, on the one client the recipe shipped.
   */
  public function testOneTokenAndOneClientServeTheWholeTurn(): void {
    $this->frontend->append(self::answer('Read it.', ['ok' => TRUE]));
    $this->frontend->append(self::answer('Wrote it.', ['ok' => TRUE]));

    $this->call('openkb_get_page_for_editing');
    $this->call('openkb_update_blocks');

    $bearers = array_map(
      static fn (array $call): string => $call['request']->getHeaderLine('Authorization'),
      $this->sent,
    );
    $this->assertCount(2, $bearers);
    $this->assertSame($bearers[0], $bearers[1]);
    $this->assertCount(1, $this->container->get('entity_type.manager')->getStorage('oauth2_token')->loadMultiple());
    $this->assertCount(1, $this->container->get('entity_type.manager')->getStorage('consumer')->loadMultiple());
  }

  /**
   * Without the client the recipe ships, the chat says so and writes nothing.
   */
  public function testTheMissingChatClientIsSaidRatherThanCreated(): void {
    $storage = $this->container->get('entity_type.manager')->getStorage('consumer');
    $storage->delete($storage->loadMultiple());

    $result = $this->call('openkb_update_blocks');

    $this->assertFalse($result->isSuccess());
    $this->assertStringContainsString('has no "OpenKB AI" OAuth client', (string) $result->getMessage());
    $this->assertSame([], $this->sent, 'nothing is sent without an identity');
    $this->assertSame([], $storage->loadMultiple(), 'and no client is made on the way');
  }

  /**
   * An administrator is refused: their token would not be capped by anything.
   */
  public function testAnAdministratorIsRefusedRatherThanUncapped(): void {
    $admin = $this->createUser([], 'boss', TRUE);
    $this->setCurrentUser($admin);

    $result = $this->call('openkb_update_blocks');

    $this->assertFalse($result->isSuccess());
    $this->assertStringContainsString('Use an editor account', (string) $result->getMessage());
    $this->assertSame([], $this->sent);
  }

  /**
   * A re-applied recipe leaves the one client it imported, not a second.
   */
  public function testReapplyingTheRecipeLeavesOneClient(): void {
    $this->importChatClient();

    $consumers = $this->container->get('entity_type.manager')->getStorage('consumer')->loadMultiple();
    $this->assertCount(1, $consumers);
    $this->assertSame('OpenKB AI', (string) reset($consumers)->label());
  }

  /**
   * The token carries the client's scopes, so narrowing them narrows it.
   */
  public function testNarrowingTheClientsScopesNarrowsTheToken(): void {
    $storage = $this->container->get('entity_type.manager')->getStorage('consumer');
    $found = $storage->loadByProperties(['client_id' => 'openkb_chat']);
    $consumer = reset($found);
    $consumer->set('scopes', [['scope_id' => 'agent_read']])->save();
    $this->frontend->append(self::answer('Read it.', ['ok' => TRUE]));

    $this->call('openkb_get_page_for_editing');

    $tokens = $this->container->get('entity_type.manager')->getStorage('oauth2_token')->loadMultiple();
    /** @var \Drupal\simple_oauth\Entity\Oauth2TokenInterface $token */
    $token = reset($tokens);
    $this->assertSame(
      ['agent_read'],
      array_map(static fn ($scope): string => (string) $scope->id(), $token->get('scopes')->getScopes()),
    );
  }

  /**
   * Whatever comes back is a failure the model reads, never a throw.
   *
   * A status of NULL is a frontend that never answered at all.
   *
   * @dataProvider refusals
   */
  public function testEveryRefusalComesBackAsTheToolsFailure(?int $status, array $body, string $says): void {
    $this->frontend->append($status === NULL
      ? new ConnectException('Connection refused', new Request('POST', self::ENDPOINT))
      : self::json($status, $body));

    $result = $this->call('openkb_get_page_for_editing');

    $this->assertFalse($result->isSuccess());
    $this->assertStringContainsString($says, (string) $result->getMessage());
  }

  /**
   * What a session or a network can answer, and what the caller is told.
   *
   * A 4xx is the session speaking and keeps its own words; only a 5xx or a
   * dead connection reads as an outage.
   *
   * @return array<string, array{?int, array, string}>
   *   Test cases.
   */
  public static function refusals(): array {
    return [
      'a refusing status' => [
        403,
        ['statusCode' => 403, 'statusMessage' => 'Agent token required'],
        'Agent token required',
      ],
      'a refusing JSON-RPC envelope' => [
        400,
        ['jsonrpc' => '2.0', 'error' => ['message' => 'getPageForEditing takes no expects.']],
        'getPageForEditing takes no expects.',
      ],
      'a JSON-RPC error in an accepted call' => [
        200,
        ['jsonrpc' => '2.0', 'id' => 1, 'error' => ['message' => 'Unknown tool: getPageForEditing']],
        'Unknown tool: getPageForEditing',
      ],
      'a failing frontend' => [500, [], 'could not be reached'],
      'a frontend that does not answer' => [NULL, [], 'could not be reached'],
    ];
  }

  /**
   * A 200 this parser cannot read is an outage, not an empty success.
   *
   * The relay's Accept lists text/event-stream because the transport answers
   * 406 without it, so a frontend built to stream would be within its rights
   * to answer one. json_decode makes nothing of an SSE frame, and a model told
   * the session answered nothing would act on it.
   */
  public function testAnUnreadableBodyIsAnOutageRatherThanAnEmptySuccess(): void {
    $this->frontend->append(new Response(200, ['Content-Type' => 'text/event-stream'], "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"));

    $result = $this->call('openkb_get_page_for_editing');

    $this->assertFalse($result->isSuccess());
    $this->assertStringContainsString('could not be reached', (string) $result->getMessage());
  }

  /**
   * An unset endpoint falls back to the frontend's own base URL.
   *
   * `openkb_recipe_ci` sets the endpoint to the in-network origin, because a
   * Bearer cannot pass the Basic auth in front of the public host. Everywhere
   * else has this fallback.
   */
  public function testAnUnsetEndpointFallsBackToTheFrontendBaseUrl(): void {
    $this->config('openkb_tools.settings')->set('session_endpoint', '')->save();
    $this->config('lupus_decoupled_ce_api.settings')
      ->set('frontend_base_url', 'https://kb.example.com/')
      ->save();
    $this->frontend->append(self::answer('Read it.', ['ok' => TRUE]));

    $this->call('openkb_get_page_for_editing');

    $this->assertSame('https://kb.example.com/api/mcp', (string) $this->lastRequest()->getUri());
  }

  /**
   * With no endpoint and no frontend to derive one from, nothing is called.
   */
  public function testWithNoFrontendThereIsNothingToRelayTo(): void {
    $this->config('openkb_tools.settings')->set('session_endpoint', '')->save();
    $this->config('lupus_decoupled_ce_api.settings')->set('frontend_base_url', '')->save();

    $result = $this->call('openkb_get_page_for_editing');

    $this->assertFalse($result->isSuccess());
    $this->assertStringContainsString('no editing frontend configured', (string) $result->getMessage());
    $this->assertSame([], $this->sent);
  }

  /**
   * A refusal by the editing session is the tool's own failure, not a throw.
   */
  public function testTheSessionsRefusalComesBackAsTheToolsFailure(): void {
    $conflict = ['ok' => FALSE, 'conflicts' => [['id' => 'b-1', 'version' => 'v3']]];
    $this->frontend->append(self::answer('Block b-1 moved since you read it.', $conflict, TRUE));

    $result = $this->call('openkb_update_blocks');

    $this->assertFalse($result->isSuccess());
    $this->assertSame('Block b-1 moved since you read it.', (string) $result->getMessage());
    // The conflict travels with the refusal: the retry is built from it.
    $this->assertSame(['result' => $conflict], $result->getContextValues());
  }

  /**
   * Each runtime names the same tool its own way, and Drupal maps between them.
   */
  public function testTheFrontendToolNameIsDerivedFromThePluginId(): void {
    $names = [];
    foreach (array_keys(self::CALLS) as $id) {
      $this->frontend->append(self::answer('Done.', ['ok' => TRUE]));
      $this->call($id);
      $names[] = Json::decode((string) $this->lastRequest()->getBody())['params']['name'];
    }

    $this->assertSame(
      ['getPageForEditing', 'updateBlocks', 'updateFields', 'commentOnBlock', 'waitForChanges'],
      $names,
    );
  }

  /**
   * Asking what changed relays timeoutSec: 0, and is answered.
   *
   * The chat's declaration has no timeout input, so the relay is the only
   * thing that names one.
   *
   * @dataProvider whatChanged
   */
  public function testAskingWhatChangedNeverWaits(string $says, array $answer): void {
    $this->frontend->append(self::answer($says, $answer));

    $result = $this->call('openkb_wait_for_changes');

    $this->assertTrue($result->isSuccess(), (string) $result->getMessage());
    $this->assertSame($says, (string) $result->getMessage());
    $this->assertSame(['result' => $answer], $result->getContextValues());
    $this->assertSame(
      ['path' => 'team-wiki/getting-started', 'timeoutSec' => 0],
      Json::decode((string) $this->lastRequest()->getBody())['params']['arguments'],
    );
  }

  /**
   * A quiet page and a page that moved, as the session answers each.
   *
   * @return array<string, array{string, array}>
   *   Test cases.
   */
  public static function whatChanged(): array {
    return [
      'nothing since the cursor' => [
        'Nothing has happened on Getting Started. Ask again with the cursor.',
        ['events' => [], 'cursor' => 'c-4', 'editors' => 1, 'restarted' => FALSE, 'dropped' => FALSE],
      ],
      'a block somebody finished' => [
        "b-1 settled at v3, by editor1\nb-2 settled at v1, by editor1",
        [
          'events' => [
            ['kind' => 'blocks', 'blockId' => 'b-1', 'event' => 'settled', 'version' => 'v3'],
            ['kind' => 'blocks', 'blockId' => 'b-2', 'event' => 'settled', 'version' => 'v1'],
          ],
          'cursor' => 'c-6',
          'editors' => 1,
          'restarted' => FALSE,
          'dropped' => FALSE,
        ],
      ],
    ];
  }

  /**
   * The cursor an answer carries is what the next call resumes from.
   */
  public function testTheNextCallResumesFromTheCursorItWasGiven(): void {
    $this->frontend->append(self::answer('Nothing has happened.', ['events' => [], 'cursor' => 'c-4', 'editors' => 1]));
    $this->frontend->append(self::answer('b-1 settled at v3.', [
      'events' => [['kind' => 'blocks', 'blockId' => 'b-1', 'event' => 'settled', 'version' => 'v3']],
      'cursor' => 'c-5',
      'editors' => 1,
    ]));

    $cursor = $this->call('openkb_wait_for_changes')->getContextValues()['result']['cursor'];
    $tool = $this->tool('openkb_wait_for_changes');
    $tool->setInputValue('cursor', $cursor);
    $tool->execute();

    $this->assertSame(
      ['path' => 'team-wiki/getting-started', 'cursor' => 'c-4', 'timeoutSec' => 0],
      Json::decode((string) $this->lastRequest()->getBody())['params']['arguments'],
    );
  }

  /**
   * A reader who is not logged in has no session identity to act through.
   */
  public function testAnAnonymousReaderMayNotReachTheSession(): void {
    $this->setCurrentUser(new AnonymousUserSession());

    $this->assertFalse($this->tool('openkb_update_blocks')->access());
    $this->assertSame([], $this->sent);
  }

  /**
   * Runs one session tool and hands back what it answered.
   */
  private function call(string $id): ExecutableResult {
    return $this->tool($id)->execute()->getResult();
  }

  /**
   * One session tool, with its inputs set.
   */
  private function tool(string $id): ToolInterface {
    $tool = $this->container->get('plugin.manager.tool')->createInstance($id);
    foreach (self::CALLS[$id] as $name => $value) {
      $tool->setInputValue($name, $value);
    }

    return $tool;
  }

  /**
   * The last request the frontend received.
   */
  private function lastRequest(): RequestInterface {
    $this->assertNotEmpty($this->sent, 'The frontend was not called.');

    return end($this->sent)['request'];
  }

  /**
   * One MCP tool answer, as the frontend frames it.
   */
  private static function answer(string $text, array $structured, bool $failed = FALSE): Response {
    return self::json(200, [
      'jsonrpc' => '2.0',
      'id' => 1,
      'result' => [
        'content' => [['type' => 'text', 'text' => $text]],
        'structuredContent' => $structured,
      ] + ($failed ? ['isError' => TRUE] : []),
    ]);
  }

  /**
   * One JSON response from the frontend.
   */
  private static function json(int $status, array $body): Response {
    return new Response($status, ['Content-Type' => 'application/json'], Json::encode($body));
  }

  /**
   * One claim of a bearer token's JWT.
   */
  private function claim(string $bearer, string $name): string {
    $payload = explode('.', substr($bearer, strlen('Bearer ')))[1] ?? '';
    $claims = Json::decode((string) base64_decode(strtr($payload, '-_', '+/')));

    return (string) ($claims[$name] ?? '');
  }

}
