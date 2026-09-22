<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow;

use Drupal\Core\Entity\EntityInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\openkb_space\SpaceInterface;
use Drupal\openkb_space_access\SpaceAccess;
use Drupal\openkb_space_access\SpaceModerationPolicy;

/**
 * Which review steps a page's space actually enforces.
 *
 * Both flags are recorded on every page, whatever its space says — turning
 * a knob on later finds the history already there. What the space decides is
 * which of them hold a publication up:
 *
 * - `field_moderation` ON → the peer step, and with it the four-eyes rule.
 *   A wiki-style space asks for neither: anyone on its roster publishes.
 * - `field_agent_review` ON (the default) → the agent step. This one holds in
 *   a wiki space too: that is the space where nothing else would hold
 *   unreviewed agent text back.
 *
 * Fail-closed: a page whose space cannot be read enforces both steps.
 * A policy that cannot be established is not a policy of permitting anything.
 */
final class ReviewPolicy {

  /**
   * The per-space flag turning the agent step on; absent reads as on.
   */
  private const AGENT_REVIEW_FIELD = 'field_agent_review';

  public function __construct(
    private readonly SpaceModerationPolicy $moderation,
    private readonly SpaceAccess $spaceAccess,
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * The steps that hold up a publication of this page.
   *
   * @param \Drupal\Core\Entity\EntityInterface $entity
   *   The page.
   *
   * @return string[]
   *   The enforced steps, in blocker-list order.
   */
  public function enforcedSteps(EntityInterface $entity): array {
    $steps = [];
    if ($this->moderation->applies($entity)) {
      $steps[] = PageBlocks::STEP_PEER;
    }
    if ($this->agentReviewApplies($entity)) {
      $steps[] = PageBlocks::STEP_AGENT;
    }
    return $steps;
  }

  /**
   * Whether an account may self-approve this page's blocks (ADR 0002).
   *
   * The four-eyes rule keeps a change's own writers from signing it off — with
   * one exception: an admin may approve their own block (and one no server
   * could attribute), the review still being recorded either way. A global
   * admin moderates anywhere. The space-admin half of the exception awaits a
   * space-admin role: the space model today grants editors publish access but
   * has no rank above them, and reading it as "editor" would hand every editor
   * a way past the rule the step exists to enforce.
   *
   * @param \Drupal\Core\Entity\EntityInterface $entity
   *   The page.
   * @param \Drupal\Core\Session\AccountInterface $account
   *   The account approving.
   *
   * @return bool
   *   TRUE when the account may sign off its own writing here.
   */
  public function mayModerate(EntityInterface $entity, AccountInterface $account): bool {
    return $account->hasPermission('administer nodes');
  }

  /**
   * Whether the agent step is enforced for this page.
   *
   * @param \Drupal\Core\Entity\EntityInterface $entity
   *   The page.
   *
   * @return bool
   *   TRUE when agent-written blocks need a human sign-off before publishing.
   */
  private function agentReviewApplies(EntityInterface $entity): bool {
    $space = $this->space($entity);
    if ($space === NULL || !$space->hasField(self::AGENT_REVIEW_FIELD)) {
      return TRUE;
    }
    $value = $space->get(self::AGENT_REVIEW_FIELD)->value;
    return $value === NULL ? TRUE : (bool) $value;
  }

  /**
   * The space a page belongs to, or NULL when it has none.
   *
   * @param \Drupal\Core\Entity\EntityInterface $entity
   *   The page.
   *
   * @return \Drupal\openkb_space\SpaceInterface|null
   *   The space.
   */
  private function space(EntityInterface $entity): ?SpaceInterface {
    $id = $this->spaceAccess->spaceIdOf($entity);
    $space = $id === NULL ? NULL : $this->entityTypeManager->getStorage('openkb_space')->load($id);
    return $space instanceof SpaceInterface ? $space : NULL;
  }

}
