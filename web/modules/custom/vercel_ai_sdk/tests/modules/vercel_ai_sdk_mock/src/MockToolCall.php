<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_mock;

use Drupal\ai\OperationType\Chat\Tools\ToolsFunctionInput;
use Drupal\ai\OperationType\Chat\Tools\ToolsFunctionOutput;
use Drupal\ai\OperationType\Chat\Tools\ToolsPropertyInput;
use Drupal\ai\OperationType\Chat\Tools\ToolsPropertyResult;

/**
 * One tool call a scripted answer asks for.
 *
 * The name is the site's own function name — `tool__<tool id>` — so a script
 * asks for a tool the site really has, and the bridge runs it for real. A name
 * the site does not have is how a script asks for a failing call.
 */
final readonly class MockToolCall {

  /**
   * Constructs the call.
   *
   * @param string $id
   *   The tool call id, which the answer's parts are keyed by.
   * @param string $name
   *   The function name to call.
   * @param array<string, mixed> $arguments
   *   The arguments to call it with.
   */
  public function __construct(
    public string $id,
    public string $name,
    public array $arguments = [],
  ) {}

  /**
   * The call a scripted entry holds.
   *
   * @param array<string, mixed> $values
   *   The scripted shape: `id`, `name` and `arguments`.
   */
  public static function fromArray(array $values): self {
    $name = (string) ($values['name'] ?? '');
    if ($name === '') {
      throw new \InvalidArgumentException('A scripted tool call must name a function.');
    }
    $arguments = $values['arguments'] ?? [];
    return new self(
      id: (string) ($values['id'] ?? 'call-' . substr(hash('xxh3', $name), 0, 8)),
      name: $name,
      arguments: is_array($arguments) ? $arguments : [],
    );
  }

  /**
   * The call as drupal/ai's own tool-call output.
   */
  public function toToolsFunctionOutput(): ToolsFunctionOutput {
    $call = new ToolsFunctionOutput(new ToolsFunctionInput($this->name), $this->id, []);
    $call->setName($this->name);
    foreach ($this->arguments as $key => $value) {
      $call->addArgument(new ToolsPropertyResult(new ToolsPropertyInput((string) $key), $value));
    }
    return $call;
  }

}
