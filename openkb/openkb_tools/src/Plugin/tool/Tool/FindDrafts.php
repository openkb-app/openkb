<?php

declare(strict_types=1);

namespace Drupal\openkb_tools\Plugin\tool\Tool;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Datetime\DateFormatterInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Render\Markup;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_space\SpaceStorage;
use Drupal\path_alias\AliasManagerInterface;
use Drupal\tool\Attribute\Tool;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolBase;
use Drupal\tool\Tool\ToolOperation;
use Drupal\tool\TypedData\InputDefinition;
use Drupal\tool\TypedData\ListInputDefinition;
use Drupal\tool\TypedData\MapInputDefinition;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Finds pages carrying unfinished work, by a fragment of their title.
 *
 * Work in progress is what search cannot answer: the index holds published
 * default revisions, so a page nobody has published yet and a forward draft on
 * top of a published one are both invisible to `tool_api__search_pages`. This
 * asks storage instead — the newest revision of each page, matched on its
 * own title — so "the draft I just made" resolves to a path an editing call
 * can take.
 *
 * Two shapes count as unfinished work: a page whose newest revision is not
 * published, and one published with a newer draft above it. A page whose
 * newest revision *is* its published one is finished work and is not
 * answered.
 *
 * The gate is per hit, and it is `update`: this names work to edit, so a page
 * the caller may read but not write is not one of its answers.
 */
#[Tool(
  id: 'openkb_find_drafts',
  label: new TranslatableMarkup('Find drafts'),
  description: new TranslatableMarkup('Find knowledge-base pages with unfinished work — unpublished pages, and published pages carrying a newer draft — by a word or two of their title. This is how you resolve "the draft I just created": tool_api__search_pages reads the published index and answers neither kind. Answers the twenty most recently changed, newest first, each with the path getPageForEditing and updateBlocks take, the space it lives in, and whether the page itself is still unpublished ("draft") or published with a draft on top ("published-with-draft"). Only pages you may edit are listed.'),
  operation: ToolOperation::Read,
  destructive: FALSE,
  input_definitions: [
    'title' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Title'),
      description: new TranslatableMarkup('Part of the page title, matched anywhere in it. Words from the title, not a question — nothing here searches page content.'),
      constraints: ['Length' => ['min' => 1]],
    ),
    'space' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Space'),
      description: new TranslatableMarkup('Narrows to one space, by the slug tool_api__list_spaces reports.'),
      required: FALSE,
    ),
  ],
  output_definitions: [
    'drafts' => new ListInputDefinition(
      label: new TranslatableMarkup('Drafts'),
      description: new TranslatableMarkup('The pages with unfinished work, most recently changed first.'),
      item_definition: new MapInputDefinition(
        label: new TranslatableMarkup('Draft'),
        description: new TranslatableMarkup('One page you may edit.'),
        property_definitions: [
          'path' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Path'),
            description: new TranslatableMarkup('The page path, as getPageForEditing and updateBlocks read by.'),
          ),
          'title' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Title'),
            description: new TranslatableMarkup("The newest revision's title."),
          ),
          'space' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Space'),
            description: new TranslatableMarkup("The slug of the space the page lives in."),
          ),
          'state' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('State'),
            description: new TranslatableMarkup('"draft" — the page is not published; "published-with-draft" — a published page carries a newer draft, so an edit here changes work somebody already signed off.'),
          ),
          'changed' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Changed'),
            description: new TranslatableMarkup('When the draft was last written, ISO 8601.'),
          ),
          'author' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Author'),
            description: new TranslatableMarkup('Who wrote the newest revision.'),
          ),
        ],
      ),
    ),
  ],
)]
final class FindDrafts extends ToolBase {

  /**
   * The bundle every KB page is.
   */
  private const BUNDLE = 'kb_page';

  /**
   * How many pages one call answers.
   */
  private const LIMIT = 20;

  /**
   * The entity type manager.
   */
  protected EntityTypeManagerInterface $entityTypeManager;

  /**
   * Resolves the path a hit is addressed by.
   */
  protected AliasManagerInterface $aliasManager;

  /**
   * Formats the timestamp a hit carries.
   */
  protected DateFormatterInterface $dateFormatter;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
    $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
    $instance->entityTypeManager = $container->get('entity_type.manager');
    $instance->aliasManager = $container->get('path_alias.manager');
    $instance->dateFormatter = $container->get('date.formatter');
    return $instance;
  }

  /**
   * {@inheritdoc}
   */
  protected function doExecute(array $values): ExecutableResult {
    $fragment = trim((string) ($values['title'] ?? ''));
    if ($fragment === '') {
      return ExecutableResult::failure(
        new TranslatableMarkup('A title fragment is required — this finds pages by their title, not by their content.'),
      );
    }
    $slug = trim((string) ($values['space'] ?? ''));
    $spaces = SpaceStorage::get($this->entityTypeManager);
    $space = $slug === '' ? NULL : $spaces->getBySlug($slug);
    if ($slug !== '' && !$space instanceof SpaceInterface) {
      return ExecutableResult::failure(new TranslatableMarkup(
        'No space "@slug" — call tool_api__list_spaces and narrow by a slug it reports.',
        ['@slug' => $slug],
      ));
    }

    $storage = $this->entityTypeManager->getStorage('node');
    // The newest revision of each page, matched on the title that revision
    // carries: a draft renamed since the publish is found under its new name.
    // Both narrowings are the query's, so the twenty it caps at are twenty
    // candidates, not twenty rows that mostly fall away below.
    $query = $storage->getQuery()
      ->accessCheck(TRUE)
      ->latestRevision()
      ->condition('type', self::BUNDLE)
      ->condition('title', $fragment, 'CONTAINS')
      // Both shapes of unfinished work leave the newest revision unpublished:
      // a page nobody published, and the draft sitting over a published one.
      ->condition('status', 0)
      ->sort('changed', 'DESC')
      // Drafts written in the same second tie on `changed`; the newer revision
      // breaks it, so the order is the same on every run.
      ->sort('vid', 'DESC')
      ->range(0, self::LIMIT);
    if ($space instanceof SpaceInterface) {
      $query->condition('field_space.target_id', $space->id());
    }
    $revision_ids = array_keys($query->execute());

    $drafts = [];
    $revisions = $storage->loadMultipleRevisions($revision_ids);
    // Ordered by the query, not by the load: a cache hit comes back first
    // whatever the rows said.
    foreach ($revision_ids as $revision_id) {
      $revision = $revisions[$revision_id] ?? NULL;
      if (!$revision instanceof NodeInterface || !$revision->access('update')) {
        continue;
      }
      $default = $storage->load($revision->id());
      if (!$default instanceof NodeInterface) {
        continue;
      }
      $pending = $revision->getRevisionId() !== $default->getRevisionId();
      $drafts[] = $this->toHit($revision, $pending && $default->isPublished());
    }

    return ExecutableResult::success($this->answer($fragment, $drafts), ['drafts' => $drafts]);
  }

  /**
   * {@inheritdoc}
   *
   * Every hit is checked for `update` as it is read, so being signed in is the
   * whole gate here. Anonymous edits nothing and would only ever be answered
   * an empty list.
   */
  protected function checkAccess(array $values, AccountInterface $account, bool $return_as_object = FALSE): bool|AccessResultInterface {
    $access = AccessResult::allowedIf($account->isAuthenticated())
      ->addCacheContexts(['user.roles:authenticated']);

    return $return_as_object ? $access : $access->isAllowed();
  }

  /**
   * One revision as the hit contract.
   *
   * @return array<string, string>
   *   The hit.
   */
  private function toHit(NodeInterface $revision, bool $over_published): array {
    $space = $revision->get('field_space')->entity;

    return [
      'path' => $this->aliasManager->getAliasByPath(
        '/node/' . $revision->id(),
        $revision->language()->getId(),
      ),
      'title' => (string) $revision->label(),
      'space' => $space instanceof SpaceInterface ? $space->getSlug() : '',
      'state' => $over_published ? 'published-with-draft' : 'draft',
      'changed' => $this->dateFormatter->format($revision->getChangedTime(), 'custom', 'c'),
      'author' => (string) ($revision->getRevisionUser()?->getDisplayName() ?? ''),
    ];
  }

  /**
   * The hits as the caller reads them.
   *
   * @param string $fragment
   *   The title fragment that was matched.
   * @param array<int, array<string, string>> $drafts
   *   The hits.
   */
  private function answer(string $fragment, array $drafts): TranslatableMarkup {
    if (!$drafts) {
      return new TranslatableMarkup(
        'No page you may edit has unfinished work whose title holds @title.',
        ['@title' => Markup::create($fragment)],
      );
    }

    $lines = [];
    foreach ($drafts as $draft) {
      $lines[] = sprintf('%s — %s (%s)', $draft['title'], $draft['path'], $draft['state']);
    }

    // Markup, not an escaping placeholder: a title holding `&` reaches the
    // model as the hits carry it.
    return new TranslatableMarkup("@count page(s) with unfinished work matching @title:\n@list", [
      '@count' => count($drafts),
      '@title' => Markup::create($fragment),
      '@list' => Markup::create(implode("\n", $lines)),
    ]);
  }

}
