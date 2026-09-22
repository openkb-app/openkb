<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_test\Form;

use Drupal\Core\Form\FormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\State\StateInterface;
use Drupal\ai\PluginManager\ChatProcessorPluginManager;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Hosts a ChatProcessor plugin's configuration form, as a real host would.
 *
 * The processor's tool picker is a contrib form element whose submitted shape
 * is not obvious from its code, so the only way to know what a save actually
 * stores is to run one. The configuration a submit produces is put in state
 * for the test to read.
 */
final class ProcessorConfigForm extends FormBase {

  /**
   * The state key the submitted configuration is left under.
   */
  public const STATE_KEY = 'vercel_ai_sdk_test.submitted_configuration';

  /**
   * The chat processor plugin id the form configures.
   */
  public static string $pluginId = 'vercel_ai_sdk';

  public function __construct(
    protected ChatProcessorPluginManager $processors,
    protected StateInterface $state,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self(
      $container->get('plugin.manager.ai.chat_processor'),
      $container->get('state'),
    );
  }

  /**
   * {@inheritdoc}
   */
  public function getFormId(): string {
    return 'vercel_ai_sdk_test_processor_config';
  }

  /**
   * {@inheritdoc}
   */
  public function buildForm(array $form, FormStateInterface $form_state): array {
    $form = $this->processor()->buildConfigurationForm($form, $form_state);
    $form['actions']['submit'] = ['#type' => 'submit', '#value' => 'Save'];
    return $form;
  }

  /**
   * {@inheritdoc}
   */
  public function submitForm(array &$form, FormStateInterface $form_state): void {
    $processor = $this->processor();
    $processor->submitConfigurationForm($form, $form_state);
    $this->state->set(self::STATE_KEY, $processor->getConfiguration());
  }

  /**
   * The processor under configuration.
   */
  private function processor(): object {
    return $this->processors->createInstance(self::$pluginId, []);
  }

}
