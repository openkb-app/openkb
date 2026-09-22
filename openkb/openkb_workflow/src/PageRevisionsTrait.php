<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow;

use Drupal\node\NodeInterface;
use Drupal\node\NodeStorageInterface;

/**
 * Which revision of a page a write works on, and how a fact is saved.
 *
 * A moderated page carries a forward draft, so "the node" the router hands
 * a controller is the *default* revision while every editing surface works on
 * the *latest* one. Reading or writing the wrong one is silent. The save half:
 * attribution, approvals and space placement are facts *about* a revision —
 * they must not fork history or move the default. Three flags in a fixed
 * order; every consumer resolves both the same way, from here.
 *
 * Consumers provide {@see self::revisionStorage()}.
 */
trait PageRevisionsTrait {

  /**
   * The node storage the revision reads go through.
   */
  abstract protected function revisionStorage(): NodeStorageInterface;

  /**
   * The latest revision — what every editing surface works on.
   */
  public function workingCopy(NodeInterface $node): NodeInterface {
    $vid = $this->latestRevisionId($node);
    if ($vid === NULL || $vid === (int) $node->getRevisionId()) {
      return $node;
    }
    /** @var \Drupal\node\NodeInterface $latest */
    $latest = $this->revisionStorage()->loadRevision($vid);
    return $latest;
  }

  /**
   * The working copy, read past anything this request already loaded.
   *
   * The read half of {@see \Drupal\openkb_workflow\BlockMetaLock}: a sidecar
   * writer
   * holding the lock still clobbers its predecessor if it mutates a value it
   * took before that predecessor committed. The router loads the page before
   * any lock is taken, and a controller that checkpointed already holds its own
   * write in the storage's cache — both are values from before the hold.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page as the route resolved it.
   *
   * @return \Drupal\node\NodeInterface
   *   The latest revision as storage holds it right now.
   */
  public function freshWorkingCopy(NodeInterface $node): NodeInterface {
    $storage = $this->revisionStorage();
    $storage->resetCache();
    /** @var \Drupal\node\NodeInterface|null $reloaded */
    $reloaded = $storage->load($node->id());
    return $this->workingCopy($reloaded ?? $node);
  }

  /**
   * The revision id of the page's newest revision, default or not.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The page.
   *
   * @return int|null
   *   The revision id, or NULL for an unsaved node.
   */
  public function latestRevisionId(NodeInterface $node): ?int {
    if ($node->isNew()) {
      return NULL;
    }
    $vid = $this->revisionStorage()->getLatestRevisionId((int) $node->id());
    return $vid === NULL ? NULL : (int) $vid;
  }

  /**
   * The revision a write is being made on top of, loaded UNCHANGED.
   *
   * "Unchanged" is the whole point: the caller is usually holding that very
   * revision with its new values already applied, and the storage's static
   * revision cache would hand back that same object — so a diff would compare
   * the write against itself and find nothing changed.
   *
   * @param \Drupal\node\NodeInterface $node
   *   The revision being written.
   *
   * @return \Drupal\node\NodeInterface|null
   *   The base revision, or NULL when there is none to compare against.
   */
  public function baseRevision(NodeInterface $node): ?NodeInterface {
    $vid = $this->latestRevisionId($node);
    if ($vid === NULL) {
      return NULL;
    }
    /** @var \Drupal\node\NodeInterface|null $base */
    $base = $this->revisionStorage()->loadRevisionUnchanged($vid);
    return $base;
  }

  /**
   * Saves a fact onto the revision it is about, without versioning it.
   *
   * @param \Drupal\node\NodeInterface $revision
   *   The revision to save, with the fact already set on it.
   */
  public function saveStateOnly(NodeInterface $revision): void {
    // Not an editorial update: it says something about the revision it is
    // written on, so it neither forks the history nor moves which revision is
    // default nor re-runs the machinery an authored change would.
    $revision->setSyncing(TRUE);
    $revision->setNewRevision(FALSE);
    $revision->save();
  }

}
