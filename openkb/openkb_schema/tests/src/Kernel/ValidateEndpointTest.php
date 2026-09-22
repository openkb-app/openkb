<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_schema\Kernel;

use Drupal\field\Entity\FieldConfig;
use Drupal\field\Entity\FieldStorageConfig;
use Drupal\KernelTests\KernelTestBase;
use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;
use Drupal\taxonomy\Entity\Term;
use Drupal\taxonomy\Entity\Vocabulary;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Tests the dry-run field validation endpoint.
 *
 * Recreates a minimal kb_page field model programmatically (the recipe is
 * not applied in kernel tests) and exercises POST /openkb/node/{node}/validate
 * through the real http_kernel.
 *
 * @group openkb_schema
 */
final class ValidateEndpointTest extends KernelTestBase {

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
    'openkb_schema',
  ];

  /**
   * The node validated against.
   */
  private Node $node;

  /**
   * A resolvable kb_tags term.
   */
  private Term $term;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();

    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('taxonomy_term');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['user', 'filter', 'node']);

    NodeType::create(['type' => 'kb_page', 'name' => 'Page'])->save();
    Vocabulary::create(['vid' => 'kb_tags', 'name' => 'KB tags'])->save();

    FieldStorageConfig::create([
      'field_name' => 'field_type',
      'entity_type' => 'node',
      'type' => 'list_string',
      'cardinality' => 1,
      'settings' => [
        'allowed_values' => ['article' => 'Article', 'adr' => 'ADR'],
      ],
    ])->save();
    FieldConfig::create([
      'field_name' => 'field_type',
      'entity_type' => 'node',
      'bundle' => 'kb_page',
      'label' => 'Type',
      'required' => TRUE,
    ])->save();

    FieldStorageConfig::create([
      'field_name' => 'field_tags',
      'entity_type' => 'node',
      'type' => 'entity_reference',
      'cardinality' => -1,
      'settings' => ['target_type' => 'taxonomy_term'],
    ])->save();
    FieldConfig::create([
      'field_name' => 'field_tags',
      'entity_type' => 'node',
      'bundle' => 'kb_page',
      'label' => 'Tags',
      'settings' => [
        'handler' => 'default:taxonomy_term',
        'handler_settings' => ['target_bundles' => ['kb_tags' => 'kb_tags']],
      ],
    ])->save();

    $this->term = Term::create(['vid' => 'kb_tags', 'name' => 'Architecture']);
    $this->term->save();

    $this->setUpCurrentUser([], ['access content', 'edit any kb_page content']);

    $this->node = Node::create([
      'type' => 'kb_page',
      'title' => 'Baseline title',
      'field_type' => 'article',
    ]);
    $this->node->save();
  }

  /**
   * Valid values — scalars and a resolvable reference — validate clean.
   */
  public function testCleanPass(): void {
    $response = $this->request([
      'title' => 'A perfectly fine title',
      'field_type' => 'adr',
      'field_tags' => [['id' => $this->term->uuid(), 'label' => 'Architecture']],
    ]);
    $this->assertSame(200, $response->getStatusCode());
    $this->assertSame([], $this->decode($response)['errors']);
  }

  /**
   * Server-side rules produce per-field messages, keyed by field name.
   */
  public function testViolations(): void {
    $response = $this->request([
      'title' => str_repeat('x', 300),
      'field_type' => 'not-an-allowed-value',
    ]);
    $this->assertSame(200, $response->getStatusCode());
    $errors = $this->decode($response)['errors'];
    $this->assertSame(['title', 'field_type'], array_keys($errors));
    $this->assertStringContainsString('255', $errors['title'][0]);
    $this->assertNotEmpty($errors['field_type'][0]);
    // Messages are plain text — no markup from Drupal's placeholders.
    $this->assertStringNotContainsString('<', $errors['title'][0]);
  }

  /**
   * A required field set to NULL violates.
   */
  public function testRequiredField(): void {
    $errors = $this->decode($this->request(['field_type' => NULL]))['errors'];
    $this->assertArrayHasKey('field_type', $errors);
  }

  /**
   * A reference whose UUID resolves nowhere errors in the commit-lane wording.
   */
  public function testUnresolvableReference(): void {
    $errors = $this->decode($this->request([
      'field_tags' => [['id' => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'label' => 'Ghost']],
    ]))['errors'];
    $this->assertSame(['Referenced taxonomy_term "Ghost" does not exist.'], $errors['field_tags']);
  }

  /**
   * A field the node does not carry is reported, not guessed at.
   */
  public function testUnknownField(): void {
    $errors = $this->decode($this->request(['field_nope' => 'x']))['errors'];
    $this->assertSame(['Unknown field "field_nope".'], $errors['field_nope']);
  }

  /**
   * Validation never writes: the stored node is untouched afterwards.
   */
  public function testNoWrite(): void {
    $this->request(['title' => 'Something else entirely']);
    $storage = $this->container->get('entity_type.manager')->getStorage('node');
    $storage->resetCache([$this->node->id()]);
    $reloaded = $storage->load($this->node->id());
    $this->assertSame('Baseline title', $reloaded->getTitle());
    $revision_ids = $storage->getQuery()
      ->allRevisions()
      ->condition('nid', $this->node->id())
      ->accessCheck(FALSE)
      ->execute();
    $this->assertCount(1, $revision_ids);
  }

  /**
   * A malformed body is a 400, not a silent empty pass.
   */
  public function testBadRequest(): void {
    $response = $this->request(NULL);
    $this->assertSame(400, $response->getStatusCode());
  }

  /**
   * Without update access on the node the route is forbidden.
   */
  public function testAccessDenied(): void {
    $this->setUpCurrentUser([], ['access content']);
    $response = $this->request(['title' => 'x']);
    $this->assertSame(403, $response->getStatusCode());
  }

  /**
   * Issues a real POST /openkb/node/{nid}/validate through the http_kernel.
   *
   * @param array|null $fields
   *   Field values for the request body, or NULL to send a malformed body.
   */
  private function request(?array $fields): Response {
    /** @var \Symfony\Component\HttpKernel\HttpKernelInterface $http_kernel */
    $http_kernel = $this->container->get('http_kernel');
    $request = Request::create(
      '/openkb/node/' . $this->node->id() . '/validate',
      'POST',
      server: ['CONTENT_TYPE' => 'application/json'],
      content: json_encode($fields === NULL ? ['nonsense' => TRUE] : ['fields' => $fields], JSON_THROW_ON_ERROR),
    );
    return $http_kernel->handle($request);
  }

  /**
   * Decodes a JSON response body.
   */
  private function decode(Response $response): array {
    return json_decode((string) $response->getContent(), TRUE, 512, JSON_THROW_ON_ERROR);
  }

}
