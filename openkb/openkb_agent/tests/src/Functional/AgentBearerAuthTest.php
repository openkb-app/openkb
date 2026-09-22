<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Functional;

use Drupal\node\Entity\Node;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerCredentials;
use Drupal\Tests\BrowserTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\simple_oauth\Functional\SimpleOauthTestTrait;
use Drupal\user\UserInterface;
use GuzzleHttp\RequestOptions;
use Psr\Http\Message\ResponseInterface;

/**
 * The shipped agent scope ceiling and identity contract, end to end.
 *
 * Uses the recipe's actual scope config: an agent token acts as its owner on
 * JSON:API + custom routes, capped at the content-write ceiling, and the
 * identity endpoint resolves {uid, name, via, scopes}.
 *
 * @group openkb_agent
 */
final class AgentBearerAuthTest extends BrowserTestBase {

  use RecipeConfigTrait;
  use SimpleOauthTestTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'node',
    'field',
    'text',
    'filter',
    'options',
    'taxonomy',
    'jsonapi',
    'serialization',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'openkb_schema',
    'openkb_agent',
    'openkb_workflow',
    'openkb_jsonapi',
    'openkb_space',
    'openkb_space_access',
  ];

  /**
   * {@inheritdoc}
   */
  protected $defaultTheme = 'stark';

  /**
   * The agent's credentials.
   */
  protected PersonalConsumerCredentials $credentials;

  /**
   * The human owner account.
   */
  protected UserInterface $owner;

  /**
   * A page authored by someone other than the owner.
   */
  protected Node $page;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    // The body field + its `comark` format: what a collab commit writes, and
    // what the agent ceiling has to cover.
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->agentConfigNames());
    $this->applyAgentScopeSettings();
    $this->setUpKeys();

    // Mirrors the recipe's config action — JSON:API write routes exist only
    // with read_only off.
    $this->config('jsonapi.settings')->set('read_only', FALSE)->save();

    $author = $this->drupalCreateUser();
    $this->page = Node::create([
      'type' => 'kb_page',
      'title' => 'Original title',
      'uid' => $author->id(),
      'status' => 1,
    ]);
    $this->page->save();

    // An owner with the collab write set, mirroring an OpenKB editor.
    $this->owner = $this->drupalCreateUser([
      'access content',
      'edit any kb_page content',
      'delete any kb_page content',
      // The recipe grants this to `authenticated`: a write that leaves the
      // stored body in place validates the format it carries.
      'use text format comark',
    ], 'fago');
    $this->credentials = $this->container->get('simple_oauth_personal_consumers.manager')
      ->create($this->owner, 'Claude');

    // Pick up the JSON:API routes for the imported node type.
    $this->rebuildAll();
  }

  /**
   * Fetches an access token via the client_credentials grant.
   */
  protected function getToken(): string {
    $response = $this->getHttpClient()->post($this->buildUrl('/oauth/token'), [
      RequestOptions::FORM_PARAMS => [
        'grant_type' => 'client_credentials',
        'client_id' => $this->credentials->clientId,
        'client_secret' => $this->credentials->secret,
      ],
    ]);
    $payload = json_decode((string) $response->getBody(), TRUE);
    $this->assertArrayHasKey('access_token', $payload);
    return $payload['access_token'];
  }

  /**
   * Performs a JSON:API PATCH on the page's title.
   */
  protected function patchPage(array $headers): ResponseInterface {
    return $this->getHttpClient()->patch(
      $this->buildUrl('/jsonapi/node/kb_page/' . $this->page->uuid()),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::HEADERS => $headers + ['Content-Type' => 'application/vnd.api+json'],
        RequestOptions::JSON => [
          'data' => [
            'type' => 'node--kb_page',
            'id' => $this->page->uuid(),
            'attributes' => ['title' => 'Patched by agent'],
          ],
        ],
      ]
    );
  }

  /**
   * Valid token: writes as the owner within the ceiling, identity resolves.
   */
  public function testValidToken(): void {
    $auth = ['Authorization' => 'Bearer ' . $this->getToken()];

    // The identity contract: uid/name = owner, via = the agent label.
    $response = $this->getHttpClient()->get($this->buildUrl('/openkb/agent/identity'), [
      RequestOptions::HTTP_ERRORS => FALSE,
      RequestOptions::HEADERS => $auth,
    ]);
    $this->assertSame(200, $response->getStatusCode());
    $identity = json_decode((string) $response->getBody(), TRUE);
    $this->assertSame((int) $this->owner->id(), $identity['uid']);
    $this->assertSame('fago', $identity['name']);
    $this->assertSame('Claude', $identity['via']);
    // The granted scopes ride along so the collab session-join gate can name
    // the ceiling a token falls short of (OKB-61).
    $this->assertEqualsCanonicalizing(['agent_read', 'agent_write'], $identity['scopes']);

    // Custom route within the ceiling.
    $response = $this->getHttpClient()->get($this->buildUrl('/openkb/schema'), [
      RequestOptions::HTTP_ERRORS => FALSE,
      RequestOptions::HEADERS => $auth,
    ]);
    $this->assertSame(200, $response->getStatusCode());

    // JSON:API write on someone else's page, attributed to the owner.
    $this->assertSame(200, $this->patchPage($auth)->getStatusCode());
    $node_storage = $this->container->get('entity_type.manager')->getStorage('node');
    $node_storage->resetCache();
    /** @var \Drupal\node\NodeInterface $node */
    $node = $node_storage->load($this->page->id());
    $this->assertSame('Patched by agent', $node->getTitle());
    $this->assertSame($this->owner->id(), $node->getRevisionUser()->id());

    // A body write naming the format: the format carries its own permission,
    // so a ceiling holding only `edit any kb_page content` would authorize
    // the PATCH and then fail its validation — hence the `agent:write`
    // umbrella.
    $response = $this->getHttpClient()->patch(
      $this->buildUrl('/jsonapi/node/kb_page/' . $this->page->uuid()),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::HEADERS => $auth + ['Content-Type' => 'application/vnd.api+json'],
        RequestOptions::JSON => [
          'data' => [
            'type' => 'node--kb_page',
            'id' => $this->page->uuid(),
            'attributes' => [
              'field_kb_body' => ['value' => "Written by the agent.\n", 'format' => 'comark'],
            ],
          ],
        ],
      ]
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getBody());

    // The owner may delete, but delete is outside the agent ceiling.
    $response = $this->getHttpClient()->delete(
      $this->buildUrl('/jsonapi/node/kb_page/' . $this->page->uuid()),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::HEADERS => $auth,
      ]
    );
    $this->assertSame(403, $response->getStatusCode());
  }

  /**
   * A regular session resolves identity with via = NULL.
   */
  public function testSessionIdentity(): void {
    $this->drupalLogin($this->owner);
    $this->drupalGet('/openkb/agent/identity');
    $this->assertSession()->statusCodeEquals(200);
    $this->assertSame([
      'uid' => (int) $this->owner->id(),
      'name' => 'fago',
      'via' => NULL,
      'scopes' => [],
    ], json_decode($this->getSession()->getPage()->getContent(), TRUE));

    // Anonymous requests have no acting identity.
    $this->drupalLogout();
    $this->drupalGet('/openkb/agent/identity');
    $this->assertSession()->statusCodeEquals(403);
  }

  /**
   * An owner without the write set yields a write-less agent token.
   */
  public function testPowerlessOwner(): void {
    $reader = $this->drupalCreateUser(['access content']);
    $this->credentials = $this->container->get('simple_oauth_personal_consumers.manager')
      ->create($reader, 'Claude');
    $auth = ['Authorization' => 'Bearer ' . $this->getToken()];
    $this->assertSame(403, $this->patchPage($auth)->getStatusCode());
  }

}
