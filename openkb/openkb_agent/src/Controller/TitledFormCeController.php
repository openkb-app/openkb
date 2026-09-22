<?php

declare(strict_types=1);

namespace Drupal\openkb_agent\Controller;

use Drupal\Core\Controller\HtmlFormController;
use Drupal\Core\Routing\RouteMatchInterface;
use Drupal\lupus_decoupled_form\Controller\CustomElementsFormControllerTrait;
use Symfony\Component\HttpFoundation\Request;

/**
 * A custom-elements form controller that keeps the form's own heading.
 *
 * The stock one drops `#title`, which for a confirm form is the whole
 * question — "Revoke the API client Claude?". The route's title is the generic
 * one ("Revoke agent token"), so without this the screen never names what is
 * about to happen.
 */
final class TitledFormCeController extends HtmlFormController {

  use CustomElementsFormControllerTrait;

  /**
   * {@inheritdoc}
   */
  public function getContentResult(Request $request, RouteMatchInterface $route_match) {
    $form = parent::getContentResult($request, $route_match);
    $element = $this->getCustomElementsContentResult($form);
    if (isset($form['#title'])) {
      $element->setAttribute('title', (string) $form['#title']);
    }
    return $element;
  }

}
