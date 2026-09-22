<?php

declare(strict_types=1);

namespace Drupal\openkb_space_access;

use Drupal\Core\Cache\RefinableCacheableDependencyInterface;
use Drupal\Core\Session\AccessPolicyProcessorInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\openkb_space\SpaceStorage;

/**
 * What an account may do, per space, as a listable map.
 *
 * "Where may I operate?" asked once, for every space at once. An agent has to
 * answer it before it creates anything, and so does a human picking a target
 * space; both read the same map, so neither discovers a refusal by attempting
 * a write.
 *
 * The levels are the roster ranks flattened to one ordered scale — `read` <
 * `write` < `manage` — because a caller filtering for "where may I write"
 * should not have to know which roster grants that. They are computed from
 * {@see SpaceAccessPolicy}, never from the rosters directly: the policy also
 * answers for the account types that sit on no roster at all (a site
 * administrator, the collaboration server, anyone signed in when a space reads
 * `all_users`), and a second reading of the fields would miss all of them.
 *
 * Spaces the account cannot even read are absent, which is the same thing
 * {@see SpaceAccess::hiddenSpaceIds} hides them from elsewhere: the map is not
 * a directory of what exists, it is what this account may operate on.
 */
final class SpaceAccessMap {

  /**
   * Read the space's pages.
   */
  public const READ = 'read';

  /**
   * Write the space's pages.
   */
  public const WRITE = 'write';

  /**
   * Administer the space itself.
   */
  public const MANAGE = 'manage';

  /**
   * The levels, least privileged first — the order `access` filters against.
   */
  private const RANKS = [self::READ, self::WRITE, self::MANAGE];

  public function __construct(
    private readonly AccessPolicyProcessorInterface $processor,
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly SpaceModerationPolicy $moderationPolicy,
  ) {}

  /**
   * The spaces the account may operate on, most privileged level per space.
   *
   * @param \Drupal\Core\Session\AccountInterface $account
   *   The account to answer for.
   * @param array $filters
   *   Optional. `q` narrows to spaces whose name or description contains the
   *   string, case-insensitively; `access` drops everything below that level.
   * @param \Drupal\Core\Cache\RefinableCacheableDependencyInterface|null $cacheability
   *   Collects what the answer varies by, when the caller has somewhere to put
   *   it.
   *
   * @return array<int, array{slug: string, name: string, description: string, access: string, moderated: bool}>
   *   One entry per space, ordered by name.
   */
  public function list(AccountInterface $account, array $filters = [], ?RefinableCacheableDependencyInterface $cacheability = NULL): array {
    $calculated = $this->processor->processAccessPolicies($account, SpaceAccessPolicy::SCOPE);
    if ($cacheability) {
      $cacheability->addCacheableDependency($calculated);
      // The policy declares `user` as a persistent cache context, which the
      // processor strips from its result on the way out — it is how the
      // permissions are stored, not something it wants bubbling. This answer
      // does vary by account, so it has to say so itself.
      $cacheability->addCacheContexts(['user']);
    }

    $minimum = $this->rank($filters['access'] ?? self::READ);
    $needle = trim((string) ($filters['q'] ?? ''));

    $spaces = [];
    $storage = SpaceStorage::get($this->entityTypeManager);
    foreach ($storage->all() as $id => $space) {
      $item = $calculated->getItem(SpaceAccessPolicy::SCOPE, (int) $id);
      if (!$item) {
        continue;
      }

      $level = match (TRUE) {
        $item->isAdmin(), $item->hasPermission(SpaceAccessPolicy::MANAGE) => self::MANAGE,
        $item->hasPermission(SpaceAccessPolicy::UPDATE) => self::WRITE,
        $item->hasPermission(SpaceAccessPolicy::VIEW) => self::READ,
        default => NULL,
      };
      if ($level === NULL || $this->rank($level) < $minimum) {
        continue;
      }

      $name = (string) $space->label();
      // `description` is a configurable field the recipe ships, not a base one.
      $description = $space->hasField('description')
        ? trim(strip_tags((string) ($space->get('description')->value ?? '')))
        : '';
      if ($needle !== '' && !$this->matches($needle, $name, $description)) {
        continue;
      }

      $spaces[] = [
        'slug' => $space->getSlug(),
        'name' => $name,
        'description' => $description,
        'access' => $level,
        'moderated' => $this->moderationPolicy->isModerated($space),
      ];
    }

    usort($spaces, static fn (array $a, array $b): int => strcasecmp($a['name'], $b['name']));
    return $spaces;
  }

  /**
   * Where a level sits on the scale. An unknown level reads as the lowest.
   */
  private function rank(string $level): int {
    $rank = array_search($level, self::RANKS, TRUE);
    return $rank === FALSE ? 0 : $rank;
  }

  /**
   * Whether a space's name or description contains the needle.
   */
  private function matches(string $needle, string $name, string $description): bool {
    return mb_stripos($name, $needle) !== FALSE || mb_stripos($description, $needle) !== FALSE;
  }

}
