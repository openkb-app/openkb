<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access\Cache;

use Drupal\Core\Cache\CacheableMetadata;
use Drupal\Core\Cache\Context\CacheContextInterface;
use Drupal\Core\Cache\Context\UserCacheContextBase;
use Drupal\Core\Session\AccountInterface;
use Drupal\openkb_space_access\SpaceAccess;
use Drupal\openkb_space_access\SpaceAccessPolicy;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\openkb_space\SpaceStorage;

/**
 * Cache context: the set of spaces the account may read.
 *
 * A space collection is narrowed per account — by
 * openkb_space_access_query_openkb_space_access_alter() in SQL, and by the
 * entity access handler per space. A response built from it therefore varies,
 * and has to say so or it is stored under a key every other account matches.
 *
 * Keyed by the readable set rather than by the account, the way core keys node
 * reads by `user.node_grants:view` rather than by `user`: two accounts that
 * read the same spaces genuinely have the same answer and should share it.
 * A bare `user` context would be correct too, but it is an auto-placeholder
 * context, which makes dynamic_page_cache refuse the whole ce-api read path.
 */
final class SpaceVisibilityCacheContext extends UserCacheContextBase implements CacheContextInterface {

  public function __construct(
    AccountInterface $user,
    private readonly SpaceAccess $spaceAccess,
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {
    parent::__construct($user);
  }

  /**
   * {@inheritdoc}
   */
  public static function getLabel() {
    return t('Readable spaces');
  }

  /**
   * {@inheritdoc}
   */
  public function getContext() {
    $ids = $this->spaceAccess->spaceIds($this->user, SpaceAccessPolicy::VIEW);
    if (!$ids) {
      return 'none';
    }
    sort($ids);
    return implode(',', $ids);
  }

  /**
   * {@inheritdoc}
   */
  public function getCacheableMetadata() {
    $metadata = new CacheableMetadata();
    // A roster or read-access save changes which spaces an account reads; a
    // space that does not exist yet can only be described by the list tag.
    $metadata->addCacheTags(['openkb_space_list']);
    $storage = SpaceStorage::get($this->entityTypeManager);
    foreach ($storage->all() as $space) {
      $metadata->addCacheableDependency($space);
    }
    return $metadata;
  }

}
