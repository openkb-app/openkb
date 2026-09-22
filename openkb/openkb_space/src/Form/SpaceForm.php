<?php

declare(strict_types=1);

namespace Drupal\openkb_space\Form;

use Drupal\Core\Entity\ContentEntityForm;
use Drupal\Core\Form\FormStateInterface;

/**
 * Form controller for the space entity edit forms.
 */
final class SpaceForm extends ContentEntityForm {

  /**
   * {@inheritdoc}
   */
  public function form(array $form, FormStateInterface $form_state): array {
    $form = parent::form($form, $form_state);
    // Every save is a revision (see Space::preSave), so there is nothing to
    // opt into; the log message stays visible instead.
    $form['revision']['#access'] = FALSE;
    return $form;
  }

  /**
   * {@inheritdoc}
   */
  protected function getNewRevisionDefault(): bool {
    return TRUE;
  }

  /**
   * {@inheritdoc}
   */
  public function save(array $form, FormStateInterface $form_state): int {
    $result = parent::save($form, $form_state);

    $message_args = ['%label' => $this->entity->toLink()->toString()];
    $logger_args = [
      '%label' => $this->entity->label(),
      'link' => $this->entity->toLink($this->t('View'))->toString(),
    ];

    switch ($result) {
      case SAVED_NEW:
        $this->messenger()->addStatus($this->t('New space %label has been created.', $message_args));
        $this->logger('openkb_space')->notice('New space %label has been created.', $logger_args);
        break;

      case SAVED_UPDATED:
        $this->messenger()->addStatus($this->t('The space %label has been updated.', $message_args));
        $this->logger('openkb_space')->notice('The space %label has been updated.', $logger_args);
        break;

      default:
        throw new \LogicException('Could not save the entity.');
    }

    $form_state->setRedirectUrl($this->entity->toUrl());

    return $result;
  }

}
