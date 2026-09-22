<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk\Plugin\ChatProcessor;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\Plugin\ContainerFactoryPluginInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\ai\AiProviderInterface;
use Drupal\ai\AiProviderPluginManager;
use Drupal\ai\Attribute\ChatProcessor;
use Drupal\ai\Base\ChatProcessorBase;
use Drupal\ai\OperationType\Chat\ChatInput;
use Drupal\ai\OperationType\Chat\ChatMessage;
use Drupal\ai\OperationType\Chat\ChatOutput;
use Drupal\ai\OperationType\Chat\StreamedChatMessageIteratorInterface;
use Drupal\ai\OperationType\Chat\Tools\ToolsInput;
use Drupal\ai_assistant_api\Entity\AiAssistant;
use Drupal\vercel_ai_sdk\Exception\ChatUnavailableException;
use Drupal\vercel_ai_sdk\Service\ChatToolRegistry;
use Drupal\vercel_ai_sdk\Stream\UiMessage;
use Drupal\vercel_ai_sdk\Stream\UiMessageStream;
use Psr\Log\LoggerInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Serves a chat turn as Vercel AI SDK UI-message parts.
 *
 * The configured `ai_assistant` entity decides provider, model and the system
 * prompt, which is its Instructions field. Upstream provides neither the
 * UI-message serializer nor the round loop that lets a turn call tools before
 * it answers, so both live here.
 *
 * History is client-held: every turn arrives complete in the request, and the
 * history contract is answered from the input, not from a server-side store.
 */
#[ChatProcessor(
  id: 'vercel_ai_sdk',
  label: new TranslatableMarkup('Vercel AI SDK chat'),
  description: new TranslatableMarkup('Streams an AI Assistant as Vercel AI SDK UI-message parts, with a tool-calling round loop.'),
)]
final class VercelAiSdkProcessor extends ChatProcessorBase implements ContainerFactoryPluginInterface {

  use StringTranslationTrait;

  /**
   * Provider whose streaming iterator is unusable outside PHPUnit.
   */
  private const NON_STREAMING_PROVIDER = 'echoai';

  /**
   * How many times a turn may call tools before it has to answer.
   *
   * Every round is a provider call the user waits on, so a model that keeps
   * asking for tools answers from what it has instead.
   */
  private const MAX_TOOL_ROUNDS = 3;

  /**
   * The assistant replies completed on this thread, in order.
   *
   * @var array<int, array{role: string, message: string}>
   */
  private array $completed = [];

  /**
   * Constructs the processor.
   */
  public function __construct(
    array $configuration,
    string $plugin_id,
    mixed $plugin_definition,
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly AiProviderPluginManager $aiProvider,
    private readonly ChatToolRegistry $tools,
    private readonly LoggerInterface $logger,
  ) {
    parent::__construct($configuration, $plugin_id, $plugin_definition);
    $this->setConfiguration($configuration);
  }

  /**
   * {@inheritdoc}
   */
  public function setConfiguration(array $configuration): void {
    $this->configuration = $configuration + $this->defaultConfiguration();
  }

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): self {
    return new self(
      $configuration,
      $plugin_id,
      $plugin_definition,
      $container->get('entity_type.manager'),
      $container->get('ai.provider'),
      $container->get('vercel_ai_sdk.tool_registry'),
      $container->get('logger.channel.vercel_ai_sdk'),
    );
  }

  /**
   * {@inheritdoc}
   */
  public function defaultConfiguration(): array {
    return [
      'assistant_id' => '',
      'tools' => [],
    ];
  }

  /**
   * {@inheritdoc}
   *
   * The `ai_tools_library` element posts its selection from a hidden field
   * named `tools` whatever the element is keyed, so the key has to be `tools`.
   */
  public function buildConfigurationForm(array $form, FormStateInterface $form_state): array {
    $options = [];
    foreach ($this->entityTypeManager->getStorage('ai_assistant')->loadMultiple() as $assistant) {
      $options[(string) $assistant->id()] = $assistant->label();
    }
    $form['assistant_id'] = [
      '#type' => 'select',
      '#title' => $this->t('AI Assistant'),
      '#description' => $this->t('Prompt, provider and model for this chat.'),
      '#options' => $options,
      '#default_value' => $this->configuration['assistant_id'],
      '#required' => TRUE,
      '#empty_option' => $this->t('- Select an Assistant -'),
    ];

    $form['tools'] = [
      '#type' => 'ai_tools_library',
      '#title' => $this->t('Tools'),
      '#description' => $this->t('The tools this chat offers the model. Select none to offer every tool the chatting account may call.'),
      '#default_value' => $this->configuration['tools'],
    ];

    return $form;
  }

  /**
   * {@inheritdoc}
   */
  public function submitConfigurationForm(array &$form, FormStateInterface $form_state): void {
    $this->setConfiguration([
      'assistant_id' => (string) $form_state->getValue('assistant_id'),
      'tools' => array_values(array_filter((array) $form_state->getValue('tools'))),
    ]);
  }

  /**
   * {@inheritdoc}
   *
   * A missing assistant is a misconfiguration, not an access answer, so
   * execute() reports it as unavailable instead.
   */
  public function access(AccountInterface $account): AccessResultInterface {
    $assistant = $this->loadAssistant();
    if ($assistant && !$assistant->status()) {
      return AccessResult::forbidden('The AI Assistant is disabled.')->addCacheableDependency($assistant);
    }
    $access = AccessResult::allowedIfHasPermission($account, 'use vercel ai sdk chat');
    return $assistant ? $access->addCacheableDependency($assistant) : $access;
  }

  /**
   * {@inheritdoc}
   *
   * The conversation the client sent, plus any reply completed since. Nothing
   * is stored server-side, so no thread id is needed to read it.
   */
  public function getMessageHistory(): array {
    $history = [];
    foreach ($this->getInput()?->getMessages() ?? [] as $message) {
      if ($message instanceof ChatMessage) {
        $history[] = ['role' => $message->getRole(), 'message' => $message->getText()];
      }
    }
    return array_merge($history, $this->completed);
  }

  /**
   * {@inheritdoc}
   */
  public function onStreamComplete(string $message): void {
    if ($message !== '') {
      $this->completed[] = ['role' => 'assistant', 'message' => $message];
    }
  }

  /**
   * {@inheritdoc}
   *
   * The client holds the history, so a reset is only a new name for it to
   * collect under.
   */
  public function resetThread($thread_id): string {
    $this->completed = [];
    return 't-' . bin2hex(random_bytes(8));
  }

  /**
   * {@inheritdoc}
   */
  public function allowsImages(): bool {
    return FALSE;
  }

  /**
   * {@inheritdoc}
   */
  public function allowedFileExtensions(): array {
    return [];
  }

  /**
   * {@inheritdoc}
   *
   * Everything a turn needs is resolved before returning: once the first part
   * is written the status is committed, and a failure can only be said in-band.
   *
   * @throws \Drupal\vercel_ai_sdk\Exception\ChatUnavailableException
   *   When no turn can be served for this assistant.
   */
  public function doExecute(): ChatOutput {
    $input = $this->getInput();
    if (!$input) {
      throw new \InvalidArgumentException('Chat input must be set before execution.');
    }
    $assistantId = (string) $this->configuration['assistant_id'];
    $assistant = $this->loadAssistant();
    if (!$assistant) {
      $this->logger->error('AI assistant "@id" not found; no chat turn can be served.', ['@id' => $assistantId]);
      throw new ChatUnavailableException(sprintf('AI assistant "%s" is not available.', $assistantId));
    }

    return new ChatOutput(new UiMessageStream($this->turn($assistant, $input)), NULL, []);
  }

  /**
   * Yields the turn's parts, or the protocol's error part if it fails.
   */
  private function turn(AiAssistant $assistant, ChatInput $input): \Generator {
    try {
      yield from $this->rounds($assistant, $input);
    }
    catch (\Throwable $e) {
      $this->logger->error('drupal/ai provider call failed for assistant "@id": @msg', [
        '@id' => (string) $this->configuration['assistant_id'],
        '@msg' => $e->getMessage(),
      ]);
      // The assistant's own wording, which is what a reader is shown; the
      // exception is for the log, since it names internals.
      $message = trim((string) ($assistant->get('error_message') ?? ''));
      yield [
        'type' => 'error',
        'errorText' => $message !== '' ? $message : 'The AI provider call failed.',
      ];
    }
  }

  /**
   * The tool round loop: ask, run what was asked for, ask again.
   */
  private function rounds(AiAssistant $assistant, ChatInput $input): \Generator {
    [$providerId, $modelId] = $this->resolveProvider($assistant);
    if ($providerId === '' || $modelId === '') {
      throw new \RuntimeException('AI Assistant has no provider/model configured.');
    }
    $chatMessages = $input->getMessages();
    if (!$chatMessages) {
      throw new \RuntimeException('No user messages in payload.');
    }

    /** @var \Drupal\ai\OperationType\Chat\ChatInterface $provider */
    $provider = $this->aiProvider->createInstance($providerId);
    $systemPrompt = $this->systemPrompt($assistant, $input);
    // The tools this account may call, asked once for the whole turn. What the
    // registry offers is what the model is given; nothing here names a tool.
    $functions = $this->tools->functions((array) $this->configuration['tools']);

    // drupal/ai's tag convention, so a subscriber can act on one assistant's
    // calls and leave the rest alone.
    $tags = ['ai_assistant_api_assistant_message_' . $assistant->id()];

    $messageId = 'm-' . bin2hex(random_bytes(6));
    yield ['type' => 'start', 'messageId' => $messageId];

    for ($round = 0; $round <= self::MAX_TOOL_ROUNDS; $round++) {
      yield ['type' => 'start-step'];

      $roundInput = new ChatInput($chatMessages);
      if ($systemPrompt !== '') {
        $roundInput->setSystemPrompt($systemPrompt);
      }
      // The caller context travels with the call, so a provider can answer one
      // request differently without the bridge naming a key of it.
      $context = $input->getRequestMetadataValue(UiMessage::CONTEXT_KEY);
      if ($context !== NULL) {
        $roundInput->setRequestMetadataValue(UiMessage::CONTEXT_KEY, $context);
      }
      // A turn is served frame by frame, so the provider is asked to stream.
      // `echoai`'s streaming iterator needs a class only the PHPUnit harness
      // autoloads, so it answers whole and readTurn re-chunks it.
      $roundInput->setStreamedOutput($providerId !== self::NON_STREAMING_PROVIDER);
      // Withheld on the last round: a tool asked for there would never run.
      if ($functions && $round < self::MAX_TOOL_ROUNDS) {
        $roundInput->setChatTools(new ToolsInput($functions));
      }

      if ($round === 0) {
        $reasoningId = 'r-' . $messageId;
        yield ['type' => 'reasoning-start', 'id' => $reasoningId];
        yield [
          'type' => 'reasoning-delta',
          'id' => $reasoningId,
          'delta' => 'Asking ' . $providerId . ' (' . $modelId . ')…',
        ];
        yield ['type' => 'reasoning-end', 'id' => $reasoningId];
      }

      $textId = 'tx-' . $messageId . '-' . $round;
      $started = FALSE;
      $calls = [];

      $output = $provider->chat($roundInput, $modelId, $tags);
      $normalized = $output->getNormalized();
      foreach ($this->readTurn($normalized, $calls) as $delta) {
        if (!$started) {
          yield ['type' => 'text-start', 'id' => $textId];
          $started = TRUE;
        }
        yield ['type' => 'text-delta', 'id' => $textId, 'delta' => $delta];
      }
      if ($started) {
        yield ['type' => 'text-end', 'id' => $textId];
      }
      yield ['type' => 'finish-step'];

      if (!$calls) {
        yield from $this->dataParts($output, $normalized);
        break;
      }
      yield from $this->runTools($calls, $chatMessages);
    }

    yield ['type' => 'finish'];
  }

  /**
   * The answering round's response metadata, as the protocol's data parts.
   *
   * A streamed answer's metadata is complete only once the stream is, and the
   * iterator is what carries it.
   */
  private function dataParts(ChatOutput $output, mixed $normalized): \Generator {
    $metadata = $normalized instanceof StreamedChatMessageIteratorInterface
      ? $normalized->getMetadata()
      : $output->getMetadata();
    foreach ((is_array($metadata) ? $metadata : []) as $key => $value) {
      // The caller's own context travels with the call and comes back in the
      // metadata; publishing it would hand the client its own request.
      if ($key === UiMessage::CONTEXT_KEY) {
        continue;
      }
      yield ['type' => 'data-' . $key, 'data' => $value];
    }
  }

  /**
   * The system prompt for a turn, with the caller context appended.
   */
  private function systemPrompt(AiAssistant $assistant, ChatInput $input): string {
    $prompt = (string) ($assistant->get('instructions') ?? '');
    $context = $input->getRequestMetadataValue(UiMessage::CONTEXT_KEY);
    $context = is_array($context) ? UiMessage::modelContext($context) : [];
    if ($context) {
      $prompt .= "\n\nCaller context (JSON): " . json_encode($context, JSON_UNESCAPED_SLASHES);
    }
    return $prompt;
  }

  /**
   * Reads one provider answer as text deltas, collecting any tool calls.
   *
   * Tool calls ride on the chunks of a streamed answer, so they are collected
   * as the text flows: the answer keeps streaming and a tool call is still
   * noticed.
   *
   * @param mixed $normalized
   *   The provider's normalized output.
   * @param array $calls
   *   Collects the tool calls the answer carried, by reference.
   *
   * @return iterable<string>
   *   The text deltas, in order.
   */
  private function readTurn(mixed $normalized, array &$calls): iterable {
    if ($normalized instanceof StreamedChatMessageIteratorInterface) {
      foreach ($normalized as $chunk) {
        $delta = (string) $chunk->getText();
        if ($delta !== '') {
          yield $delta;
        }
      }
      // A chunk carries the provider's own tool-call fragments: one call's
      // name and its arguments arrive split over many of them. The iterator
      // assembles the fragments into drupal/ai's tool calls, and that assembly
      // is complete once the stream is.
      foreach ($normalized->getTools() as $call) {
        $calls[] = $call;
      }
      return;
    }

    if ($normalized instanceof ChatMessage) {
      foreach ($normalized->getTools() ?? [] as $call) {
        $calls[] = $call;
      }
      // Chunk by word so the UI animates the answer instead of dumping it in
      // one frame.
      $words = preg_split('/(\s+)/', $normalized->getText(), -1, PREG_SPLIT_DELIM_CAPTURE) ?: [];
      $buf = '';
      foreach ($words as $w) {
        $buf .= $w;
        if (strlen($buf) >= 12) {
          yield $buf;
          $buf = '';
        }
      }
      if ($buf !== '') {
        yield $buf;
      }
    }
  }

  /**
   * Runs the tools the model asked for and feeds the results back in.
   *
   * Each call is reported as four parts — named, then its arguments, then its
   * result or its failure — so the panel can show a call while it is still
   * running. The results are appended as the assistant's tool-call message plus
   * one `tool` message per call, the shape providers expect a tool round in.
   *
   * @param \Drupal\ai\OperationType\Chat\Tools\ToolsFunctionOutputInterface[] $calls
   *   The calls to run.
   * @param \Drupal\ai\OperationType\Chat\ChatMessage[] $chatMessages
   *   The conversation, appended to by reference.
   */
  private function runTools(array $calls, array &$chatMessages): \Generator {
    $assistantTurn = new ChatMessage('assistant', '');
    $assistantTurn->setTools($calls);
    $chatMessages[] = $assistantTurn;

    foreach ($calls as $call) {
      $arguments = [];
      foreach ($call->getArguments() as $argument) {
        $arguments[$argument->getName()] = $argument->getValue();
      }
      $id = $call->getToolId();
      $name = $call->getName();

      // `dynamic` marks a tool the client holds no schema for. The site decides
      // which tools exist, so every one of them is that, and the client is
      // handed the name as a field instead of having to read it off the part
      // type.
      yield [
        'type' => 'tool-input-start',
        'toolCallId' => $id,
        'toolName' => $name,
        'dynamic' => TRUE,
      ];
      yield [
        'type' => 'tool-input-available',
        'toolCallId' => $id,
        'toolName' => $name,
        'input' => $arguments ?: (object) [],
        'dynamic' => TRUE,
      ];

      $startedAt = hrtime(TRUE);
      $result = $this->tools->call($name, $arguments, (array) $this->configuration['tools']);
      // How long the reader waited on this call. The protocol keeps a result
      // part's provider metadata, which is the one field of it that reaches
      // the client.
      $took = ['vercel_ai_sdk' => ['durationMs' => intdiv(hrtime(TRUE) - $startedAt, 1000000)]];

      // A failed tool is failed on the tool: the turn goes on, and the
      // assistant's own error sentence stays for a turn that could not be
      // served at all.
      yield $result['error'] !== NULL ? [
        'type' => 'tool-output-error',
        'toolCallId' => $id,
        'errorText' => $result['error'],
        'dynamic' => TRUE,
        'providerMetadata' => $took,
      ] : [
        'type' => 'tool-output-available',
        'toolCallId' => $id,
        'output' => $result['data'] ?: ['text' => $result['text']],
        'dynamic' => TRUE,
        'providerMetadata' => $took,
      ];

      $toolTurn = new ChatMessage('tool', $result['text']);
      $toolTurn->setToolsId($id);
      $chatMessages[] = $toolTurn;
    }
  }

  /**
   * The provider and model to serve a turn with.
   *
   * The assistant entity decides, except for its "Default" option, which
   * defers to `ai.settings: default_providers.chat` — the resolution
   * \Drupal\ai_assistant_api\AiAssistantApiRunner::getProviderAndModel() does.
   *
   * @return array{0: string, 1: string}
   *   Provider id and model id, either empty when unresolvable.
   */
  private function resolveProvider(AiAssistant $assistant): array {
    $providerId = (string) $assistant->get('llm_provider');
    $modelId = (string) $assistant->get('llm_model');

    if ($providerId === AiProviderInterface::DEFAULT_MODEL_VALUE) {
      $defaults = $this->aiProvider->getDefaultProviderForOperationType('chat') ?? [];
      $providerId = (string) ($defaults['provider_id'] ?? '');
      $modelId = (string) ($defaults['model_id'] ?? '');
    }

    return [$providerId, $modelId];
  }

  /**
   * Loads the configured AI Assistant config entity.
   */
  private function loadAssistant(): ?AiAssistant {
    $id = (string) $this->configuration['assistant_id'];
    if ($id === '') {
      return NULL;
    }
    try {
      $assistant = $this->entityTypeManager->getStorage('ai_assistant')->load($id);
    }
    catch (\Throwable) {
      return NULL;
    }
    return $assistant instanceof AiAssistant ? $assistant : NULL;
  }

}
