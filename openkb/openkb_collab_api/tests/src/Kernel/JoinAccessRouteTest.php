<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_collab_api\Kernel;

use Drupal\Core\Cache\CacheableResponseInterface;
use Drupal\Core\Logger\RfcLogLevel;
use Drupal\Core\Session\AccountInterface;
use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_collab_api_field_test\Hook\FieldAccessHooks;
use Psr\Log\AbstractLogger;

/**
 * What the join gate is told about a node and the account asking.
 *
 * Admission is the security boundary (ADR 0003), and node update is only half
 * of it: Drupal decides field edit access separately, so a field the joiner
 * may not edit would otherwise still be editable through the shared document.
 * `GET /openkb/node/<nid>/join-access` answers both halves and names the
 * account, so a join costs one request — and a refused join reaches the log
 * naming the account and the fields.
 *
 * @group openkb_collab_api
 */
final class JoinAccessRouteTest extends OpenkbRequestKernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'openkb_schema',
    'openkb_collab_api',
    'openkb_collab_api_field_test',
  ];

  /**
   * The page every case joins a session on.
   */
  private NodeInterface $page;

  /**
   * Everything logged on this module's channel.
   *
   * @var object{records: array<int, array{0: mixed, 1: string, 2: array}>}
   */
  private object $log;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->container->get('router.builder')->rebuild();

    // Attached to the module's own channel, not the factory: the channel is
    // built from `logger.channel_base`, so the factory never sees it.
    $this->log = new class() extends AbstractLogger {

      /**
       * Every record logged, as [level, message, context] triples.
       *
       * @var array<int, array{0: mixed, 1: string, 2: array}>
       */
      public array $records = [];

      /**
       * {@inheritdoc}
       */
      public function log($level, $message, array $context = []): void {
        $this->records[] = [$level, (string) $message, $context];
      }

    };
    $this->container->get('logger.channel.openkb_collab_api')->addLogger($this->log);

    $this->page = Node::create([
      'type' => 'kb_page',
      'title' => 'Admission',
      'field_kb_body' => ['value' => 'Body. {#b-one}', 'format' => 'comark'],
      'status' => TRUE,
    ]);
    $this->page->save();
  }

  /**
   * An editor of the whole page is admitted, by name.
   */
  public function testFullAccessIsGranted(): void {
    $editor = $this->editor();

    $answer = $this->joinAnswer($editor);

    $this->assertTrue($answer['update']);
    $this->assertSame([], $answer['denied_fields']);
    $this->assertSame((int) $editor->id(), $answer['account']['uid']);
    $this->assertSame($editor->getAccountName(), $answer['account']['name']);
    $this->assertSame([], $this->log->records, 'An admitted join is not a refusal.');
  }

  /**
   * An account without node update is refused, and still named.
   *
   * The gate tells "signed in without access" from "not signed in" by the
   * account on the answer, so a refusal has to carry one.
   */
  public function testNodeUpdateDenied(): void {
    $reader = $this->createUser(['access content']);

    $answer = $this->joinAnswer($reader);

    $this->assertFalse($answer['update']);
    $this->assertSame((int) $reader->id(), $answer['account']['uid']);
    $this->assertSame([], $this->log->records, 'A refusal the fields did not cause is not this log.');
  }

  /**
   * One field out of reach refuses the join, and says which field.
   *
   * The account may update the node — that half still answers yes.
   */
  public function testDeniedFieldIsNamed(): void {
    $this->denyField('field_owner');

    $answer = $this->joinAnswer($this->editor());

    $this->assertTrue($answer['update'], 'The account may still update the node.');
    $this->assertSame(['field_owner'], $answer['denied_fields']);
  }

  /**
   * The body and the title are session fields too, contract or no contract.
   */
  public function testBodyAndTitleAreSessionFields(): void {
    $this->denyField('field_kb_body');
    $this->assertSame(['field_kb_body'], $this->joinAnswer($this->editor())['denied_fields']);

    $this->denyField('title');
    $this->assertSame(['title'], $this->joinAnswer($this->editor())['denied_fields']);
  }

  /**
   * A refused join is in the log at warning, naming the account and the field.
   */
  public function testDenialIsLogged(): void {
    $this->denyField('field_owner');
    $editor = $this->editor();

    $this->joinAnswer($editor);

    $this->assertCount(1, $this->log->records, 'The refusal reached the log, once.');
    [$level, , $context] = $this->log->records[0];
    $this->assertSame(RfcLogLevel::WARNING, $level);
    $this->assertSame($editor->getAccountName(), $context['@account']);
    $this->assertSame('field_owner', $context['@fields']);
    $this->assertSame((string) $this->page->id(), (string) $context['@nid']);
  }

  /**
   * An account that may not read the node gets no answer at all.
   */
  public function testUnreadableNodeIsRefused(): void {
    $this->page->setUnpublished()->save();

    $response = $this->request('/openkb/node/' . $this->page->id() . '/join-access');

    $this->assertSame(403, $response->getStatusCode());
  }

  /**
   * A node that does not exist is a 404, not a grant.
   */
  public function testMissingNodeIsNotFound(): void {
    $response = $this->request('/openkb/node/999999/join-access', $this->editor());

    $this->assertSame(404, $response->getStatusCode());
  }

  /**
   * The answer is this account's, so nothing may cache it.
   */
  public function testAnswerIsNotCacheable(): void {
    $response = $this->request('/openkb/node/' . $this->page->id() . '/join-access', $this->editor());

    $this->assertNotInstanceOf(CacheableResponseInterface::class, $response);
    $this->assertStringContainsString('no-cache', (string) $response->headers->get('Cache-Control'));
  }

  /**
   * Denies edit access to one field, for every account.
   */
  private function denyField(string $name): void {
    $this->container->get('state')->set(FieldAccessHooks::DENIED_FIELD, $name);
  }

  /**
   * An account that may update the page.
   */
  private function editor(): AccountInterface {
    return $this->createUser(['access content', 'edit any kb_page content']);
  }

  /**
   * The gate's answer for one account.
   */
  private function joinAnswer(AccountInterface $account): array {
    $response = $this->request('/openkb/node/' . $this->page->id() . '/join-access', $account);
    $this->assertSame(200, $response->getStatusCode());
    return $this->decode($response);
  }

}
