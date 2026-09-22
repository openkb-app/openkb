<?php

declare(strict_types=1);

namespace Drupal\Tests\simple_oauth_personal_consumers\Functional;

use Drupal\node\Entity\Node;
use Drupal\node\Entity\NodeType;
use Drupal\simple_oauth\Entity\Oauth2Scope;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerCredentials;
use Drupal\Tests\BrowserTestBase;
use Drupal\Tests\simple_oauth\Functional\SimpleOauthTestTrait;
use Drupal\user\Entity\Role;
use Drupal\user\UserInterface;
use GuzzleHttp\RequestOptions;
use Psr\Http\Message\ResponseInterface;

/**
 * The permission-intersection matrix for personal-consumer Bearer tokens.
 *
 * Effective permissions are always owner ∩ scope: an owner without a
 * permission yields a powerless token, role changes reflect live, revoked
 * consumers die entirely, and an owner who becomes an administrator loses the
 * token rather than gaining an uncapped one.
 *
 * @group simple_oauth_personal_consumers
 */
final class PersonalConsumerBearerTest extends BrowserTestBase {

  use SimpleOauthTestTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'node',
    'field',
    'text',
    'filter',
    'jsonapi',
    'serialization',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
  ];

  /**
   * {@inheritdoc}
   */
  protected $defaultTheme = 'stark';

  /**
   * A node authored by someone else.
   */
  protected Node $node;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->setUpKeys();
    NodeType::create(['type' => 'page', 'name' => 'Page'])->save();
    $this->config('jsonapi.settings')->set('read_only', FALSE)->save();

    // The scope ceiling: content read + write, one permission per scope.
    foreach ([
      'test_read' => 'access content',
      'test_write' => 'edit any page content',
    ] as $id => $permission) {
      Oauth2Scope::create([
        'id' => $id,
        'name' => str_replace('_', ':', $id),
        'description' => $permission,
        'grant_types' => ['client_credentials' => ['status' => TRUE]],
        'umbrella' => FALSE,
        'granularity_id' => 'permission',
        'granularity_configuration' => ['permission' => $permission],
      ])->save();
    }
    $this->config('simple_oauth_personal_consumers.settings')
      ->set('scopes', ['test_read', 'test_write'])
      ->save();

    $author = $this->drupalCreateUser();
    $this->node = Node::create([
      'type' => 'page',
      'title' => 'Original title',
      'uid' => $author->id(),
      'status' => 1,
    ]);
    $this->node->save();

    $this->rebuildAll();
  }

  /**
   * Provisions a personal consumer for the given owner.
   */
  protected function provision(UserInterface $owner): PersonalConsumerCredentials {
    return $this->container->get('simple_oauth_personal_consumers.manager')
      ->create($owner, 'Claude');
  }

  /**
   * Fetches an access token via the client_credentials grant.
   */
  protected function getToken(PersonalConsumerCredentials $credentials): string {
    $response = $this->tokenRequest($credentials);
    $payload = json_decode((string) $response->getBody(), TRUE);
    $this->assertArrayHasKey('access_token', $payload);
    return $payload['access_token'];
  }

  /**
   * POSTs to /oauth/token with the consumer's credentials.
   */
  protected function tokenRequest(PersonalConsumerCredentials $credentials): ResponseInterface {
    return $this->getHttpClient()->post($this->buildUrl('/oauth/token'), [
      RequestOptions::HTTP_ERRORS => FALSE,
      RequestOptions::FORM_PARAMS => [
        'grant_type' => 'client_credentials',
        'client_id' => $credentials->clientId,
        'client_secret' => $credentials->secret,
      ],
    ]);
  }

  /**
   * Performs a JSON:API PATCH on the node's title.
   */
  protected function patchNode(array $headers, string $title = 'Patched via token'): ResponseInterface {
    return $this->getHttpClient()->patch(
      $this->buildUrl('/jsonapi/node/page/' . $this->node->uuid()),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::HEADERS => $headers + ['Content-Type' => 'application/vnd.api+json'],
        RequestOptions::JSON => [
          'data' => [
            'type' => 'node--page',
            'id' => $this->node->uuid(),
            'attributes' => ['title' => $title],
          ],
        ],
      ]
    );
  }

  /**
   * Owner permissions gate the token, live; writes are attributed to them.
   */
  public function testOwnerIntersection(): void {
    $owner = $this->drupalCreateUser([], 'fago');
    $credentials = $this->provision($owner);
    $auth = ['Authorization' => 'Bearer ' . $this->getToken($credentials)];

    // The scope allows the write, but the owner can't — denied.
    $this->assertSame(403, $this->patchNode($auth)->getStatusCode());

    // Granting the owner a role flips the same consumer to allowed.
    $rid = $this->drupalCreateRole(['access content', 'edit any page content']);
    $owner->addRole($rid);
    $owner->save();
    $auth = ['Authorization' => 'Bearer ' . $this->getToken($credentials)];
    $this->assertSame(200, $this->patchNode($auth)->getStatusCode());

    // The change is attributed to the owner — sub-credential, same identity.
    $node_storage = $this->container->get('entity_type.manager')->getStorage('node');
    $node_storage->resetCache();
    /** @var \Drupal\node\NodeInterface $node */
    $node = $node_storage->load($this->node->id());
    $this->assertSame('Patched via token', $node->getTitle());
    $this->assertSame($owner->id(), $node->getRevisionUser()->id());

    // Outside the scope ceiling the owner's own permissions don't help.
    $delete_rid = $this->drupalCreateRole(['delete any page content']);
    $owner->addRole($delete_rid);
    $owner->save();
    // Saving the user expired its tokens (simple_oauth's user-update
    // handling), so fetch a fresh one.
    $auth = ['Authorization' => 'Bearer ' . $this->getToken($credentials)];
    $response = $this->getHttpClient()->delete(
      $this->buildUrl('/jsonapi/node/page/' . $this->node->uuid()),
      [
        RequestOptions::HTTP_ERRORS => FALSE,
        RequestOptions::HEADERS => $auth,
      ]
    );
    $this->assertSame(403, $response->getStatusCode());
  }

  /**
   * Owners with different roles never share cached calculated permissions.
   *
   * Both tokens carry the same permission-granularity scopes, so the stock
   * 'user.roles' cache context resolves to just "authenticated" for either
   * token user. Without the simple_oauth patch (see patches/) the first
   * owner's permission intersection would be cached and served to the
   * second owner too — the powerless owner's empty set would deny the
   * privileged owner, or vice versa.
   */
  public function testCrossOwnerIsolation(): void {
    $powerless = $this->drupalCreateUser([], 'powerless_owner');
    $rid = $this->drupalCreateRole(['access content', 'edit any page content']);
    $privileged = $this->drupalCreateUser([], 'privileged_owner');
    $privileged->addRole($rid);
    $privileged->save();

    $powerless_auth = ['Authorization' => 'Bearer ' . $this->getToken($this->provision($powerless))];
    $privileged_auth = ['Authorization' => 'Bearer ' . $this->getToken($this->provision($privileged))];

    // The powerless owner primes the cache with an empty intersection ….
    $this->assertSame(403, $this->patchNode($powerless_auth)->getStatusCode());
    // … which must not leak to the privileged owner's token …
    $this->assertSame(200, $this->patchNode($privileged_auth)->getStatusCode());
    // … nor the privileged result back to the powerless one.
    $this->assertSame(403, $this->patchNode($powerless_auth)->getStatusCode());
  }

  /**
   * Promoting an owner to admin kills their live token, not upgrades it.
   *
   * Provisioning refuses an admin owner outright (proven at the service layer
   * in PersonalConsumerManagerTest). Without a second check at access time, a
   * legitimately-provisioned token whose owner is promoted afterwards would
   * keep authenticating — and since the token is capped at owner ∩ scope, an
   * admin owner means no cap at all.
   */
  public function testOwnerPromotedToAdminIsRefused(): void {
    $owner = $this->drupalCreateUser(['access content', 'edit any page content']);
    $credentials = $this->provision($owner);
    $this->assertSame(
      200,
      $this->patchNode(['Authorization' => 'Bearer ' . $this->getToken($credentials)])->getStatusCode(),
      'The token works while its owner is a normal account.',
    );

    // An `is_admin` role, granted after the fact. Note this is the promotion
    // path a user-presave hook cannot see: nothing about the *user* says
    // "admin", only the role they hold.
    $admin_role = Role::create([
      'id' => 'late_admin',
      'label' => 'Late admin',
      'is_admin' => TRUE,
    ]);
    $admin_role->save();
    $owner->addRole($admin_role->id());
    $owner->save();

    // Saving the user expired the old token (simple_oauth's user-update
    // handling), so the promoted owner gets a brand-new one — the gate must
    // hold for freshly-issued tokens too, not just stale ones.
    $auth = ['Authorization' => 'Bearer ' . $this->getToken($credentials)];
    $this->assertSame(403, $this->patchNode($auth, 'Patched after promotion')->getStatusCode());

    // The write really did not land.
    $node_storage = $this->container->get('entity_type.manager')->getStorage('node');
    $node_storage->resetCache();
    /** @var \Drupal\node\NodeInterface $node */
    $node = $node_storage->load($this->node->id());
    $this->assertNotSame('Patched after promotion', $node->getTitle());

    // Demoting the owner restores the token — the gate refuses, it does not
    // burn the credential.
    $owner->removeRole($admin_role->id());
    $owner->save();
    $auth = ['Authorization' => 'Bearer ' . $this->getToken($credentials)];
    $this->assertSame(200, $this->patchNode($auth, 'Patched after demotion')->getStatusCode());
  }

  /**
   * Missing and invalid tokens are rejected.
   */
  public function testMissingAndInvalidToken(): void {
    $this->assertContains($this->patchNode([])->getStatusCode(), [401, 403]);
    $this->assertSame(401, $this->patchNode(['Authorization' => 'Bearer garbage'])->getStatusCode());
  }

  /**
   * Revoked consumer: existing tokens die, new tokens cannot be issued.
   */
  public function testRevoked(): void {
    $owner = $this->drupalCreateUser(['access content', 'edit any page content']);
    $credentials = $this->provision($owner);
    $token = $this->getToken($credentials);
    $this->assertSame(200, $this->patchNode(['Authorization' => 'Bearer ' . $token])->getStatusCode());

    $this->container->get('simple_oauth_personal_consumers.manager')
      ->revoke($credentials->consumer);

    $this->assertSame(401, $this->patchNode(['Authorization' => 'Bearer ' . $token])->getStatusCode());
    $this->assertGreaterThanOrEqual(400, $this->tokenRequest($credentials)->getStatusCode());
  }

}
