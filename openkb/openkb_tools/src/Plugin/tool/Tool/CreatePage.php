<?php

declare(strict_types=1);

namespace Drupal\openkb_tools\Plugin\tool\Tool;

use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_space\SpaceStorage;
use Drupal\openkb_space_access\SpaceAccessMap;
use Drupal\path_alias\AliasManagerInterface;
use Drupal\tool\Attribute\Tool;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolBase;
use Drupal\tool\Tool\ToolOperation;
use Drupal\tool\TypedData\InputDefinition;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Creates a page in a space, ready for the caller's first block write.
 *
 * Takes a title and a space and no body: content arrives through
 * `updateBlocks`, one block at a time, under `expect`.
 *
 * The page is seeded with one paragraph carrying placeholder text and a minted
 * `{#b-…}`, whose id rides back on the result, so the caller's first write
 * replaces a block it was handed rather than describing where to land.
 *
 * Pathauto derives the alias from the title, so the returned `path` is the
 * authoritative answer for where the page landed.
 *
 * The write gate is the space's write level from {@see SpaceAccessMap}, the
 * source `tool_api__list_spaces` filters on.
 */
#[Tool(
  id: 'openkb_create_page',
  label: new TranslatableMarkup('Create page'),
  description: new TranslatableMarkup('Create a new, empty page in a space you may write to. Call tool_api__list_spaces with access="write" first and pass one of the slugs it returns; a space it did not return is refused. The page is created as an unpublished draft owned by you — publishing it is an editorial decision no tool performs. Its path is generated from the title, so the returned "path" is authoritative and may differ from anything you had in mind. The page starts with one placeholder block whose id is returned as "block": pass that id to updateBlocks to replace it with your first real content.'),
  operation: ToolOperation::Write,
  destructive: FALSE,
  input_definitions: [
    'title' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Title'),
      description: new TranslatableMarkup('The page title. It names the page and seeds its path; it is not parsed out of any body text.'),
      constraints: ['Length' => ['min' => 1]],
    ),
    'space' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Space'),
      description: new TranslatableMarkup('The slug of the space to create in, exactly as tool_api__list_spaces reports it.'),
      constraints: ['Length' => ['min' => 1]],
    ),
  ],
  output_definitions: [
    'path' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Path'),
      description: new TranslatableMarkup('Where the page lives — the authoritative answer, and what every other tool takes as its "path".'),
    ),
    'nid' => new InputDefinition(
      data_type: 'integer',
      label: new TranslatableMarkup('Node ID'),
      description: new TranslatableMarkup("The page's node id."),
    ),
    'title' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Title'),
      description: new TranslatableMarkup('The page title as stored.'),
    ),
    'space' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Space'),
      description: new TranslatableMarkup('The slug of the space it was created in.'),
    ),
    'block' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Block'),
      description: new TranslatableMarkup('The id of the placeholder block the page starts with. Name it as updateBlocks\' "id" to replace it with your first content.'),
    ),
    'published' => new InputDefinition(
      data_type: 'boolean',
      label: new TranslatableMarkup('Published'),
      description: new TranslatableMarkup('Always false: a created page is a draft. Whether it then owes review before it can publish is the space\'s own policy, reported by tool_api__list_spaces as "moderated".'),
    ),
  ],
)]
final class CreatePage extends ToolBase {

  /**
   * The bundle every KB page is.
   */
  private const BUNDLE = 'kb_page';

  /**
   * The text of the placeholder block a new page starts with.
   */
  private const PLACEHOLDER = 'This page has no content yet.';

  /**
   * The space access map.
   */
  protected SpaceAccessMap $accessMap;

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
    $instance->accessMap = $container->get(SpaceAccessMap::class);
    $instance->entityTypeManager = $container->get('entity_type.manager');
    $instance->aliasManager = $container->get('path_alias.manager');
    return $instance;
  }

  /**
   * {@inheritdoc}
   *
   * Create access on the bundle is the permission the `agent:write:create`
   * scope names. Which spaces the caller may create in is answered per call in
   * {@see self::writableSpace()}.
   */
  protected function checkAccess(array $values, AccountInterface $account, bool $return_as_object = FALSE): bool|AccessResultInterface {
    $access = $this->entityTypeManager
      ->getAccessControlHandler('node')
      ->createAccess(self::BUNDLE, $account, [], TRUE);

    return $return_as_object ? $access : $access->isAllowed();
  }

  /**
   * A fresh block id, spelled as the frontend's minter spells it.
   */
  protected static function mintBlockId(): string {
    return 'b-' . bin2hex(random_bytes(4));
  }

  /**
   * {@inheritdoc}
   */
  protected function doExecute(array $values): ExecutableResult {
    $title = trim((string) ($values['title'] ?? ''));
    $slug = trim((string) ($values['space'] ?? ''));
    if ($title === '') {
      return ExecutableResult::failure(
        new TranslatableMarkup('A title is required — it names the page and seeds its path.'),
      );
    }
    $space = $this->writableSpace($slug);
    if (!$space instanceof SpaceInterface) {
      return ExecutableResult::failure(new TranslatableMarkup(
        'You may not create pages in "@slug". Call tool_api__list_spaces with access="write" and create only into a space it returns.',
        ['@slug' => $slug],
      ));
    }
    $block = self::mintBlockId();
    // The title heading carries a block id like any block: it is the lead
    // section's anchor, which every citation of that section lands on.
    $titleBlock = self::mintBlockId();

    $node = $this->entityTypeManager->getStorage('node')->create([
      'type' => self::BUNDLE,
      'title' => $title,
      'uid' => $this->currentUser->id(),
      'field_space' => ['target_id' => $space->id()],
      // No format: the body field's own configured one is stamped on at save.
      'field_kb_body' => [
        'value' => sprintf("# %s {#%s}\n\n%s {#%s}\n", $title, $titleBlock, self::PLACEHOLDER, $block),
      ],
      // Unconditional, whatever the space's moderation policy says: no agent
      // scope names publishing, so a created page is always a draft.
      'moderation_state' => 'draft',
    ]);

    $violations = $node->validate();
    if ($violations->count() > 0) {
      return ExecutableResult::failure(new TranslatableMarkup(
        'The page was refused: @message',
        ['@message' => (string) $violations->get(0)->getMessage()],
      ));
    }
    $node->save();

    return ExecutableResult::success(
      new TranslatableMarkup('Created "@title".', ['@title' => $node->label()]),
      [
        'path' => $this->aliasManager->getAliasByPath('/node/' . $node->id()),
        'nid' => (int) $node->id(),
        'title' => $node->label(),
        'space' => $slug,
        'block' => $block,
        'published' => (bool) $node->isPublished(),
      ],
    );
  }

  /**
   * The space behind a slug, or NULL if the caller may not write there.
   *
   * Reads the map `tool_api__list_spaces` answers from, so a slug this accepts
   * is exactly one `access: "write"` returned. A space the caller may only read
   * and one nobody named are alike here: the refusal says what to do next, not
   * what exists.
   */
  private function writableSpace(string $slug): ?SpaceInterface {
    foreach ($this->accessMap->list($this->currentUser, ['access' => SpaceAccessMap::WRITE]) as $listed) {
      if ($listed['slug'] === $slug) {
        $spaces = SpaceStorage::get($this->entityTypeManager);
        return $spaces->getBySlug($slug);
      }
    }
    return NULL;
  }

}
