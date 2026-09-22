<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite\Attribute;

use Drupal\Component\Plugin\Attribute\Plugin;
use Drupal\Core\StringTranslation\TranslatableMarkup;

/**
 * Declares a source of passages an answer can be grounded on.
 */
#[\Attribute(\Attribute::TARGET_CLASS)]
class Retriever extends Plugin {

  /**
   * Constructs the attribute.
   *
   * @param string $id
   *   The plugin id.
   * @param \Drupal\Core\StringTranslation\TranslatableMarkup $label
   *   The human-readable name.
   * @param \Drupal\Core\StringTranslation\TranslatableMarkup|null $description
   *   What it retrieves from.
   * @param class-string|null $deriver
   *   The deriver class.
   */
  public function __construct(
    public readonly string $id,
    public readonly TranslatableMarkup $label,
    public readonly ?TranslatableMarkup $description = NULL,
    public readonly ?string $deriver = NULL,
  ) {}

}
