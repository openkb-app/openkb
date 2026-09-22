<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite\ValueObject;

use Drupal\Core\Config\Entity\ConfigEntityInterface;

/**
 * One assistant's grounding settings, read off its third-party settings.
 */
readonly class GroundingSettings {

  /**
   * The model always answers; an answer without sources is marked as such.
   */
  public const MODE_GROUNDED = 'grounded';

  /**
   * Nothing surviving the gate is answered as such, without a model call.
   */
  public const MODE_STRICT = 'strict';

  /**
   * The score a source has to reach to be offered to the model.
   *
   * 5.0 on OpenSearch BM25 against the shipped index. Another backend needs
   * its own value.
   */
  public const DEFAULT_SCORE_GATE = 5.0;

  /**
   * The rules an answer is held to, in the model's own instructions.
   */
  public const DEFAULT_CITATION_CONTRACT = "Answer using only the sources below. Cite each claim inline with the bracketed number of the source it comes from, e.g. [1] or [2][3]. If the sources do not contain the answer, say you do not have enough information and cite nothing — never answer from outside them.";

  /**
   * What is said when nothing was retrieved to answer from.
   */
  public const DEFAULT_NO_ANSWER_MESSAGE = 'I have nothing on that in the sources I can read.';

  /**
   * The tag drupal/ai's API Explorer marks its own chat calls with.
   */
  public const EXPLORER_TAG = 'ai_api_explorer';

  /**
   * The third-party settings key the whole set lives under.
   */
  private const KEY = 'grounding';

  /**
   * Constructs the settings.
   *
   * @param string $assistantId
   *   The assistant the settings belong to.
   * @param string $mode
   *   How strictly an answer must be grounded.
   * @param string $retriever
   *   The retriever plugin id.
   * @param array<string, mixed> $retrieverSettings
   *   The retriever's own configuration.
   * @param float $scoreGate
   *   The score a source has to reach to be offered to the model.
   * @param int $minSources
   *   How many sources have to clear the gate for the turn to be answerable.
   * @param int $maxSources
   *   How many sources the model is offered at most.
   * @param int $maxPerEntity
   *   How many passages of one page the model is offered at most.
   * @param string $citationContract
   *   The rules appended to the assistant's system prompt.
   * @param string $noAnswerMessage
   *   What is answered when nothing was retrieved.
   * @param string $extraGuidance
   *   Site-specific wording appended after the contract.
   * @param bool $groundExplorerCalls
   *   Whether the API Explorer's own chat calls count as this assistant's.
   */
  public function __construct(
    public string $assistantId = '',
    public string $mode = self::MODE_GROUNDED,
    public string $retriever = '',
    public array $retrieverSettings = [],
    public float $scoreGate = self::DEFAULT_SCORE_GATE,
    public int $minSources = 1,
    public int $maxSources = 5,
    public int $maxPerEntity = 2,
    public string $citationContract = self::DEFAULT_CITATION_CONTRACT,
    public string $noAnswerMessage = self::DEFAULT_NO_ANSWER_MESSAGE,
    public string $extraGuidance = '',
    public bool $groundExplorerCalls = FALSE,
  ) {}

  /**
   * The settings an assistant carries, or NULL when it is not grounded.
   *
   * @param \Drupal\Core\Config\Entity\ConfigEntityInterface $assistant
   *   The assistant.
   *
   * @return self|null
   *   The settings, or NULL when the assistant names no retriever.
   */
  public static function fromAssistant(ConfigEntityInterface $assistant): ?self {
    $values = $assistant->getThirdPartySetting('ai_rag_cite', self::KEY);
    if (!is_array($values) || ($values['retriever'] ?? '') === '') {
      return NULL;
    }
    $defaults = new self();
    return new self(
      assistantId: (string) $assistant->id(),
      mode: (string) ($values['mode'] ?? $defaults->mode),
      retriever: (string) $values['retriever'],
      retrieverSettings: (array) ($values['retriever_settings'] ?? []),
      scoreGate: (float) ($values['score_gate']['value'] ?? $defaults->scoreGate),
      minSources: (int) ($values['min_sources'] ?? $defaults->minSources),
      maxSources: (int) ($values['max_sources'] ?? $defaults->maxSources),
      maxPerEntity: (int) ($values['max_per_entity'] ?? $defaults->maxPerEntity),
      citationContract: (string) ($values['citation_contract'] ?? $defaults->citationContract),
      noAnswerMessage: (string) ($values['no_answer_message'] ?? $defaults->noAnswerMessage),
      extraGuidance: (string) ($values['extra_guidance'] ?? $defaults->extraGuidance),
      groundExplorerCalls: (bool) ($values['ground_explorer_calls'] ?? $defaults->groundExplorerCalls),
    );
  }

  /**
   * Writes the settings back onto an assistant.
   *
   * @param \Drupal\Core\Config\Entity\ConfigEntityInterface $assistant
   *   The assistant.
   * @param array<string, mixed> $values
   *   The settings, in their stored shape.
   */
  public static function store(ConfigEntityInterface $assistant, array $values): void {
    if (($values['retriever'] ?? '') === '') {
      $assistant->unsetThirdPartySetting('ai_rag_cite', self::KEY);
      return;
    }
    $assistant->setThirdPartySetting('ai_rag_cite', self::KEY, $values);
  }

}
