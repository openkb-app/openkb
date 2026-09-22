<?php

declare(strict_types=1);

namespace Drupal\Tests\vercel_ai_sdk\Kernel;

use Drupal\Core\Form\FormState;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\ai\OperationType\Chat\ChatMessage;
use Drupal\ai\OperationType\Chat\Tools\ToolsFunctionInput;
use Drupal\ai\OperationType\Chat\Tools\ToolsFunctionOutput;
use Drupal\ai\OperationType\Chat\Tools\ToolsPropertyInput;
use Drupal\ai\OperationType\Chat\Tools\ToolsPropertyResult;
use Drupal\ai_assistant_api\Entity\AiAssistant;
use Drupal\vercel_ai_sdk\Stream\UiMessage;
use Drupal\vercel_ai_sdk\Stream\UiMessageStream;
use Drupal\vercel_ai_sdk_test\Form\ProcessorConfigForm;
use Drupal\vercel_ai_sdk_test\Plugin\AiFunctionCall\ScriptedFunctionCall;
use Drupal\vercel_ai_sdk_test\Plugin\AiProvider\ScriptedProvider;

/**
 * The chat's tool-calling round.
 *
 * A provider with a runnable model is out of scope for a kernel test, so the
 * processor runs over a scripted one: what is under test is the loop the
 * processor runs around a provider, not the provider. Five things have to
 * hold —
 *
 * - the model is offered exactly the site's Tool API function calls,
 * - a picked tool set narrows that offer, and survives the save that picked
 *   it — a configured set that reaches a turn in the wrong shape matches
 *   nothing and empties the chat,
 * - a call it makes is executed and its result fed back, so the next round
 *   reasons over real data rather than over the request for it,
 * - a model that will not stop asking is cut off and made to answer,
 * - every question and every call is answered for the chatting account.
 *
 * @group vercel_ai_sdk
 */
final class ChatToolLoopTest extends KernelTestBase {

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
    'key',
    'file',
    'ai',
    'ai_assistant_api',
    'vercel_ai_sdk',
    'vercel_ai_sdk_test',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installConfig(['user']);
    ScriptedProvider::$answers = [];
    ScriptedProvider::$inputs = [];
    ScriptedProvider::$callTags = [];
    ScriptedProvider::$metadata = [];
    ScriptedFunctionCall::$names = [];
    ScriptedFunctionCall::$results = [];
    ScriptedFunctionCall::$calls = [];
    ScriptedFunctionCall::$accounts = [];
    // The entity's own properties are typed and mostly non-nullable, so a
    // scripted assistant has to be complete rather than minimal.
    AiAssistant::create([
      'id' => 'scripted',
      'label' => 'Scripted',
      'description' => 'Scripted provider, for the loop.',
      'llm_provider' => 'scripted',
      'llm_model' => 'scripted-1',
      'llm_configuration' => [],
      'instructions' => 'Be brief.',
      'system_role' => 'assistant',
      'allow_history' => 'session',
      'history_context_length' => '4',
      'preprompt_instructions' => '',
      'assistant_message' => '',
      'error_message' => '',
      'specific_error_messages' => [],
    ])->save();
  }

  /**
   * A tool call is executed and its result carried into the next round.
   */
  public function testToolCallIsRunAndFedBack(): void {
    $this->script([
      $this->toolCall('call-1', 'listSpaces', ['access' => 'write']),
      new ChatMessage('assistant', 'You may write in Ops.'),
    ]);
    $this->tools(['listSpaces' => ['text' => 'Ops', 'data' => ['spaces' => [['slug' => 'ops']]]]]);

    $parts = $this->turn();

    self::assertSame(
      ['start', 'start-step', 'reasoning-start', 'reasoning-delta', 'reasoning-end', 'finish-step',
        'tool-input-available', 'tool-output-available',
        'start-step', 'text-start', 'text-delta', 'text-delta', 'text-end', 'finish-step', 'finish',
      ],
      array_column($parts, 'type'),
    );

    $call = $this->firstOfType($parts, 'tool-input-available');
    self::assertSame('listSpaces', $call['toolName']);
    self::assertSame('call-1', $call['toolCallId']);
    self::assertSame(['access' => 'write'], $call['input']);

    $output = $this->firstOfType($parts, 'tool-output-available');
    self::assertSame(['spaces' => [['slug' => 'ops']]], $output['output']);

    // The tool ran with what the model asked for.
    self::assertSame([['listSpaces', ['access' => 'write']]], ScriptedFunctionCall::$calls);

    // And its result reached the next round as a `tool` message, so the answer
    // is grounded in the data rather than in the request for it.
    $roles = array_map(
      static fn (ChatMessage $m): string => $m->getRole(),
      ScriptedProvider::$inputs[1]->getMessages(),
    );
    self::assertSame(['user', 'assistant', 'tool'], $roles);
    self::assertSame('Ops', ScriptedProvider::$inputs[1]->getMessages()[2]->getText());
  }

  /**
   * The model is offered the site's tool function calls, and nothing else.
   */
  public function testTheModelIsOfferedTheToolFunctionCalls(): void {
    $this->script([new ChatMessage('assistant', 'Hello.')]);
    $this->tools(['listSpaces' => NULL, 'searchPages' => NULL]);
    $this->turn();

    self::assertSame(['listSpaces', 'searchPages'], $this->offered());
  }

  /**
   * A site with no tools has a chat with no tools.
   */
  public function testNoToolsMeansNoTools(): void {
    $this->script([new ChatMessage('assistant', 'Hello.')]);
    $this->turn();
    self::assertNull(ScriptedProvider::$inputs[0]->getChatTools());
  }

  /**
   * A configured tool set narrows what a turn may offer and run.
   *
   * The processor is the gate, not the provider: a tool left out of the
   * configuration is neither mentioned to the model nor executed if it asks
   * for it anyway.
   */
  public function testTheConfiguredToolSetNarrowsTheOffer(): void {
    $this->script([
      $this->toolCall('call-1', 'searchPages', []),
      new ChatMessage('assistant', 'Sorry.'),
    ]);
    $this->tools(['listSpaces' => NULL, 'searchPages' => ['text' => 'pages', 'data' => []]]);

    $this->turn(['scripted_tool:listSpaces']);

    self::assertSame(['listSpaces'], $this->offered());
    self::assertSame([], ScriptedFunctionCall::$calls, 'A tool outside the set is never executed.');
    $fed = ScriptedProvider::$inputs[1]->getMessages()[2];
    self::assertSame('tool', $fed->getRole());
    self::assertStringContainsString('No tool named "searchPages"', $fed->getText());
  }

  /**
   * Two picked tools narrow the offer to those two, and refuse a third.
   *
   * The single-selection case would pass on a configuration holding one
   * comma-joined string, which is the shape the tool picker's own hidden field
   * carries; two is what tells the two apart.
   */
  public function testTwoPickedToolsNarrowToThoseTwo(): void {
    $this->script([
      $this->toolCall('call-1', 'createPage', []),
      new ChatMessage('assistant', 'Sorry.'),
    ]);
    $this->tools([
      'listSpaces' => ['text' => 'spaces', 'data' => []],
      'searchPages' => ['text' => 'pages', 'data' => []],
      'createPage' => ['text' => 'made', 'data' => []],
    ]);

    $this->turn(['scripted_tool:listSpaces', 'scripted_tool:searchPages']);

    self::assertSame(['listSpaces', 'searchPages'], $this->offered());
    self::assertSame([], ScriptedFunctionCall::$calls, 'A tool outside the set is never executed.');
    $fed = ScriptedProvider::$inputs[1]->getMessages()[2];
    self::assertStringContainsString('No tool named "createPage"', $fed->getText());
  }

  /**
   * Picking tools in the form stores the ids the turn narrows by.
   *
   * The picker is `ai_tools_library`, whose hidden field carries the selection
   * as one comma-joined string. What a save leaves in `tools` has to be the
   * list of ids, because that is what a turn matches a function call against —
   * a stored string would match nothing and quietly empty the chat.
   */
  public function testPickedToolsSurviveTheConfigurationForm(): void {
    $this->tools(['listSpaces' => NULL, 'searchPages' => NULL]);

    $form_state = new FormState();
    // What the browser posts: the picker's hidden field, by its own name.
    $form_state->setValues([
      'assistant_id' => 'scripted',
      'tools' => 'scripted_tool:listSpaces,scripted_tool:searchPages',
    ]);
    $this->container->get('form_builder')->submitForm(ProcessorConfigForm::class, $form_state);

    $configuration = $this->container->get('state')->get(ProcessorConfigForm::STATE_KEY);
    self::assertSame(
      ['scripted_tool:listSpaces', 'scripted_tool:searchPages'],
      $configuration['tools'],
    );
  }

  /**
   * A model that keeps calling tools is eventually made to answer.
   *
   * The last round withholds the tools, so the cap is not just a counter — the
   * model is left with no way to ask again.
   */
  public function testTheLoopIsCapped(): void {
    $this->script(array_fill(0, 10, $this->toolCall('c', 'listSpaces', [])));
    $this->tools(['listSpaces' => ['text' => 'ok', 'data' => []]]);

    $parts = $this->turn();

    self::assertCount(4, ScriptedProvider::$inputs);
    self::assertNotNull(ScriptedProvider::$inputs[2]->getChatTools());
    self::assertNull(ScriptedProvider::$inputs[3]->getChatTools(), 'The last round is asked without tools.');
    self::assertSame('finish', end($parts)['type']);
  }

  /**
   * A tool the site does not have is reported to the model, not thrown.
   */
  public function testUnknownToolIsAnsweredAsResult(): void {
    $this->script([
      $this->toolCall('call-1', 'deletEverything', []),
      new ChatMessage('assistant', 'Sorry.'),
    ]);
    $this->tools(['listSpaces' => NULL]);
    $this->turn();

    $fed = ScriptedProvider::$inputs[1]->getMessages()[2];
    self::assertSame('tool', $fed->getRole());
    self::assertStringContainsString('No tool named "deletEverything"', $fed->getText());
  }

  /**
   * Tools are offered and executed as the account that is chatting.
   *
   * This is the security property the whole tool layer rests on: the model may
   * only reach what the person chatting could have reached themselves. The
   * processor must therefore never switch accounts around a tool round — a
   * turn run by one user must consult and call its providers as that user.
   */
  public function testToolsRunAsTheChattingUser(): void {
    $chatter = $this->createUser();
    $this->setCurrentUser($chatter);

    $this->script([
      $this->toolCall('call-1', 'listSpaces', []),
      new ChatMessage('assistant', 'Done.'),
    ]);
    $this->tools(['listSpaces' => ['text' => 'ok', 'data' => []]]);

    $this->turn();

    self::assertSame([(int) $chatter->id()], array_unique(ScriptedFunctionCall::$accounts));
  }

  /**
   * Runs one turn and returns its parts.
   *
   * @param string[] $configuredTools
   *   Function call plugin ids the processor is configured with, or none.
   */
  private function turn(array $configuredTools = []): array {
    $processor = $this->container->get('plugin.manager.ai.chat_processor')->createInstance(
      'vercel_ai_sdk',
      ['assistant_id' => 'scripted', 'tools' => $configuredTools],
    );
    $processor->setInput(UiMessage::toChatInput(
      [['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'Where may I write?']]]],
      NULL,
    ));

    $stream = $processor->execute()->getNormalized();
    self::assertInstanceOf(UiMessageStream::class, $stream);
    $parts = [];
    foreach ($stream->doIterate() as $chunk) {
      $parts[] = UiMessageStream::part($chunk);
    }
    return $parts;
  }

  /**
   * The names offered to the model on the first round.
   *
   * @return string[]
   *   The function names, in order.
   */
  private function offered(): array {
    $offered = ScriptedProvider::$inputs[0]->getChatTools();
    self::assertNotNull($offered);
    return array_values(array_map(
      static fn (ToolsFunctionInput $f): string => $f->getName(),
      $offered->getFunctions(),
    ));
  }

  /**
   * Scripts what the provider answers this turn with, in order.
   */
  private function script(array $answers): void {
    ScriptedProvider::$answers = $answers;
  }

  /**
   * An assistant message asking for one tool.
   */
  private function toolCall(string $id, string $name, array $arguments): ChatMessage {
    $call = new ToolsFunctionOutput(new ToolsFunctionInput($name), $id, []);
    $call->setName($name);
    foreach ($arguments as $key => $value) {
      $call->addArgument(new ToolsPropertyResult(new ToolsPropertyInput($key), $value));
    }
    $message = new ChatMessage('assistant', '');
    $message->setTools([$call]);
    return $message;
  }

  /**
   * Scripts the site's tool function calls and what each one answers.
   *
   * @param array<string, array{text: string, data: array}|null> $results
   *   The result per function name, in offer order. NULL for a tool the test
   *   does not run.
   */
  private function tools(array $results): void {
    ScriptedFunctionCall::$names = array_keys($results);
    ScriptedFunctionCall::$results = array_filter($results);
  }

  /**
   * The first part of a type.
   */
  private function firstOfType(array $parts, string $type): array {
    foreach ($parts as $part) {
      if ($part['type'] === $type) {
        return $part;
      }
    }
    $this->fail("No $type part was emitted.");
  }

}
