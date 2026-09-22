<?php

declare(strict_types=1);

namespace Drupal\openkb_schema;

use Drupal\Core\Entity\EntityFieldManagerInterface;
use Psr\Log\LoggerInterface;

/**
 * The text format the page body is authored in.
 *
 * The field config is where a body's format is configured, so
 * `field_kb_body`'s `allowed_formats` answers it for every reader and every
 * writer alike — the allowed list the schema publishes, and the presave that
 * stamps the format onto a body arriving without one. Exactly one configured
 * format is the contract, since a body carries one format.
 */
final class BodyFormat {

  /**
   * Entity type of the page.
   */
  public const ENTITY_TYPE_ID = 'node';

  /**
   * Bundle of the page.
   */
  public const BUNDLE = 'kb_page';

  /**
   * Field holding the page body.
   */
  public const FIELD = 'field_kb_body';

  /**
   * Cache tag of the field config, to add whether or not it exists.
   */
  public const CACHE_TAG = 'config:field.field.' . self::ENTITY_TYPE_ID . '.' . self::BUNDLE . '.' . self::FIELD;

  /**
   * Whether the misconfiguration has been reported this request.
   */
  private bool $logged = FALSE;

  /**
   * Constructs the body format reader.
   */
  public function __construct(
    protected readonly EntityFieldManagerInterface $entityFieldManager,
    protected readonly LoggerInterface $logger,
  ) {}

  /**
   * The configured format id.
   *
   * @return string|null
   *   The format, or NULL when the field does not name exactly one — which
   *   leaves consumers no format to read or write with.
   */
  public function id(): ?string {
    $definitions = $this->entityFieldManager->getFieldDefinitions(self::ENTITY_TYPE_ID, self::BUNDLE);
    $field = $definitions[self::FIELD] ?? NULL;
    $formats = $field?->getSetting('allowed_formats') ?: [];
    if (count($formats) !== 1) {
      // A misconfigured field is one site fault, and the lookup runs on every
      // page save, so the warning stands once per request.
      if (!$this->logged) {
        $this->logged = TRUE;
        $this->logger->warning('The %field field configures @count text formats; one is the contract, so consumers are left without a format.', [
          '%field' => self::FIELD,
          '@count' => count($formats),
        ]);
      }
      return NULL;
    }
    return (string) reset($formats);
  }

}
