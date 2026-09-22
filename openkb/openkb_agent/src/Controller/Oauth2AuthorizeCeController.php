<?php

declare(strict_types=1);

namespace Drupal\openkb_agent\Controller;

use Drupal\lupus_decoupled_form\Controller\CustomElementsFormControllerTrait;
use Drupal\openkb_agent\ConsentScreen;
use Drupal\simple_oauth\Controller\Oauth2AuthorizeController;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\Request;

/**
 * Serves the consent screen as custom elements, for the frontend to render.
 *
 * Backs a clone of `oauth2_token.authorize` requiring the `custom_elements`
 * format, so only `/ce-api` reaches it. The parent controller decides
 * everything; only the built consent form is wrapped, which leaves the stock
 * HTML screen with its own scope list and unmarked buttons.
 */
final class Oauth2AuthorizeCeController extends Oauth2AuthorizeController {

  use CustomElementsFormControllerTrait;

  /**
   * The consent screen's props, and what the frontend submits back.
   */
  private ConsentScreen $consentScreen;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container) {
    $controller = parent::create($container);
    $controller->consentScreen = $container->get('openkb_agent.consent_screen');
    return $controller;
  }

  /**
   * {@inheritdoc}
   */
  public function authorize(Request $request) {
    $form = parent::authorize($request);
    // Anything else is a redirect the parent decided: an already-approved
    // client's code, or the answer to Allow or Deny.
    if (!is_array($form)) {
      return $form;
    }
    $props = $this->consentScreen->props($form);
    $this->consentScreen->removeScopeList($form);
    $this->consentScreen->markDecisionButtons($form);

    $element = $this->getCustomElementsContentResult($form);
    foreach ($props as $name => $value) {
      $element->setAttribute($name, $value);
    }
    return $element;
  }

}
