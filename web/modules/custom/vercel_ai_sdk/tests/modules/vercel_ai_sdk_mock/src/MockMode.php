<?php

declare(strict_types=1);

namespace Drupal\vercel_ai_sdk_mock;

use Drupal\Core\StringTranslation\TranslatableMarkup;

/**
 * What the `mock` provider answers with.
 */
enum MockMode: string {

  // Fixed text from the settings, so the same question answers the same way on
  // every run.
  case Canned = 'canned';

  // The caller decides, through the request context: the answer text and the
  // data parts the bridge publishes. For end-to-end runs and Itests.
  case Scripted = 'scripted';

  /**
   * What an admin form calls this mode.
   */
  public function label(): TranslatableMarkup {
    return match ($this) {
      self::Canned => new TranslatableMarkup('Canned — the text below, whatever the request says'),
      self::Scripted => new TranslatableMarkup('Scripted — the answer the request asks for, for automated runs'),
    };
  }

  /**
   * The modes as an admin form offers them.
   *
   * @return array<string, \Drupal\Core\StringTranslation\TranslatableMarkup>
   *   Label, keyed by mode value.
   */
  public static function options(): array {
    $options = [];
    foreach (self::cases() as $case) {
      $options[$case->value] = $case->label();
    }
    return $options;
  }

}
