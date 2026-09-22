<?php

declare(strict_types=1);

namespace Drupal\openkb_tools_test\Plugin\tool\Tool;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\State\StateInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\tool\Attribute\Tool;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolBase;
use Drupal\tool\Tool\ToolOperation;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * A tool that denies every account, exposed so only access can stop it.
 *
 * Access is enforced when a tool executes, not when it is listed (ADR 0009),
 * so this one is advertised like any other. Its execute() records that it ran,
 * which is what a test asserts never happened.
 */
#[Tool(
  id: 'openkb_forbidden_probe',
  label: new TranslatableMarkup('Forbidden probe'),
  description: new TranslatableMarkup('Denies every account; reaching its body means access was not enforced.'),
  operation: ToolOperation::Read,
  destructive: FALSE,
)]
final class ForbiddenProbe extends ToolBase {

  /**
   * Records that the body was reached.
   */
  protected StateInterface $state;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
    $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
    $instance->state = $container->get('state');
    return $instance;
  }

  /**
   * {@inheritdoc}
   */
  protected function checkAccess(array $values, AccountInterface $account, bool $return_as_object = FALSE): bool|AccessResultInterface {
    $access = AccessResult::forbidden('Nobody may call this tool.');

    return $return_as_object ? $access : $access->isAllowed();
  }

  /**
   * {@inheritdoc}
   */
  protected function doExecute(array $values): ExecutableResult {
    $this->state->set('openkb_tools_test.probe_ran', TRUE);

    return ExecutableResult::success(new TranslatableMarkup('Breach.'));
  }

}
