<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite_test\EventSubscriber;

use Drupal\Core\State\StateInterface;
use Drupal\search_api\Event\ProcessingResultsEvent;
use Drupal\search_api\Event\SearchApiEvents;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;

/**
 * Answers every hit's fields as a processing backend would.
 *
 * A real backend returns the values the index's processors stored — stemmed,
 * lowercased, stripped of stopwords. `search_api_db` returns none and
 * search_api then reads them off the entity, so a kernel test cannot otherwise
 * tell the two sources apart.
 */
class ProcessedFieldValues implements EventSubscriberInterface {

  /**
   * State key: TRUE makes the backend answer processed values.
   */
  public const PROCESS = 'ai_rag_cite_test.process_field_values';

  /**
   * What a processed field answers.
   */
  public const PROCESSED = 'processed by the index';

  /**
   * Constructs the subscriber.
   *
   * @param \Drupal\Core\State\StateInterface $state
   *   Whether the backend answers processed values.
   */
  public function __construct(
    private readonly StateInterface $state,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    return [SearchApiEvents::PROCESSING_RESULTS => 'process'];
  }

  /**
   * Sets the fields on each hit, which stops search_api extracting them.
   */
  public function process(ProcessingResultsEvent $event): void {
    if (!$this->state->get(self::PROCESS, FALSE)) {
      return;
    }
    $results = $event->getResults();
    $index = $results->getQuery()->getIndex();
    foreach ($results->getResultItems() as $item) {
      foreach ($index->getFields() as $name => $field) {
        $item->setField($name, (clone $field)->setValues([self::PROCESSED]));
      }
    }
  }

}
