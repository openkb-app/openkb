<?php

declare(strict_types=1);

namespace Drupal\openkb_tools\Plugin\tool\Tool;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\openkb_space_access\SpaceAccessMap;
use Drupal\tool\Attribute\Tool;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolBase;
use Drupal\tool\Tool\ToolOperation;
use Drupal\tool\TypedData\InputDefinition;
use Drupal\tool\TypedData\ListInputDefinition;
use Drupal\tool\TypedData\MapInputDefinition;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * Lists the spaces the caller may operate in, with its own access level.
 *
 * The first question an agent has to answer: a space is an access boundary
 * with a roster, so "where may I write?" cannot be inferred from a page
 * listing and must not be discovered by attempting a write. Filtering to
 * `access: write` turns that into one call whose result is exactly the set of
 * legal targets for a create.
 *
 * `GET /openkb/spaces` is the product's API for the same question and came
 * first; both reach it through {@see SpaceAccessMap}, so the tool cannot
 * disagree with the API.
 *
 * The result is scoped to the caller, which is what lets the access gate be as
 * wide as "signed in": an account only ever sees its own map.
 */
#[Tool(
  id: 'openkb_list_spaces',
  label: new TranslatableMarkup('List spaces'),
  description: new TranslatableMarkup('List the knowledge-base spaces you may work in, each with your own access level ("read", "write" or "manage") and whether edits there go through review. Call this before creating a page: filter with access="write" and create only into a space this returns. Spaces you may not read are not listed.'),
  operation: ToolOperation::Read,
  destructive: FALSE,
  input_definitions: [
    'q' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Query'),
      description: new TranslatableMarkup('Narrows the list to spaces whose name or description contains it.'),
      required: FALSE,
    ),
    'access' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Access level'),
      description: new TranslatableMarkup('Drops spaces below it: "read" (the default) lists everything you can see, "write" only where you may create and edit pages, "manage" only where you administer the space itself.'),
      required: FALSE,
      default_value: SpaceAccessMap::READ,
      constraints: [
        'AllowedValues' => [
          'choices' => [SpaceAccessMap::READ, SpaceAccessMap::WRITE, SpaceAccessMap::MANAGE],
        ],
      ],
    ),
  ],
  output_definitions: [
    'spaces' => new ListInputDefinition(
      label: new TranslatableMarkup('Spaces'),
      description: new TranslatableMarkup('The spaces you may work in, by name. Each entry carries "slug" (the space\'s URL segment, and the first segment of every page path in it), "name", "description", "access" ("read", "write" or "manage") and "moderated" (whether edits here need an editor to sign them off before they publish).'),
      item_definition: new MapInputDefinition(
        label: new TranslatableMarkup('Space'),
        description: new TranslatableMarkup('One space and what you may do in it.'),
        property_definitions: [
          'slug' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Slug'),
            description: new TranslatableMarkup("The space's URL segment, and the first segment of every page path in it."),
          ),
          'name' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Name'),
            description: new TranslatableMarkup("The space's name."),
          ),
          'description' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Description'),
            description: new TranslatableMarkup('What the space is for.'),
            required: FALSE,
          ),
          'access' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Access'),
            description: new TranslatableMarkup('What you may do here: read pages, write them, or administer the space.'),
          ),
          'moderated' => new InputDefinition(
            data_type: 'boolean',
            label: new TranslatableMarkup('Moderated'),
            description: new TranslatableMarkup('Whether edits here need an editor to sign them off before they publish.'),
          ),
        ],
      ),
    ),
  ],
)]
final class ListSpaces extends ToolBase {

  /**
   * The space access map.
   */
  protected SpaceAccessMap $accessMap;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
    $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
    $instance->accessMap = $container->get(SpaceAccessMap::class);
    return $instance;
  }

  /**
   * {@inheritdoc}
   */
  protected function doExecute(array $values): ExecutableResult {
    $spaces = $this->accessMap->list($this->currentUser, [
      'q' => (string) ($values['q'] ?? ''),
      'access' => (string) ($values['access'] ?? SpaceAccessMap::READ),
    ]);

    return ExecutableResult::success(
      new TranslatableMarkup('Listed @count space(s) you may work in.', ['@count' => count($spaces)]),
      ['spaces' => $spaces],
    );
  }

  /**
   * {@inheritdoc}
   *
   * Self-scoped: the map is the account's own, so being signed in is the whole
   * gate. Anonymous holds no space permission and would only ever get an empty
   * list, so it is refused rather than told nothing at length.
   */
  protected function checkAccess(array $values, AccountInterface $account, bool $return_as_object = FALSE): bool|AccessResultInterface {
    $access = AccessResult::allowedIf($account->isAuthenticated())
      ->addCacheContexts(['user.roles:authenticated']);

    return $return_as_object ? $access : $access->isAllowed();
  }

}
