<?php

declare(strict_types=1);

namespace Drupal\openkb_tools\Plugin\tool\Tool;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Field\EntityReferenceFieldItemListInterface;
use Drupal\Core\Field\FieldItemListInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\node\NodeInterface;
use Drupal\openkb_schema\SchemaBuilder;
use Drupal\openkb_schema\SchemaUnavailableException;
use Drupal\comark\ComarkEntities;
use Drupal\path_alias\AliasManagerInterface;
use Drupal\tool\Attribute\Tool;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolBase;
use Drupal\tool\Tool\ToolOperation;
use Drupal\tool\TypedData\InputDefinition;
use Drupal\tool\TypedData\MapInputDefinition;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\Yaml\Yaml;

/**
 * Reads the published knowledge base, over Drupal's own read path.
 *
 * ADR 0009 puts a tool in Drupal unless it interacts with the live editing
 * session. Reading what is published needs no session: the published revision
 * is the default revision, the content of record, and this tool answers from
 * the entity itself. That is what lets the in-product chat have a read tool at
 * all — the chat is an MCP client of nothing and reaches only Drupal's tools.
 *
 * The split against {@see GetPageForEditing} is total. This serves the
 * published page and nothing an edit needs:
 *
 * - no `draft` input — reading the working copy is the editing part;
 * - no `versions` — block versions are the `expect` tokens `updateBlocks`
 *   refuses stale writes against, and a read that cannot precede a write has
 *   no use for one. They are also underivable here: a version is the hash of a
 *   block's *canonical* markdown, and canonical is what the comark serializer
 *   in the frontend spells. Drupal stores whatever was written to it — the
 *   seeded corpus and {@see CreatePage} both write plain markdown carrying a
 *   leading `# <title>` — so a hash taken here would disagree with the one the
 *   write side derives, and the disagreement would surface as a spurious
 *   refusal of a legitimate write;
 * - no `status` — `draft_exists`, `blocks_pending` and `can_publish` describe
 *   the working copy's editorial standing, which is the editing surface's
 *   subject, not the published page's.
 *
 * The projection is the `.md` wire format: the exposed frontmatter above the
 * body. Exposure is the `frontmatter` form display, read through
 * {@see SchemaBuilder}, so a field placed or removed there follows here with
 * no field list in this file.
 */
#[Tool(
  id: 'openkb_get_page',
  label: new TranslatableMarkup('Get page'),
  description: new TranslatableMarkup('Read a published knowledge-base page by path, as the `.md` wire format — a YAML frontmatter block of the exposed fields above the body — with the fields also given structured. This is the knowledge base as it stands published, which is what a reader of the page sees. It is the tool to answer questions from and to cite. It is not what an edit is based on: writes are made on the working copy, which this tool does not serve, and it answers no `versions` map — to edit a page, read it with getPageForEditing, whose `versions` are the `expect` tokens updateBlocks takes. A page with no published version yet is reported as not found.'),
  operation: ToolOperation::Read,
  destructive: FALSE,
  input_definitions: [
    'path' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Path'),
      description: new TranslatableMarkup('The page path, e.g. "team-wiki/getting-started" — its space slug then its own, exactly the URL path (a leading slash, a trailing ".md" and a "#block" anchor are tolerated). It is what a link between pages points at, and what every page tool takes as its "path".'),
      constraints: ['Length' => ['min' => 1]],
    ),
  ],
  output_definitions: [
    'path' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Path'),
      description: new TranslatableMarkup('Where the page lives — the address every other tool takes as its "path".'),
    ),
    'title' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Title'),
      description: new TranslatableMarkup("The page title. It is the page's own field, so it is not repeated as a heading in the body."),
    ),
    'title_block_id' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Title block id'),
      description: new TranslatableMarkup("The block the title is stored as. The body does not spell it, so this is where it is answered — it is the block a tool_api__search_pages hit on the page's lead section names."),
    ),
    'frontmatter' => new MapInputDefinition(
      label: new TranslatableMarkup('Frontmatter'),
      description: new TranslatableMarkup('The exposed fields as data, in display order — the same values the markdown carries in its frontmatter block. An exposed field with nothing in it is null, or an empty list where the field takes several values; a reference is {"id": uuid, "label": …}.'),
    ),
    'markdown' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Markdown'),
      description: new TranslatableMarkup('The whole page in the `.md` wire format: the frontmatter block above the body, carrying the `{#b-…}` id each block is addressed by — the ids updateBlocks names blocks with, so this read is enough to say which block you mean. Naming one in a write also takes its version, which only getPageForEditing answers.'),
    ),
  ],
)]
final class GetPage extends ToolBase {

  /**
   * The bundle every KB page is.
   */
  private const BUNDLE = 'kb_page';

  /**
   * The field carrying the comark body.
   */
  private const BODY_FIELD = 'field_kb_body';

  /**
   * The `.md` frontmatter fence.
   */
  private const DELIMITER = '---';

  /**
   * The frontmatter exposure contract.
   */
  protected SchemaBuilder $schema;

  /**
   * The entity type manager.
   */
  protected EntityTypeManagerInterface $entityTypeManager;

  /**
   * The path alias manager.
   */
  protected AliasManagerInterface $aliasManager;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
    $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
    $instance->schema = $container->get('openkb_schema.schema_builder');
    $instance->entityTypeManager = $container->get('entity_type.manager');
    $instance->aliasManager = $container->get('path_alias.manager');
    return $instance;
  }

  /**
   * {@inheritdoc}
   *
   * Reading content at all. Which pages the caller may read is the node access
   * system's answer, asked per call in {@see self::published()} — a space is an
   * access boundary and a tool-wide gate could not express it.
   */
  protected function checkAccess(array $values, AccountInterface $account, bool $return_as_object = FALSE): bool|AccessResultInterface {
    $access = AccessResult::allowedIfHasPermission($account, 'access content');

    return $return_as_object ? $access : $access->isAllowed();
  }

  /**
   * {@inheritdoc}
   */
  protected function doExecute(array $values): ExecutableResult {
    $path = trim((string) ($values['path'] ?? ''));
    $node = $this->published($path);
    if (!$node instanceof NodeInterface) {
      return ExecutableResult::failure(new TranslatableMarkup(
        'No published page at "@path". A path is the space slug then the page slug, exactly as the page\'s URL spells it.',
        ['@path' => $path],
      ));
    }

    $frontmatter = $this->frontmatter($node);
    return ExecutableResult::success(
      new TranslatableMarkup('Read "@title".', ['@title' => $node->label()]),
      [
        'path' => $this->aliasManager->getAliasByPath('/node/' . $node->id()),
        'title' => (string) $node->label(),
        'title_block_id' => $this->titleBlockId($node),
        'frontmatter' => $frontmatter,
        // The body a model reads spells its specials as characters, not as
        // the serializer's entities (ADR 0014). The frontmatter is Drupal's
        // own values and carries none.
        'markdown' => $this->markdown($frontmatter, ComarkEntities::decode($this->body($node))),
      ],
    );
  }

  /**
   * The published page at a path, or NULL when the caller gets none.
   *
   * Missing, unpublished and unreadable answer alike: which of the three it is
   * would say whether a page exists behind a space the caller is not on.
   */
  private function published(string $path): ?NodeInterface {
    // search_pages answers a path anchored on the section it cites, so the
    // address an agent carries over from a hit names a block after it.
    $alias = '/' . trim((string) preg_replace(['/#.*$/', '/\.md$/'], '', $path), '/');
    if (!preg_match('#^/node/(\d+)$#', $this->aliasManager->getPathByAlias($alias), $matches)) {
      return NULL;
    }
    $node = $this->entityTypeManager->getStorage('node')->load((int) $matches[1]);
    if (!$node instanceof NodeInterface || $node->bundle() !== self::BUNDLE) {
      return NULL;
    }
    // The default revision is the published one wherever a forward draft
    // exists, so loading by id is already the published read.
    return $node->isPublished() && $node->access('view', $this->currentUser) ? $node : NULL;
  }

  /**
   * The exposed fields as the wire format shapes them, in display order.
   *
   * @return array<string, mixed>
   *   Frontmatter key => value.
   */
  private function frontmatter(NodeInterface $node): array {
    $values = [];
    foreach ($this->exposedFieldNames() as $name) {
      $items = $node->get($name);
      $key = str_starts_with($name, 'field_') ? substr($name, strlen('field_')) : $name;
      $multiple = $items->getFieldDefinition()->getFieldStorageDefinition()->getCardinality() !== 1;
      $projected = $items->access('view', $this->currentUser) ? $this->fieldValues($items) : [];
      $values[$key] = $multiple ? $projected : ($projected[0] ?? NULL);
    }
    return $values;
  }

  /**
   * One field's items, projected.
   *
   * A reference becomes the {id, label} pair the wire format is made of: the
   * UUID addresses the target over JSON:API, the label makes it readable
   * without a second call.
   *
   * @return list<mixed>
   *   The values, in delta order.
   */
  private function fieldValues(FieldItemListInterface $items): array {
    if ($items instanceof EntityReferenceFieldItemListInterface) {
      return array_values(array_map(
        static fn (EntityInterface $target): array => [
          'id' => $target->uuid(),
          'label' => (string) $target->label(),
        ],
        $items->referencedEntities(),
      ));
    }
    return array_values(array_map(
      static fn (array $item): mixed => $item['value'] ?? NULL,
      $items->getValue(),
    ));
  }

  /**
   * The exposed field names, or none where the contract is not configured.
   *
   * @return string[]
   *   Field machine names, in display order.
   */
  private function exposedFieldNames(): array {
    try {
      return $this->schema->exposedFieldNames();
    }
    catch (SchemaUnavailableException) {
      return [];
    }
  }

  /**
   * The id the title heading is stored under, or '' where it carries none.
   *
   * The heading itself is stripped from every read, but a citation on the
   * page's lead section names its block, so the id has to stay reachable.
   */
  private function titleBlockId(NodeInterface $node): string {
    $line = $this->titleHeading($node);
    return preg_match('/\{#([\w-]+)\}[ \t]*$/', $line, $matches) ? $matches[1] : '';
  }

  /**
   * The leading `# ` heading line, or '' where the body opens on a block.
   */
  private function titleHeading(NodeInterface $node): string {
    $body = (string) $node->get(self::BODY_FIELD)->value;
    return preg_match('/^#[ \t][^\n]*/', $body, $matches) ? $matches[0] : '';
  }

  /**
   * The stored body, without the title it may repeat as a leading heading.
   *
   * The title is the node's own field. A body that opens with an ATX `# `
   * heading carries it a second time — the seeded corpus and every page
   * {@see CreatePage} makes are written that way — and the editor's serializer
   * takes that heading off every commit, so the published `.md` lanes take it
   * off every read.
   */
  private function body(NodeInterface $node): string {
    $body = (string) $node->get(self::BODY_FIELD)->value;
    if ($this->titleHeading($node) === '') {
      return $body;
    }
    return ltrim(substr($body, strcspn($body, "\n") + 1), "\n");
  }

  /**
   * The `.md` document: the frontmatter block above the body.
   *
   * With no exposed fields there is nothing to project, so the body is the
   * whole document rather than a body under an empty block.
   *
   * @param array<string, mixed> $frontmatter
   *   The projected fields.
   * @param string $body
   *   The body.
   */
  private function markdown(array $frontmatter, string $body): string {
    if ($frontmatter === []) {
      return $body;
    }
    $yaml = rtrim(Yaml::dump(
      $frontmatter,
      PHP_INT_MAX,
      2,
      Yaml::DUMP_EMPTY_ARRAY_AS_SEQUENCE | Yaml::DUMP_MULTI_LINE_LITERAL_BLOCK,
    ), "\n");

    return self::DELIMITER . "\n" . $yaml . "\n" . self::DELIMITER . "\n\n" . $body;
  }

}
