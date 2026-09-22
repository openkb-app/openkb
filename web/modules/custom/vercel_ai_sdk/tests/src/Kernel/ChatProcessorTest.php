<?php

declare(strict_types=1);

namespace Drupal\Tests\vercel_ai_sdk\Kernel;

use Drupal\Core\Logger\RfcLogLevel;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\ai\Event\PreGenerateResponseEvent;
use Drupal\ai\OperationType\Chat\ChatInput;
use Drupal\ai\OperationType\Chat\ChatMessage;
use Drupal\ai\OperationType\Chat\ChatOutput;
use Drupal\ai\Plugin\ChatProcessor\ChatProcessorInterface;
use Drupal\ai_assistant_api\Entity\AiAssistant;
use Drupal\vercel_ai_sdk\Exception\ChatUnavailableException;
use Drupal\vercel_ai_sdk\Plugin\ChatProcessor\VercelAiSdkProcessor;
use Drupal\vercel_ai_sdk\Stream\UiMessage;
use Drupal\vercel_ai_sdk\Stream\UiMessageStream;
use Drupal\vercel_ai_sdk_test\Plugin\AiProvider\ScriptedProvider;
use Drupal\vercel_ai_sdk_test\StreamedAnswer;
use Psr\Log\AbstractLogger;

/**
 * The ChatProcessor contract, as this module depends on it.
 *
 * `drupal/ai` 1.5 ships the ChatProcessor plugin type without change records,
 * so every part of the contract the chat relies on is pinned here rather than
 * assumed: input handling, what execute() hands back, that the answer streams,
 * how history is answered from the client-held conversation, and who may run
 * a turn.
 *
 * @group vercel_ai_sdk
 */
final class ChatProcessorTest extends KernelTestBase {

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
    // Ships the keyless `echoai` provider the default-resolution case runs on.
    'ai_test',
    // The real provider a fresh install points the assistant at, unkeyed here.
    'ai_provider_openai',
    'vercel_ai_sdk',
    'vercel_ai_sdk_test',
  ];

  /**
   * Records everything logged on the module's channel.
   */
  private AbstractLogger $recorder;

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
    $this->createAssistant('scripted', 'scripted', 'scripted-1');

    $this->recorder = new class() extends AbstractLogger {
      /**
       * Every record logged, as [level, message] pairs.
       *
       * @var array<int, array{0: mixed, 1: string}>
       */
      public array $records = [];

      /**
       * {@inheritdoc}
       */
      public function log($level, $message, array $context = []): void {
        $this->records[] = [$level, (string) $message];
      }

    };
    // Attached to the module's own channel, not the factory: the channel is
    // built from `logger.channel_base` rather than through
    // LoggerChannelFactory::get(), so the factory never sees it.
    $this->container->get('logger.channel.vercel_ai_sdk')->addLogger($this->recorder);
  }

  /**
   * The plugin is discovered as a ChatProcessor and configured per instance.
   */
  public function testPluginIsRegisteredAsProcessor(): void {
    $processor = $this->processor('scripted');
    self::assertInstanceOf(ChatProcessorInterface::class, $processor);
    self::assertInstanceOf(VercelAiSdkProcessor::class, $processor);
    // Defaults fill in around what the caller passed.
    self::assertSame(['assistant_id' => 'scripted', 'tools' => []], $processor->getConfiguration());
  }

  /**
   * Execution without input is refused by the contract, not attempted.
   */
  public function testInputIsRequired(): void {
    $this->expectException(\InvalidArgumentException::class);
    $this->processor('scripted')->execute();
  }

  /**
   * The input carries the conversation and the caller context.
   */
  public function testInputCarriesConversationAndContext(): void {
    $input = UiMessage::toChatInput(
      [
        ['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'Hello?']]],
        ['role' => 'assistant', 'content' => 'Hi.'],
        // Textless messages carry nothing to reason over.
        ['role' => 'user', 'parts' => []],
      ],
      ['query' => 'getting'],
    );

    self::assertSame(
      [['user', 'Hello?'], ['assistant', 'Hi.']],
      array_map(static fn (ChatMessage $m): array => [$m->getRole(), $m->getText()], $input->getMessages()),
    );
    self::assertSame(['query' => 'getting'], $input->getRequestMetadataValue(UiMessage::CONTEXT_KEY));
  }

  /**
   * Execute hands back a streamed output carrying UI-message parts.
   *
   * Two views of one answer: our controller reads the parts, and a generic
   * drupal/ai consumer iterating the same output reads the prose.
   */
  public function testExecuteStreamsUiMessageParts(): void {
    ScriptedProvider::$answers = [new ChatMessage('assistant', 'The kb covers onboarding.')];
    $processor = $this->processor('scripted');
    $processor->setInput($this->userTurn());

    $output = $processor->execute();
    self::assertInstanceOf(ChatOutput::class, $output);
    self::assertSame($output, $processor->getOutput());

    $stream = $output->getNormalized();
    self::assertInstanceOf(UiMessageStream::class, $stream);

    $parts = [];
    $text = '';
    foreach ($stream->doIterate() as $chunk) {
      $parts[] = UiMessageStream::part($chunk);
      $text .= $chunk->getText();
    }

    self::assertSame(
      ['start', 'start-step', 'reasoning-start', 'reasoning-delta', 'reasoning-end',
        'text-start', 'text-delta', 'text-delta', 'text-end', 'finish-step', 'finish',
      ],
      array_column($parts, 'type'),
    );
    self::assertSame('The kb covers onboarding.', $text);
    // The whole answer is not one frame, so the drawer animates it.
    self::assertGreaterThan(1, count(array_filter($parts, static fn (array $p): bool => $p['type'] === 'text-delta')));
  }

  /**
   * The call says which assistant is asking, so a subscriber can scope itself.
   */
  public function testTheProviderCallIsTaggedWithTheAssistant(): void {
    $processor = $this->processor('scripted');
    $processor->setInput($this->userTurn());
    $this->parts($processor->execute());

    self::assertSame([['ai_assistant_api_assistant_message_scripted']], ScriptedProvider::$callTags);
  }

  /**
   * What the answer carries beside its text reaches the client as data parts.
   *
   * The bridge names no key: whatever a grounding or retrieval module puts on
   * the response is what the client is offered, under `data-<key>`.
   */
  public function testResponseMetadataReachesTheClientAsDataParts(): void {
    ScriptedProvider::$answers = [new ChatMessage('assistant', 'Onboarding lives in Ops [1].')];
    ScriptedProvider::$metadata = ['citations' => [['n' => 1, 'title' => 'Onboarding']]];
    $processor = $this->processor('scripted');
    $processor->setInput($this->userTurn());

    $parts = $this->parts($processor->execute());

    $citations = $this->firstOfType($parts, 'data-citations');
    self::assertSame([['n' => 1, 'title' => 'Onboarding']], $citations['data']);
    // After the answer and before the turn ends, so the client has the text.
    $types = array_column($parts, 'type');
    self::assertSame(['text-end', 'finish-step', 'data-citations', 'finish'], array_slice($types, -4));
  }

  /**
   * A streamed answer's metadata is read after the stream, not before it.
   *
   * What a streamed answer cited is only knowable once it has been written, so
   * a grounding module sets the metadata from the iterator's own completion
   * callback — long after the bridge began streaming the turn.
   */
  public function testMetadataSetAfterTheStreamStillReachesTheClient(): void {
    $stream = StreamedAnswer::of(['Onboarding lives ', 'in Ops [1].']);
    $stream->addCallback(static function () use ($stream): void {
      $stream->setMetadata(['citations' => [['n' => 1, 'title' => 'Onboarding']]]);
    });
    ScriptedProvider::$answers = [$stream];
    $processor = $this->processor('scripted');
    $processor->setInput($this->userTurn());

    $parts = $this->parts($processor->execute());

    self::assertSame(
      [['n' => 1, 'title' => 'Onboarding']],
      $this->firstOfType($parts, 'data-citations')['data'],
    );
    $types = array_column($parts, 'type');
    self::assertSame(['text-end', 'finish-step', 'data-citations', 'finish'], array_slice($types, -4));
  }

  /**
   * A generic drupal/ai consumer reads the same answer as prose.
   */
  public function testOutputReadsAsPlainStreamedAnswer(): void {
    ScriptedProvider::$answers = [new ChatMessage('assistant', 'The kb covers onboarding.')];
    $processor = $this->processor('scripted');
    $processor->setInput($this->userTurn());

    $text = '';
    foreach ($processor->execute()->getNormalized() as $chunk) {
      $text .= $chunk->getText();
    }
    self::assertSame('The kb covers onboarding.', $text);
  }

  /**
   * An unresolvable assistant throws instead of streaming a substitute turn.
   *
   * The controller picks the HTTP status before it starts streaming, so a
   * failure hidden behind the first yield would surface too late to be
   * anything but a 200.
   */
  public function testMissingAssistantThrowsEagerly(): void {
    // A generator body runs nothing until it is advanced, so the contract is
    // only satisfiable if doExecute() is not one.
    self::assertFalse(
      (new \ReflectionMethod(VercelAiSdkProcessor::class, 'doExecute'))->isGenerator(),
      'doExecute() must resolve eagerly, so it cannot be a generator.',
    );

    $processor = $this->processor('does-not-exist');
    $processor->setInput($this->userTurn());

    $this->expectException(ChatUnavailableException::class);
    $this->expectExceptionMessage('does-not-exist');
    $processor->execute();
  }

  /**
   * The failure is logged at error level, not shrugged off as a warning.
   */
  public function testMissingAssistantIsLoggedAsError(): void {
    $processor = $this->processor('does-not-exist');
    $processor->setInput($this->userTurn());
    try {
      $processor->execute();
    }
    catch (ChatUnavailableException) {
      // The log record is what this case asserts on.
    }

    $errors = array_filter(
      $this->recorder->records,
      static fn (array $record): bool => $record[0] === RfcLogLevel::ERROR,
    );
    self::assertNotEmpty($errors, 'The unavailable assistant was logged at error level.');
    self::assertStringContainsString('not found', implode("\n", array_column($errors, 1)));
  }

  /**
   * A provider that fails mid-turn is reported in-band, as an error part.
   *
   * By then the status is committed, so the AI-SDK protocol's own `error` part
   * is the only channel left; the drawer renders a failure state from it.
   */
  public function testProviderFailureBecomesAnErrorPart(): void {
    // An assistant with no model resolves to no provider at all.
    $this->createAssistant('broken', '__default__', '');
    $processor = $this->processor('broken');
    $processor->setInput($this->userTurn());

    $parts = $this->parts($processor->execute());
    self::assertSame(['error'], array_column($parts, 'type'));
    self::assertSame('The AI provider call failed.', $parts[0]['errorText']);
  }

  /**
   * A real provider with no key answers the error state, not a fatal.
   *
   * What a fresh install ships: the assistant points at OpenAI and nobody has
   * entered a key yet. The turn has to end as a state the drawer can render.
   */
  public function testKeylessRealProviderIsReportedInBand(): void {
    $this->createAssistant('unkeyed', 'openai', 'gpt-4o-mini');
    $processor = $this->processor('unkeyed');
    $processor->setInput($this->userTurn());

    $parts = $this->parts($processor->execute());

    self::assertContains('error', array_column($parts, 'type'));
    self::assertSame('The AI provider call failed.', $this->firstOfType($parts, 'error')['errorText']);
  }

  /**
   * A failed turn is reported in the assistant's own words.
   *
   * The exception names internals and goes to the log; what reaches the reader
   * is the wording an operator set on the assistant.
   */
  public function testTheAssistantsErrorMessageIsWhatTheReaderIsShown(): void {
    $this->createAssistant('worded', '__default__', '', TRUE, 'The AI backend is unavailable right now.');
    $processor = $this->processor('worded');
    $processor->setInput($this->userTurn());

    $parts = $this->parts($processor->execute());

    self::assertSame('The AI backend is unavailable right now.', $this->firstOfType($parts, 'error')['errorText']);
  }

  /**
   * A provider's own transport in the caller context stays out of the prompt.
   *
   * The context is appended to the system prompt for the model to reason over.
   * `mock` is a scripted answer addressed to one provider, so on a keyed
   * environment it would otherwise be pasted into a real model's prompt.
   */
  public function testProviderTransportDoesNotReachTheModelsPrompt(): void {
    $processor = $this->processor('scripted');
    $processor->setInput(UiMessage::toChatInput(
      [['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'Where may I write?']]]],
      ['route' => '/general/getting-started', 'mock' => ['text' => 'Scripted.']],
    ));

    $this->parts($processor->execute());

    $prompt = ScriptedProvider::$inputs[0]->getSystemPrompt();
    self::assertStringContainsString('/general/getting-started', $prompt);
    self::assertStringNotContainsString('Scripted.', $prompt);
    // The provider still gets the whole context: that is how it is scripted.
    self::assertArrayHasKey('mock', ScriptedProvider::$inputs[0]->getRequestMetadataValue(UiMessage::CONTEXT_KEY));
  }

  /**
   * The caller's own context is not published back as a data part.
   *
   * It travels with the call and drupal/ai returns it in the response
   * metadata, so without the skip the client is handed its own request.
   */
  public function testTheCallerContextIsNotPublishedBack(): void {
    ScriptedProvider::$answers = [new ChatMessage('assistant', 'Onboarding lives in Ops [1].')];
    ScriptedProvider::$metadata = [
      UiMessage::CONTEXT_KEY => ['route' => '/general/getting-started'],
      'citations' => [['n' => 1, 'title' => 'Onboarding']],
    ];
    $processor = $this->processor('scripted');
    $processor->setInput($this->userTurn());

    $types = array_column($this->parts($processor->execute()), 'type');

    self::assertContains('data-citations', $types);
    self::assertNotContains('data-' . UiMessage::CONTEXT_KEY, $types);
  }

  /**
   * The assistant decides the provider; "Default" defers to the site default.
   *
   * `__default__` is the only case in which `ai.settings` reaches this path.
   * An assistant naming a provider outright is served by that provider no
   * matter what the site default says.
   */
  public function testProviderResolution(): void {
    $this->config('ai.settings')
      ->set('default_providers.chat.provider_id', 'echoai')
      ->set('default_providers.chat.model_id', 'gpt-test')
      ->save();

    $this->createAssistant('site_default', '__default__', '');
    $this->createAssistant('named', 'echoai', 'gpt-awesome');

    self::assertStringContainsString('echoai (gpt-test)', $this->turnText('site_default'));
    self::assertStringContainsString('echoai (gpt-awesome)', $this->turnText('named'));
  }

  /**
   * A turn is streamed, except by the provider that cannot stream one.
   *
   * `ChatInput` defaults to no streaming, so a provider is served frame by
   * frame only because the bridge asks it to. `echoai`'s streaming iterator is
   * unusable outside PHPUnit, so that one call is made unstreamed and
   * re-chunked on the way out.
   */
  public function testTheProviderIsAskedToStreamUnlessItCannot(): void {
    $streamed = [];
    $this->container->get('event_dispatcher')->addListener(
      PreGenerateResponseEvent::EVENT_NAME,
      static function (PreGenerateResponseEvent $event) use (&$streamed): void {
        $streamed[$event->getProviderId()] = $event->getInput()->isStreamedOutput();
      },
    );
    $this->createAssistant('echo', 'echoai', 'gpt-test');

    $this->turnText('scripted');
    $this->turnText('echo');

    self::assertTrue($streamed['scripted']);
    self::assertFalse($streamed['echoai']);
  }

  /**
   * Who may run a turn: the permission, and an assistant that is switched on.
   */
  public function testAccess(): void {
    $this->createAssistant('off', 'scripted', 'scripted-1', FALSE);

    $chatter = $this->createUser(['use vercel ai sdk chat']);
    $stranger = $this->createUser();

    self::assertTrue($this->processor('scripted')->access($chatter)->isAllowed());
    self::assertFalse($this->processor('scripted')->access($stranger)->isAllowed());
    // A disabled assistant serves nobody, permission or not.
    self::assertFalse($this->processor('off')->access($chatter)->isAllowed());

    // The answer varies by who is asking and follows the assistant.
    $access = $this->processor('scripted')->access($chatter);
    self::assertContains('user.permissions', $access->getCacheContexts());
    self::assertContains('config:ai_assistant_api.ai_assistant.scripted', $access->getCacheTags());
  }

  /**
   * History is the client-held conversation, plus the reply once it lands.
   *
   * Nothing is stored server-side: every turn arrives complete in the request,
   * so the contract is answered from the input rather than from a thread.
   */
  public function testMessageHistoryIsTheClientHeldConversation(): void {
    $processor = $this->processor('scripted');
    self::assertSame([], $processor->getMessageHistory());

    $processor->setInput(UiMessage::toChatInput([
      ['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'Where may I write?']]],
      ['role' => 'assistant', 'parts' => [['type' => 'text', 'text' => 'In Ops.']]],
      ['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'And read?']]],
    ], NULL));

    self::assertSame(
      [
        ['role' => 'user', 'message' => 'Where may I write?'],
        ['role' => 'assistant', 'message' => 'In Ops.'],
        ['role' => 'user', 'message' => 'And read?'],
      ],
      $processor->getMessageHistory(),
    );

    $processor->onStreamComplete('Everywhere.');
    self::assertSame(
      ['role' => 'assistant', 'message' => 'Everywhere.'],
      array_slice($processor->getMessageHistory(), -1)[0],
    );

    // A reset hands back a new thread name for the client to collect under.
    $reset = $processor->resetThread('t-old');
    self::assertNotSame('t-old', $reset);
    self::assertCount(3, $processor->getMessageHistory());
  }

  /**
   * The turn is text: the UI-message serializer carries no files or images.
   */
  public function testNoFilesAreAccepted(): void {
    $processor = $this->processor('scripted');
    self::assertFalse($processor->allowsImages());
    self::assertSame([], $processor->allowedFileExtensions());
  }

  /**
   * A configured processor instance.
   */
  private function processor(string $assistantId): ChatProcessorInterface {
    /** @var \Drupal\ai\Plugin\ChatProcessor\ChatProcessorInterface $processor */
    $processor = $this->container->get('plugin.manager.ai.chat_processor')
      ->createInstance('vercel_ai_sdk', ['assistant_id' => $assistantId]);
    return $processor;
  }

  /**
   * One user turn, in the AI-SDK UI-message shape the controller passes on.
   */
  private function userTurn(): ChatInput {
    return UiMessage::toChatInput(
      [['role' => 'user', 'parts' => [['type' => 'text', 'text' => 'Where may I write?']]]],
      NULL,
    );
  }

  /**
   * The first part of a type.
   *
   * @param array<int, array<string, mixed>> $parts
   *   The turn's parts.
   * @param string $type
   *   The part type.
   *
   * @return array<string, mixed>
   *   The part.
   */
  private function firstOfType(array $parts, string $type): array {
    foreach ($parts as $part) {
      if ($part['type'] === $type) {
        return $part;
      }
    }
    self::fail(sprintf('No "%s" part in the turn.', $type));
  }

  /**
   * The decoded UI-message parts of one output.
   */
  private function parts(ChatOutput $output): array {
    $stream = $output->getNormalized();
    self::assertInstanceOf(UiMessageStream::class, $stream);
    $parts = [];
    foreach ($stream->doIterate() as $chunk) {
      $parts[] = UiMessageStream::part($chunk);
    }
    return $parts;
  }

  /**
   * One turn, as the concatenated part bodies.
   */
  private function turnText(string $assistantId): string {
    $processor = $this->processor($assistantId);
    $processor->setInput($this->userTurn());
    return implode("\n", array_map(
      static fn (array $part): string => UiMessage::encode($part),
      $this->parts($processor->execute()),
    ));
  }

  /**
   * An assistant entity with the given provider selection.
   *
   * AiAssistant declares non-nullable typed properties, so every one of them
   * has to carry a value even where this test does not care about it.
   */
  private function createAssistant(string $id, string $provider, string $model, bool $status = TRUE, string $errorMessage = ''): void {
    AiAssistant::create([
      'id' => $id,
      'label' => $id,
      'status' => $status,
      'description' => '',
      'allow_history' => 'none',
      'system_role' => 'assistant',
      'instructions' => 'Be brief.',
      'preprompt_instructions' => '',
      'assistant_message' => '',
      'error_message' => $errorMessage,
      'specific_error_messages' => [],
      'llm_provider' => $provider,
      'llm_model' => $model,
      'llm_configuration' => [],
    ])->save();
  }

}
