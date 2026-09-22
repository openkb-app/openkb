<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_space\Kernel;

use Drupal\Component\Serialization\Json;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\openkb_agent\Traits\RequestCarrierTrait;
use Drupal\Tests\openkb_space\Traits\OutlineRequestTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\openkb_space\SpaceInterface;

/**
 * Restructuring a space, over `PUT /openkb/space/{openkb_space}/outline`.
 *
 * What the space itself decides is asserted here: `restructure` is its
 * managers', and a write naming a tree the field no longer holds is refused
 * whole. `openkb_space_access` is not enabled, so nothing can widen the rule —
 * what it widens is its own suite's
 * (\Drupal\Tests\openkb_space_access\Kernel\OutlineRestructureTest).
 *
 * @group openkb_space
 */
final class OutlineWriteTest extends KernelTestBase {

  use OutlineRequestTrait;
  use RecipeConfigTrait;
  use RequestCarrierTrait;
  use UserCreationTrait;

  /**
   * The space under test.
   */
  private SpaceInterface $space;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'filter',
    'text',
    'node',
    'options',
    'taxonomy',
    'path',
    'path_alias',
    'serialization',
    // The route answers in JSON:API's error taxonomy, so its request format
    // has to be registered — which jsonapi does, and it autowires a file
    // upload handler on the way.
    'file',
    'jsonapi',
    'openkb_space',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('taxonomy_term');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('file');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['system', 'field', 'filter', 'node', 'user']);
    // User 1 is a superuser and would answer every access question with yes.
    $this->createUser();

    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->container->get('router.builder')->rebuild();

    $this->createRosterAccounts();
    $this->space = $this->createSpace('Handbook');
  }

  /**
   * A space holds restructuring to its managers.
   */
  public function testSpaceIsRestructuredByManagersOnly(): void {
    $page = $this->createPage($this->space, 'Onboarding');
    $expected = [
      'viewer' => 403,
      'member' => 403,
      'manager' => 200,
      'admin' => 200,
    ];
    foreach ($expected as $rank => $status) {
      $response = $this->put($this->space, $this->accounts[$rank], [
        'outline' => [['id' => $page]],
        'expect' => $this->storedTree($this->space),
      ]);
      $this->assertSame($status, $response->getStatusCode(), $rank . ': ' . $response->getContent());
    }
  }

  /**
   * A write naming a tree the field no longer holds is refused whole.
   */
  public function testStaleWriteIsRefused(): void {
    $first = $this->createPage($this->space, 'First');
    $second = $this->createPage($this->space, 'Second');

    // One editor lands a tree.
    $landed = $this->put($this->space, $this->accounts['manager'], [
      'outline' => [['id' => $first], ['id' => $second]],
      'expect' => [],
    ]);
    $this->assertSame(200, $landed->getStatusCode(), (string) $landed->getContent());

    // The other was still looking at the empty tree.
    $refused = $this->put($this->space, $this->accounts['admin'], [
      'outline' => [['id' => $second], ['id' => $first]],
      'expect' => [],
    ]);
    $this->assertSame(409, $refused->getStatusCode(), (string) $refused->getContent());
    $this->assertSame(
      [['id' => $first], ['id' => $second]],
      $this->storedTree($this->space),
      'the losing write left the tree exactly as the winner stored it',
    );
  }

  /**
   * An `expect` that differs only in how it spells "no children" still matches.
   *
   * A stored tree, a tree a client read and a tree a raw PATCH wrote all spell
   * an empty child list differently. Comparing them literally would refuse a
   * write that named exactly the right tree.
   */
  public function testExpectMatchesWhateverSpelledTheStoredTree(): void {
    $page = $this->createPage($this->space, 'Only page');

    // Stored without `children`, expected with it.
    $this->space->set('outline', Json::encode([['id' => $page]]))->save();
    $verbose = $this->put($this->space, $this->accounts['manager'], [
      'outline' => [['id' => $page, 'children' => []]],
      'expect' => [['id' => $page, 'children' => []]],
    ]);
    $this->assertSame(200, $verbose->getStatusCode(), (string) $verbose->getContent());
    $this->assertSame(
      [['id' => $page, 'children' => []]],
      $this->decode($verbose)['outline'],
      'the answer is the tree as stored, in one canonical spelling',
    );

    // Stored with `children`, expected without it.
    $this->space = $this->reloadSpace($this->space);
    $this->space->set('outline', Json::encode([['id' => $page, 'children' => []]]))->save();
    $terse = $this->put($this->space, $this->accounts['manager'], [
      'outline' => [['id' => $page]],
      'expect' => [['id' => $page]],
    ]);
    $this->assertSame(200, $terse->getStatusCode(), (string) $terse->getContent());
  }

  /**
   * The field holds one spelling of a tree, whatever the caller sent.
   *
   * Storage is read by more than this endpoint — the e2e suite and any client
   * reading `outline` see the raw string — so an empty child list is
   * left out rather than written as `[]` by whoever happened to send it.
   */
  public function testStoredTreeKeepsTheMinimalSpelling(): void {
    $parent = $this->createPage($this->space, 'Parent');
    $child = $this->createPage($this->space, 'Child');

    $response = $this->put($this->space, $this->accounts['manager'], [
      'outline' => [
        ['id' => $parent, 'children' => [['id' => $child, 'children' => []]]],
      ],
      'expect' => [],
    ]);
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());

    $this->assertSame(
      Json::encode([['id' => $parent, 'children' => [['id' => $child]]]]),
      $this->reloadSpace($this->space)->get('outline')->value,
    );
  }

  /**
   * A body that names no tree to replace is a bad request, and writes nothing.
   */
  public function testMissingExpectIsRejected(): void {
    $page = $this->createPage($this->space, 'Page');

    $response = $this->put($this->space, $this->accounts['manager'], [
      'outline' => [['id' => $page]],
    ]);
    $this->assertSame(400, $response->getStatusCode(), (string) $response->getContent());
    $this->assertSame([], $this->storedTree($this->space));
  }

  /**
   * The endpoint is the space restructuring surface and nothing else.
   */
  public function testAnUnknownSpaceIsRejected(): void {
    $response = $this->request(
      '/openkb/space/99999/outline',
      $this->accounts['admin'],
      'PUT',
      ['outline' => [], 'expect' => []],
      ['X-CSRF-Token' => $this->container->get('csrf_token')->get('rest')],
    );
    $this->assertSame(404, $response->getStatusCode(), (string) $response->getContent());
  }

}
