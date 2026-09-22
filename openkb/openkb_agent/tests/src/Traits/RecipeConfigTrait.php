<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Traits;

use Symfony\Component\Yaml\Yaml;

/**
 * Imports config shipped by the openkb recipes from their actual YAML files.
 *
 * Tests cannot apply the whole recipe (OpenSearch, content, …), but the
 * agent scopes under test must be the shipped artifacts, not test doubles —
 * so create them straight from the recipe's config dir. The agent OAuth
 * scopes ship in openkb_recipe_agents; the rest of the KB model ships in
 * openkb_recipe_main.
 */
trait RecipeConfigTrait {

  /**
   * Creates config entities from the shipped recipe config/*.yml files.
   *
   * @param string[] $names
   *   Config names in dependency order, e.g.
   *   'simple_oauth.oauth2_scope.agent_read'.
   */
  protected function importRecipeConfig(array $names): void {
    /** @var \Drupal\Core\Config\ConfigManagerInterface $config_manager */
    $config_manager = \Drupal::service('config.manager');
    $entity_type_manager = \Drupal::entityTypeManager();

    foreach ($names as $name) {
      $data = Yaml::parseFile($this->recipeConfigPath($name));
      // Options fields: the API expects the simple [value => label] map and
      // converts it on save — feed it that instead of the export shape.
      if (isset($data['settings']['allowed_values'])) {
        $data['settings']['allowed_values'] = array_column($data['settings']['allowed_values'], 'label', 'value');
      }
      $entity_type_id = $config_manager->getEntityTypeIdByName($name);
      if (!$entity_type_id) {
        throw new \InvalidArgumentException("Not a config entity: $name");
      }
      $entity_type_manager->getStorage($entity_type_id)
        ->create($data)
        ->save();
    }
  }

  /**
   * Absolute path to a shipped config YAML, resolving what ships it.
   *
   * A module's own config entities ship with the module and are only named by
   * the recipe for import. Of the recipes: the agent OAuth scopes and the MCP
   * tool configs ship in openkb_recipe_agents, the collaboration server's
   * scope and role in openkb_recipe_collab, everything else in
   * openkb_recipe_main.
   */
  protected function recipeConfigPath(string $name): string {
    if ($name === 'views.view.openkb_spaces') {
      return dirname(DRUPAL_ROOT) . "/openkb/openkb_space/config/install/$name.yml";
    }
    $recipe = match (TRUE) {
      str_starts_with($name, 'simple_oauth.oauth2_scope.agent_'),
      str_starts_with($name, 'mcp_server_tool_bridge.mcp_tool_config.') => 'openkb_recipe_agents',
      $name === 'simple_oauth.oauth2_scope.collab',
      $name === 'user.role.collab_server' => 'openkb_recipe_collab',
      default => 'openkb_recipe_main',
    };
    return dirname(DRUPAL_ROOT) . "/recipes/$recipe/config/$name.yml";
  }

  /**
   * The agent scope ceiling shipped by the recipe.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function agentConfigNames(): array {
    return [
      'simple_oauth.oauth2_scope.agent_read',
      'simple_oauth.oauth2_scope.agent_read_content',
      'simple_oauth.oauth2_scope.agent_read_space',
      'simple_oauth.oauth2_scope.agent_write',
      'simple_oauth.oauth2_scope.agent_write_content',
      'simple_oauth.oauth2_scope.agent_write_create',
      'simple_oauth.oauth2_scope.agent_write_format',
      'simple_oauth.oauth2_scope.agent_write_space',
    ];
  }

  /**
   * The MCP tool configs that put the Drupal tools on /mcp.
   *
   * One enabled mcp_tool_config entity per tool: the bridge derives one MCP
   * tool from each, named `tool_api__<id>`.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function mcpToolConfigNames(): array {
    return [
      'mcp_server_tool_bridge.mcp_tool_config.list_spaces',
      'mcp_server_tool_bridge.mcp_tool_config.get_page',
      'mcp_server_tool_bridge.mcp_tool_config.create_page',
      'mcp_server_tool_bridge.mcp_tool_config.search_pages',
      'mcp_server_tool_bridge.mcp_tool_config.find_drafts',
      'mcp_server_tool_bridge.mcp_tool_config.list_assignments',
    ];
  }

  /**
   * The agent scopes that only exist where the page is moderated.
   *
   * Split off agentConfigNames() because each depends on content_moderation or
   * the editorial workflow: a suite that does not enable them cannot import
   * these, and a suite that does needs all of them — without the Draft
   * transition core refuses an agent `update` outright.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function agentModerationConfigNames(): array {
    return [
      'simple_oauth.oauth2_scope.agent_write_draft',
      'simple_oauth.oauth2_scope.agent_write_latest',
      'simple_oauth.oauth2_scope.agent_write_revisions',
      'simple_oauth.oauth2_scope.agent_write_unpublished_any',
    ];
  }

  /**
   * The kb_page content model shipped by the recipe.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function kbPageConfigNames(): array {
    return [
      'taxonomy.vocabulary.kb_tags',
      'node.type.kb_page',
      'field.storage.node.field_type',
      'field.storage.node.field_summary',
      'field.storage.node.field_owner',
      'field.storage.node.field_contributors',
      'field.storage.node.field_tags',
      'field.storage.node.field_space',
      'field.field.node.kb_page.field_type',
      'field.field.node.kb_page.field_summary',
      'field.field.node.kb_page.field_owner',
      'field.field.node.kb_page.field_contributors',
      'field.field.node.kb_page.field_tags',
      'field.field.node.kb_page.field_space',
      'core.entity_form_mode.node.frontmatter',
      'core.entity_form_display.node.kb_page.frontmatter',
    ];
  }

  /**
   * The comark body field shipped by the recipe.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function kbBodyConfigNames(): array {
    return [
      'filter.format.comark',
      'field.storage.node.field_kb_body',
      'field.field.node.kb_page.field_kb_body',
    ];
  }

  /**
   * The review sidecar and the node form it is kept out of.
   *
   * Depends on node.type.kb_page and the body field (see
   * kbPageConfigNames() and kbBodyConfigNames()) — the default form display
   * carries widgets for both.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function kbReviewConfigNames(): array {
    return [
      'field.storage.node.field_block_meta',
      'field.field.node.kb_page.field_block_meta',
      'core.entity_form_display.node.kb_page.default',
    ];
  }

  /**
   * The space's configurable fields, as shipped by the recipe.
   *
   * Roster, read access and outline are base fields the module carries; these
   * are the three the recipe adds.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function kbSpaceConfigNames(): array {
    return [
      'field.storage.openkb_space.description',
      'field.storage.openkb_space.field_moderation',
      'field.storage.openkb_space.field_agent_review',
      'field.field.openkb_space.openkb_space.description',
      'field.field.openkb_space.openkb_space.field_moderation',
      'field.field.openkb_space.openkb_space.field_agent_review',
    ];
  }

  /**
   * The CE displays the page read surface is made of.
   *
   * Depends on the page's fields and its body (see kbPageConfigNames()
   * and kbBodyConfigNames()): a suite importing these reads the props the
   * frontend consumes rather than custom_elements' bare fallback.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function kbCeDisplayConfigNames(): array {
    return [
      'field.storage.node.field_block_meta',
      'field.field.node.kb_page.field_block_meta',
      'core.entity_view_mode.openkb_space.custom_elements_space',
      'custom_elements.entity_ce_display.openkb_space.openkb_space.custom_elements_space',
      'custom_elements.entity_ce_display.node.kb_page.full',
    ];
  }

  /**
   * The editorial moderation workflow shipped by the recipe.
   *
   * Depends on node.type.kb_page (see kbPageConfigNames()) and the
   * content_moderation module being enabled.
   *
   * @return string[]
   *   Config names in dependency order.
   */
  protected function kbModerationConfigNames(): array {
    return [
      'workflows.workflow.editorial',
    ];
  }

  /**
   * The permissions the recipe grants a role, from its actual recipe.yml.
   *
   * Narrowed to the permissions that exist here: the recipe grants what a
   * whole site has, and a kernel test installs the modules its own subject
   * needs. createUser() fails a test on a permission no installed module
   * defines, so a test would otherwise break the moment an unrelated module of
   * the recipe's grew one.
   *
   * @param string $role
   *   The role id, e.g. 'authenticated'.
   *
   * @return string[]
   *   The granted permission names.
   */
  protected function recipeGrantedPermissions(string $role): array {
    $recipe = Yaml::parseFile(dirname(DRUPAL_ROOT) . '/recipes/openkb_recipe_main/recipe.yml');
    $granted = $recipe['config']['actions']["user.role.$role"]['grantPermissions'] ?? [];
    $defined = \Drupal::service('user.permissions')->getPermissions();
    return array_values(array_filter(
      $granted,
      static fn (string $permission) => isset($defined[$permission]),
    ));
  }

  /**
   * Mirrors the recipe's config action wiring the agent scope ceiling.
   */
  protected function applyAgentScopeSettings(): void {
    \Drupal::configFactory()->getEditable('simple_oauth_personal_consumers.settings')
      ->set('scopes', ['agent_read', 'agent_write'])
      ->save();
  }

}
