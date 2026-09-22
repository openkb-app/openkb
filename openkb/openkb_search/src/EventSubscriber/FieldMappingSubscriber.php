<?php

declare(strict_types=1);

namespace Drupal\openkb_search\EventSubscriber;

use Drupal\openkb_search\Plugin\OpenSearch\Analyser\OpenKbText;
use Drupal\search_api_opensearch\Event\FieldMappingEvent;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;

/**
 * Reads every `text` field with the product's analyzer.
 *
 * Runs ahead of a project's own subscriber and only names an analyzer where
 * none is named yet, so a project's choice wins either way round.
 */
final class FieldMappingSubscriber implements EventSubscriberInterface {

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    return [FieldMappingEvent::class => ['onFieldMapping', 100]];
  }

  /**
   * Names the analyzer on the mapping of one field.
   */
  public function onFieldMapping(FieldMappingEvent $event): void {
    if ($event->getField()->getType() === 'text') {
      $event->setParam($event->getParam() + ['analyzer' => OpenKbText::PLUGIN_ID]);
    }
  }

}
