<?php

declare(strict_types=1);

namespace Drupal\simple_oauth_personal_consumers\Form;

use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\Core\Form\ConfirmFormBase;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\Url;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface;
use Drupal\user\UserInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Confirms revoking a personal consumer.
 *
 * Revokes its tokens and disables issuance; the consumer entity is kept so
 * historical attribution keeps resolving.
 */
class PersonalConsumerRevokeForm extends ConfirmFormBase {

  /**
   * The account whose page this is.
   */
  protected UserInterface $user;

  /**
   * The consumer being revoked.
   */
  protected ConsumerInterface $consumer;

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
    return 'simple_oauth_personal_consumers_revoke';
  }

  /**
   * {@inheritdoc}
   */
  public function buildForm(array $form, FormStateInterface $form_state, ?UserInterface $user = NULL, ?ConsumerInterface $consumer = NULL): array {
    // The consumer must be a personal consumer of the page's user — the
    // route access check only covers "own page".
    if (!$consumer->hasField('personal') || !$consumer->get('personal')->value
      || (int) $consumer->get('user_id')->target_id !== (int) $user->id()
      || $this->manager->isRevoked($consumer)) {
      throw new NotFoundHttpException();
    }
    $this->user = $user;
    $this->consumer = $consumer;
    return parent::buildForm($form, $form_state);
  }

  /**
   * {@inheritdoc}
   */
  public function getQuestion() {
    return $this->t('Revoke the API client %label?', ['%label' => $this->consumer->label()]);
  }

  /**
   * {@inheritdoc}
   */
  public function getDescription() {
    return $this->t('All of its tokens stop working immediately and no new tokens can be issued. The client stays listed as revoked. This cannot be undone.');
  }

  /**
   * {@inheritdoc}
   */
  public function getCancelUrl() {
    return Url::fromRoute('simple_oauth_personal_consumers.collection', ['user' => $this->user->id()]);
  }

  /**
   * {@inheritdoc}
   */
  public function submitForm(array &$form, FormStateInterface $form_state): void {
    $label = $this->consumer->label();
    $this->manager->revoke($this->consumer);
    $this->messenger()->addStatus($this->t('API client %label revoked.', ['%label' => $label]));
    $form_state->setRedirectUrl($this->getCancelUrl());
  }

}
