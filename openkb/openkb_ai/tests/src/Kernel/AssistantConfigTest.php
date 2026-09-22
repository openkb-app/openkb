<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_ai\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\ai_assistant_api\Entity\AiAssistant;
use Drupal\ai_rag_cite\ValueObject\GroundingSettings;

/**
 * Verifies the openkb ai_assistant config entity ships with the right shape.
 *
 * The system prompt is the contract the Nuxt drawer / sidecar rely on:
 * comark/MDC fence syntax (`::callout`, `::infobox`) for any markup the model
 * emits. Locking it here means a future config-rename or copy-paste regression
 * fails loudly instead of silently degrading frontend rendering. The grounding
 * settings are the other half of that contract: they decide what an answer may
 * be built from at all.
 *
 * @group openkb_ai
 */
final class AssistantConfigTest extends KernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'key',
    'file',
    'ai',
    'ai_assistant_api',
    'ai_rag_cite',
    'search_api',
    'search_api_opensearch',
    // The assistant's retriever plugin, and the schema of its settings.
    'openkb_search',
    // The document types a search narrows by come from the frontmatter
    // schema, which openkb_search's PageTypes reads.
    'openkb_schema',
    'vercel_ai_sdk',
    'mcp_server',
    'openkb_ai',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installConfig(['openkb_ai']);
  }

  /**
   * The openkb assistant entity loads and carries the comark contract.
   */
  public function testAssistantConfigEntityLoads(): void {
    /** @var \Drupal\ai_assistant_api\Entity\AiAssistant|null $assistant */
    $assistant = $this->container->get('entity_type.manager')
      ->getStorage('ai_assistant')
      ->load('openkb');

    self::assertInstanceOf(AiAssistant::class, $assistant);
    self::assertSame('Ask openKB', (string) $assistant->label());
    // A real install answers from OpenAI once a key is entered; development
    // and CI point it at the keyless `mock` provider instead.
    self::assertSame('openai', (string) $assistant->get('llm_provider'));
    self::assertSame('gpt-4o-mini', (string) $assistant->get('llm_model'));

    // The prompt lives in Instructions: that is the field the assistant form
    // edits, and it is required there, so an empty one cannot be saved back.
    $prompt = (string) $assistant->get('instructions');
    self::assertNotSame('', $prompt);
    self::assertStringContainsString('::callout', $prompt);
    self::assertStringContainsString('::infobox', $prompt);
    self::assertStringContainsString('comark', $prompt);
  }

  /**
   * The assistant is grounded, and points retrieval at the chunk index.
   */
  public function testTheAssistantIsGroundedInTheKnowledgeBase(): void {
    $settings = GroundingSettings::fromAssistant(
      $this->container->get('entity_type.manager')->getStorage('ai_assistant')->load('openkb'),
    );

    self::assertNotNull($settings);
    self::assertSame(GroundingSettings::MODE_GROUNDED, $settings->mode);
    self::assertSame('ai_search_chunks', $settings->retriever);
    self::assertGreaterThan(0, $settings->retrieverSettings['top_k']);
    // The prompt asks for `[n]` markers; the contract is what supplies the
    // sources they point at, so the two cannot drift apart.
    self::assertStringContainsString('[1]', $settings->citationContract);
    self::assertNotSame('', $settings->noAnswerMessage);
  }

}
