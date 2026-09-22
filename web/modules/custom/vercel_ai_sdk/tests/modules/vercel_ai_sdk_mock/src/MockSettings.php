<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_mock;

use Drupal\Core\Config\ConfigFactoryInterface;

/**
 * What the `mock` provider answers, and how fast.
 *
 * Config, read per call, so an admin changes what an environment answers with
 * no rebuild and no cache rebuild. Which provider a turn goes to is the
 * assistant's business, not this file's.
 */
final readonly class MockSettings {

  /**
   * The config object the settings live in.
   */
  public const CONFIG = 'vercel_ai_sdk_mock.settings';

  /**
   * The canned answer, `@prompt` standing for the question.
   */
  public const DEFAULT_ANSWER = "Mock answer for:\n\n@prompt\n\nThe knowledge base covers onboarding, the system architecture and the authoring workflow.";

  /**
   * Constructs the settings.
   *
   * @param \Drupal\vercel_ai_sdk_mock\MockMode $mode
   *   What an answer is made of.
   * @param int $delayMs
   *   Pause between two frames, in milliseconds; 0 leaves an answer unpaced.
   * @param string $answer
   *   The canned answer, with `@prompt` for the question.
   */
  public function __construct(
    public MockMode $mode = MockMode::Canned,
    public int $delayMs = 0,
    public string $answer = self::DEFAULT_ANSWER,
  ) {}

  /**
   * The settings a site answers under.
   */
  public static function get(ConfigFactoryInterface $configFactory): self {
    $config = $configFactory->get(self::CONFIG);
    $defaults = new self();

    return new self(
      mode: MockMode::tryFrom((string) $config->get('mode')) ?? $defaults->mode,
      delayMs: max(0, (int) $config->get('delay_ms')),
      answer: (string) ($config->get('answer') ?? $defaults->answer),
    );
  }

}
