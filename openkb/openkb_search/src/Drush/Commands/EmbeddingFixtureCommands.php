<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Drush\Commands;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Extension\ModuleExtensionList;
use Drupal\openkb_search\Embedding\EmbeddingCacheInterface;
use Drush\Attributes as CLI;
use Drush\Commands\AutowireTrait;
use Drush\Commands\DrushCommands;

/**
 * Moves the embedding cache to and from the fixture CI indexes against.
 *
 * Indexing embeds every section of every page. Paying an API call for that on
 * each CI run is both slow and billed, and it makes a build depend on a key,
 * so the vectors are exported once from a run that had one and imported before
 * indexing. The cache holds no text — its key is a hash of it — so a file is
 * exactly what the cache yields, written under the same keys.
 */
final class EmbeddingFixtureCommands extends DrushCommands {

  use AutowireTrait;

  /**
   * Where the fixture lives, relative to this module.
   */
  private const FIXTURE_DIR = 'tests/fixtures/embeddings';

  public function __construct(
    private readonly EmbeddingCacheInterface $cache,
    private readonly ModuleExtensionList $moduleList,
  ) {
    parent::__construct();
  }

  /**
   * Writes the embedding cache out, one file per provider, model and dimension.
   *
   * @param array $options
   *   The command options.
   */
  #[CLI\Command(name: 'openkb:embeddings-export')]
  #[CLI\Option(name: 'dir', description: 'Where to write, default the openkb_search fixture directory.')]
  #[CLI\Option(name: 'model', description: 'Export only this embedding model. Every provider that answered it is written to a file of its own.')]
  #[CLI\Usage(
    name: 'drush openkb:embeddings-export --model=text-embedding-3-small',
    description: 'Refreshes the fixture from a site that has an OpenAI key.',
  )]
  public function export(array $options = ['dir' => self::REQ, 'model' => self::REQ]): void {
    $dir = $this->dir($options['dir'] ?? NULL);
    if (!is_dir($dir) && !mkdir($dir, 0777, TRUE) && !is_dir($dir)) {
      throw new \RuntimeException(sprintf('Cannot write the fixture directory "%s".', $dir));
    }

    $files = [];
    foreach ($this->cache->all() as $key => $entry) {
      $provider = (string) ($entry['provider'] ?? '');
      $model = (string) ($entry['model'] ?? '');
      $dimensions = (int) ($entry['dimensions'] ?? 0);
      if (($options['model'] ?? NULL) !== NULL && $model !== $options['model']) {
        continue;
      }
      $files[$this->fileName($provider, $model, $dimensions)][$key] = [
        'provider' => $provider,
        'model' => $model,
        'dimensions' => $dimensions,
        // Six decimals: the vectors are unit-scaled, and full float precision
        // triples the file for a difference no cosine distance can see.
        'vector' => array_map(fn (float $value) => round($value, 6), array_values($entry['vector'] ?? [])),
      ];
    }

    foreach ($files as $name => $entries) {
      ksort($entries);
      file_put_contents($dir . '/' . $name, Json::encode($entries) . "\n");
      $this->logger()->success(sprintf('%s: %d embeddings.', $name, count($entries)));
    }
    if ($files === []) {
      $this->logger()->warning('The embedding cache is empty, so nothing was written. Index the site with a keyed provider first.');
    }
  }

  /**
   * Loads the fixture into the embedding cache.
   *
   * @param array $options
   *   The command options.
   */
  #[CLI\Command(name: 'openkb:embeddings-import')]
  #[CLI\Option(name: 'dir', description: 'Where to read from, default the openkb_search fixture directory.')]
  #[CLI\Usage(
    name: 'drush openkb:embeddings-import',
    description: 'Fills the cache before indexing, so indexing calls no API.',
  )]
  public function import(array $options = ['dir' => self::REQ]): void {
    // The indexing run that follows is what the fixture is for, so its hits
    // and misses are counted from here. A stale or absent fixture shows as
    // misses; outside a tally nothing is counted at all.
    $this->cache->tally(TRUE);

    $dir = $this->dir($options['dir'] ?? NULL);
    $files = glob($dir . '/*.json') ?: [];
    if ($files === []) {
      $this->logger()->warning(sprintf('No embedding fixture in %s. Indexing will ask the provider for every chunk.', $dir));
      return;
    }
    foreach ($files as $file) {
      $entries = Json::decode((string) file_get_contents($file));
      if (!is_array($entries)) {
        throw new \RuntimeException(sprintf('The fixture "%s" is not a JSON object of cache entries.', $file));
      }
      $counts = $this->cache->restore($entries);
      $this->logger()->success(sprintf('%s: %d embeddings.', basename($file), $counts['restored']));
      if ($counts['skipped'] > 0) {
        $this->logger()->warning(sprintf('%s: %d entries are not a vector of their own dimension and were left out.', basename($file), $counts['skipped']));
      }
    }
  }

  /**
   * The fixture directory, the module's own unless the caller names one.
   */
  private function dir(?string $asked): string {
    return rtrim($asked ?? ($this->moduleList->getPath('openkb_search') . '/' . self::FIXTURE_DIR), '/');
  }

  /**
   * One provider, model and dimension's file name.
   *
   * The provider is part of it because two of them answer the same model id —
   * the keyless test provider among them — and a file named after the model
   * alone would put their vectors in the same place.
   */
  private function fileName(string $provider, string $model, int $dimensions): string {
    return preg_replace('/[^a-z0-9.-]+/i', '-', $provider . '-' . $model . '-' . $dimensions) . '.json';
  }

}
