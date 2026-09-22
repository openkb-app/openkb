<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite\EventSubscriber;

use Drupal\Component\Plugin\Exception\PluginException;
use Drupal\Core\Config\Entity\ConfigEntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Utility\Error;
use Drupal\ai\Event\PostGenerateResponseEvent;
use Drupal\ai\Event\PreGenerateResponseEvent;
use Drupal\ai\OperationType\Chat\ChatInput;
use Drupal\ai\OperationType\Chat\ChatMessage;
use Drupal\ai\OperationType\Chat\ChatOutput;
use Drupal\ai\OperationType\Chat\StreamedChatMessageIteratorInterface;
use Drupal\ai_rag_cite\CitedStream;
use Drupal\ai_rag_cite\Grounding;
use Drupal\ai_rag_cite\RetrieverException;
use Drupal\ai_rag_cite\RetrieverInterface;
use Drupal\ai_rag_cite\RetrieverPluginManager;
use Drupal\ai_rag_cite\ValueObject\GroundingSettings;
use Psr\Log\LoggerInterface;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;

/**
 * Grounds an assistant's answers in retrieved sources, and cites them back.
 *
 * Retrieval runs before the model is asked, so the mode decides an unanswerable
 * question before a token is spent.
 */
class GroundingSubscriber implements EventSubscriberInterface {

  /**
   * The tag naming the assistant a provider call belongs to.
   *
   * The convention drupal/ai's own assistant runner tags calls with, so an
   * assistant is grounded whichever runner drives it.
   */
  private const ASSISTANT_TAG_PREFIX = 'ai_assistant_api_assistant_message_';

  /**
   * Request metadata key the caller context travels under.
   *
   * The convention drupal/ai carries a turn's context under, so a context
   * arrives whichever chat client sent it. What the keys mean is the
   * retriever's business.
   */
  public const CALLER_CONTEXT_KEY = 'contexts';

  /**
   * What each grounded assistant's turn is grounded on, by assistant id.
   *
   * One turn is one request and every round of it asks the same question, so
   * the first round retrieves and the rest are grounded on what it found. Two
   * assistants answering in one request hold their own.
   *
   * @var array<string, array{question: string, context: array<string, mixed>, scope: string, sources: \Drupal\ai_rag_cite\ValueObject\Source[]}>
   */
  private array $held = [];

  /**
   * Constructs the subscriber.
   *
   * @param \Drupal\Core\Entity\EntityTypeManagerInterface $entityTypeManager
   *   Loads the assistant a call is tagged with.
   * @param \Drupal\ai_rag_cite\RetrieverPluginManager $retrievers
   *   The retriever plugins.
   * @param \Drupal\ai_rag_cite\Grounding $grounding
   *   The gate and the citation pass.
   * @param \Psr\Log\LoggerInterface $logger
   *   The logger.
   */
  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly RetrieverPluginManager $retrievers,
    private readonly Grounding $grounding,
    private readonly LoggerInterface $logger,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    return [
      PreGenerateResponseEvent::EVENT_NAME => 'ground',
      PostGenerateResponseEvent::EVENT_NAME => 'cite',
    ];
  }

  /**
   * Puts the sources in front of the model, or says there are none.
   *
   * @param \Drupal\ai\Event\PreGenerateResponseEvent $event
   *   The event.
   */
  public function ground(PreGenerateResponseEvent $event): void {
    $settings = $this->settingsFor($event->getTags());
    $input = $event->getInput();
    if (!$settings || !$input instanceof ChatInput) {
      return;
    }
    $held = $this->held[$settings->assistantId] ?? ['question' => '', 'context' => [], 'scope' => '', 'sources' => []];
    $question = $this->question($input);
    $context = $this->callerContext($input);
    if ($question !== '' && ($question !== $held['question'] || $context !== $held['context'])) {
      try {
        $retriever = $this->retriever($settings);
        $held = [
          'question' => $question,
          'context' => $context,
          // What was searched, for an answer that has to say it found nothing.
          'scope' => $retriever->scopeDescription($context),
          'sources' => $this->evidence($retriever, $question, $context, $settings),
        ];
      }
      catch (RetrieverException | PluginException $e) {
        // An outage is not an empty knowledge base: say the sources could not
        // be reached rather than letting the model answer as if there were
        // none, and keep the detail in the log.
        Error::logException($this->logger, $e);
        $this->held[$settings->assistantId] = [
          'question' => $question,
          'context' => $context,
          'scope' => '',
          'sources' => [],
        ];
        $event->setForcedOutputObject($this->noAnswer($settings, 'dependency_unavailable'));
        return;
      }
      $this->held[$settings->assistantId] = $held;
    }
    // A round that asks nothing new, in a turn nothing was retrieved for, is
    // not this module's to answer.
    if ($held['question'] === '') {
      return;
    }
    // Nothing to stand on: strict says so and stops, grounded lets the model
    // answer and marks the answer as standing on nothing.
    if (!$held['sources'] && $settings->mode === GroundingSettings::MODE_STRICT) {
      $event->setForcedOutputObject($this->noAnswer($settings, 'insufficient_evidence'));
      return;
    }
    $input->setSystemPrompt(
      $this->grounding->systemPrompt($input->getSystemPrompt(), $held['sources'], $settings, $held['scope']),
    );
  }

  /**
   * Answers back which sources the answer actually used.
   *
   * @param \Drupal\ai\Event\PostGenerateResponseEvent $event
   *   The event.
   */
  public function cite(PostGenerateResponseEvent $event): void {
    // Scoped by the same tag the grounding was: another assistant's call in
    // the same request answers for itself.
    $settings = $this->settingsFor($event->getTags());
    $output = $event->getOutput();
    $held = $settings ? $this->held[$settings->assistantId] ?? NULL : NULL;
    if (!$settings || !$held || $held['question'] === '' || !$output instanceof ChatOutput) {
      return;
    }
    $normalized = $output->getNormalized();
    $sources = $held['sources'];

    if ($normalized instanceof StreamedChatMessageIteratorInterface) {
      // A streamed answer is read as it is written, so what it cited can only
      // be known once it has been; the iterator carries the answer back out,
      // with the markers naming no source dropped as they go past.
      $cited = CitedStream::of($normalized, $this->grounding, count($sources));
      $cited->addCallback(function (ChatMessage $message) use ($cited, $sources, $settings): void {
        $cited->setMetadata(array_merge(
          $cited->getMetadata(),
          $this->metadata($message->getText(), $sources, $settings),
        ));
      });
      $event->setOutput(new ChatOutput($cited, $output->getRawOutput(), $output->getMetadata()));
      return;
    }
    if (!$normalized instanceof ChatMessage) {
      return;
    }
    $text = $this->grounding->stripOutOfRangeMarkers($normalized->getText(), count($sources));
    $normalized->setText($text);
    $event->setOutput(new ChatOutput($normalized, $output->getRawOutput(), $this->metadata($text, $sources, $settings)));
  }

  /**
   * The grounding settings of the assistant a call is tagged with.
   *
   * @param array<int, string> $tags
   *   The call's tags.
   */
  private function settingsFor(array $tags): ?GroundingSettings {
    foreach ($tags as $tag) {
      if (!str_starts_with((string) $tag, self::ASSISTANT_TAG_PREFIX)) {
        continue;
      }
      $assistant = $this->entityTypeManager->getStorage('ai_assistant')
        ->load(substr((string) $tag, strlen(self::ASSISTANT_TAG_PREFIX)));
      $settings = $assistant instanceof ConfigEntityInterface
        ? GroundingSettings::fromAssistant($assistant)
        : NULL;
      if ($settings) {
        return $settings;
      }
    }
    return in_array(GroundingSettings::EXPLORER_TAG, $tags, TRUE) ? $this->explorerAssistant() : NULL;
  }

  /**
   * The assistant that has taken the API Explorer's chat calls, if any.
   *
   * The Explorer names no assistant, so an assistant claims its calls instead.
   * The assistant form refuses a second claimant, so there is at most one.
   */
  private function explorerAssistant(): ?GroundingSettings {
    foreach ($this->entityTypeManager->getStorage('ai_assistant')->loadMultiple() as $assistant) {
      $settings = $assistant instanceof ConfigEntityInterface
        ? GroundingSettings::fromAssistant($assistant)
        : NULL;
      if ($settings?->groundExplorerCalls) {
        return $settings;
      }
    }
    return NULL;
  }

  /**
   * The question a round is grounded on, or '' when the round asks nothing new.
   *
   * A round that follows a tool call ends in the tool's answer, not the
   * account's: it is grounded on what the turn's first round retrieved, so the
   * numbers the answer cites mean the same thing in every round.
   */
  private function question(ChatInput $input): string {
    $messages = $input->getMessages();
    $last = end($messages);
    return $last instanceof ChatMessage && $last->getRole() === 'user'
      ? trim($last->getText())
      : '';
  }

  /**
   * What the turn may be grounded on, or nothing when the gate is not cleared.
   *
   * A set too small to answer from is no evidence at all: the turn stands on
   * nothing, so nothing is offered to the model and no `[n]` resolves.
   *
   * @param \Drupal\ai_rag_cite\RetrieverInterface $retriever
   *   The configured retriever.
   * @param string $question
   *   What the account asked.
   * @param array<string, mixed> $context
   *   The caller context the turn arrived with.
   * @param \Drupal\ai_rag_cite\ValueObject\GroundingSettings $settings
   *   The assistant's grounding settings.
   *
   * @return \Drupal\ai_rag_cite\ValueObject\Source[]
   *   The sources.
   */
  private function evidence(RetrieverInterface $retriever, string $question, array $context, GroundingSettings $settings): array {
    $sources = $this->grounding->gate($retriever->retrieve($question, $context), $settings);
    return count($sources) >= $settings->minSources ? $sources : [];
  }

  /**
   * The caller context of a turn, empty where the client sent none.
   *
   * @param \Drupal\ai\OperationType\Chat\ChatInput $input
   *   The turn's input.
   *
   * @return array<string, mixed>
   *   The context.
   */
  private function callerContext(ChatInput $input): array {
    $context = $input->getRequestMetadataValue(self::CALLER_CONTEXT_KEY);
    return is_array($context) ? $context : [];
  }

  /**
   * The configured retriever.
   */
  private function retriever(GroundingSettings $settings): RetrieverInterface {
    /** @var \Drupal\ai_rag_cite\RetrieverInterface $retriever */
    $retriever = $this->retrievers->createInstance($settings->retriever, $settings->retrieverSettings);
    return $retriever;
  }

  /**
   * The answer given when there is nothing to ground one on.
   */
  private function noAnswer(GroundingSettings $settings, string $state): ChatOutput {
    return new ChatOutput(
      new ChatMessage('assistant', $settings->noAnswerMessage),
      NULL,
      ['citations' => [], 'grounding' => ['mode' => $settings->mode, 'state' => $state, 'retrieved' => 0]],
    );
  }

  /**
   * What the answer is published alongside: its sources, and how it stands.
   *
   * @param string $text
   *   The generated answer.
   * @param \Drupal\ai_rag_cite\ValueObject\Source[] $sources
   *   The sources the turn was grounded on.
   * @param \Drupal\ai_rag_cite\ValueObject\GroundingSettings $settings
   *   The settings the turn ran under.
   *
   * @return array<string, mixed>
   *   The response metadata.
   */
  private function metadata(string $text, array $sources, GroundingSettings $settings): array {
    $citations = $this->grounding->citations($text, $sources);
    return [
      'citations' => $citations,
      'grounding' => [
        'mode' => $settings->mode,
        'state' => $citations ? 'grounded' : 'ungrounded',
        // An answer citing nothing because nothing was found reads differently
        // from one citing nothing it was offered, so the count travels with it.
        'retrieved' => count($sources),
      ],
    ];
  }

}
