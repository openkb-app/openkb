<?php

declare(strict_types=1);

namespace Drupal\simple_oauth_personal_consumers\Form;

use Drupal\Core\Form\FormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface;
use Drupal\user\UserInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Creates a personal client-credentials consumer; secret shown exactly once.
 */
class PersonalConsumerCreateForm extends FormBase {

  /**
   * Form-state key for the one-time credentials.
   *
   * Set it before building the form and the secret arrives there instead of in
   * a message — for a caller that answers the submit with the page itself and
   * renders the secret on it. Left unset, the secret goes out as a message,
   * which is how the HTML page carries it across its post/redirect/get.
   */
  public const CREDENTIALS = 'personal_consumer_credentials';

  public function __construct(
    protected PersonalConsumerManagerInterface $manager,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): static {
    return new static($container->get('simple_oauth_personal_consumers.manager'));
  }

  /**
   * {@inheritdoc}
   */
  public function getFormId(): string {
    return 'simple_oauth_personal_consumers_create';
  }

  /**
   * {@inheritdoc}
   */
  public function buildForm(array $form, FormStateInterface $form_state, ?UserInterface $user = NULL): array {
    $form['#user'] = $user;
    if ($user !== NULL && $this->manager->isAdminAccount($user)) {
      $form['refused'] = [
        '#markup' => $this->t('Administrator accounts cannot own personal API clients — use a non-admin account.'),
      ];
      return $form;
    }
    $form['label'] = [
      '#type' => 'textfield',
      '#title' => $this->t('Client name'),
      '#description' => $this->t("The client acts on your behalf — its changes count as yours, made via this client. One short word reads best: the name is how every page names the agent, and it must differ from the names of your other agents."),
      '#required' => TRUE,
      '#maxlength' => 64,
    ];
    $form['actions'] = ['#type' => 'actions'];
    $form['actions']['submit'] = [
      '#type' => 'submit',
      '#value' => $this->t('Create API client'),
      '#button_type' => 'primary',
    ];
    return $form;
  }

  /**
   * {@inheritdoc}
   */
  public function validateForm(array &$form, FormStateInterface $form_state): void {
    /** @var \Drupal\user\UserInterface $user */
    $user = $form['#user'];
    if ($this->manager->isAdminAccount($user)) {
      $form_state->setErrorByName('label', $this->t('Administrator accounts cannot own personal API clients — use a non-admin account.'));
      return;
    }
    $label = (string) $form_state->getValue('label');
    if ($this->manager->nameTaken($user, $label)) {
      $form_state->setErrorByName('label', $this->manager->nameTakenError($label));
    }
  }

  /**
   * {@inheritdoc}
   */
  public function submitForm(array &$form, FormStateInterface $form_state): void {
    /** @var \Drupal\user\UserInterface $user */
    $user = $form['#user'];
    $credentials = $this->manager->create($user, $form_state->getValue('label'));

    $this->messenger()->addStatus($this->t('API client %name created.', [
      '%name' => $credentials->consumer->label(),
    ]));
    if ($form_state->has(self::CREDENTIALS)) {
      $form_state->set(self::CREDENTIALS, $credentials);
      return;
    }
    $this->messenger()->addWarning($this->t('Copy the credentials now — the secret is shown only once.<br>Client ID: <code>@client_id</code><br>Client secret: <code>@secret</code>', [
      '@client_id' => $credentials->clientId,
      '@secret' => $credentials->secret,
    ]));
  }

}
