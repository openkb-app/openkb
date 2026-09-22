<?php

declare(strict_types=1);

namespace Drupal\Tests\comark\Kernel;

use Drupal\Tests\openkb_search\Kernel\ChunkIndexTestBase;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Psr7\Request as GuzzleRequest;
use GuzzleHttp\Psr7\Response;
use Psr\Http\Message\RequestInterface;

/**
 * The enrichment a page carries into the index comes from the sidecar.
 *
 * Comark is JavaScript, so the markdown is cut into sections by the Nuxt
 * sidecar and nothing in PHP parses it a second time. A failed call still
 * indexes the item — with a title and a slug and nothing of what the page says
 * — and search_api marks it done, so the degradation is permanent and silent
 * unless the log line says otherwise. Asserting on a word that appears only in
 * the body is what tells the two states apart.
 *
 * @group comark
 */
final class ComarkIndexableTest extends ChunkIndexTestBase {

  /**
   * A word only the body carries. Nothing else in the corpus matches it.
   */
  private const BODY_ONLY = 'Qwertzuiop';

  /**
   * The body of the probe page, with a component fence and a subheading.
   */
  private const BODY = "This paragraph mentions " . self::BODY_ONLY . " once.\n\n## Subheading Xyzzyx\n\n::callout{type=\"info\"}\nInside a callout.\n::\n";

  /**
   * What each request carried, where a case watches the calls.
   *
   * @var list<array{uri: string, body: array<string, mixed>}>
   */
  private array $calls = [];

  /**
   * How the stubbed sidecar answers, where a case replaces it.
   *
   * @var (callable(\Psr\Http\Message\RequestInterface): \GuzzleHttp\Psr7\Response)|null
   */
  private $answer = NULL;

  /**
   * {@inheritdoc}
   */
  protected function sidecarResponse(RequestInterface $request): Response {
    $this->calls[] = [
      'uri' => (string) $request->getUri(),
      'body' => json_decode((string) $request->getBody(), TRUE) ?: [],
    ];
    return $this->answer === NULL ? parent::sidecarResponse($request) : ($this->answer)($request);
  }

  /**
   * The enrichment reaches the index, so a body word finds the page.
   */
  public function testBodyTextIsSearchable(): void {
    $this->createPage('Plain Title', TRUE, self::BODY);

    $this->indexPages();

    $text = implode("\n", array_column($this->rows(['content']), 'content'));
    $this->assertStringContainsString(self::BODY_ONLY, $text);
    $this->assertStringContainsString('Xyzzyx', $text);
  }

  /**
   * The sidecar is called on the frontend the Lupus settings name.
   *
   * Comark carries no origin of its own — a hardcoded or comark-private one
   * would be a second source of truth for where the frontend lives.
   */
  public function testTheSidecarIsCalledOnTheConfiguredFrontend(): void {
    $this->createPage('Origin Probe', TRUE, self::BODY);

    $this->indexPages();

    $this->assertSame([self::FRONTEND_BASE_URL . '/api/comark/indexable'], array_column($this->calls, 'uri'));
  }

  /**
   * The chunking Drupal owns travels with the request.
   *
   * The sidecar cuts the sections, but the token target and cap are
   * `openkb_search.settings` — the strategy that embeds the chunks is
   * configured there, so the two cannot be allowed to drift.
   */
  public function testTheRequestCarriesTheConfiguredChunkOptions(): void {
    $this->config('openkb_search.settings')->set('chunk', ['target_tokens' => 120, 'max_tokens' => 240])->save();

    $this->createPage('Chunked', TRUE, self::BODY);
    $this->indexPages();

    $this->assertSame(['targetTokens' => 120, 'maxTokens' => 240], $this->calls[0]['body']['chunkOptions'] ?? NULL);
  }

  /**
   * No configured frontend means nothing of the page in the index.
   */
  public function testMissingFrontendBaseUrlLeavesNoSectionIndexed(): void {
    $this->config('lupus_decoupled_ce_api.settings')
      ->set('frontend_base_url', '')
      ->save();

    $this->createPage('Unconfigured', TRUE, self::BODY);

    $this->assertSame(1, $this->index->indexItems());
    $this->assertSame([], $this->calls);
    $this->assertSame([], $this->rows(['content']));
  }

  /**
   * An unreachable sidecar leaves the page unsearchable, and says so loudly.
   *
   * Both halves matter. The item being counted as indexed regardless is why
   * the corpus can sit section-less indefinitely — search_api will not come
   * back to it — and the log line is the only thing that surfaces it, so it
   * has to name the origin that failed and be an error rather than a warning.
   */
  public function testUnreachableSidecarLeavesNoSectionIndexed(): void {
    $this->answer = function (RequestInterface $request): never {
      throw new ConnectException(
        'Failed to connect to host port 3000: Connection refused',
        new GuzzleRequest('POST', $request->getUri()),
      );
    };

    $this->createPage('Title Survives', TRUE, self::BODY);

    $this->assertSame(
      1,
      $this->index->indexItems(),
      'The item is indexed even though its enrichment failed — that is what makes the degradation permanent.',
    );
    $this->assertSame([], $this->rows(['content']));
  }

}
