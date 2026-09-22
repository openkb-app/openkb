<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Plugin\OpenSearch\Analyser;

use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\search_api_opensearch\Analyser\AnalyserBase;
use Drupal\search_api_opensearch\Attribute\OpenSearchAnalyser;

/**
 * The product's text analysis: standard tokenizer, lowercase, ascii folding.
 *
 * Language-specific analysis — a stemmer, a decompounder, stopwords, synonyms
 * — is project configuration on the same field-mapping event.
 */
#[OpenSearchAnalyser(
  id: OpenKbText::PLUGIN_ID,
  label: new TranslatableMarkup('OpenKB text'),
)]
final class OpenKbText extends AnalyserBase {

  /**
   * The plugin ID, which is also the analyzer's name in the index.
   */
  public const PLUGIN_ID = 'openkb_text';

  /**
   * {@inheritdoc}
   */
  public function getSettings(): array {
    return [
      'analysis' => [
        'analyzer' => [
          self::PLUGIN_ID => [
            'type' => 'custom',
            'tokenizer' => 'standard',
            'filter' => ['lowercase', 'asciifolding'],
          ],
        ],
      ],
    ];
  }

}
