<?php

declare(strict_types=1);

namespace Drupal\openkb_tools;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolBase;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * A tool declared in Drupal and executed by the frontend's editing session.
 *
 * ADR 0009: Drupal declares the tool's identity, purpose and inputs; the
 * executable JSON Schema is the frontend's. Drupal cannot run these, so the
 * chat's call is relayed to `/api/mcp` ({@see SessionToolRelay}); an agent
 * reaches them on that endpoint itself.
 */
abstract class SessionToolBase extends ToolBase {

  /**
   * The relay that runs the tool in the frontend's editing session.
   */
  protected SessionToolRelay $relay;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition) {
    /** @var static $instance */
    $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
    $instance->relay = $container->get('openkb_tools.session_relay');

    return $instance;
  }

  /**
   * {@inheritdoc}
   *
   * Only that somebody is acting is decided here: a relayed call carries the
   * account's own credential, and whether it may edit this page is the editing
   * session's answer.
   */
  protected function checkAccess(array $values, AccountInterface $account, bool $return_as_object = FALSE): bool|AccessResultInterface {
    $access = $account->isAnonymous()
      ? AccessResult::forbidden('Log in to work on a page\'s editing session.')
      : AccessResult::allowed();
    $access->addCacheContexts(['user.roles:authenticated']);

    return $return_as_object ? $access : $access->isAllowed();
  }

  /**
   * {@inheritdoc}
   */
  protected function doExecute(array $values): ExecutableResult {
    return $this->relay->call(
      $this->sessionToolName(),
      // The frontend's schemas are closed, so an unset input must not travel
      // as a null.
      array_filter($this->sessionToolArguments($values), static fn ($value): bool => $value !== NULL),
      (string) array_key_first($this->getOutputDefinitions()),
      $this->currentUser,
    );
  }

  /**
   * The arguments the frontend is called with.
   *
   * The inputs as given, plus whatever this tool always asks the session for
   * and no caller may choose.
   */
  protected function sessionToolArguments(array $values): array {
    return $values;
  }

  /**
   * What the frontend calls this tool.
   *
   * The plugin id without `openkb_`, in camel case.
   */
  protected function sessionToolName(): string {
    $words = explode('_', (string) preg_replace('/^openkb_/', '', $this->getPluginId()));

    return array_shift($words) . implode('', array_map(ucfirst(...), $words));
  }

}
