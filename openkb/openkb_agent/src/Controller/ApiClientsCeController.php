<?php

declare(strict_types=1);

namespace Drupal\openkb_agent\Controller;

use Drupal\Core\Form\FormState;
use Drupal\Core\Url;
use Drupal\custom_elements\CustomElement;
use Drupal\lupus_decoupled_form\Controller\CustomElementsFormControllerTrait;
use Drupal\simple_oauth_personal_consumers\Controller\PersonalConsumersController;
use Drupal\simple_oauth_personal_consumers\Form\PersonalConsumerCreateForm;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerCredentials;
use Drupal\user\UserInterface;

/**
 * Serves the API-clients page as custom elements, for the frontend to render.
 *
 * Backs a clone of `simple_oauth_personal_consumers.collection` requiring the
 * `custom_elements` format, so only `/ce-api` reaches it. What the page is
 * about travels as props and what has to be submitted back travels in the slot:
 * the clients are the same rows the stock page lists, stated as data instead of
 * a rendered table, and the slot is Drupal's own create form, posting straight
 * back so provisioning works with JavaScript off.
 */
final class ApiClientsCeController extends PersonalConsumersController {

  use CustomElementsFormControllerTrait;

  /**
   * The API-clients page, as the frontend renders it.
   *
   * @param \Drupal\user\UserInterface $user
   *   The account whose page this is.
   *
   * @return \Drupal\custom_elements\CustomElement
   *   The create form, carrying the account's clients as props.
   */
  public function customElementsPage(UserInterface $user): CustomElement {
    $form_state = new FormState();
    $form_state->addBuildInfo('args', [$user]);
    // A submit answers with this page rather than a redirect to it, and the
    // one-time secret comes off the form state — not out of the session's
    // messages, which any of the app's other Drupal calls can drain first.
    $form_state->disableRedirect();
    $form_state->set(PersonalConsumerCreateForm::CREDENTIALS, FALSE);
    $form = $this->formBuilder()->buildForm(PersonalConsumerCreateForm::class, $form_state);

    $element = $this->getCustomElementsContentResult($form);
    $element->setAttribute('account', $user->getAccountName());
    $element->setAttribute('clients', $this->clients($user));
    $credentials = $form_state->get(PersonalConsumerCreateForm::CREDENTIALS);
    if ($credentials instanceof PersonalConsumerCredentials) {
      $element->setAttribute('created_client', [
        'label' => (string) $credentials->consumer->label(),
        'client_id' => $credentials->clientId,
        'secret' => $credentials->secret,
      ]);
    }
    // Provisioning or revoking a client invalidates the page — the tag the
    // stock listing carries.
    $element->addCacheTags(['consumer_list']);
    return $element;
  }

  /**
   * The account's clients, as the frontend lists them.
   *
   * @param \Drupal\user\UserInterface $user
   *   The account whose page this is.
   *
   * @return array[]
   *   One entry per client, revoked ones included — a revoked client stays
   *   listed so its historical attribution keeps making sense.
   */
  private function clients(UserInterface $user): array {
    $clients = [];
    foreach ($this->manager->getConsumers($user) as $consumer) {
      $revoked = $this->manager->isRevoked($consumer);
      $clients[] = [
        'label' => (string) $consumer->label(),
        'client_id' => $consumer->getClientId(),
        'revoked' => $revoked,
        'created' => $this->utc($consumer->get('created')->value),
        // The last token issued for it, which the consumer records to the hour.
        'last_used' => $this->utc($consumer->get('last_used')->value),
        'revoke_url' => $revoked ? NULL : Url::fromRoute('simple_oauth_personal_consumers.revoke', [
          'user' => $user->id(),
          'consumer' => $consumer->id(),
        ])->toString(),
      ];
    }
    return $clients;
  }

  /**
   * A stored timestamp as UTC, which is the frontend's input for a date.
   *
   * @param mixed $timestamp
   *   The field value, empty for a client that has never been used.
   *
   * @return string|null
   *   An ISO 8601 instant, or NULL.
   */
  private function utc(mixed $timestamp): ?string {
    return $timestamp ? gmdate(\DateTimeInterface::ATOM, (int) $timestamp) : NULL;
  }

}
