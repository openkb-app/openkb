<?php

declare(strict_types=1);

namespace Drupal\openkb_agent\Hook;

use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\Hook\Attribute\Hook;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use Drupal\openkb_agent\ConsentScreen;

/**
 * The module's hooks.
 */
final class OpenkbAgentHooks {

  use StringTranslationTrait;

  public function __construct(
    private readonly ConsentScreen $consentScreen,
  ) {}

  /**
   * Implements hook_local_tasks_alter().
   *
   * In OpenKB personal consumers are agent credentials, so the profile tab
   * reads "Agent tokens".
   */
  #[Hook('local_tasks_alter')]
  public function localTasksAlter(array &$local_tasks): void {
    if (isset($local_tasks['simple_oauth_personal_consumers.collection'])) {
      $local_tasks['simple_oauth_personal_consumers.collection']['title'] = $this->t('Agent tokens');
    }
  }

  /**
   * Implements hook_form_FORM_ID_alter() for simple_oauth_authorize_form.
   */
  #[Hook('form_simple_oauth_authorize_form_alter')]
  public function consentFormAlter(array &$form, FormStateInterface $form_state): void {
    $this->consentScreen->alterForm($form, $form_state);
  }

}
