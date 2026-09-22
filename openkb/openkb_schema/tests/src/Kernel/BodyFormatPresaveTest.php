<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_schema\Kernel;

use Drupal\field\Entity\FieldConfig;
use Drupal\field\Entity\FieldStorageConfig;
use Drupal\KernelTests\KernelTestBase;
use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;

/**
 * Drupal names the format a body is stored under.
 *
 * Every write surface hands in a body value alone; the presave fills the
 * format in from the body field's own `allowed_formats`, so no client has to
 * know it and retargeting the field is the whole change a site makes.
 *
 * @group openkb_schema
 */
final class BodyFormatPresaveTest extends KernelTestBase {

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
    'openkb_schema',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');

    NodeType::create(['type' => 'kb_page', 'name' => 'Page'])->save();
    FieldStorageConfig::create([
      'entity_type' => 'node',
      'field_name' => 'field_kb_body',
      'type' => 'text_long',
    ])->save();
    $this->setBodyFormats(['comark']);
  }

  /**
   * A body written without a format is stored with the configured one.
   */
  public function testFillsTheConfiguredFormat(): void {
    $this->assertSame('comark', $this->save('# Body')->get('field_kb_body')->format);

    $this->setBodyFormats(['plain']);
    $this->assertSame('plain', $this->save('# Body')->get('field_kb_body')->format);
  }

  /**
   * A format the write names is left alone.
   */
  public function testKeepsAnIncomingFormat(): void {
    $node = Node::create([
      'type' => 'kb_page',
      'title' => 'Named',
      'field_kb_body' => ['value' => '# Body', 'format' => 'plain'],
    ]);
    $node->save();
    $this->assertSame('plain', $node->get('field_kb_body')->format);
  }

  /**
   * A field naming no single format leaves the body as it came in.
   *
   * The write is not refused — a site that configures its body field this way
   * is misconfigured, not the caller — and `BodyFormat` logs it.
   */
  public function testAmbiguousFieldLeavesTheFormatUnset(): void {
    $this->setBodyFormats(['comark', 'plain']);
    $this->assertNull($this->save('# Body')->get('field_kb_body')->format);
  }

  /**
   * Saves a page carrying only a body value.
   */
  private function save(string $body): Node {
    $node = Node::create([
      'type' => 'kb_page',
      'title' => 'Page',
      'field_kb_body' => ['value' => $body],
    ]);
    $node->save();
    return $node;
  }

  /**
   * Sets the text formats the body field is configured with.
   */
  private function setBodyFormats(array $formats): void {
    $field = FieldConfig::loadByName('node', 'kb_page', 'field_kb_body')
      ?? FieldConfig::create([
        'entity_type' => 'node',
        'bundle' => 'kb_page',
        'field_name' => 'field_kb_body',
        'label' => 'Body',
      ]);
    $field->setSetting('allowed_formats', $formats)->save();
  }

}
