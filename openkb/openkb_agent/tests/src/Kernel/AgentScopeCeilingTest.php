<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;

/**
 * What the shipped `agent:write` tree authorizes, read off the recipe config.
 *
 * The ceiling is an umbrella whose children carry the permissions, so a child
 * that is missing or hung under the wrong parent silently narrows every agent
 * token. Asserted against the recipe's own YAML, which is what a site applies.
 *
 * @group openkb_agent
 */
final class AgentScopeCeilingTest extends KernelTestBase {

  use RecipeConfigTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'file',
    'image',
    // consumer's grant_types is a list_string.
    'options',
    'serialization',
    'consumers',
    'simple_oauth',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('file');
    $this->installEntitySchema('consumer');
    $this->installConfig(['system', 'field', 'user']);
    $this->importRecipeConfig($this->agentConfigNames());
  }

  /**
   * Writing covers creating: an agent may author a page, not only edit one.
   */
  public function testTheWriteCeilingCoversCreating(): void {
    $provider = $this->container->get('simple_oauth.oauth2_scope.provider');
    $this->assertTrue($provider->scopeHasPermission(
      'create kb_page content',
      $provider->load('agent_write'),
    ));
  }

}
