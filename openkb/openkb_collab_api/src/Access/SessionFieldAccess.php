<?php

declare(strict_types=1);

namespace Drupal\openkb_collab_api\Access;

use Drupal\Core\Cache\RefinableCacheableDependencyInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\NodeInterface;
use Drupal\openkb_schema\SchemaBuilder;
use Drupal\openkb_schema\SchemaUnavailableException;

/**
 * Which of a collaborative session's fields an account may edit.
 *
 * Admission is the security boundary (ADR 0003): the Y.Doc is a shared buffer,
 * so whoever joins can influence content a later checkpoint commits under
 * someone else's credentials. Node update access is the join gate's question,
 * and it is not the same question as field access — `FieldItemList::access()`
 * and `hook_entity_field_access()` decide that one separately, per field and
 * per entity. A field the joiner may not edit would otherwise be editable
 * through the session.
 */
final class SessionFieldAccess {

  /**
   * The body the session's document is, outside the frontmatter contract.
   */
  private const BODY_FIELD = 'field_kb_body';

  /**
   * The title the session's `fields` map carries.
   *
   * A base field, so outside the frontmatter contract like the body.
   */
  private const TITLE_FIELD = 'title';

  /**
   * Constructs the session field access checker.
   */
  public function __construct(
    private readonly SchemaBuilder $schemaBuilder,
  ) {}

  /**
   * Every field a collaborative session on this node can edit.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The node the session edits.
   * @param \Drupal\Core\Cache\RefinableCacheableDependencyInterface|null $cacheability
   *   Collects the exposure contract's config dependencies.
   *
   * @return string[]
   *   Field machine names, those the node actually has.
   */
  public function sessionFields(NodeInterface $node, ?RefinableCacheableDependencyInterface $cacheability = NULL): array {
    try {
      $exposed = $this->schemaBuilder->exposedFieldNames($cacheability);
    }
    catch (SchemaUnavailableException) {
      // No contract, no frontmatter: the document is still title and body.
      $exposed = [];
    }
    $names = [self::TITLE_FIELD, self::BODY_FIELD, ...$exposed];
    return array_values(array_filter($names, $node->hasField(...)));
  }

  /**
   * The session fields this account may not edit on this node.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The node the session edits.
   * @param \Drupal\Core\Session\AccountInterface $account
   *   The account joining the session.
   * @param \Drupal\Core\Cache\RefinableCacheableDependencyInterface|null $cacheability
   *   Collects the exposure contract's config dependencies.
   *
   * @return string[]
   *   Field machine names, empty when the account may edit all of them.
   */
  public function deniedFields(NodeInterface $node, AccountInterface $account, ?RefinableCacheableDependencyInterface $cacheability = NULL): array {
    $denied = [];
    foreach ($this->sessionFields($node, $cacheability) as $name) {
      if (!$node->get($name)->access('edit', $account)) {
        $denied[] = $name;
      }
    }
    return $denied;
  }

}
