<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_mock;

/**
 * One model answer the mock provider gives: the text, and what rides with it.
 *
 * The metadata is the provider's own response metadata, which the bridge
 * publishes as `data-<key>` parts — the same route a real grounded turn's
 * citations take.
 */
final readonly class MockAnswer {

  /**
   * Constructs the answer.
   *
   * @param string $text
   *   What the model said.
   * @param array<string, mixed> $metadata
   *   The response metadata.
   */
  public function __construct(
    public string $text = '',
    public array $metadata = [],
  ) {}

  /**
   * The answer a scripted context holds.
   *
   * @param array<string, mixed> $values
   *   The scripted shape: `text`, and `metadata` keyed by data-part name.
   */
  public static function fromArray(array $values): self {
    $metadata = $values['metadata'] ?? [];
    return new self(
      text: (string) ($values['text'] ?? ''),
      metadata: is_array($metadata) ? $metadata : [],
    );
  }

}
