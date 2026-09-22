<?php

declare(strict_types=1);

namespace Drupal\openkb_space\Form;

use Drupal\Core\Form\FormBase;
use Drupal\Core\Form\FormStateInterface;

/**
 * The page Field UI hangs its tabs off; the entity type has no settings.
 */
final class SpaceSettingsForm extends FormBase {

  /**
   * {@inheritdoc}
   */
  public function getFormId(): string {
    return 'openkb_space_settings';
  }

  /**
   * {@inheritdoc}
   */
  public function buildForm(array $form, FormStateInterface $form_state): array {
    $form['fields'] = [
      '#markup' => $this->t('Spaces have no settings of their own. Manage their fields and displays in the tabs above.'),
    ];
    return $form;
  }

  /**
   * {@inheritdoc}
   */
  public function submitForm(array &$form, FormStateInterface $form_state): void {
  }

}
