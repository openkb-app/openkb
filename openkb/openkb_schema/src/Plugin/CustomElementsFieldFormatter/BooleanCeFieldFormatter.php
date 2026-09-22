<?php

declare(strict_types=1);

namespace Drupal\openkb_schema\Plugin\CustomElementsFieldFormatter;

use Drupal\Core\Field\FieldItemListInterface;
use Drupal\Core\Form\FormStateInterface;
use Drupal\custom_elements\CustomElement;
use Drupal\custom_elements\CustomElementsFieldFormatterBase;

/**
 * Puts a boolean field on the wire as a boolean.
 *
 * Storage returns `"1"` or `"0"`, and a pass-through formatter sends that
 * string on; `"0"` is truthy in JavaScript. An empty field sends NULL, which
 * is not the same answer as FALSE.
 *
 * @todo Contribute this formatter to the custom_elements module upstream.
 *
 * @CustomElementsFieldFormatter(
 *   id = "boolean",
 *   label = @Translation("Boolean"),
 *   field_types = {"boolean"},
 * )
 */
class BooleanCeFieldFormatter extends CustomElementsFieldFormatterBase {

  /**
   * {@inheritdoc}
   */
  public function build(FieldItemListInterface $items, CustomElement $custom_element, $langcode = NULL) {
    $item = $items->first();
    $value = $item === NULL ? NULL : (bool) $item->value;
    $custom_element->setAttribute($this->getName() ?: $items->getName(), $value);
  }

  /**
   * {@inheritdoc}
   */
  public function buildConfigurationForm(array $form, FormStateInterface $form_state) {
    return [];
  }

  /**
   * {@inheritdoc}
   */
  public function submitConfigurationForm(array &$form, FormStateInterface $form_state) {
  }

}
