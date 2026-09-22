<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_workflow\Functional;

use Drupal\Tests\openkb_agent\Functional\ReviewTestBase;
use Drupal\openkb_workflow\PageBlocks;

/**
 * Every write surface credits and flags what it changed, whichever one it is.
 *
 * The property under test is that attribution is not something a write surface
 * opts into. It happens in presave, so the node form, a JSON:API PATCH, the
 * collab checkpoint and an agent's token all produce the same facts, and none
 * of them has to know the review model exists. Each case here therefore knocks
 * on a *different door* and asserts the same facts came out — the carrier is
 * the subject, so each stays a browser test:
 *
 * - the commit endpoint accepts no write authentication but the editing
 *   session's own cookie plus that session's CSRF token;
 * - the JSON:API PATCH is the surface anyone holding update access can write
 *   over without going near the editor at all;
 * - the agent credential is a bearer token issued at `/oauth/token` under the
 *   recipe's scope ceiling, and `via` comes from that credential alone.
 *
 * What presave does once a save is under way needs none of that, and is asked
 * of presave directly: see
 * \Drupal\Tests\openkb_workflow\Kernel\PresaveAttributionTest.
 *
 * Test-matrix case 3 (every path stamps; an agent credential stamps the agent
 * step too).
 *
 * @group openkb_workflow
 */
final class WriteSurfaceAttributionTest extends ReviewTestBase {

  /**
   * The body a page is seeded with — two addressable blocks.
   */
  private const SEED = "One. {#b-one}\n\nTwo. {#b-two}";

  /**
   * A commit-endpoint checkpoint flags the blocks it moved, and only those.
   */
  public function testCommitEndpointStampsChangedBlocks(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);

    $response = $this->writeBody($page, $editor, "One. {#b-one}\n\nTwo, rewritten. {#b-two}");
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());

    $sidecar = $this->sidecar($page);
    $this->assertTrue($this->pageBlocks()->isPending($sidecar['b-two'], PageBlocks::STEP_PEER));
    $this->assertFalse(
      $this->pageBlocks()->isPending($sidecar['b-one'] ?? [], PageBlocks::STEP_PEER),
      'A block the write did not touch owes nothing.',
    );
    $this->assertSame([(int) $editor->id()], $this->pageBlocks()->contributorsSince($sidecar['b-two'], PageBlocks::STEP_PEER));
  }

  /**
   * A plain JSON:API PATCH stamps exactly as the commit endpoint does.
   *
   * The commit route is the editor's carrier, not the boundary the model is
   * enforced at — anyone holding update access can write over `/jsonapi`, so
   * the facts have to be produced a layer below both.
   */
  public function testJsonApiPatchStampsChangedBlocks(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);

    $response = $this->patchPage($page, $editor, [
      'field_kb_body' => ['value' => "One, rewritten. {#b-one}\n\nTwo. {#b-two}", 'format' => 'comark'],
      // As a draft: publishing the unreviewed rewrite is the gate's to refuse
      // (PublishGateTest); the stamping below is this test's subject.
      'moderation_state' => 'draft',
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());

    $sidecar = $this->sidecar($page);
    $this->assertTrue($this->pageBlocks()->isPending($sidecar['b-one'], PageBlocks::STEP_PEER));
    $this->assertFalse($this->pageBlocks()->isPending($sidecar['b-two'] ?? [], PageBlocks::STEP_PEER));
  }

  /**
   * An agent credential stamps the agent step as well, and is credited as one.
   *
   * The write authenticates as the agent's human owner — so the peer step sees
   * that account — while `via` records that a machine typed it. Both facts come
   * from the credential; nothing in the payload names either.
   */
  public function testAgentCredentialStampsBothSteps(): void {
    $owner = $this->createEditor();
    $page = $this->createPage($owner->id(), self::SEED);
    $token = $this->agentToken($owner);

    $response = $this->patchAsAgent($page, $token, [
      'field_kb_body' => ['value' => "One. {#b-one}\n\nTwo, by the agent. {#b-two}", 'format' => 'comark'],
      // Naming the state keeps this an attribution test: an implicit publish
      // of the unreviewed rewrite is the gate's to refuse
      // (PublishGateTest::testJsonApiPatchIsGatedLikeTheCommitRoute).
      'moderation_state' => 'draft',
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());

    $block = $this->sidecar($page)['b-two'];
    $this->assertTrue($this->pageBlocks()->isPending($block, PageBlocks::STEP_AGENT));
    $this->assertTrue($this->pageBlocks()->isPending($block, PageBlocks::STEP_PEER));
    $this->assertSame(
      [['uid' => (int) $owner->id(), 'via' => 'Claude']],
      array_map(
        static fn (array $c): array => ['uid' => (int) $c['uid'], 'via' => $c['via'] ?? NULL],
        $block['contributors'],
      ),
      'The write is credited to the owner acting through the agent, and to nobody else.',
    );
  }

}
