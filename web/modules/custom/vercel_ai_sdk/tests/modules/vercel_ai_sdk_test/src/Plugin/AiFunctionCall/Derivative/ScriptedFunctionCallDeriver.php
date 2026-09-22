<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_test\Plugin\AiFunctionCall\Derivative;

use Drupal\Component\Plugin\Derivative\DeriverBase;
use Drupal\vercel_ai_sdk_test\Plugin\AiFunctionCall\ScriptedFunctionCall;

/**
 * One scripted function call per name a test asked for.
 */
final class ScriptedFunctionCallDeriver extends DeriverBase {

  /**
   * {@inheritdoc}
   */
  public function getDerivativeDefinitions($base_plugin_definition): array {
    $this->derivatives = [];
    foreach (ScriptedFunctionCall::$names as $name) {
      $this->derivatives[$name] = [
        'id' => 'scripted_tool:' . $name,
        'function_name' => $name,
        'name' => $name,
        'description' => $name,
      ] + $base_plugin_definition;
    }
    return $this->derivatives;
  }

}
