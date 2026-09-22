<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\openkb_agent\Traits\RequestCarrierTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;

/**
 * OpenKB in a kernel, on the config the recipe ships — with a request carrier.
 *
 * The container it builds is the module's own, so a suite that only needs to
 * save an entity and look at what came out extends this and never calls
 * ::request(). What the carrier can and cannot do is
 * {@see \Drupal\Tests\openkb_agent\Traits\RequestCarrierTrait}.
 *
 * @see \Drupal\Tests\openkb_agent\Functional\ReviewTestBase
 */
abstract class OpenkbRequestKernelTestBase extends KernelTestBase {

  use RecipeConfigTrait;
  use RequestCarrierTrait;
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
    'taxonomy',
    'path',
    'path_alias',
    'workflows',
    'content_moderation',
    'serialization',
    // The module's commit resource inherits jsonapi.entity_resource, so the
    // container does not compile without jsonapi — which in turn autowires a
    // file upload handler, so file comes with it.
    'file',
    // The page carries a media reference, and jsonapi builds a resource
    // type for every field it finds — so the whole field's stack has to be
    // there before the router can be built.
    'image',
    'media',
    'jsonapi',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'openkb_space',
    'openkb_space_access',
    'openkb_agent',
    'openkb_workflow',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();

    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('taxonomy_term');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('file');
    $this->installEntitySchema('content_moderation_state');
    // simple_oauth's default-consumer lookup runs on any request that reaches
    // authentication, whether or not the suite issues a token.
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['system', 'field', 'filter', 'node', 'user']);

    // User 1 is a superuser and would answer every access question with yes;
    // take it out of circulation so the accounts a suite makes start at 2.
    $this->createUser();
  }

}
