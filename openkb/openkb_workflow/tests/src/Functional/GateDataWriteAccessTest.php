<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_workflow\Functional;

use Drupal\Tests\openkb_agent\Functional\ReviewTestBase;
use Drupal\openkb_workflow\PageBlocks;

/**
 * No client can write the review sidecar, on any path.
 *
 * This is the property the whole gate rests on. Drupal cannot tell a request
 * the frontend server forwarded from the same request sent by hand, so the
 * only safe answer is that gate data is never accepted from a payload at all —
 * not the flags, not the approvals, not the contributor records. Everything in
 * `field_block_meta` is then something a server watched being earned.
 *
 * Test-matrix cases 1 (a forged payload lands nothing, and presave stamps the
 * change anyway) and 2 (the field is write-dead: JSON:API refuses it, the node
 * form offers no widget).
 *
 * @group openkb_workflow
 */
final class GateDataWriteAccessTest extends ReviewTestBase {

  /**
   * The body a page is seeded with.
   */
  private const SEED = 'One. {#b-one}';

  /**
   * A sidecar a caller would forge: approved by itself, nothing pending.
   */
  private const FORGED = '{"b-one":{"contributors":[{"uid":1,"via":null,"name":"nobody","lastEdit":1}],"review:peer":{"uid":1,"name":"nobody","at":1,"vid":1}}}';

  /**
   * A commit carrying a forged sidecar writes its content and none of it.
   *
   * Dropped rather than refused: the editor never meant to send it, and a 403
   * over a field the user cannot see would strand a real checkpoint. What must
   * not happen is that any of it lands — and the change still gets flagged.
   */
  public function testForgedSidecarInCommitIsIgnored(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);

    $response = $this->postCommit($page, $editor, [
      'attributes' => [
        'field_kb_body' => ['value' => 'One, rewritten. {#b-one}', 'format' => 'comark'],
        'field_block_meta' => self::FORGED,
      ],
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());

    $block = $this->sidecar($page)['b-one'];
    $this->assertArrayNotHasKey('review:peer', $block, 'A forged sign-off did not land.');
    $this->assertTrue(
      $this->pageBlocks()->isPending($block, PageBlocks::STEP_PEER),
      'The change was flagged regardless of what the payload claimed.',
    );
    $this->assertSame([(int) $editor->id()], array_column($block['contributors'], 'uid'));
  }

  /**
   * A commit that sends nothing but a forged sidecar changes nothing.
   */
  public function testForgedSidecarAloneWritesNothing(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);

    $response = $this->postCommit($page, $editor, [
      'attributes' => ['field_block_meta' => self::FORGED],
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());

    $this->assertSame([], $this->sidecar($page));
  }

  /**
   * Case 2: a JSON:API PATCH on the sidecar is refused, pointing at the field.
   *
   * The commit route drops the field; plain JSON:API is where the denial has
   * to be visible, because that is the surface a caller would reach for to
   * write it deliberately.
   */
  public function testJsonApiPatchOnTheSidecarIsDenied(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);

    $response = $this->patchPage($page, $editor, ['field_block_meta' => self::FORGED]);

    $this->assertSame(403, $response->getStatusCode(), (string) $response->getBody());
    $errors = $this->decode($response)['errors'];
    $this->assertSame('/data/attributes/field_block_meta', $errors[0]['source']['pointer']);
    $this->assertSame([], $this->sidecar($page));
  }

  /**
   * An agent's token is no better placed to write it than a session is.
   */
  public function testAgentTokenCannotWriteTheSidecar(): void {
    $owner = $this->createEditor();
    $page = $this->createPage($owner->id(), self::SEED);
    $token = $this->agentToken($owner);

    $response = $this->patchAsAgent($page, $token, ['field_block_meta' => self::FORGED]);

    $this->assertSame(403, $response->getStatusCode(), (string) $response->getBody());
    $this->assertSame([], $this->sidecar($page));
  }

  /**
   * Case 2, the other half: the node form offers no widget for it.
   *
   * An editor with the run of the admin UI still cannot type a sign-off into
   * the field, because the form display does not carry it.
   */
  public function testNodeFormOffersNoSidecarWidget(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);

    $this->drupalLogin($editor);
    $this->drupalGet('/node/' . $page->id() . '/edit');
    $this->assertSession()->statusCodeEquals(200);
    $this->assertSession()->fieldNotExists('field_block_meta[0][value]');
  }

  /**
   * Saving the node form still flags what the form changed.
   *
   * The admin UI is a write path like any other: it cannot supply gate data,
   * and it cannot escape producing it.
   */
  public function testNodeFormSaveStampsTheChange(): void {
    $editor = $this->createEditor();
    $page = $this->createPage($editor->id(), self::SEED);

    $this->drupalLogin($editor);
    $this->drupalGet('/node/' . $page->id() . '/edit');
    $this->submitForm([
      'field_kb_body[0][value]' => 'One, rewritten in the form. {#b-one}',
      'moderation_state[0][state]' => 'draft',
    ], 'Save');

    $this->assertSame(
      'One, rewritten in the form. {#b-one}',
      (string) $this->workingCopy($page)->get('field_kb_body')->value,
      (string) $this->getSession()->getPage()->getText(),
    );
    $this->assertTrue($this->pageBlocks()->isPending($this->sidecar($page)['b-one'], PageBlocks::STEP_PEER));
  }

}
