<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_test;

/**
 * One fragment of a tool call, as a streaming provider hands it over.
 *
 * A streamed tool call does not arrive whole: the first fragment carries the
 * call id and the function name, and the arguments follow as pieces of JSON
 * over the next ones. drupal/ai reads a fragment with `toArray()` only and
 * assembles the call from the pieces, so that is all this has to answer.
 */
final readonly class StreamedToolCallDelta {

  /**
   * Constructs the fragment.
   *
   * @param string $arguments
   *   This fragment's piece of the arguments JSON.
   * @param string|null $id
   *   The call id, on the fragment that opens a call.
   * @param string|null $name
   *   The function name, on the fragment that opens a call.
   */
  private function __construct(
    private string $arguments,
    private ?string $id = NULL,
    private ?string $name = NULL,
  ) {}

  /**
   * The fragment that opens a call: its id, its name, its first arguments.
   */
  public static function opening(string $id, string $name, string $arguments = ''): self {
    return new self($arguments, $id, $name);
  }

  /**
   * A fragment carrying nothing but more of the open call's arguments.
   */
  public static function continuing(string $arguments): self {
    return new self($arguments);
  }

  /**
   * The fragment as the provider SDKs shape it.
   *
   * @return array<string, mixed>
   *   The fragment, without the keys it does not carry.
   */
  public function toArray(): array {
    return array_filter([
      'id' => $this->id,
      'type' => $this->id === NULL ? NULL : 'function',
      'function' => array_filter([
        'name' => $this->name,
        'arguments' => $this->arguments,
      ], static fn (?string $value): bool => $value !== NULL),
    ], static fn (mixed $value): bool => $value !== NULL);
  }

}
