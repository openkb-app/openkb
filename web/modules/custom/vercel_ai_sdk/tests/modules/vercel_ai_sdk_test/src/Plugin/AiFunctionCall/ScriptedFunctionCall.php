<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_test\Plugin\AiFunctionCall;

use Drupal\Core\Session\AccountInterface;
use Drupal\ai\Attribute\FunctionCall;
use Drupal\ai\Base\FunctionCallBase;
use Drupal\ai\Service\FunctionCalling\FunctionCallInterface;
use Drupal\ai\Service\FunctionCalling\StructuredExecutableFunctionCallInterface;
use Drupal\vercel_ai_sdk_test\Plugin\AiFunctionCall\Derivative\ScriptedFunctionCallDeriver;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Function calls in the `tool` group, scripted by a test.
 *
 * The chat's tools are the site's Tool API tools, which reach it as `tool`
 * group function calls. These stand in for them: one derivative per name in
 * ::$names, answering from ::$results and recording what it was asked and as
 * whom.
 *
 * Everything is static — the plugin is built by the function call manager, so
 * a test never holds the instance. Set the properties in setUp(), before the
 * manager's definitions are first read.
 */
#[FunctionCall(
  id: 'scripted_tool',
  function_name: 'scripted_tool',
  name: 'Scripted tool',
  description: 'A scripted tool.',
  group: 'tool',
  deriver: ScriptedFunctionCallDeriver::class,
)]
final class ScriptedFunctionCall extends FunctionCallBase implements StructuredExecutableFunctionCallInterface {

  /**
   * The function names to derive, in order.
   *
   * @var string[]
   */
  public static array $names = [];

  /**
   * What each name answers with, keyed by function name.
   *
   * `{text, data}` for a tool that answers; `{throw: <message>}` for one that
   * fails, which is the other half of what a chat has to survive.
   *
   * @var array<string, array{text?: string, data?: array, throw?: string}>
   */
  public static array $results = [];

  /**
   * Every call made, as [name, arguments] pairs.
   *
   * @var array<int, array{0: string, 1: array}>
   */
  public static array $calls = [];

  /**
   * The account id every instantiation was made as, in order.
   *
   * @var int[]
   */
  public static array $accounts = [];

  /**
   * The values the model called with.
   *
   * @var array
   */
  protected array $values = [];

  /**
   * The account this instance was built as.
   */
  protected AccountInterface $currentUser;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): FunctionCallInterface|static {
    $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
    $instance->currentUser = $container->get('current_user');
    self::$accounts[] = (int) $instance->currentUser->id();
    return $instance;
  }

  /**
   * {@inheritdoc}
   */
  public function setContextValue($name, $value) {
    $this->values[$name] = $value;
    return $this;
  }

  /**
   * {@inheritdoc}
   */
  public function execute(): void {
    self::$calls[] = [$this->getFunctionName(), $this->values];
    $throw = $this->result()['throw'] ?? NULL;
    if (is_string($throw)) {
      throw new \RuntimeException($throw);
    }
  }

  /**
   * {@inheritdoc}
   */
  public function getReadableOutput(): string {
    return (string) ($this->result()['text'] ?? '');
  }

  /**
   * {@inheritdoc}
   */
  public function getStructuredOutput(): array {
    return (array) ($this->result()['data'] ?? []);
  }

  /**
   * {@inheritdoc}
   */
  public function setStructuredOutput(array $output): void {
    self::$results[$this->getFunctionName()] = $output;
  }

  /**
   * The scripted result for this function.
   */
  private function result(): array {
    return self::$results[$this->getFunctionName()] ?? ['text' => '', 'data' => []];
  }

}
