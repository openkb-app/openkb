<?php

declare(strict_types=1);

namespace Drupal\openkb_tools\Plugin\tool\Tool;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Render\Markup;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Utility\Error;
use Drupal\openkb_search\Retrieval\PageTypes;
use Drupal\openkb_search\Retrieval\ChunkHit;
use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;
use Drupal\search_api\SearchApiException;
use Drupal\tool\Attribute\Tool;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolBase;
use Drupal\tool\Tool\ToolOperation;
use Drupal\tool\TypedData\InputDefinition;
use Drupal\tool\TypedData\ListInputDefinition;
use Drupal\tool\TypedData\MapInputDefinition;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Hybrid search across the sections the caller may read.
 *
 * The one retrieval both AI consumers share — the chat in-process, agents over
 * `/mcp` (ADR 0009) — so neither can be answered hits the other would not get.
 * It answers evidence to cite, never a finished answer. The query runs in
 * Drupal (ADR 0010), where the index's processor scopes it to the account.
 */
#[Tool(
  id: 'openkb_search_pages',
  label: new TranslatableMarkup('Search pages'),
  description: new TranslatableMarkup('Search across knowledge-base pages you may read. A hit is one section of a page, not the whole page: it carries the section text, the headings it sits under, and a path that lands on the very block it opens on. Every query is matched two ways at once and the two rankings are combined: by meaning, so a section is found in words other than yours, and by the words themselves, so a name or a term you spell exactly is found where it is written. A section answers the word half only when it holds every word of the query, and the meaning half only when it is near enough to it, so no hits means nothing in the pages you may read is about the question, not that search is broken — it says so when it cannot run. It searches published pages: a page nobody has published and a draft written on top of a published page are both invisible here, so find those with tool_api__find_drafts. Narrow to one kind of document with `type`, which every hit also names.'),
  operation: ToolOperation::Read,
  destructive: FALSE,
  input_definitions: [
    'q' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Query'),
      description: new TranslatableMarkup('What to look for, in your own words. A word you write a minus in front of takes every section carrying it out of the answer.'),
      constraints: ['Length' => ['min' => 1]],
    ),
    'type' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Type'),
      description: new TranslatableMarkup('Answer only sections of pages of this document type, by its machine name — the `type` a hit names, and one of the values the frontmatter schema lists. Left out, every type answers.'),
      required: FALSE,
    ),
  ],
  output_definitions: [
    'query' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Query'),
      description: new TranslatableMarkup('The query that was run.'),
    ),
    'total' => new InputDefinition(
      data_type: 'integer',
      label: new TranslatableMarkup('Total'),
      description: new TranslatableMarkup('How many sections were answered.'),
    ),
    'hits' => new ListInputDefinition(
      label: new TranslatableMarkup('Hits'),
      description: new TranslatableMarkup('The matches, best first.'),
      item_definition: new MapInputDefinition(
        label: new TranslatableMarkup('Hit'),
        description: new TranslatableMarkup('One matching section.'),
        property_definitions: [
          'id' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Id'),
            description: new TranslatableMarkup('The index item id of the page the section belongs to.'),
          ),
          'title' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Title'),
            description: new TranslatableMarkup("The page's title."),
          ),
          'path' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Path'),
            description: new TranslatableMarkup('The page path, anchored on the section: tool_api__get_page reads by the part before the "#". A hit on the lead section, the text above the page’s first sub-heading, anchors on the page’s title heading.'),
          ),
          'block_id' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Block id'),
            description: new TranslatableMarkup("The block the section opens on, which tool_api__comment_on_block comments on. A hit on the lead section names the page's title heading, whose id tool_api__get_page answers as `title_block_id` — an anchor to link to, not a block a comment can name. Empty for a section whose markdown spells no id, and then the path carries no anchor either."),
          ),
          'space' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Space'),
            description: new TranslatableMarkup('The space the page lives in.'),
          ),
          'type' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Type'),
            description: new TranslatableMarkup("The page's document type, by machine name — what the `type` argument narrows by."),
            required: FALSE,
          ),
          'tags' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Tags'),
            description: new TranslatableMarkup('The tags the page carries, comma-separated.'),
            required: FALSE,
          ),
          'heading' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Heading'),
            description: new TranslatableMarkup('The headings the section sits under, outermost first.'),
            required: FALSE,
          ),
          'excerpt' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Excerpt'),
            description: new TranslatableMarkup("The section's own text."),
            required: FALSE,
          ),
          'score' => new InputDefinition(
            data_type: 'float',
            label: new TranslatableMarkup('Score'),
            description: new TranslatableMarkup('How well the section matched, relative to the other hits of this query.'),
          ),
        ],
      ),
    ),
  ],
)]
final class SearchPages extends ToolBase {

  /**
   * The chunk index read path.
   */
  protected ChunkRetrievalInterface $retrieval;

  /**
   * The configuration naming the hit count.
   */
  protected ConfigFactoryInterface $configFactory;

  /**
   * The document types a search may be narrowed to.
   */
  protected PageTypes $types;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
    $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
    $instance->retrieval = $container->get(ChunkRetrievalInterface::class);
    $instance->configFactory = $container->get('config.factory');
    $instance->types = $container->get(PageTypes::class);
    return $instance;
  }

  /**
   * {@inheritdoc}
   */
  protected function doExecute(array $values): ExecutableResult {
    $top_k = (int) $this->configFactory->get('openkb_tools.settings')->get('search.top_k');
    if ($top_k < 1) {
      return ExecutableResult::failure(new TranslatableMarkup(
        'Search is unavailable: no hit count is configured.',
      ));
    }

    $query = (string) $values['q'];
    $type = trim((string) ($values['type'] ?? ''));
    if ($type !== '' && !$this->types->has($type)) {
      // Every type is published in the frontmatter schema, so a value outside
      // it is a mistaken call rather than a search that matches nothing.
      return ExecutableResult::failure(new TranslatableMarkup(
        'There is no document type "@type". The types are: @types.',
        ['@type' => $type, '@types' => implode(', ', $this->types->values())],
      ));
    }

    try {
      $hits = array_map($this->toHit(...), $this->retrieval->retrieve($query, $top_k, ['type' => $type]));
    }
    catch (SearchApiException $e) {
      // A backend outage is unavailability, not "no matches" — say so, and
      // keep the detail in the log rather than in the model's context.
      Error::logException($this->logger, $e);
      return ExecutableResult::failure(new TranslatableMarkup(
        'Search is unavailable: the index could not be queried.',
      ));
    }

    return ExecutableResult::success(
      $this->answer($query, $hits),
      ['query' => $query, 'total' => count($hits), 'hits' => $hits],
    );
  }

  /**
   * {@inheritdoc}
   *
   * Which pages the caller reaches is the index processor's answer, per query.
   * Anonymous holds no space and would only ever be answered nothing.
   */
  protected function checkAccess(array $values, AccountInterface $account, bool $return_as_object = FALSE): bool|AccessResultInterface {
    $access = AccessResult::allowedIf($account->isAuthenticated())
      ->addCacheContexts(['user.roles:authenticated']);

    return $return_as_object ? $access : $access->isAllowed();
  }

  /**
   * One retrieved section as the hit contract.
   *
   * Every field is read off the index row: it carries the page's title, its
   * address and the section's own text, which is what an answer cites a page
   * by — so a hit costs no entity load.
   *
   * @return array<string, mixed>
   *   The hit.
   */
  private function toHit(ChunkHit $hit): array {
    $values = [
      'id' => $hit->entityId,
      'title' => $hit->title,
      'path' => $hit->anchoredPath(),
      'block_id' => $hit->blockId,
      'space' => $hit->space,
      'type' => $hit->type,
      'tags' => implode(', ', $hit->tags),
      'heading' => $hit->headingLine(),
      'excerpt' => $hit->prose(),
      'score' => $hit->score,
    ];
    // Each is declared optional: a section without them omits the key
    // rather than answering an empty string the model would read as content.
    foreach (['type', 'tags', 'heading', 'excerpt'] as $optional) {
      if ($values[$optional] === '') {
        unset($values[$optional]);
      }
    }
    return $values;
  }

  /**
   * The hits as the caller reads them.
   *
   * Unnumbered: an agent over MCP cites nothing, and in the chat the only
   * numbering an answer may cite is the grounding layer's.
   *
   * @param string $query
   *   The query that was run.
   * @param array<int, array<string, mixed>> $hits
   *   The hits.
   */
  private function answer(string $query, array $hits): TranslatableMarkup {
    if (!$hits) {
      return new TranslatableMarkup('No page you may read matches @query.', ['@query' => Markup::create($query)]);
    }

    $lines = [];
    foreach ($hits as $hit) {
      $lines[] = sprintf('%s — %s', $hit['title'], $hit['path']);
    }

    // Markup, not a bare string: an `@` placeholder HTML-escapes, and a title
    // holding `&` must reach the model as the hits carry it.
    return new TranslatableMarkup("@count result(s) for @query:\n@list", [
      '@count' => count($hits),
      '@query' => Markup::create($query),
      '@list' => Markup::create(implode("\n", $lines)),
    ]);
  }

}
