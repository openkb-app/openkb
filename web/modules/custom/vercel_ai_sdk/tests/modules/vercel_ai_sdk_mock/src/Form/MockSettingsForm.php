<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_mock\Form;

use Drupal\Core\Form\ConfigFormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\vercel_ai_sdk_mock\MockMode;
use Drupal\vercel_ai_sdk_mock\MockSettings;

/**
 * What the `mock` AI provider answers.
 */
final class MockSettingsForm extends ConfigFormBase {

  /**
   * {@inheritdoc}
   */
  public function getFormId(): string {
    return 'vercel_ai_sdk_mock_settings';
  }

  /**
   * {@inheritdoc}
   */
  protected function getEditableConfigNames(): array {
    return [MockSettings::CONFIG];
  }

  /**
   * {@inheritdoc}
   */
  public function buildForm(array $form, FormStateInterface $form_state): array {
    $config = $this->config(MockSettings::CONFIG);

    $form['intro'] = [
      '#markup' => $this->t('These settings decide what the <em>Mock (no key)</em> provider answers. Which provider answers at all is set on the assistant, at <a href=":url">AI Assistants</a>.', [
        ':url' => '/admin/config/ai/ai-assistant',
      ]),
    ];

    $form['mode'] = [
      '#type' => 'select',
      '#title' => $this->t('Mode'),
      '#default_value' => (string) $config->get('mode'),
      '#options' => MockMode::options(),
      '#description' => $this->t('A scripted answer still falls back to the text below when the request asks for nothing.'),
    ];

    $form['delay_ms'] = [
      '#type' => 'number',
      '#title' => $this->t('Pause between frames, in milliseconds'),
      '#default_value' => (int) $config->get('delay_ms'),
      '#min' => 0,
      '#required' => TRUE,
      '#description' => $this->t('0 leaves an answer unpaced. A paced answer is what proves the stream reaches the browser frame by frame.'),
    ];

    $form['answer'] = [
      '#type' => 'textarea',
      '#title' => $this->t('Canned answer'),
      '#default_value' => (string) $config->get('answer'),
      '#rows' => 6,
      '#description' => $this->t('@prompt stands for the question the assistant asked.'),
    ];

    return parent::buildForm($form, $form_state);
  }

  /**
   * {@inheritdoc}
   */
  public function submitForm(array &$form, FormStateInterface $form_state): void {
    $this->config(MockSettings::CONFIG)
      ->set('mode', (string) $form_state->getValue('mode'))
      ->set('delay_ms', (int) $form_state->getValue('delay_ms'))
      // A textarea posts CRLF; the answer is streamed as written, and config
      // that differs from `config/install` only in its line endings is drift.
      ->set('answer', str_replace("\r\n", "\n", (string) $form_state->getValue('answer')))
      ->save();

    parent::submitForm($form, $form_state);
  }

}
