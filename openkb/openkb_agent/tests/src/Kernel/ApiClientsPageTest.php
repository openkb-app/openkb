<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Kernel;

use Drupal\Component\Utility\Crypt;
use Drupal\Core\Form\EnforcedResponseException;
use Drupal\Core\Form\FormState;
use Drupal\Core\Menu\MenuLinkInterface;
use Drupal\Core\Messenger\MessengerInterface;
use Drupal\Core\Routing\RouteMatch;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\custom_elements\CustomElement;
use Drupal\openkb_agent\Controller\ApiClientsCeController;
use Drupal\simple_oauth_personal_consumers\Form\PersonalConsumerCreateForm;
use Drupal\user\UserInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Session\Session;
use Symfony\Component\HttpFoundation\Session\Storage\MockArraySessionStorage;

/**
 * The API-clients page in the frontend (OKB-162).
 *
 * Three claims. The frontend reaches the page over a *second* route, so the
 * Drupal one goes on answering exactly as it did — the profile tab is still
 * there for an administrator and for anyone not using the app. What the second
 * route answers is the same listing stated as data, so the frontend renders it
 * without parsing Drupal's markup. And the account menu's way in resolves to
 * whoever is asking, because the page's route names a user and a menu link
 * definition cannot.
 *
 * The rendering in between — the custom element, the frontend's markup, the
 * revoke round-trip — is walked over the real wire by the `api-clients` e2e
 * spec.
 */
final class ApiClientsPageTest extends KernelTestBase {

  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'file',
    'image',
    // consumer's grant_types is a list_string.
    'options',
    'serialization',
    'consumers',
    'simple_oauth',
    'simple_oauth_personal_consumers',
    'custom_elements',
    'lupus_decoupled_form',
    'openkb_agent',
  ];

  /**
   * The account whose page this is.
   */
  private UserInterface $owner;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('file');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installConfig(['system', 'field', 'user']);
    // User 1 is a superuser and may own no personal consumer; take it out of
    // circulation so the owner below is an ordinary account.
    $this->createUser();
    $this->owner = $this->createUser(['manage own personal consumers']);
    $this->setCurrentUser($this->owner);
  }

  /**
   * The Drupal page answers as it did: same path, same controller, HTML.
   */
  public function testStockRouteIsUntouched(): void {
    $route = $this->container->get('router.route_provider')
      ->getRouteByName('simple_oauth_personal_consumers.collection');

    $this->assertSame('/user/{user}/api-clients', $route->getPath());
    $this->assertSame(
      '\Drupal\simple_oauth_personal_consumers\Controller\PersonalConsumersController::page',
      $route->getDefault('_controller'),
    );
    $this->assertNull($route->getRequirement('_format'));
  }

  /**
   * The frontend's way in is a clone: same access, custom elements only.
   */
  public function testCustomElementsVariantClonesTheStockRoute(): void {
    $provider = $this->container->get('router.route_provider');
    $stock = $provider->getRouteByName('simple_oauth_personal_consumers.collection');
    $ce = $provider->getRouteByName('openkb_agent.api_clients.ce');

    $this->assertSame($stock->getPath(), $ce->getPath());
    $this->assertSame($stock->getRequirement('_custom_access'), $ce->getRequirement('_custom_access'));
    $this->assertSame('custom_elements', $ce->getRequirement('_format'));
    $this->assertSame(
      ApiClientsCeController::class . '::customElementsPage',
      $ce->getDefault('_controller'),
    );

    // The confirm form rides a CE form controller rather than one of its own.
    $revoke = $provider->getRouteByName('openkb_agent.api_clients_revoke.ce');
    $this->assertSame('custom_elements', $revoke->getRequirement('_format'));
    $this->assertSame(
      $provider->getRouteByName('simple_oauth_personal_consumers.revoke')->getDefault('_form'),
      $revoke->getDefault('_form'),
    );
  }

  /**
   * The page states its clients as data, and carries the create form.
   */
  public function testPageStatesTheClientsAsProps(): void {
    $manager = $this->container->get('simple_oauth_personal_consumers.manager');
    $kept = $manager->create($this->owner, 'Claude')->consumer;
    $gone = $manager->create($this->owner, 'Retired')->consumer;
    $manager->revoke($gone);

    $element = $this->page();

    $this->assertSame('drupal-form-simple-oauth-personal-consumers-create', $element->getTag());
    $this->assertSame($this->owner->getAccountName(), $element->getAttribute('account'));
    $this->assertSame([
      [
        'label' => 'Claude',
        'client_id' => $kept->getClientId(),
        'revoked' => FALSE,
        'created' => gmdate(\DateTimeInterface::ATOM, (int) $kept->get('created')->value),
        // Nothing has been issued for either, so neither has been used.
        'last_used' => NULL,
        'revoke_url' => '/user/' . $this->owner->id() . '/api-clients/' . $kept->id() . '/revoke',
      ],
      [
        'label' => 'Retired',
        'client_id' => $gone->getClientId(),
        // A revoked client stays listed, and has nothing left to revoke.
        'revoked' => TRUE,
        'created' => gmdate(\DateTimeInterface::ATOM, (int) $gone->get('created')->value),
        'last_used' => NULL,
        'revoke_url' => NULL,
      ],
    ], $element->getAttribute('clients'));
    // Provisioning still happens through Drupal's own form.
    $this->assertStringContainsString('name="label"', (string) $element->getSlot('default')['content']);
    // Revoking or provisioning a client has to invalidate the page.
    $this->assertContains('consumer_list', $element->getCacheTags());
  }

  /**
   * An account with no clients gets the page, not an error.
   */
  public function testPageWithoutClients(): void {
    $this->assertSame([], $this->page()->getAttribute('clients'));
  }

  /**
   * The secret rides the response that provisioned the client.
   *
   * Not the session's messages: the app makes Drupal calls of its own around a
   * page load, and whichever asks first is handed them — so a secret left there
   * can reach a render that is not this page, and it is shown exactly once.
   */
  public function testProvisioningCarriesTheSecret(): void {
    $this->submit(
      '/user/' . $this->owner->id() . '/api-clients',
      'simple_oauth_personal_consumers_create',
      ['label' => 'Fresh', 'op' => 'Create API client'],
    );

    $element = $this->page();

    $created = $element->getAttribute('created_client');
    $this->assertSame('Fresh', $created['label']);
    $this->assertNotEmpty($created['secret']);
    $this->assertNotEmpty($created['client_id']);
    // The response that provisioned it also lists it.
    $this->assertSame(['Fresh'], array_column($element->getAttribute('clients'), 'label'));

    $messages = $this->container->get('messenger')->all();
    $this->assertArrayNotHasKey(MessengerInterface::TYPE_WARNING, $messages);
    $this->assertStringNotContainsString(
      $created['secret'],
      implode(' ', array_map('strval', $messages[MessengerInterface::TYPE_STATUS] ?? [])),
    );
  }

  /**
   * A second client cannot take a name the account's agents already hold.
   *
   * The name is half the key work is assigned by, so one account's agents each
   * need their own. The error names what to do about it.
   */
  public function testNameAlreadyHeldIsRefused(): void {
    $manager = $this->container->get('simple_oauth_personal_consumers.manager');
    $manager->create($this->owner, 'claude');

    $form_state = new FormState();
    $form_state->addBuildInfo('args', [$this->owner]);
    $form_state->setValues(['label' => 'CLAUDE']);
    $this->container->get('form_builder')->submitForm(PersonalConsumerCreateForm::class, $form_state);

    $errors = array_map('strval', $form_state->getErrors());
    $this->assertSame(
      ['label' => 'You already have an agent named CLAUDE. Choose another name.'],
      array_map('strip_tags', $errors),
    );
    $this->assertSame(['claude'], array_map(
      static fn ($consumer) => $consumer->label(),
      array_values($manager->getConsumers($this->owner)),
    ), 'nothing was created');
  }

  /**
   * Without that ask, the secret goes out as a message — Drupal's own page.
   */
  public function testTheHtmlPageKeepsTheMessage(): void {
    $form_state = new FormState();
    $form_state->addBuildInfo('args', [$this->owner]);
    $form_state->setValues(['label' => 'Fresh']);
    $this->container->get('form_builder')
      ->submitForm(PersonalConsumerCreateForm::class, $form_state);

    $warnings = $this->container->get('messenger')->all()[MessengerInterface::TYPE_WARNING] ?? [];
    $this->assertStringContainsString('shown only once', implode(' ', array_map('strval', $warnings)));
  }

  /**
   * The revoke screen asks its own question, and offers the answer.
   *
   * The route's title is the generic one, so without the form's `#title` the
   * screen never names the client it is about.
   */
  public function testRevokeScreenNamesTheClient(): void {
    $consumer = $this->container->get('simple_oauth_personal_consumers.manager')
      ->create($this->owner, 'Claude')->consumer;

    $element = $this->revokeScreen($consumer);

    $title = (string) $element->getAttribute('title');
    $this->assertStringContainsString('Revoke the API client', $title);
    $this->assertStringContainsString('Claude', $title);
    $this->assertStringContainsString('value="Confirm"', (string) $element->getSlot('default')['content']);
  }

  /**
   * Confirming revokes the client and goes back to the listing.
   */
  public function testRevokeReturnsToTheListing(): void {
    $manager = $this->container->get('simple_oauth_personal_consumers.manager');
    $consumer = $manager->create($this->owner, 'Claude')->consumer;

    try {
      $this->revokeScreen($consumer, confirm: TRUE);
      $this->fail('Confirming did not redirect.');
    }
    catch (EnforcedResponseException $e) {
      $this->assertStringEndsWith(
        '/user/' . $this->owner->id() . '/api-clients',
        $e->getResponse()->getTargetUrl(),
      );
    }
    $this->assertTrue($manager->isRevoked($consumer));
  }

  /**
   * The account menu's entry points at whoever is asking.
   */
  public function testMenuLinkFollowsTheCurrentAccount(): void {
    $manager = $this->container->get('plugin.manager.menu.link');
    $manager->rebuild();
    $link = $manager->createInstance('openkb_agent.api_clients');
    assert($link instanceof MenuLinkInterface);

    $this->assertSame('account', $link->getMenuName());
    $this->assertSame(
      '/user/' . $this->owner->id() . '/api-clients',
      $link->getUrlObject()->toString(),
    );
    // The link is per-account, so a cached menu may not be shared between two.
    $this->assertContains('user', $link->getCacheContexts());

    $other = $this->createUser(['manage own personal consumers']);
    $this->setCurrentUser($other);
    $this->assertSame(
      '/user/' . $other->id() . '/api-clients',
      $manager->createInstance('openkb_agent.api_clients')->getUrlObject()->toString(),
    );
  }

  /**
   * The page, as the custom-elements route answers it.
   */
  private function page(): CustomElement {
    $controller = ApiClientsCeController::create($this->container);
    return $controller->customElementsPage($this->owner);
  }

  /**
   * The revoke screen, as the custom-elements route answers it.
   *
   * @param \Drupal\consumers\Entity\ConsumerInterface $consumer
   *   The client the screen is about.
   * @param bool $confirm
   *   Answer the question rather than only ask it.
   *
   * @return \Drupal\custom_elements\CustomElement
   *   The confirm form, carrying its own heading.
   */
  private function revokeScreen(ConsumerInterface $consumer, bool $confirm = FALSE): CustomElement {
    $name = 'openkb_agent.api_clients_revoke.ce';
    $route = $this->container->get('router.route_provider')->getRouteByName($name);
    $path = '/user/' . $this->owner->id() . '/api-clients/' . $consumer->id() . '/revoke';
    $request = $confirm
      ? $this->submit($path, 'simple_oauth_personal_consumers_revoke', ['op' => 'Confirm'])
      : $this->push(Request::create($path));
    // The controller resolves the form's arguments off the request.
    $request->attributes->set('user', $this->owner);
    $request->attributes->set('consumer', $consumer);

    return $this->container->get('openkb_agent.controller.titled_form')->getContentResult(
      $request,
      new RouteMatch($name, $route, ['user' => $this->owner, 'consumer' => $consumer]),
    );
  }

  /**
   * A submitted form request, in the stack and answerable.
   *
   * @param string $path
   *   The path the form posts back to.
   * @param string $form_id
   *   The form being submitted.
   * @param array $values
   *   The posted values, the pressed button included.
   *
   * @return \Symfony\Component\HttpFoundation\Request
   *   The request, already current.
   */
  private function submit(string $path, string $form_id, array $values): Request {
    $request = $this->push(Request::create($path, 'POST', $values + ['form_id' => $form_id]));
    // The CSRF token a browser would post back, keyed the way core keys it.
    $request->request->set('form_token', $this->container->get('csrf_token')
      ->get('form_token_placeholder_' . Crypt::hashBase64($form_id)));
    return $request;
  }

  /**
   * Makes a request current, with the session the form builder reads.
   */
  private function push(Request $request): Request {
    $request->setSession(new Session(new MockArraySessionStorage()));
    $this->container->get('request_stack')->push($request);
    return $request;
  }

}
