<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\ai\OperationType\Embeddings\EmbeddingsInput;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\node\Entity\Node;
use Drupal\openkb_search_test\Plugin\AiProvider\HashEmbeddingProvider;
use Drupal\openkb_space\Entity\Space;
use Drupal\search_api\Entity\Index;
use Drupal\search_api\Entity\Server;
use Drupal\taxonomy\Entity\Term;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use GuzzleHttp\Client;
use GuzzleHttp\Promise\Create;
use GuzzleHttp\Psr7\Response;
use Psr\Http\Message\RequestInterface;
use Symfony\Component\Yaml\Yaml;

/**
 * Runs the shipped `kb_chunks` index against the live OpenSearch container.
 *
 * The recipe's own config, with the sections stubbed where the sidecar would
 * answer them and the embeddings answered by `openkb_search_test`'s
 * deterministic provider. Each test method owns its collection, which is what
 * paratest and a re-run both need.
 *
 * A missing OpenSearch fails the test, see {@see RequiresOpenSearchTrait}.
 */
abstract class ChunkIndexTestBase extends KernelTestBase {

  use RequiresOpenSearchTrait;
  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'filter',
    'text',
    'node',
    'options',
    'path',
    'path_alias',
    'key',
    'search_api',
    'search_api_opensearch',
    'taxonomy',
    'ai',
    'ai_search',
    'ai_vdb_provider_opensearch',
    // The document types a search narrows by come from the frontmatter
    // schema, which openkb_search's PageTypes reads.
    'openkb_schema',
    'openkb_search',
    'openkb_search_test',
    'openkb_space',
    'openkb_space_access',
    'lupus_decoupled_ce_api',
    'comark',
  ];

  /**
   * The embeddings engine the test indexes with: provider__model.
   */
  protected const ENGINE = 'openkb_hash__text-embedding-3-small';

  /**
   * The frontend origin the sidecar is expected to be called on.
   */
  protected const FRONTEND_BASE_URL = 'http://frontend.example.com:3000';

  /**
   * A block id at the end of a line, the way comark spells one.
   */
  protected const BLOCK_ID = '/\s*\{#([\w-]+)\}[ \t]*$/';

  /**
   * The longest text one chunk carries; a longer block is cut into parts.
   */
  protected const CHUNK_CHARS = 400;

  /**
   * The stored fields one row carries, which is all a hit is built from.
   */
  protected const ROW_SHAPE = [
    'drupal_long_id',
    'drupal_entity_id',
    'block_id',
    'heading_path',
    'part',
    'cites',
    'links',
    'title',
    'path',
    'space',
    'langcode',
    'content',
  ];

  /**
   * The chunk index, built from the recipe's shipped config.
   */
  protected Index $index;

  /**
   * The collection this test method owns on the cluster.
   */
  protected string $collection;

  /**
   * The space probe pages are filed in.
   */
  protected Space $space;

  /**
   * The vector store, for reading rows back.
   *
   * @var \Drupal\ai\AiVdbProviderInterface
   */
  protected $provider;

  /**
   * DRUPAL_FRONTEND_BASE_URL as the test process inherited it.
   */
  private string|false $inheritedFrontendBaseUrl;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();

    $this->inheritedFrontendBaseUrl = getenv('DRUPAL_FRONTEND_BASE_URL');
    putenv('DRUPAL_FRONTEND_BASE_URL');

    $this->container->set('http_client', new Client([
      'handler' => fn (RequestInterface $request): object => Create::promiseFor($this->sidecarResponse($request)),
    ]));

    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('search_api_task');
    $this->installEntitySchema('taxonomy_term');
    $this->installSchema('node', ['node_access']);
    $this->installSchema('search_api', ['search_api_item']);
    $this->installConfig(['field', 'filter', 'node', 'search_api', 'user', 'lupus_decoupled_ce_api', 'openkb_search']);

    $this->config('lupus_decoupled_ce_api.settings')
      ->set('frontend_base_url', self::FRONTEND_BASE_URL)
      ->save();

    // How the store reaches the cluster, as openkb_recipe_chunk_store ships it.
    $this->config('ai_vdb_provider_opensearch.settings')
      ->setData($this->recipeConfig('ai_vdb_provider_opensearch.settings', 'openkb_recipe_chunk_store'))
      ->save();

    User::create(['uid' => 0, 'name' => '', 'status' => 0])->save();
    $this->setCurrentUser($this->createUser(['bypass node access']));

    $this->importRecipeConfig([
      'node.type.kb_page',
      'taxonomy.vocabulary.kb_tags',
      'field.storage.node.field_kb_body',
      'field.storage.node.field_space',
      'field.storage.node.field_type',
      'field.storage.node.field_tags',
      'field.storage.node.field_summary',
      'field.storage.node.field_owner',
      'field.storage.node.field_contributors',
      'field.field.node.kb_page.field_kb_body',
      'field.field.node.kb_page.field_space',
      'field.field.node.kb_page.field_type',
      'field.field.node.kb_page.field_tags',
      'field.field.node.kb_page.field_summary',
      'field.field.node.kb_page.field_owner',
      'field.field.node.kb_page.field_contributors',
      // The exposure contract: what it places is what a search may filter by.
      'core.entity_form_mode.node.frontmatter',
      'core.entity_form_display.node.kb_page.frontmatter',
    ]);
    $this->importRecipeConfig(['ai_search.index.kb_chunks']);

    $this->provider = $this->container->get('ai.vdb_provider')->createInstance('opensearch');
    $this->requireOpenSearch();

    // The recipe's own server, embedding through the test provider and writing
    // into a collection this test method owns: `databasePrefix` is unique per
    // method, which is what paratest and a re-run both need.
    $this->collection = 'chunks_' . strtolower($this->databasePrefix);
    $server = $this->recipeConfig('search_api.server.ai_chunks');
    $server['backend_config']['embeddings_engine'] = self::ENGINE;
    $server['backend_config']['database_settings']['collection'] = $this->collection;
    Server::create($server)->save();

    $this->space = Space::create(['label' => 'Handbook']);
    $this->space->save();

    // The shipped floor is measured on a knowledge base; these fixtures are a
    // few words long and score on their own scale, so a case about the floor
    // sets the number it needs — see setRelevanceFloor().
    $this->setRelevanceFloor(0);

    $this->index = Index::create($this->recipeConfig('search_api.index.kb_chunks'));
    $this->index->save();
  }

  /**
   * {@inheritdoc}
   */
  protected function tearDown(): void {
    if (isset($this->provider) && isset($this->collection) && $this->provider->ping()) {
      try {
        $this->provider->dropCollection($this->collection);
      }
      catch (\Exception) {
        // The collection was never created.
      }
    }
    if ($this->inheritedFrontendBaseUrl === FALSE) {
      putenv('DRUPAL_FRONTEND_BASE_URL');
    }
    else {
      putenv('DRUPAL_FRONTEND_BASE_URL=' . $this->inheritedFrontendBaseUrl);
    }
    parent::tearDown();
  }

  /**
   * The provider answers, which is what requireOpenSearch() asks.
   */
  protected function serverAvailable(): bool {
    return isset($this->provider) && $this->provider->ping();
  }

  /**
   * Every row of the collection, in document order.
   *
   * Read straight off `_source`, so nothing can be filled in from the entity
   * behind the row.
   *
   * @param string[] $source
   *   The stored fields to read; the row's own shape by default.
   *
   * @return array<int, array>
   *   One array of stored fields per row.
   */
  protected function rows(array $source = self::ROW_SHAPE): array {
    $index = 'default_' . $this->collection;
    $client = $this->provider->getClient();
    $client->indices()->refresh(['index' => $index]);
    $result = $client->search([
      'index' => $index,
      'body' => [
        'size' => 50,
        'query' => ['match_all' => (object) []],
        '_source' => $source,
        'sort' => ['drupal_long_id' => 'asc'],
      ],
    ]);
    return array_map(fn (array $hit) => $hit['_source'], $result['hits']['hits']);
  }

  /**
   * Indexes what has been created, and makes it answerable.
   */
  protected function indexPages(): void {
    $this->index->indexItems();
    $this->provider->getClient()->indices()->refresh(['index' => 'default_' . $this->collection]);
  }

  /**
   * What the vector clause alone answers, best first.
   *
   * The scale the floor is set on: OpenSearch scores the collection's metric
   * as `(1 + cosine) / 2`. A hit's own score is the fused one, which the
   * pipeline normalised against the result set, so the floor cannot be read
   * off it.
   *
   * @return list<array{score: float, content: string}>
   *   One entry per row within the search, best first.
   */
  protected function vectorScores(string $query): array {
    $backend = $this->index->getServerInstance()->getBackendConfig();
    [$providerId, $modelId] = explode('__', $backend['embeddings_engine'], 2);
    $engine = $this->container->get('ai.provider')->createInstance($providerId);
    $engine->setConfiguration(['dimensions' => $backend['embeddings_engine_configuration']['dimensions']]);
    $vector = $engine->embeddings(new EmbeddingsInput($query, NULL), $modelId)->getNormalized();

    $result = $this->provider->getClient()->search([
      'index' => 'default_' . $this->collection,
      'body' => [
        'size' => 50,
        'query' => ['knn' => ['vector' => ['vector' => $vector, 'k' => 50]]],
        '_source' => ['content'],
      ],
    ]);
    return array_map(
      fn (array $hit): array => ['score' => (float) $hit['_score'], 'content' => (string) $hit['_source']['content']],
      $result['hits']['hits'],
    );
  }

  /**
   * The texts the embeddings provider was last handed.
   *
   * @return list<string>
   *   The texts of the last call that reached the provider; a query answered
   *   from the embedding cache leaves the ones before it standing.
   */
  protected function embeddedTexts(): array {
    return array_values((array) $this->container->get('state')->get(HashEmbeddingProvider::TEXTS_STATE_KEY, []));
  }

  /**
   * Sets the floor the vector clause of a query carries.
   */
  protected function setRelevanceFloor(float $floor): void {
    $this->config('openkb_search.settings')->set('vector_floor', $floor)->save();
  }

  /**
   * Creates a kb_page in a space, published or not.
   *
   * The body is stored the way a write spells it: every block carries an id,
   * the title heading included. Pass an id in the markdown to name it, or
   * FALSE for $blockIds to store markdown no write has been through.
   * $frontmatter names the fields a case needs; the rest keep their defaults,
   * so a page is an `article` unless it says otherwise.
   */
  protected function createPage(string $title, bool $published, string $body, ?Space $space = NULL, bool $blockIds = TRUE, array $frontmatter = []): Node {
    $node = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'status' => $published,
      'uid' => 1,
      'field_kb_body' => [
        'value' => $blockIds ? $this->withBlockIds("# $title\n\n$body") : "# $title\n\n$body",
        'format' => 'comark',
      ],
      'field_space' => ['target_id' => ($space ?? $this->space)->id()],
    ] + $frontmatter);
    $node->save();
    return $node;
  }

  /**
   * A tag of the kb_tags vocabulary, for a frontmatter reference.
   */
  protected function createTag(string $name): Term {
    $term = Term::create(['vid' => 'kb_tags', 'name' => $name]);
    $term->save();
    return $term;
  }

  /**
   * The markdown with an id on every block that carries none.
   *
   * Ids are counted rather than random, so a case can name the one it means.
   */
  protected function withBlockIds(string $markdown): string {
    $block = 0;
    $lines = [];
    foreach (explode("\n", $markdown) as $line) {
      if (trim($line) === '') {
        $lines[] = $line;
        continue;
      }
      $block++;
      $lines[] = preg_match(self::BLOCK_ID, $line) === 1 ? $line : $line . ' {#b-' . $block . '}';
    }
    return implode("\n", $lines);
  }

  /**
   * A members-only space whose viewer roster holds the one account.
   */
  protected function createSpace(string $name, UserInterface $viewer): Space {
    $space = Space::create([
      'label' => $name,
      'viewers' => [['target_id' => $viewer->id()]],
      // A space is reached by its alias, and the alias unslashed is the slug
      // every URL names it by.
      'path' => ['alias' => '/' . strtolower(str_replace(' ', '-', $name))],
    ]);
    $space->save();
    return $space;
  }

  /**
   * What the strategy embeds for one chunk: where it sits, then what it says.
   *
   * The title is the index's first Contextual Content field and is written
   * bare, so it opens the text unless the heading path already does.
   *
   * @param string $title
   *   The page title.
   * @param array{heading_path: list<string>, text: string} $chunk
   *   The chunk.
   * @param list<string> $context
   *   The Contextual Content lines that follow it, in field order.
   */
  protected function embedded(string $title, array $chunk, array $context = []): string {
    $path = $chunk['heading_path'];
    $lines = ($path[0] ?? '') === $title ? [] : array_filter([$title]);
    $lines = [...$lines, ...$context, implode(' > ', $path)];
    return implode("\n", [...array_filter($lines), $chunk['text']]);
  }

  /**
   * Drops what both alias caches hold of `/node/<nid>`.
   *
   * A page saved before its alias exists leaves both holding "no alias";
   * a real save writes the two together.
   */
  protected function clearAliasCaches(): void {
    $this->container->get('path_alias.whitelist')->clear();
    $this->container->get('path_alias.manager')->cacheClear();
  }

  /**
   * What the stubbed sidecar answers one request with.
   *
   * A case that watches the call, or makes it fail, overrides this.
   */
  protected function sidecarResponse(RequestInterface $request): Response {
    return new Response(200, ['Content-Type' => 'application/json'], (string) json_encode(
      $this->sidecar($this->requestedMarkdown($request)),
    ));
  }

  /**
   * The sections the sidecar would answer, cut on the same rule it cuts on.
   *
   * A heading opens a section and closes the one above it; the heading path is
   * the headings still open. A block id is the one the markdown spells, empty
   * where it spells none. The chunker itself is covered by its own vitest
   * suite — what this stands in for is the shape the strategy is handed.
   *
   * @return array{chunks: array<int, array{block_id: string, heading_path: string[], part: int, text: string, cites: string[], links: string[]}>}
   *   The sidecar payload.
   */
  protected function sidecar(string $markdown): array {
    $chunks = [];
    $open = [];
    foreach (explode("\n", $markdown) as $line) {
      if (trim($line) === '') {
        continue;
      }
      $id = preg_match(self::BLOCK_ID, $line, $found) === 1 ? $found[1] : '';
      $line = (string) preg_replace(self::BLOCK_ID, '', $line);
      $line = rtrim($line);
      if (preg_match('/^(#+)\s+(.*)$/', $line, $matches) === 1) {
        $level = strlen($matches[1]);
        while ($open !== [] && end($open)['level'] >= $level) {
          array_pop($open);
        }
        $open[] = ['level' => $level, 'text' => $matches[2]];
        $chunks[] = [
          'block_id' => $id,
          'heading_path' => array_column($open, 'text'),
          'part' => 0,
          'text' => $matches[2],
        ] + $this->edges($line);
        continue;
      }
      if ($chunks === []) {
        $chunks[] = ['block_id' => $id, 'heading_path' => [], 'part' => 0, 'text' => $line] + $this->edges($line);
        continue;
      }
      $last = count($chunks) - 1;
      $chunks[$last]['text'] .= "\n\n" . $line;
      foreach ($this->edges($line) as $kind => $found) {
        $chunks[$last][$kind] = array_values(array_unique([...$chunks[$last][$kind], ...$found]));
      }
    }
    return ['chunks' => $this->split($chunks)];
  }

  /**
   * The reference edges one line of markdown names.
   *
   * The same rule the sidecar follows: a reference names the page and, where
   * it names a block, that block too.
   *
   * @return array{cites: list<string>, links: list<string>}
   *   The edges.
   */
  protected function edges(string $line): array {
    $edges = ['cites' => [], 'links' => []];
    $patterns = [
      'cites' => '/:citation\{([^}]*)\}/',
      'links' => '/:doc\[[^\]]*\]\{([^}]*)\}/',
    ];
    foreach ($patterns as $kind => $pattern) {
      preg_match_all($pattern, $line, $found, PREG_SET_ORDER);
      foreach ($found as $one) {
        if (preg_match('/\bnid="(\d+)"/', $one[1], $nid) !== 1) {
          continue;
        }
        $edges[$kind][] = $nid[1];
        if (preg_match('/\bblock="([\w-]+)"/', $one[1], $block) === 1) {
          $edges[$kind][] = $nid[1] . '#' . $block[1];
        }
      }
      $edges[$kind] = array_values(array_unique($edges[$kind]));
    }
    return $edges;
  }

  /**
   * Cuts a chunk whose text is too long into parts, on paragraph boundaries.
   *
   * {@see self::CHUNK_CHARS} is this fixture's own rule, not the chunker's:
   * what it stands in for is the shape a consumer has to collapse again — the
   * parts of one block share its id and its heading path, counting from 0.
   *
   * @param array<int, array{block_id: string, heading_path: string[], part: int, text: string}> $chunks
   *   The chunks, one per block.
   *
   * @return array<int, array{block_id: string, heading_path: string[], part: int, text: string}>
   *   The chunks, oversized blocks cut into parts.
   */
  protected function split(array $chunks): array {
    $cut = [];
    foreach ($chunks as $chunk) {
      $text = '';
      $part = 0;
      foreach (explode("\n\n", $chunk['text']) as $paragraph) {
        if ($text !== '' && mb_strlen($text . "\n\n" . $paragraph) > self::CHUNK_CHARS) {
          $cut[] = ['part' => $part++, 'text' => $text] + $chunk;
          $text = '';
        }
        $text = $text === '' ? $paragraph : $text . "\n\n" . $paragraph;
      }
      $cut[] = ['part' => $part, 'text' => $text] + $chunk;
    }
    return $cut;
  }

  /**
   * The markdown the indexer posted to the sidecar.
   */
  protected function requestedMarkdown(RequestInterface $request): string {
    $payload = json_decode((string) $request->getBody(), TRUE);
    return (string) ($payload['markdown'] ?? '');
  }

  /**
   * Creates config entities straight from the recipe's YAML files.
   *
   * @param string[] $names
   *   Config names, in dependency order.
   */
  protected function importRecipeConfig(array $names): void {
    /** @var \Drupal\Core\Config\ConfigManagerInterface $manager */
    $manager = $this->container->get('config.manager');
    foreach ($names as $name) {
      $data = $this->recipeConfig($name);
      $entityType = $manager->getEntityTypeIdByName($name);
      if ($entityType === NULL) {
        $this->config($name)->setData($data)->save();
        continue;
      }
      // A recipe file holds a storage record: a list field's allowed values
      // are a list there and a map on the entity.
      $storage = $this->container->get('entity_type.manager')->getStorage($entityType);
      $storage->createFromStorageRecord($data)->save();
    }
  }

  /**
   * One of the recipe's config files, without its dependencies.
   *
   * @param string $name
   *   The config name.
   * @param string $recipe
   *   The recipe that ships it.
   *
   * @return array<string, mixed>
   *   The config data.
   */
  protected function recipeConfig(string $name, string $recipe = 'openkb_recipe_main'): array {
    $data = Yaml::parseFile(dirname(DRUPAL_ROOT) . "/recipes/$recipe/config/$name.yml");
    unset($data['dependencies']);
    return $data;
  }

}
