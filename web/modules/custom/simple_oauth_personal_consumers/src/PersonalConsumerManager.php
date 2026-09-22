<?php

declare(strict_types=1);

namespace Drupal\simple_oauth_personal_consumers;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Component\Utility\Crypt;
use Drupal\Component\Uuid\UuidInterface;
use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Database\Connection;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Entity\Sql\SqlContentEntityStorage;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\simple_oauth\ExpiredCollector;
use Drupal\user\UserInterface;

/**
 * Provisions, revokes and sweeps owner-bound personal OAuth2 consumers.
 */
class PersonalConsumerManager implements PersonalConsumerManagerInterface {

  use StringTranslationTrait;

  /**
   * The granularity "last used" is kept at, in seconds.
   */
  protected const USAGE_RESOLUTION = 3600;

  public function __construct(
    protected EntityTypeManagerInterface $entityTypeManager,
    protected UuidInterface $uuid,
    protected ExpiredCollector $expiredCollector,
    protected ConfigFactoryInterface $configFactory,
    protected TimeInterface $time,
    protected Connection $database,
  ) {}

  /**
   * {@inheritdoc}
   */
  public function create(UserInterface $owner, string $label): PersonalConsumerCredentials {
    if ($owner->isAnonymous()) {
      throw new \InvalidArgumentException('Cannot create a personal consumer for the anonymous user.');
    }
    if ($this->isAdminAccount($owner)) {
      throw new \InvalidArgumentException('Administrator accounts cannot own personal API clients — use a non-admin account.');
    }

    $scopes = $this->configFactory->get('simple_oauth_personal_consumers.settings')->get('scopes') ?? [];
    $client_id = $this->uuid->generate();
    $secret = Crypt::randomBytesBase64(32);
    /** @var \Drupal\consumers\Entity\ConsumerInterface $consumer */
    $consumer = $this->entityTypeManager->getStorage('consumer')->create([
      'label' => trim($label),
      'client_id' => $client_id,
      // The password field type hashes on save; plaintext lives only in the
      // returned credentials.
      'secret' => $secret,
      'grant_types' => ['client_credentials'],
      'confidential' => TRUE,
      'is_default' => FALSE,
      'third_party' => FALSE,
      'user_id' => $owner->id(),
      'personal' => TRUE,
      'scopes' => $scopes,
    ]);
    $consumer->save();

    return new PersonalConsumerCredentials($consumer, $client_id, $secret);
  }

  /**
   * {@inheritdoc}
   */
  public function revoke(ConsumerInterface $consumer): void {
    foreach ($this->expiredCollector->collectForClient($consumer, TRUE) as $token) {
      $token->revoke();
      $token->save();
    }
    // Issuance is grant-gated per consumer, so an empty grant list blocks new
    // tokens; status is the human-readable revoked marker. The entity is kept
    // so historical attribution to this consumer keeps resolving.
    $consumer->set('grant_types', []);
    $consumer->set('status', FALSE);
    $consumer->save();
  }

  /**
   * {@inheritdoc}
   */
  public function getConsumers(UserInterface $owner): array {
    $storage = $this->entityTypeManager->getStorage('consumer');
    $ids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('user_id', $owner->id())
      ->condition('personal', TRUE)
      ->sort('id')
      ->execute();
    return $storage->loadMultiple($ids);
  }

  /**
   * {@inheritdoc}
   */
  public function nameTaken(UserInterface $owner, string $name, ?ConsumerInterface $except = NULL): bool {
    $wanted = $this->comparable($name);
    foreach ($this->getConsumers($owner) as $consumer) {
      if ($except !== NULL && $consumer->id() === $except->id()) {
        continue;
      }
      if ($this->comparable((string) $consumer->label()) === $wanted) {
        return TRUE;
      }
    }
    return FALSE;
  }

  /**
   * {@inheritdoc}
   */
  public function nameTakenError(string $name): TranslatableMarkup {
    return $this->t('You already have an agent named %name. Choose another name.', ['%name' => trim($name)]);
  }

  /**
   * A name as it is compared: trimmed, case folded.
   */
  protected function comparable(string $name): string {
    return mb_strtolower(trim($name));
  }

  /**
   * {@inheritdoc}
   */
  public function recordUsage(ConsumerInterface $consumer): void {
    $now = $this->time->getRequestTime();
    if ($now - (int) $consumer->get('last_used')->value < static::USAGE_RESOLUTION) {
      return;
    }
    $storage = $this->entityTypeManager->getStorage('consumer');
    assert($storage instanceof SqlContentEntityStorage);
    $table_mapping = $storage->getTableMapping();
    $definition = $consumer->getFieldDefinition('last_used')->getFieldStorageDefinition();
    // Written past the entity API: saving a consumer makes simple_oauth delete
    // every non-refresh token it holds, and a usage stamp must not revoke the
    // token whose issuance it records.
    $this->database->update($table_mapping->getFieldTableName('last_used'))
      ->fields([$table_mapping->getFieldColumnName($definition, 'value') => $now])
      ->condition('id', $consumer->id())
      ->execute();
    $consumer->set('last_used', $now);
    $storage->resetCache([$consumer->id()]);
  }

  /**
   * {@inheritdoc}
   */
  public function sweepUnclaimed(): int {
    $retention = (int) $this->configFactory
      ->get('simple_oauth_personal_consumers.settings')
      ->get('unclaimed_retention');
    // Nothing is swept without a positive retention.
    if ($retention <= 0) {
      return 0;
    }
    $storage = $this->entityTypeManager->getStorage('consumer');
    $ids = $storage->getQuery()
      ->accessCheck(FALSE)
      ->condition('personal', TRUE)
      ->notExists('user_id')
      ->condition('created', $this->time->getRequestTime() - $retention, '<')
      ->execute();
    if (!$ids) {
      return 0;
    }
    $storage->delete($storage->loadMultiple($ids));
    return count($ids);
  }

  /**
   * {@inheritdoc}
   */
  public function isRevoked(ConsumerInterface $consumer): bool {
    return !((bool) $consumer->get('status')->value);
  }

  /**
   * {@inheritdoc}
   */
  public function isAdminAccount(UserInterface $owner): bool {
    if ((int) $owner->id() === 1) {
      return TRUE;
    }
    /** @var \Drupal\user\RoleInterface[] $roles */
    $roles = $this->entityTypeManager->getStorage('user_role')
      ->loadMultiple($owner->getRoles());
    foreach ($roles as $role) {
      if ($role->isAdmin()) {
        return TRUE;
      }
    }
    return FALSE;
  }

}
