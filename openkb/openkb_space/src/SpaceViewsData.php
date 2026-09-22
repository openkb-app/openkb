<?php

declare(strict_types=1);

namespace Drupal\openkb_space;

use Drupal\views\EntityViewsData;

/**
 * Views integration for spaces.
 */
final class SpaceViewsData extends EntityViewsData {

  /**
   * {@inheritdoc}
   */
  public function getViewsData(): array {
    $data = parent::getViewsData();
    // Filter the owner by name, as the content listing does for authors.
    $data['openkb_space']['uid']['filter']['id'] = 'user_name';
    return $data;
  }

}
