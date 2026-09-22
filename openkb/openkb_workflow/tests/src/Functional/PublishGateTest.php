<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_workflow\Functional;

use Drupal\Tests\openkb_agent\Functional\ReviewTestBase;
use Drupal\openkb_workflow\PageBlocks;

/**
 * Nothing goes live while a block is still waiting for review.
 *
 * Test-matrix case 7. The gate sits on the one decision every published
 * revision passes through — the state a commit lands in — so it holds for the
 * editor's explicit Publish and equally for an ordinary save in a wiki-style
 * space, where content goes live without anybody pressing anything.
 *
 * @group openkb_workflow
 */
final class PublishGateTest extends ReviewTestBase {

  /**
   * The body a page is seeded with — two addressable blocks.
   */
  private const SEED = "One. {#b-one}\n\nTwo. {#b-two}";

  /**
   * A publish is refused, and the refusal names the blocks and what they owe.
   */
  public function testPublishIsRefusedAndNamesTheBlockers(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);
    $published_vid = (int) $page->getRevisionId();
    $this->writeBody($page, $editor, "One, rewritten. {#b-one}\n\nTwo. {#b-two}");

    $response = $this->writeBody($page, $editor, "One, rewritten. {#b-one}\n\nTwo. {#b-two}", 'published');

    $this->assertSame(422, $response->getStatusCode(), (string) $response->getBody());
    $errors = $this->decode($response)['errors'];
    $this->assertCount(1, $errors);
    $this->assertSame('b-one', $errors[0]['meta']['item']);
    $this->assertSame([PageBlocks::STEP_PEER], $errors[0]['meta']['steps']);
    $this->assertStringEndsWith('/b-one', $errors[0]['source']['pointer']);

    // Nothing went live: the default revision is the one it always was.
    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertSame($published_vid, (int) $default->getRevisionId());
    $this->assertSame(self::SEED, (string) $default->get('field_kb_body')->value);
  }

  /**
   * Taking a block out is held, and published once it is signed off.
   *
   * The block is gone from the body, so the whole of the review hangs on the
   * record it leaves behind: the gate names that record, and a sign-off on it
   * clears the publish operation like any block's (ADR 0017).
   */
  public function testRemovingBlockIsHeldUntilSignedOff(): void {
    $editor = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);
    $shorter = 'One. {#b-one}';
    $this->writeBody($page, $editor, $shorter);

    $refused = $this->writeBody($page, $editor, $shorter, 'published');
    $this->assertSame(422, $refused->getStatusCode(), (string) $refused->getBody());
    $this->assertSame('b-two', $this->decode($refused)['errors'][0]['meta']['item']);

    $this->signOff($page, 'b-two', $reviewer);

    $published = $this->writeBody($page, $editor, $shorter, 'published');
    $this->assertSame(200, $published->getStatusCode(), (string) $published->getBody());
    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertSame($shorter, (string) $default->get('field_kb_body')->value);
  }

  /**
   * Renaming the page is held, and cleared like any other change.
   *
   * The title is a node field with no block of its own, so it takes a review
   * entry of its own and the refusal points at the field (ADR 0017).
   */
  public function testRenamingThePageIsHeldUntilSignedOff(): void {
    $editor = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);
    $renamed = ['attributes' => ['title' => 'A different name for the same text']];
    $this->postCommit($page, $editor, $renamed);

    $refused = $this->postCommit($page, $editor, [
      'attributes' => $renamed['attributes'] + ['moderation_state' => 'published'],
    ]);
    $this->assertSame(422, $refused->getStatusCode(), (string) $refused->getBody());
    $error = $this->decode($refused)['errors'][0];
    $this->assertSame(PageBlocks::FIELD_TITLE, $error['meta']['item']);
    $this->assertSame('/data/attributes/title', $error['source']['pointer']);

    $this->signOff($page, PageBlocks::FIELD_TITLE, $reviewer);

    $published = $this->postCommit($page, $editor, [
      'attributes' => $renamed['attributes'] + ['moderation_state' => 'published'],
    ]);
    $this->assertSame(200, $published->getStatusCode(), (string) $published->getBody());
    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertSame('A different name for the same text', $default->label());
  }

  /**
   * Reordering blocks is held, though every block's bytes are unchanged.
   *
   * Swapping two blocks yields one item: order is the longest common
   * subsequence of the two id sequences, and one of the pair holds its place
   * in it (ADR 0017).
   */
  public function testMovingBlockIsHeldUntilSignedOff(): void {
    $editor = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);
    $swapped = "Two. {#b-two}\n\nOne. {#b-one}";
    $this->writeBody($page, $editor, $swapped);

    $refused = $this->writeBody($page, $editor, $swapped, 'published');
    $this->assertSame(422, $refused->getStatusCode(), (string) $refused->getBody());
    $moved = array_column(array_column($this->decode($refused)['errors'], 'meta'), 'item');
    $this->assertSame(['b-two'], $moved);

    foreach ($moved as $item) {
      $this->signOff($page, $item, $reviewer);
    }

    $published = $this->writeBody($page, $editor, $swapped, 'published');
    $this->assertSame(200, $published->getStatusCode(), (string) $published->getBody());
    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertSame($swapped, (string) $default->get('field_kb_body')->value);
  }

  /**
   * The same write publishes once the blocks have been signed off.
   */
  public function testPublishSucceedsAfterApproval(): void {
    $editor = $this->createEditor();
    $reviewer = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);
    $body = "One, rewritten. {#b-one}\n\nTwo. {#b-two}";
    $this->writeBody($page, $editor, $body);

    $this->signOff($page, 'b-one', $reviewer);

    $response = $this->writeBody($page, $editor, $body, 'published');

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertTrue($default->isPublished());
    $this->assertSame($body, (string) $default->get('field_kb_body')->value);
  }

  /**
   * A change made in the same request as the publish is judged too.
   *
   * The gate reads the page this write is about to produce. Judging the one
   * it replaces would let a single request rewrite a block and publish it
   * before anything had flagged it.
   */
  public function testPublishInTheSameWriteAsTheChangeIsRefused(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);

    $response = $this->writeBody(
      $page,
      $editor,
      "One, rewritten and published in one go. {#b-one}\n\nTwo. {#b-two}",
      'published',
    );

    $this->assertSame(422, $response->getStatusCode(), (string) $response->getBody());
    $this->assertSame('b-one', $this->decode($response)['errors'][0]['meta']['item']);
  }

  /**
   * In a wiki space a save over a pending agent block lands as a draft.
   *
   * This is the case the gate exists for. There is no Publish button in a
   * wiki-style space: the save itself is the publication. But text an agent
   * wrote that no human has signed off must not reach the live page on the
   * strength of an ordinary save, so the write is diverted to a forward draft
   * (ADR 0003/0004) — the save is kept and the live page held — rather than
   * refused outright, which would risk losing the human's own edit in the same
   * request. The response carries the state the write landed in, so the chrome
   * can say the page is waiting on the sign-off.
   */
  public function testWikiSpaceSaveOverPendingAgentDrafts(): void {
    $owner = $this->createEditor();
    $wiki = $this->createSpace(FALSE, $owner);
    $page = $this->createPage($owner->id(), self::SEED, $wiki);
    $token = $this->agentToken($owner);

    // The agent writes a forward draft — a raw PATCH that kept the page
    // published would be refused by the gate (its step is pending).
    $response = $this->patchAsAgent($page, $token, [
      'field_kb_body' => ['value' => "One, by the agent. {#b-one}\n\nTwo. {#b-two}", 'format' => 'comark'],
      'moderation_state' => 'draft',
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-one'], PageBlocks::STEP_AGENT));

    // Baseline the live revision after the agent's write, so what the human
    // save does — and only the human save — is what the assertions below read.
    $live_vid = (int) $this->nodeStorage()->load($page->id())->getRevisionId();

    // The human's next save would publish the agent's text, wiki-style — so it
    // is held as a draft instead, not refused.
    $response = $this->writeBody($page, $owner, "One, by the agent. {#b-one}\n\nTwo, by the human. {#b-two}");

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
    $this->assertSame('draft', $this->decode($response)['data']['attributes']['moderation_state']);

    // The human save landed as a forward draft: the live revision did not move,
    // and the reader's page still lacks the edit it carried.
    /** @var \Drupal\node\NodeInterface $default */
    $default = $this->nodeStorage()->load($page->id());
    $this->assertTrue($default->isPublished());
    $this->assertSame($live_vid, (int) $default->getRevisionId());
    $this->assertStringNotContainsString('Two, by the human.', (string) $default->get('field_kb_body')->value);
  }

  /**
   * The gate holds below the commit route: a JSON:API PATCH cannot publish.
   *
   * The commit endpoint is the editor's carrier, not the boundary the model is
   * enforced at. Anyone holding update access can PATCH the body over JSON:API
   * and, naming no moderation state, would land a new published default
   * revision with the change live and unreviewed. The OkbPendingReview
   * constraint refuses that write with a 422, whichever credential carried it
   * (ADR 0004: one gate, every surface) — the wire client holds the payload,
   * so a refusal loses nothing; the commit routes stay the divert-to-draft
   * path.
   */
  public function testJsonApiPatchIsGatedLikeTheCommitRoute(): void {
    foreach (['human', 'agent'] as $carrier) {
      $editor = $this->createEditor();
      $page = $this->createPage($editor->id(), self::SEED);
      $published_vid = (int) $page->getRevisionId();
      $attributes = [
        'field_kb_body' => [
          'value' => "One, rewritten by the $carrier and never reviewed. {#b-one}\n\nTwo. {#b-two}",
          'format' => 'comark',
        ],
      ];

      $response = $carrier === 'agent'
        ? $this->patchAsAgent($page, $this->agentToken($editor), $attributes)
        : $this->patchPage($page, $editor, $attributes);
      $this->assertSame(422, $response->getStatusCode(), "$carrier: " . $response->getBody());
      $this->assertStringContainsString('await review', (string) $response->getBody(), "$carrier: violation names the gate");

      // Nothing was saved: the default revision is the one it was, and no
      // forward draft carries the refused rewrite.
      /** @var \Drupal\node\NodeInterface $default */
      $default = $this->nodeStorage()->load($page->id());
      $this->assertSame($published_vid, (int) $default->getRevisionId(), "$carrier: default revision moved");
      $this->assertSame(self::SEED, (string) $default->get('field_kb_body')->value, "$carrier: live body changed");
      $this->assertSame(
        $published_vid,
        (int) $this->workingCopy($page)->getRevisionId(),
        "$carrier: the refused write left a revision behind",
      );
    }
  }

  /**
   * A wiki space that turns agent review off publishes the agent's text.
   *
   * The knob is the space's to set; what it must not do is silently default to
   * off.
   */
  public function testWikiSpaceWithoutAgentReviewPublishesOnSave(): void {
    $owner = $this->createEditor();
    $wiki = $this->createSpace(FALSE, $owner);
    $wiki->set('field_agent_review', FALSE)->save();
    $page = $this->createPage($owner->id(), self::SEED, $wiki);
    $token = $this->agentToken($owner);

    $this->patchAsAgent($page, $token, [
      'field_kb_body' => ['value' => "One, by the agent. {#b-one}\n\nTwo. {#b-two}", 'format' => 'comark'],
    ]);
    $response = $this->writeBody($page, $owner, "One, by the agent. {#b-one}\n\nTwo, by the human. {#b-two}");

    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
    $this->assertTrue($this->nodeStorage()->load($page->id())->isPublished());
    $this->assertTrue(
      $this->pageBlocks()->isPending($this->sidecar($page)['b-one'], PageBlocks::STEP_AGENT),
      'The flag is still recorded — turning the knob back on finds the history there.',
    );
  }

  /**
   * A checkpoint in a moderated space is not a publication, so it is not gated.
   *
   * Drafting is how work gets to a reviewer in the first place; a gate that
   * stopped it would stop the review it is asking for.
   */
  public function testDraftingIsNeverGated(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);

    foreach (['One, once. {#b-one}', 'One, twice. {#b-one}', 'One, three times. {#b-one}'] as $body) {
      $response = $this->writeBody($page, $editor, $body . "\n\nTwo. {#b-two}");
      $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());
    }
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-one'], PageBlocks::STEP_PEER));
  }

  /**
   * A brand-new page cannot be published on the strength of its own author.
   *
   * Everything in it is a change nobody else has read.
   */
  public function testNewPageCannotPublishItself(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), 'Seed. {#b-seed}');
    // Undo the base class's settled history: this page is brand new.
    $this->writeBody($page, $editor, "A brand new first block. {#b-new}");

    $response = $this->writeBody($page, $editor, 'A brand new first block. {#b-new}', 'published');

    $this->assertSame(422, $response->getStatusCode(), (string) $response->getBody());
    $this->assertSame('b-new', $this->decode($response)['errors'][0]['meta']['item']);
  }

}
