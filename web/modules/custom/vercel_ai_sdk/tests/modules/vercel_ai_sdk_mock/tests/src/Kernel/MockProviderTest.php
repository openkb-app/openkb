<?php

declare(strict_types=1);

namespace Drupal\Tests\vercel_ai_sdk_mock\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\ai\OperationType\Chat\ChatInput;
use Drupal\ai\OperationType\Chat\ChatMessage;
use Drupal\ai\OperationType\Chat\StreamedChatMessageIteratorInterface;
use Drupal\vercel_ai_sdk\Stream\UiMessage;
use Drupal\vercel_ai_sdk_mock\MockSettings;
use Drupal\vercel_ai_sdk_mock\Plugin\AiProvider\MockProvider;

/**
 * Tests the keyless `mock` chat provider.
 *
 * It replaces the model call and nothing else, so an assistant pointed at it
 * runs its own prompt, tools and grounding. What a call answers is
 * `vercel_ai_sdk_mock.settings`; the answer streams in pieces and carries
 * response metadata, which is the route the bridge publishes data parts on.
 *
 * @group vercel_ai_sdk_mock
 */
final class MockProviderTest extends KernelTestBase {

  use UserCreationTrait;

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
    'vercel_ai_sdk',
    'vercel_ai_sdk_mock',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installConfig(['vercel_ai_sdk_mock']);
    // The shipped mode is the end-to-end run's, and its pacing; most cases here
    // are about an answer nothing steers, and none of them is about the clock.
    $this->config(MockSettings::CONFIG)->set('mode', 'canned')->set('delay_ms', 0)->save();
  }

  /**
   * The module ships the settings CI and local development want.
   */
  public function testTheShippedDefaults(): void {
    $this->config(MockSettings::CONFIG)->delete();
    $this->container->get('config.installer')->installDefaultConfig('module', 'vercel_ai_sdk_mock');

    $settings = MockSettings::get($this->container->get('config.factory'));
    self::assertSame('scripted', $settings->mode->value);
    self::assertSame(40, $settings->delayMs);
  }

  /**
   * The provider offers itself for chat without a key.
   */
  public function testTheProviderIsUsableForChat(): void {
    $provider = $this->provider();

    self::assertTrue($provider->isUsable('chat'));
    self::assertSame(['chat'], $provider->getSupportedOperationTypes());
    self::assertArrayHasKey(MockProvider::MODEL, $provider->getConfiguredModels('chat'));
  }

  /**
   * A canned answer is the operator's text, streamed in several pieces.
   */
  public function testTheCannedAnswerComesFromTheSettings(): void {
    $this->config(MockSettings::CONFIG)->set('answer', 'The site says: @prompt')->save();

    $stream = $this->ask('Tell me about openKB');

    self::assertGreaterThan(1, count($stream['chunks']), 'The answer streams, so the frontend animates it.');
    self::assertSame('The site says: Tell me about openKB', $stream['text']);
    self::assertSame([], $stream['metadata'], 'Nothing was scripted, so nothing rides with the answer.');
  }

  /**
   * A canned answer is the operator's alone: the request cannot steer it.
   */
  public function testTheCannedAnswerIgnoresTheContext(): void {
    $stream = $this->ask('Tell me about openKB', ['mock' => $this->script()]);

    self::assertStringContainsString('Tell me about openKB', $stream['text']);
    self::assertSame([], $stream['metadata']);
  }

  /**
   * A scripted answer and its data parts come from the caller context.
   */
  public function testTheContextScriptsTheAnswer(): void {
    $this->config(MockSettings::CONFIG)->set('mode', 'scripted')->save();

    $stream = $this->ask('How do we release?', ['mock' => $this->script()]);

    self::assertSame('Cut the tag [1], then deploy [2].', $stream['text']);
    // The metadata is what the bridge publishes as `data-citations` and
    // `data-grounding`, so a browser run reaches a state no unkeyed turn does.
    self::assertSame($this->script()['metadata'], $stream['metadata']);
  }

  /**
   * A scripted call nobody scripted falls back to the canned answer.
   *
   * So a browser run that only wants a turn to look at needs no script, and
   * the e2e run can stay in one mode.
   */
  public function testAnUnscriptedCallAnswersTheCannedText(): void {
    $this->config(MockSettings::CONFIG)->set('mode', 'scripted')->save();

    $stream = $this->ask('How do we release?');

    self::assertStringContainsString('How do we release?', $stream['text']);
    self::assertSame([], $stream['metadata']);
  }

  /**
   * A script that names only metadata keeps the canned answer.
   */
  public function testThePartialScriptKeepsTheCannedText(): void {
    $this->config(MockSettings::CONFIG)->set('mode', 'scripted')->save();

    $stream = $this->ask('How do we release?', ['mock' => ['metadata' => ['grounding' => ['state' => 'grounded']]]]);

    self::assertStringContainsString('How do we release?', $stream['text']);
    self::assertSame(['grounding' => ['state' => 'grounded']], $stream['metadata']);
  }

  /**
   * A scripted tool round asks for the calls, then answers with the text.
   *
   * The round after the calls already carries their results, which is what
   * tells the two apart — so the bridge's own loop decides how often the tools
   * are asked for, rather than a counter in here.
   */
  public function testTheContextScriptsToolRound(): void {
    $this->config(MockSettings::CONFIG)->set('mode', 'scripted')->save();
    $script = [
      'text' => 'Ops and Docs.',
      'tools' => [['id' => 'call-1', 'name' => 'tool__openkb_list_spaces', 'arguments' => ['access' => 'read']]],
    ];

    $asked = new ChatInput([new ChatMessage('user', 'Where may I write?')]);
    $asked->setStreamedOutput(TRUE);
    $asked->setRequestMetadataValue(UiMessage::CONTEXT_KEY, ['mock' => $script]);

    // The round that asks for tools has nothing to stream, so it answers whole.
    $round = $this->provider()->chat($asked, MockProvider::MODEL)->getNormalized();
    self::assertInstanceOf(ChatMessage::class, $round);
    self::assertSame('', $round->getText());
    $calls = $round->getTools();
    self::assertCount(1, $calls);
    self::assertSame('call-1', $calls[0]->getToolId());
    self::assertSame('tool__openkb_list_spaces', $calls[0]->getName());
    self::assertSame('access', $calls[0]->getArguments()[0]->getName());
    self::assertSame('read', $calls[0]->getArguments()[0]->getValue());

    // The next round holds the result, and is answered with the scripted text.
    $answered = new ChatInput([
      new ChatMessage('user', 'Where may I write?'),
      new ChatMessage('assistant', ''),
      new ChatMessage('tool', 'Ops, Docs'),
    ]);
    $answered->setStreamedOutput(TRUE);
    $answered->setRequestMetadataValue(UiMessage::CONTEXT_KEY, ['mock' => $script]);

    $stream = $this->provider()->chat($answered, MockProvider::MODEL)->getNormalized();
    self::assertInstanceOf(StreamedChatMessageIteratorInterface::class, $stream);
    self::assertSame('Ops and Docs.', implode('', array_map(
      static fn (object $chunk): string => $chunk->getText(),
      iterator_to_array($stream, FALSE),
    )));
  }

  /**
   * A scripted tool call that names no function is refused.
   */
  public function testTheNamelessToolCallIsRefused(): void {
    $this->config(MockSettings::CONFIG)->set('mode', 'scripted')->save();

    $this->expectException(\InvalidArgumentException::class);
    $this->ask('Where may I write?', ['mock' => ['tools' => [['id' => 'call-1']]]]);
  }

  /**
   * A script that is not an answer fails the call rather than vanishing.
   */
  public function testTheBrokenScriptIsRefused(): void {
    $this->config(MockSettings::CONFIG)->set('mode', 'scripted')->save();

    $this->expectException(\InvalidArgumentException::class);
    $this->ask('How do we release?', ['mock' => ['text' => ['not', 'a', 'string']]]);
  }

  /**
   * A paced answer spends the delay between its frames.
   */
  public function testThePacedAnswerSpendsTheDelay(): void {
    $this->config(MockSettings::CONFIG)->set('mode', 'scripted')->save();
    // Warm plugin discovery first, so what the clock measures is the pacing.
    $this->ask('warm-up');

    $start = microtime(TRUE);
    $this->ask('How do we release?', ['mock' => ['text' => str_repeat('x', 160), 'delay_ms' => 20]]);
    self::assertGreaterThan(0.15, microtime(TRUE) - $start);
  }

  /**
   * A request may not hold a worker for as long as it likes.
   *
   * Two chunks, so one pause: a minute was asked for and the 100 ms cap is
   * what the answer actually waits.
   */
  public function testTheRequestedPacingIsCapped(): void {
    $this->config(MockSettings::CONFIG)->set('mode', 'scripted')->save();
    $this->ask('warm-up');

    $start = microtime(TRUE);
    $this->ask('How do we release?', ['mock' => ['text' => str_repeat('x', 32), 'delay_ms' => 60000]]);
    $elapsed = microtime(TRUE) - $start;

    self::assertGreaterThan(0.09, $elapsed);
    self::assertLessThan(0.3, $elapsed);
  }

  /**
   * A caller that asked for no stream gets a message, not an iterator.
   *
   * The API Explorer and every non-chat AI operation read the message and
   * nothing else, so a provider that always streams answers them with nothing.
   */
  public function testTheUnstreamedCallAnswersOneMessage(): void {
    $this->config(MockSettings::CONFIG)->set('answer', 'The site says: @prompt')->save();
    $input = new ChatInput([new ChatMessage('user', 'Tell me about openKB')]);
    $input->setStreamedOutput(FALSE);

    $normalized = $this->provider()->chat($input, MockProvider::MODEL)->getNormalized();

    self::assertInstanceOf(ChatMessage::class, $normalized);
    self::assertSame('The site says: Tell me about openKB', $normalized->getText());
  }

  /**
   * A streamed answer carries each frame as its own raw payload.
   *
   * `ai_logging` stores the accumulated raw output as the turn's response; a
   * frame carrying none leaves every logged answer empty.
   */
  public function testTheStreamedAnswerCarriesItsRawFrames(): void {
    $this->config(MockSettings::CONFIG)->set('answer', 'The site says: @prompt')->save();
    $input = new ChatInput([new ChatMessage('user', 'Tell me about openKB')]);
    $input->setStreamedOutput(TRUE);

    $stream = $this->provider()->chat($input, MockProvider::MODEL)->getNormalized();
    self::assertInstanceOf(StreamedChatMessageIteratorInterface::class, $stream);
    iterator_to_array($stream);

    $raw = $stream->reconstructChatOutput()->getRawOutput();
    self::assertNotEmpty($raw);
    self::assertSame('The site says: Tell me about openKB', implode('', $raw));
  }

  /**
   * A scripted answer, as a caller writes one.
   *
   * @return array<string, mixed>
   *   The answer, in its stored shape.
   */
  private function script(): array {
    return [
      'text' => 'Cut the tag [1], then deploy [2].',
      'metadata' => [
        'citations' => [['n' => 1, 'path' => '/a-page']],
        'grounding' => ['mode' => 'grounded', 'state' => 'grounded'],
      ],
    ];
  }

  /**
   * The provider, as `ai.provider` builds it.
   */
  private function provider(): object {
    return $this->container->get('ai.provider')->createInstance('mock');
  }

  /**
   * One call's answer: the pieces it arrived in, the text, and its metadata.
   *
   * @param string $prompt
   *   What to ask.
   * @param array<string, mixed>|null $context
   *   The caller context to send with it.
   *
   * @return array{chunks: array<int, string>, text: string, metadata: array<string, mixed>}
   *   The answer, with the metadata the bridge would publish as data parts.
   */
  private function ask(string $prompt, ?array $context = NULL): array {
    $input = new ChatInput([new ChatMessage('user', $prompt)]);
    $input->setStreamedOutput(TRUE);
    if ($context !== NULL) {
      $input->setRequestMetadataValue(UiMessage::CONTEXT_KEY, $context);
    }

    $output = $this->provider()->chat($input, MockProvider::MODEL);
    $normalized = $output->getNormalized();
    self::assertInstanceOf(StreamedChatMessageIteratorInterface::class, $normalized);

    // Iterated as the bridge does: drupal/ai's own iterator buffers, splits
    // and flushes, and runs the callbacks that carry the metadata out.
    $chunks = [];
    foreach ($normalized as $chunk) {
      $chunks[] = $chunk->getText();
    }
    // drupal/ai stamps the call's own request metadata onto every answer; the
    // bridge does not publish the caller its own context back, and neither
    // does what these cases assert on.
    $metadata = $normalized->getMetadata();
    unset($metadata[UiMessage::CONTEXT_KEY]);

    return [
      'chunks' => $chunks,
      'text' => implode('', $chunks),
      'metadata' => $metadata,
    ];
  }

}
