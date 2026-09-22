<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_mock;

/**
 * One model answer the mock provider gives: the text, and what rides with it.
 *
 * The metadata is the provider's own response metadata, which the bridge
 * publishes as `data-<key>` parts — the same route a real grounded turn's
 * citations take. The tools are what the model asks for before it answers;
 * the bridge runs them and asks again, and the second ask is answered with
 * the text.
 */
final readonly class MockAnswer {

  /**
   * Constructs the answer.
   *
   * @param string $text
   *   What the model said.
   * @param array<string, mixed> $metadata
   *   The response metadata.
   * @param \Drupal\vercel_ai_sdk_mock\MockToolCall[] $tools
   *   The tool calls to ask for first, empty for an answer that calls none.
   */
  public function __construct(
    public string $text = '',
    public array $metadata = [],
    public array $tools = [],
  ) {}

  /**
   * The answer a scripted context holds.
   *
   * @param array<string, mixed> $values
   *   The scripted shape: `text`, `metadata` keyed by data-part name, and
   *   `tools` as a list of calls.
   */
  public static function fromArray(array $values): self {
    $metadata = $values['metadata'] ?? [];
    $tools = $values['tools'] ?? [];
    if (!is_array($tools)) {
      throw new \InvalidArgumentException('Scripted tool calls must be a list.');
    }
    return new self(
      text: (string) ($values['text'] ?? ''),
      metadata: is_array($metadata) ? $metadata : [],
      tools: array_map(
        static fn (mixed $call): MockToolCall => MockToolCall::fromArray((array) $call),
        array_values($tools),
      ),
    );
  }

}
