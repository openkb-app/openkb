<?php

declare(strict_types=1);

namespace Drupal\openkb_space\Entity;

use Drupal\Core\Entity\Attribute\ContentEntityType;
use Drupal\Core\Entity\ContentEntityDeleteForm;
use Drupal\Core\Entity\EditorialContentEntityBase;
use Drupal\Core\Entity\EntityChangedTrait;
use Drupal\Core\Entity\EntityListBuilder;
use Drupal\Core\Entity\EntityStorageInterface;
use Drupal\Core\Entity\EntityTypeInterface;
use Drupal\Core\Entity\Form\RevisionDeleteForm;
use Drupal\Core\Entity\Form\RevisionRevertForm;
use Drupal\Core\Entity\Routing\AdminHtmlRouteProvider;
use Drupal\Core\Entity\Routing\RevisionHtmlRouteProvider;
use Drupal\Core\Field\BaseFieldDefinition;
use Drupal\Core\Field\FieldStorageDefinitionInterface;
use Drupal\Core\Language\LanguageInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\openkb_space\Form\SpaceForm;
use Drupal\openkb_space\SpaceAccessControlHandler;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_space\SpaceStorage;
use Drupal\openkb_space\SpaceViewsData;
use Drupal\user\EntityOwnerTrait;

/**
 * One openKB space.
 *
 * The collection route is answered by the `openkb_spaces` View, which takes
 * the path over from the generic list builder.
 */
#[ContentEntityType(
  id: 'openkb_space',
  label: new TranslatableMarkup('Space'),
  label_collection: new TranslatableMarkup('Spaces'),
  label_singular: new TranslatableMarkup('space'),
  label_plural: new TranslatableMarkup('spaces'),
  entity_keys: [
    'id' => 'id',
    'revision' => 'revision_id',
    'label' => 'label',
    'owner' => 'uid',
    'published' => 'status',
    'uuid' => 'uuid',
  ],
  handlers: [
    'storage' => SpaceStorage::class,
    'list_builder' => EntityListBuilder::class,
    'views_data' => SpaceViewsData::class,
    'access' => SpaceAccessControlHandler::class,
    'form' => [
      'add' => SpaceForm::class,
      'edit' => SpaceForm::class,
      'delete' => ContentEntityDeleteForm::class,
      'revision-delete' => RevisionDeleteForm::class,
      'revision-revert' => RevisionRevertForm::class,
    ],
    'route_provider' => [
      'html' => AdminHtmlRouteProvider::class,
      'revision' => RevisionHtmlRouteProvider::class,
    ],
  ],
  links: [
    'collection' => '/admin/content/space',
    'add-form' => '/openkb-space/add',
    'canonical' => '/openkb-space/{openkb_space}',
    'edit-form' => '/openkb-space/{openkb_space}/edit',
    'delete-form' => '/openkb-space/{openkb_space}/delete',
    'revision' => '/openkb-space/{openkb_space}/revision/{openkb_space_revision}/view',
    'revision-delete-form' => '/openkb-space/{openkb_space}/revision/{openkb_space_revision}/delete',
    'revision-revert-form' => '/openkb-space/{openkb_space}/revision/{openkb_space_revision}/revert',
    'version-history' => '/openkb-space/{openkb_space}/revisions',
  ],
  admin_permission: 'administer openkb_space',
  base_table: 'openkb_space',
  revision_table: 'openkb_space_revision',
  show_revision_ui: TRUE,
  label_count: [
    'singular' => '@count space',
    'plural' => '@count spaces',
  ],
  field_ui_base_route: 'entity.openkb_space.settings',
  revision_metadata_keys: [
    'revision_user' => 'revision_uid',
    'revision_created' => 'revision_timestamp',
    'revision_log_message' => 'revision_log',
  ],
)]
class Space extends EditorialContentEntityBase implements SpaceInterface {

  use EntityChangedTrait;
  use EntityOwnerTrait;

  /**
   * {@inheritdoc}
   */
  public function preSave(EntityStorageInterface $storage): void {
    parent::preSave($storage);
    // The owner manages the space.
    $owner = (int) $this->getOwnerId();
    if ($this->isNew() && $owner && !in_array($owner, $this->rosterIds(self::MANAGERS), TRUE)) {
      $this->get(self::MANAGERS)->appendItem(['target_id' => $owner]);
    }
    // Every save is a revision, stamped with who saved it. A log message
    // belongs to the save that wrote it, not to the next one.
    if (!$this->isNew()) {
      $this->setNewRevision();
      if ($this->getRevisionLogMessage() === $this->getOriginal()?->getRevisionLogMessage()) {
        $this->setRevisionLogMessage('');
      }
    }
    if ($this->isNewRevision()) {
      $this->setRevisionUserId((int) \Drupal::currentUser()->id());
      $this->setRevisionCreationTime(\Drupal::time()->getRequestTime());
    }
    // The name is the URL; core's path field carries it from here on. An empty
    // slug — which validation refuses — must not become the alias `/`.
    $slug = self::slugify((string) $this->label());
    $path = $this->get('path');
    $path->alias = $slug === '' ? '' : '/' . $slug;
    // Pathauto — here for the page pattern — swaps core's path item for its
    // own everywhere, and that one writes the alias only for an entity it is
    // told not to generate one for. 0 is its SKIP state.
    if ($path->first()?->getDataDefinition()->getPropertyDefinition('pathauto')) {
      $path->pathauto = 0;
    }
  }

  /**
   * {@inheritdoc}
   */
  public function postSave(EntityStorageInterface $storage, $update = TRUE): void {
    parent::postSave($storage, $update);
    \Drupal::service('openkb_space.cache_reset')->saved($this);
  }

  /**
   * The URL slug a name yields: transliterated, lowercased, hyphenated.
   */
  public static function slugify(string $label): string {
    $ascii = \Drupal::transliteration()
      ->transliterate($label, LanguageInterface::LANGCODE_DEFAULT, '-');
    return trim((string) preg_replace('/[^a-z0-9]+/', '-', mb_strtolower($ascii)), '-');
  }

  /**
   * {@inheritdoc}
   */
  public function getSlug(): string {
    return ltrim((string) $this->get('path')->alias, '/');
  }

  /**
   * {@inheritdoc}
   */
  public function isOnRoster(string $roster, AccountInterface $account): bool {
    return in_array((int) $account->id(), $this->rosterIds($roster), TRUE);
  }

  /**
   * {@inheritdoc}
   */
  public function isOpenToAllUsers(): bool {
    return $this->get('read_access')->value === self::ALL_USERS;
  }

  /**
   * The user ids on a roster field.
   *
   * @return int[]
   *   User ids.
   */
  private function rosterIds(string $roster): array {
    return array_map('intval', array_column($this->get($roster)->getValue(), 'target_id'));
  }

  /**
   * {@inheritdoc}
   */
  public static function baseFieldDefinitions(EntityTypeInterface $entity_type): array {
    $fields = parent::baseFieldDefinitions($entity_type);

    $fields['label'] = BaseFieldDefinition::create('string')
      ->setLabel(new TranslatableMarkup('Name'))
      ->setRequired(TRUE)
      ->setRevisionable(TRUE)
      ->setSetting('max_length', 255)
      ->addConstraint('OpenkbSpaceName')
      ->setDisplayOptions('form', ['type' => 'string_textfield', 'weight' => -10])
      ->setDisplayConfigurable('form', TRUE)
      ->setDisplayOptions('view', ['label' => 'hidden', 'type' => 'string', 'weight' => -10])
      ->setDisplayConfigurable('view', TRUE);

    $fields['status']
      ->setLabel(new TranslatableMarkup('Enabled'))
      ->setDescription(new TranslatableMarkup('A disabled space is hidden from the knowledge base; administrators still see it here.'))
      ->setDisplayOptions('form', [
        'type' => 'boolean_checkbox',
        'settings' => ['display_label' => TRUE],
        'weight' => 40,
      ])
      ->setDisplayConfigurable('form', TRUE)
      ->setDisplayOptions('view', [
        'type' => 'boolean',
        'label' => 'above',
        'settings' => ['format' => 'enabled-disabled'],
        'weight' => 40,
      ])
      ->setDisplayConfigurable('view', TRUE);

    $fields[self::MANAGERS] = self::roster(new TranslatableMarkup('Managers'), new TranslatableMarkup('Manage the space: its roster, read access and outline.'), 10);
    $fields[self::MEMBERS] = self::roster(new TranslatableMarkup('Members'), new TranslatableMarkup('Read and write in the space.'), 11);
    $fields[self::VIEWERS] = self::roster(new TranslatableMarkup('Viewers'), new TranslatableMarkup('Read the space.'), 12);

    $fields['read_access'] = BaseFieldDefinition::create('list_string')
      ->setLabel(new TranslatableMarkup('Read access'))
      ->setDescription(new TranslatableMarkup('Who may read the space: its roster, or every signed-in user.'))
      ->setRequired(TRUE)
      ->setRevisionable(TRUE)
      ->setSetting('allowed_values', [
        self::MEMBERS_ONLY => 'Members only',
        self::ALL_USERS => 'All users',
      ])
      ->setDefaultValue(self::MEMBERS_ONLY)
      ->setDisplayOptions('form', ['type' => 'options_select', 'weight' => 20])
      ->setDisplayConfigurable('form', TRUE)
      ->setDisplayOptions('view', ['type' => 'list_default', 'label' => 'above', 'weight' => 20])
      ->setDisplayConfigurable('view', TRUE);

    $fields['outline'] = BaseFieldDefinition::create('string_long')
      ->setLabel(new TranslatableMarkup('Outline'))
      ->setDescription(new TranslatableMarkup('The page tree as JSON: an ordered list of {"id", "children"} entries.'))
      ->setRevisionable(TRUE)
      ->addConstraint('OpenkbSpaceOutline');

    $fields['uid'] = BaseFieldDefinition::create('entity_reference')
      ->setLabel(new TranslatableMarkup('Owner'))
      ->setSetting('target_type', 'user')
      ->setRevisionable(TRUE)
      ->setDefaultValueCallback(self::class . '::getDefaultEntityOwner')
      ->setDisplayOptions('form', [
        'type' => 'entity_reference_autocomplete',
        'settings' => ['match_operator' => 'CONTAINS', 'size' => 60, 'placeholder' => ''],
        'weight' => 30,
      ])
      ->setDisplayConfigurable('form', TRUE)
      ->setDisplayOptions('view', ['label' => 'above', 'type' => 'author', 'weight' => 30])
      ->setDisplayConfigurable('view', TRUE);

    $fields['created'] = BaseFieldDefinition::create('created')
      ->setLabel(new TranslatableMarkup('Created'))
      ->setRevisionable(TRUE)
      ->setDisplayOptions('form', ['type' => 'datetime_timestamp', 'weight' => 31])
      ->setDisplayConfigurable('form', TRUE)
      ->setDisplayOptions('view', ['label' => 'above', 'type' => 'timestamp', 'weight' => 31])
      ->setDisplayConfigurable('view', TRUE);

    $fields['changed'] = BaseFieldDefinition::create('changed')
      ->setLabel(new TranslatableMarkup('Changed'))
      ->setRevisionable(TRUE);

    // The space's landing URL, and the slug every surface addresses it by.
    // Written from the name on save, so it is not editable here.
    $fields['path'] = BaseFieldDefinition::create('path')
      ->setLabel(new TranslatableMarkup('URL alias'))
      ->setComputed(TRUE);

    return $fields;
  }

  /**
   * An unlimited user reference: one roster.
   */
  private static function roster(TranslatableMarkup $label, TranslatableMarkup $description, int $weight): BaseFieldDefinition {
    return BaseFieldDefinition::create('entity_reference')
      ->setLabel($label)
      ->setDescription($description)
      ->setSetting('target_type', 'user')
      ->setSetting('handler_settings', ['include_anonymous' => FALSE])
      ->setRevisionable(TRUE)
      ->setCardinality(FieldStorageDefinitionInterface::CARDINALITY_UNLIMITED)
      ->setDisplayOptions('form', ['type' => 'entity_reference_autocomplete_tags', 'weight' => $weight])
      ->setDisplayConfigurable('form', TRUE)
      ->setDisplayOptions('view', ['type' => 'entity_reference_label', 'label' => 'above', 'weight' => $weight])
      ->setDisplayConfigurable('view', TRUE);
  }

}
