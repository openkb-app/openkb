<?php

declare(strict_types=1);

namespace Drupal\Tests\simple_oauth_personal_consumers\Functional;

use Drupal\Tests\BrowserTestBase;

/**
 * The self-service "API clients" profile UI: create + revoke, no admin.
 *
 * @group simple_oauth_personal_consumers
 */
final class PersonalConsumersUiTest extends BrowserTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
  ];

  /**
   * {@inheritdoc}
   */
  protected $defaultTheme = 'stark';

  /**
   * A plain user creates and revokes an API client without admin help.
   */
  public function testCreateAndRevoke(): void {
    $user = $this->drupalCreateUser(['manage own personal consumers'], 'fago');
    $this->drupalLogin($user);

    $this->drupalGet("/user/{$user->id()}/api-clients");
    $this->assertSession()->statusCodeEquals(200);
    $this->assertSession()->pageTextContains('No API clients yet.');

    // Create: the secret is displayed exactly once.
    $this->submitForm(['label' => 'Claude'], 'Create API client');
    $this->assertSession()->pageTextContains('API client Claude created.');
    $this->assertSession()->pageTextContains('the secret is shown only once');
    $this->assertSession()->pageTextContains('Client ID:');
    $this->assertSession()->pageTextContains('Client secret:');
    $this->assertSession()->elementTextContains('css', 'table', 'Claude');

    // Reload: gone.
    $this->drupalGet("/user/{$user->id()}/api-clients");
    $this->assertSession()->pageTextNotContains('Client secret:');
    $this->assertSession()->elementTextContains('css', 'table', 'Active');

    // Revoke through the confirm form; the client stays listed as revoked.
    $this->clickLink('Revoke');
    $this->assertSession()->pageTextContains('Revoke the API client Claude?');
    $this->submitForm([], 'Confirm');
    $this->assertSession()->pageTextContains('API client Claude revoked.');
    $this->assertSession()->elementTextContains('css', 'table', 'Claude');
    $this->assertSession()->elementTextContains('css', 'table', 'Revoked');
    $this->assertSession()->linkNotExists('Revoke');

    // The consumer entity survives for attribution.
    $consumers = $this->container->get('simple_oauth_personal_consumers.manager')->getConsumers($user);
    $this->assertCount(1, $consumers);
  }

  /**
   * An admin owner is refused on the create form — no client can be made.
   */
  public function testAdminOwnerRefused(): void {
    $admin = $this->drupalCreateUser(['manage own personal consumers'], 'boss', TRUE);
    $this->drupalLogin($admin);

    $this->drupalGet("/user/{$admin->id()}/api-clients");
    $this->assertSession()->statusCodeEquals(200);
    $this->assertSession()->pageTextContains('Administrator accounts cannot own personal API clients');
    $this->assertSession()->fieldNotExists('label');
    $this->assertSession()->buttonNotExists('Create API client');
  }

  /**
   * The page is strictly self-service: own profile only.
   */
  public function testAccessIsolation(): void {
    $user = $this->drupalCreateUser(['manage own personal consumers']);
    $other = $this->drupalCreateUser(['manage own personal consumers']);

    // Anonymous.
    $this->drupalGet("/user/{$user->id()}/api-clients");
    $this->assertSession()->statusCodeEquals(403);

    // Someone else's page.
    $this->drupalLogin($other);
    $this->drupalGet("/user/{$user->id()}/api-clients");
    $this->assertSession()->statusCodeEquals(403);

    // Without the permission, even the own page is denied.
    $no_permission = $this->drupalCreateUser();
    $this->drupalLogin($no_permission);
    $this->drupalGet("/user/{$no_permission->id()}/api-clients");
    $this->assertSession()->statusCodeEquals(403);
  }

  /**
   * A revoke URL for a foreign or revoked consumer 404s.
   */
  public function testRevokeGuards(): void {
    $user = $this->drupalCreateUser(['manage own personal consumers']);
    $other = $this->drupalCreateUser(['manage own personal consumers']);
    $manager = $this->container->get('simple_oauth_personal_consumers.manager');
    $foreign = $manager->create($other, 'Claude');

    $this->drupalLogin($user);
    $this->drupalGet("/user/{$user->id()}/api-clients/{$foreign->consumer->id()}/revoke");
    $this->assertSession()->statusCodeEquals(404);

    // Already-revoked consumers can't be revoked again.
    $own = $manager->create($user, 'Cursor');
    $manager->revoke($own->consumer);
    $this->drupalGet("/user/{$user->id()}/api-clients/{$own->consumer->id()}/revoke");
    $this->assertSession()->statusCodeEquals(404);
  }

}
