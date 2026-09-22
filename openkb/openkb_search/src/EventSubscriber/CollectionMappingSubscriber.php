<?php

declare(strict_types=1);

namespace Drupal\openkb_search\EventSubscriber;

use Drupal\Component\Utility\NestedArray;
use Drupal\ai_vdb_provider_opensearch\Event\CollectionMappingEvent;
use Drupal\openkb_search\Plugin\OpenSearch\Analyser\OpenKbText;
use Drupal\search_api_opensearch\Analyser\AnalyserManager;
use Symfony\Component\EventDispatcher\EventSubscriberInterface;

/**
 * Maps the text a query matches as analyzed text, not as a keyword.
 *
 * The provider maps every string as a keyword, which only an exact whole-value
 * term matches; the lexical clause of a hybrid query needs the product's
 * analyzer over it.
 *
 * The collection is created when the server's config is saved, before the
 * index's own config exists, so the fields are named here rather than read off
 * `field_settings`: a field this list does not name is a keyword, whatever
 * type the index gives it.
 */
final class CollectionMappingSubscriber implements EventSubscriberInterface {

  /**
   * The fields the lexical clause matches in.
   *
   * `content` is the chunk's own text, as ai_search stores it; `summary` is
   * the page's abstract and `title` its name, both carried onto every chunk.
   */
  private const TEXT_FIELDS = ['content', 'summary', 'title'];

  /**
   * The text fields that keep an exact value beside the analyzed one.
   *
   * A keyword sub-field is what an exact-match read of the field needs; the
   * analyzed field alone matches only through the analyzer.
   */
  private const KEYWORD_SUBFIELDS = ['title'];

  public function __construct(
    private readonly AnalyserManager $analyserManager,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function getSubscribedEvents(): array {
    return [CollectionMappingEvent::class => 'onCollectionMapping'];
  }

  /**
   * Declares the analyzer and the fields read with it.
   */
  public function onCollectionMapping(CollectionMappingEvent $event): void {
    /** @var \Drupal\search_api_opensearch\Analyser\AnalyserInterface $analyser */
    $analyser = $this->analyserManager->createInstance(OpenKbText::PLUGIN_ID);
    $event->setSettings(NestedArray::mergeDeep($event->getSettings(), $analyser->getSettings()));

    $mappings = $event->getMappings();
    foreach (self::TEXT_FIELDS as $name) {
      $mappings['properties'][$name] = [
        'type' => 'text',
        'analyzer' => OpenKbText::PLUGIN_ID,
      ];
      if (in_array($name, self::KEYWORD_SUBFIELDS, TRUE)) {
        $mappings['properties'][$name]['fields']['keyword'] = [
          'type' => 'keyword',
          'ignore_above' => 256,
        ];
      }
    }
    $event->setMappings($mappings);
  }

}
