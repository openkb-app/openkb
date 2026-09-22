<?php

declare(strict_types=1);

namespace Drupal\inline_comment\Entity;

use Drupal\Core\Entity\Attribute\ContentEntityType;
use Drupal\Core\Entity\ContentEntityBase;
use Drupal\Core\Entity\EntityTypeInterface;
use Drupal\Core\Field\BaseFieldDefinition;
use Drupal\Core\StringTranslation\TranslatableMarkup;

/**
 * One message of one thread about one region of one entity translation.
 *
 * Stored beside the commented entity, never on it: its revisions, reverts and
 * loads are untouched by any volume of discussion.
 *
 * Minimal on purpose — base fields only, no bundles, no field UI, no forms,
 * non-revisionable, `internal`. Internal is what closes the generic surfaces:
 * JSON:API builds no route for it, and with no admin permission and no access
 * handler the default one refuses every account. Messages reach their readers
 * through this module's endpoint alone.
 *
 * Coordinates:
 * - `entity_type` + `entity_id` + `langcode` — the commented translation. A
 *   thread about the German text is not one about the English text.
 * - `anchor` — the region of it the thread is about. Opaque: the consumer
 *   mints it and is the only side that knows what it names.
 * - `thread_id` + `msg_id` — the thread and the message within it.
 *
 * Columns are what this module queries on. Everything else the consumer holds
 * about a message rides `data` verbatim, so what a message says is the
 * consumer's vocabulary and adding a fact to it is no schema change.
 *
 * `created` is this side's answer; `uid` is the caller's, and has to name a
 * real account — core's own ValidReference constraint is what refuses one that
 * does not.
 */
#[ContentEntityType(
  id: 'inline_comment',
  label: new TranslatableMarkup('Inline comment'),
  label_collection: new TranslatableMarkup('Inline comments'),
  label_singular: new TranslatableMarkup('inline comment'),
  label_plural: new TranslatableMarkup('inline comments'),
  entity_keys: [
    'id' => 'id',
    'uuid' => 'uuid',
    'langcode' => 'langcode',
  ],
  handlers: [
    'storage_schema' => InlineCommentStorageSchema::class,
  ],
  base_table: 'inline_comment',
  internal: TRUE,
  label_count: [
    'singular' => '@count inline comment',
    'plural' => '@count inline comments',
  ],
)]
final class InlineComment extends ContentEntityBase {

  /**
   * The fields whose combination names one message exactly once.
   */
  public const COORDINATES = [
    'entity_type',
    'entity_id',
    'langcode',
    'anchor',
    'thread_id',
    'msg_id',
  ];

  /**
   * The longest an id coordinate may be — the stored column width.
   */
  public const ID_MAX_LENGTH = 64;

  /**
   * What an id coordinate may be.
   */
  public const ID_PATTERN = '/^[A-Za-z0-9_-]{1,64}$/';

  /**
   * {@inheritdoc}
   */
  public static function baseFieldDefinitions(EntityTypeInterface $entity_type): array {
    $fields = parent::baseFieldDefinitions($entity_type);

    $fields['entity_type'] = BaseFieldDefinition::create('string')
      ->setLabel(new TranslatableMarkup('Commented entity type'))
      ->setSetting('max_length', EntityTypeInterface::ID_MAX_LENGTH)
      ->setRequired(TRUE);

    $fields['entity_id'] = BaseFieldDefinition::create('string')
      ->setLabel(new TranslatableMarkup('Commented entity'))
      ->setSetting('max_length', self::ID_MAX_LENGTH)
      ->setRequired(TRUE);

    $fields['langcode']
      ->setLabel(new TranslatableMarkup('Commented translation'))
      ->setRequired(TRUE);

    $fields['anchor'] = self::idField(new TranslatableMarkup('Anchor'));
    $fields['thread_id'] = self::idField(new TranslatableMarkup('Thread'));
    $fields['msg_id'] = self::idField(new TranslatableMarkup('Message'));

    // Core's own ValidReference constraint is what refuses an author who is
    // not an account.
    $fields['uid'] = BaseFieldDefinition::create('entity_reference')
      ->setLabel(new TranslatableMarkup('Author'))
      ->setSetting('target_type', 'user')
      ->setRequired(TRUE);

    $fields['created'] = BaseFieldDefinition::create('created')
      ->setLabel(new TranslatableMarkup('Said at'))
      ->setRequired(TRUE);

    // What the consumer holds about the message. Nothing here reads inside it.
    $fields['data'] = BaseFieldDefinition::create('map')
      ->setLabel(new TranslatableMarkup('Message data'));

    return $fields;
  }

  /**
   * What the message carries.
   *
   * @return array
   *   The `data` map, empty when the message carries none.
   */
  public function data(): array {
    $data = $this->get('data')->first()?->getValue();
    return is_array($data) ? $data : [];
  }

  /**
   * One id coordinate: bounded, and shaped like an id.
   *
   * @param \Drupal\Core\StringTranslation\TranslatableMarkup $label
   *   The field label.
   *
   * @return \Drupal\Core\Field\BaseFieldDefinition
   *   The field definition.
   */
  private static function idField(TranslatableMarkup $label): BaseFieldDefinition {
    return BaseFieldDefinition::create('string')
      ->setLabel($label)
      ->setSetting('max_length', self::ID_MAX_LENGTH)
      ->setRequired(TRUE)
      ->addPropertyConstraints('value', [
        'Regex' => [
          'pattern' => self::ID_PATTERN,
          'message' => 'This is not an id.',
        ],
      ]);
  }

}
