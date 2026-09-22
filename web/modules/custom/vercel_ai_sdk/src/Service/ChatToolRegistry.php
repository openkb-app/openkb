<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk\Service;

use Drupal\ai\Service\FunctionCalling\FunctionCallPluginManager;
use Drupal\ai\Service\FunctionCalling\StructuredExecutableFunctionCallInterface;
use Psr\Log\LoggerInterface;

/**
 * The tools a chat turn may offer and run: the site's Tool API tools.
 *
 * `tool_ai_connector` derives one drupal/ai function call per Tool API tool,
 * all of them in the `tool` group. That group is the chat's tool surface
 * (ADR 0009). The other function calls the manager serves — every Drupal
 * Action plugin under `drupal_actions`, and whatever else a module adds — are
 * not tools we author and are not offered.
 *
 * Nothing here names a tool: a tool added to the site appears in the chat with
 * no change to this file. A processor may narrow the set further with an
 * allow-list of plugin ids; an empty allow-list is no narrowing.
 *
 * A function call runs as the current account, so the model is only ever
 * offered and only ever runs what the person chatting could have done
 * themselves.
 */
final class ChatToolRegistry {

  /**
   * The function group whose members are this chat's tools.
   */
  private const GROUP = 'tool';

  /**
   * Constructs the registry.
   *
   * @param \Drupal\ai\Service\FunctionCalling\FunctionCallPluginManager $functionCalls
   *   The drupal/ai function call plugins.
   * @param \Psr\Log\LoggerInterface $logger
   *   The channel a failing tool is reported on.
   */
  public function __construct(
    private readonly FunctionCallPluginManager $functionCalls,
    private readonly LoggerInterface $logger,
  ) {}

  /**
   * The functions to offer the model.
   *
   * @param string[] $allowed
   *   Function call plugin ids to keep, or an empty array for all of them.
   *
   * @return \Drupal\ai\OperationType\Chat\Tools\ToolsFunctionInput[]
   *   The functions, possibly empty.
   */
  public function functions(array $allowed = []): array {
    $functions = [];
    foreach ($this->ids($allowed) as $id) {
      try {
        $functions[] = $this->functionCalls->createInstance($id)->normalize();
      }
      catch (\Throwable $e) {
        $this->logger->error('Chat tool "@id" could not be offered: @msg', ['@id' => $id, '@msg' => $e->getMessage()]);
      }
    }
    return $functions;
  }

  /**
   * Runs one tool.
   *
   * A tool nobody offers, one outside the allow-list, and one that fails are
   * all answered as a result rather than raised: the model asked for something
   * it cannot have and can recover by not asking again.
   *
   * @param string $name
   *   The function name the model called.
   * @param array $arguments
   *   The arguments it called with.
   * @param string[] $allowed
   *   Function call plugin ids this processor offers, or an empty array for
   *   all of them.
   *
   * @return array{text: string, data: array}
   *   The result as prose for the model and as data for the UI.
   */
  public function call(string $name, array $arguments, array $allowed = []): array {
    $function = NULL;
    foreach ($this->ids($allowed) as $id) {
      $candidate = $this->functionCalls->createInstance($id);
      if ($candidate->getFunctionName() === $name) {
        $function = $candidate;
        break;
      }
    }
    if (!$function) {
      return ['text' => sprintf('No tool named "%s" is available to you.', $name), 'data' => []];
    }

    try {
      foreach ($arguments as $key => $value) {
        $function->setContextValue($key, $value);
      }
      $function->execute();
      $data = $function instanceof StructuredExecutableFunctionCallInterface
        ? $function->getStructuredOutput()
        : [];
      return ['text' => $function->getReadableOutput(), 'data' => $data];
    }
    catch (\Throwable $e) {
      $this->logger->error('Chat tool "@name" failed: @msg', ['@name' => $name, '@msg' => $e->getMessage()]);
      return ['text' => sprintf('The tool "%s" failed.', $name), 'data' => []];
    }
  }

  /**
   * The plugin ids of this chat's tools, narrowed by the allow-list.
   *
   * @param string[] $allowed
   *   Plugin ids to keep, or an empty array for all of them.
   *
   * @return string[]
   *   The ids, in definition order.
   */
  private function ids(array $allowed): array {
    $ids = [];
    foreach ($this->functionCalls->getDefinitions() as $id => $definition) {
      if (($definition['group'] ?? '') !== self::GROUP) {
        continue;
      }
      if ($allowed && !in_array($id, $allowed, TRUE)) {
        continue;
      }
      $ids[] = (string) $id;
    }
    return $ids;
  }

}
