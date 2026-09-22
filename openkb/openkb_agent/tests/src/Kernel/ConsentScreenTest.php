<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_agent\Kernel;

use Drupal\Core\Form\FormState;
use Drupal\Core\Session\AccountInterface;
use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\openkb_agent\ActingIdentity;
use Drupal\openkb_agent\ConsentScreen;
use Drupal\openkb_agent\Controller\Oauth2AuthorizeCeController;
use Drupal\simple_oauth\Controller\Oauth2AuthorizeController;
use Drupal\simple_oauth\Entities\ClientEntity;
use Drupal\simple_oauth\Entities\UserEntity;
use Drupal\simple_oauth\Form\Oauth2AuthorizeForm;
use Drupal\user\UserInterface;
use League\OAuth2\Server\RequestTypes\AuthorizationRequest;

/**
 * The consent screen: where it is served, what it says, what it asks (OKB-151).
 *
 * Three claims. That the frontend can reach the screen at all rests on a second
 * route rather than a changed one — `/oauth/authorize` itself must go on
 * answering exactly as simple_oauth wrote it, because that is the endpoint the
 * whole flow is specified against. What the screen says has to be the grant
 * that is made: the scopes the request asks for, in the words a person can act
 * on. And the one thing it asks for — the name this agent acts under — rides
 * simple_oauth's own POST and lands on the client.
 *
 * The rendering in between — the custom element, the frontend's markup — is
 * walked once over the real wire by the `mcp-connect-by-url` e2e spec.
 */
final class ConsentScreenTest extends KernelTestBase {

  use RecipeConfigTrait;
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
    'openkb_agent',
  ];

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
    $this->importRecipeConfig([
      'simple_oauth.oauth2_scope.agent_read',
      'simple_oauth.oauth2_scope.agent_read_content',
      'simple_oauth.oauth2_scope.agent_read_space',
      'simple_oauth.oauth2_scope.agent_write',
      'simple_oauth.oauth2_scope.agent_write_content',
      'simple_oauth.oauth2_scope.agent_write_space',
      // Outside the agent family, so the screen has no words of its own for it.
      'simple_oauth.oauth2_scope.collab',
    ]);
    // User 1 is a superuser; take it out of circulation.
    $this->createUser();
    $this->approver = $this->createUser();
    // The screen is only ever shown to whoever is about to approve.
    $this->setCurrentUser($this->approver);
  }

  /**
   * The account the consent screen is shown to.
   */
  private UserInterface $approver;

  /**
   * How many consumers this test has created, for their client IDs.
   */
  private int $clients = 0;

  /**
   * The authorization request the screen is shown for.
   *
   * @param \Drupal\consumers\Entity\ConsumerInterface $consumer
   *   The client asking.
   * @param string[] $asked
   *   The scopes the client asked for, by wire name.
   * @param string $redirect_uri
   *   The callback the request names.
   */
  private function authorizationRequest(ConsumerInterface $consumer, array $asked, string $redirect_uri = 'https://claude.ai/cb'): AuthorizationRequest {
    $repository = $this->container->get('simple_oauth.repositories.scope');
    $auth_request = new AuthorizationRequest();
    $auth_request->setClient(new ClientEntity($consumer));
    $auth_request->setScopes(array_map(
      static fn (string $name) => $repository->getScopeEntityByIdentifier($name),
      $asked,
    ));
    $auth_request->setRedirectUri($redirect_uri);
    // The controller puts the account that is about to approve on the request
    // before it builds the form; what a scope grants depends on who holds it.
    $user = new UserEntity();
    $user->setIdentifier($this->approver->id());
    $auth_request->setUser($user);
    return $auth_request;
  }

  /**
   * Builds simple_oauth's own consent form, alters and all.
   *
   * Built rather than described: what the alter and the controller do to this
   * form is keyed to the names simple_oauth gives its parts, so a stand-in
   * would go on passing after an upstream rename that breaks the screen.
   *
   * @param \Drupal\consumers\Entity\ConsumerInterface $consumer
   *   The client asking.
   * @param string[] $asked
   *   The scopes the client asked for, by wire name.
   * @param string $redirect_uri
   *   The callback the request names.
   *
   * @return array
   *   The built form.
   */
  private function screenFor(ConsumerInterface $consumer, array $asked, string $redirect_uri = 'https://claude.ai/cb'): array {
    $this->request = $this->authorizationRequest($consumer, $asked, $redirect_uri);
    return $this->container->get('form_builder')->getForm(
      Oauth2AuthorizeForm::class,
      NULL,
      $this->request,
    );
  }

  /**
   * The authorization request the last built screen was shown for.
   */
  private AuthorizationRequest $request;

  /**
   * Presses Allow on the last built screen, under a given name.
   *
   * Every handler the form carries except simple_oauth's own: completing the
   * grant needs the authorization server a real request travels with, and
   * what it does with the approval is simple_oauth's to test.
   *
   * @param array $form
   *   The built screen.
   * @param string $typed
   *   What is in the name field; empty means the pre-filled name untouched.
   */
  private function allow(array $form, string $typed): void {
    $this->assertSame('', $this->approve($form, $typed), 'the name was taken');
  }

  /**
   * Presses Allow, validation and all, and says what stopped it.
   *
   * A name the person may not take stops the approval where simple_oauth's own
   * handlers are: nothing is saved, and no code is issued.
   *
   * @param array $form
   *   The built screen.
   * @param string $typed
   *   What is in the name field; empty means the pre-filled name untouched.
   *
   * @return string
   *   The error the screen shows, or an empty string where it took the name.
   */
  private function approve(array $form, string $typed): string {
    $form_state = new FormState();
    $form_state->set('auth_request', $this->request);
    $form_state->setTriggeringElement($form['actions']['submit']);
    $form_state->setValue(ConsentScreen::NAME_ELEMENT, $typed);
    foreach ($form['#validate'] as $handler) {
      if ($handler !== '::validateForm') {
        $handler($form, $form_state);
      }
    }
    if ($errors = $form_state->getErrors()) {
      return strip_tags((string) reset($errors));
    }
    foreach ($form['#submit'] as $handler) {
      if ($handler !== '::submitForm') {
        $handler($form, $form_state);
      }
    }
    return '';
  }

  /**
   * A consumer as it stands in storage.
   */
  private function reloaded(ConsumerInterface $consumer): ConsumerInterface {
    $storage = $this->container->get('entity_type.manager')->getStorage('consumer');
    $storage->resetCache([$consumer->id()]);
    return $storage->load($consumer->id());
  }

  /**
   * A consumer under a given label.
   *
   * @param string $label
   *   How the site attributes it. A self-registered client's carries
   *   {@see \Drupal\openkb_agent\ActingIdentity::UNVERIFIED_SUFFIX}.
   * @param bool $personal
   *   Whether it is one person's agent credential, as a registered client is.
   * @param \Drupal\Core\Session\AccountInterface|null $owner
   *   Whose agent it is, or NULL for unowned, as a registered client is until
   *   the first authorization claims it.
   */
  private function consumerLabelled(string $label, bool $personal = TRUE, ?AccountInterface $owner = NULL): ConsumerInterface {
    /** @var \Drupal\consumers\Entity\ConsumerInterface $consumer */
    $consumer = $this->container->get('entity_type.manager')->getStorage('consumer')->create([
      'label' => $label,
      'client_id' => 'client-' . ++$this->clients,
      'grant_types' => ['authorization_code'],
      'redirect' => ['https://claude.ai/cb'],
      'personal' => $personal,
      'user_id' => $owner?->id(),
    ]);
    $consumer->save();
    return $consumer;
  }

  /**
   * The frontend gets its own route; `/oauth/authorize` is left alone.
   */
  public function testTheCustomElementsVariantIsAdditive(): void {
    $provider = $this->container->get('router.route_provider');

    $ce = $provider->getRouteByName('openkb_agent.oauth2_authorize.ce');
    $this->assertSame('/oauth/authorize', $ce->getPath());
    // Only a request that asks for custom elements — which is what `/ce-api`
    // turns a request into — resolves here.
    $this->assertSame('custom_elements', $ce->getRequirement('_format'));
    $this->assertSame(Oauth2AuthorizeCeController::class . '::authorize', $ce->getDefault('_controller'));
    $this->assertSame(['GET', 'POST'], $ce->getMethods());

    $stock = $provider->getRouteByName('oauth2_token.authorize');
    $this->assertSame(Oauth2AuthorizeController::class . '::authorize', $stock->getDefault('_controller'));
    $this->assertNull($stock->getRequirement('_format'), 'the specified endpoint still answers as it always did');
  }

  /**
   * The screen states the grant; `/oauth/authorize` in HTML is left alone.
   *
   * One form, walked the way a request walks it: built by simple_oauth with
   * our alter on it, read for its props, then trimmed on its way out as
   * custom elements. The stock screen is the untrimmed one, still live and
   * still approvable, with its scope list the only thing there saying what
   * approving grants.
   */
  public function testTheScreenStatesTheGrant(): void {
    $screen = $this->container->get('openkb_agent.consent_screen');
    $asked = ['agent:read', 'agent:write', 'collab'];
    $form = $this->screenFor($this->consumerLabelled('Claude'), $asked);

    $props = $screen->props($form);
    $this->assertSame('Claude', $props['client']);
    $this->assertSame('https://claude.ai/cb', $props['callback']);
    $this->assertSame($asked, array_column($props['scopes'], 'name'));
    // What approving allows, said to the person deciding — a scope's own
    // description states the permissions it caps, which is a different reader.
    $this->assertSame('Read published pages on your behalf.', $props['scopes'][0]['description']);
    $this->assertSame('Create and edit pages on your behalf.', $props['scopes'][1]['description']);
    // A scope from outside the agent family keeps its own description.
    $this->assertStringContainsString('Check point shared editing sessions', $props['scopes'][2]['description']);

    // The name is the person's to set, and the field says what it is for.
    $account = $this->approver->getAccountName();
    $field = $form[ConsentScreen::NAME_ELEMENT];
    $this->assertSame('Name of this agent', (string) $field['#title']);
    $this->assertSame('Claude', $field['#default_value']);
    $this->assertSame(
      "It acts on behalf of you ($account). Everything it writes is recorded as "
      . "'$account via <span data-okb-agent-name>Claude</span>'.",
      (string) $field['#description'],
      'the name sits in its own span, for the frontend to refresh as it is typed',
    );

    $this->assertSame($asked, array_keys($form['scopes']['#items']));
    $this->assertNotContains('okb-consent-allow', $form['actions']['submit']['#attributes']['class'] ?? []);
    $this->assertNotContains('okb-consent-deny', $form['actions']['cancel']['#attributes']['class'] ?? []);

    $screen->removeScopeList($form);
    $screen->markDecisionButtons($form);
    $this->assertArrayNotHasKey('scopes', $form, 'two lists of scopes could disagree');
    $this->assertArrayHasKey('redirect_uri', $form, 'what the frontend submits back stays');
    // The frontend styles the two buttons by these; the values are what
    // Drupal maps back onto the triggering element.
    $this->assertContains('okb-consent-allow', $form['actions']['submit']['#attributes']['class']);
    $this->assertContains('okb-consent-deny', $form['actions']['cancel']['#attributes']['class']);
    $this->assertSame('Allow', (string) $form['actions']['submit']['#value']);
    $this->assertSame('Deny', (string) $form['actions']['cancel']['#value']);
  }

  /**
   * The person names the agent, and Allow is them standing behind the name.
   *
   * A self-registered client named itself with nobody vouching for it, which
   * is what the marking in its label says. Consent is where that ends: the
   * screen asks about the name alone — the marking is the site's word about
   * it, and so is the machine parenthetical a client appends for itself — and
   * whatever is in the field when Allow is pressed is a name a human chose or
   * let stand. From then on it is the label, and attribution reads it.
   *
   * Asked only of whoever the name belongs to: the field's own description
   * says the agent's writes will read "you via <name>", which holds for one
   * person's agent credential and nothing else.
   */
  public function testTheNameIsTheOwnersToSet(): void {
    $screen = $this->container->get('openkb_agent.consent_screen');
    $consumer = $this->consumerLabelled('Claude Code (okb-1x)' . ActingIdentity::UNVERIFIED_SUFFIX);
    $form = $this->screenFor($consumer, ['agent:read']);

    // The heading names the client that asked, as it registered itself, minus
    // the marking. What is suggested is the agent — one short word; which
    // machine it runs on is not the question.
    $this->assertSame('Claude Code (okb-1x)', $screen->props($form)['client']);
    $this->assertSame('claude', $form[ConsentScreen::NAME_ELEMENT]['#default_value']);
    $this->assertTrue((bool) $consumer->get('third_party')->value, 'which the field default alone cannot tell apart');
    // Ours runs before simple_oauth completes the grant, so the consumer is
    // saved while the authorization code does not exist yet.
    $this->assertSame([$screen, 'renameAgent'], reset($form['#submit']));
    $this->assertSame('::submitForm', end($form['#submit']));

    $this->allow($form, 'Rex');
    $this->assertSame('Rex', $this->reloaded($consumer)->label(), 'the name the person chose is the label');

    // Left as pre-filled, Allow is still a person standing behind the name, so
    // there is nothing left to mark.
    $confirmed = $this->consumerLabelled('Claude' . ActingIdentity::UNVERIFIED_SUFFIX);
    $this->allow($this->screenFor($confirmed, ['agent:read']), '');
    $this->assertSame('claude', $this->reloaded($confirmed)->label());

    $verbose = $this->consumerLabelled('Codex CLI (build 7)' . ActingIdentity::UNVERIFIED_SUFFIX);
    $this->allow($this->screenFor($verbose, ['agent:read']), '');
    $this->assertSame('codex', $this->reloaded($verbose)->label());

    // A parenthetical is the install, wherever the client puts it, so it never
    // reaches the suggestion — and a name that is nothing else leaves nothing
    // to suggest.
    $leading = $this->consumerLabelled('(okb-1x) Claude' . ActingIdentity::UNVERIFIED_SUFFIX);
    $this->assertSame('claude', $this->screenFor($leading, ['agent:read'])[ConsentScreen::NAME_ELEMENT]['#default_value']);
    $bracketed = $this->consumerLabelled('(okb-1x)' . ActingIdentity::UNVERIFIED_SUFFIX);
    $this->assertSame('agent', $this->screenFor($bracketed, ['agent:read'])[ConsentScreen::NAME_ELEMENT]['#default_value']);

    // An unmarked label is a name a human already chose — on the api-clients
    // form, or at an earlier consent. Consenting again offers it back whole,
    // and Allow with the field untouched leaves it: attribution reads the
    // label, and standing assignments are keyed by it.
    $named = $this->consumerLabelled('Claude Code');
    $again = $this->screenFor($named, ['agent:read']);
    $this->assertSame('Claude Code', $screen->props($again)['client']);
    $this->assertSame('Claude Code', $again[ConsentScreen::NAME_ELEMENT]['#default_value']);
    $this->allow($again, '');
    $this->assertSame('Claude Code', $this->reloaded($named)->label());

    // A client that is nobody's agent credential, and one that is somebody
    // else's, are not this person's to name — so they are not asked. A field
    // that could not be acted on would be a screen making a claim about
    // attribution that would not come true.
    $others = [
      'nobody\'s agent credential' => $this->consumerLabelled('Shared client', personal: FALSE),
      'somebody else\'s agent' => $this->consumerLabelled('Their Claude', owner: $this->createUser()),
    ];
    foreach ($others as $whose => $consumer) {
      $form = $this->screenFor($consumer, ['agent:read']);
      $this->assertArrayNotHasKey(ConsentScreen::NAME_ELEMENT, $form, "a name that is $whose is not asked for");
      // The rest of the screen is the screen: it still states the grant.
      $this->assertSame(['agent:read'], array_column($screen->props($form)['scopes'], 'name'));
      $this->assertArrayHasKey('cancel', $form['actions']);

      // And a name posted anyway lands nowhere.
      $form_state = new FormState();
      $form_state->set('auth_request', $this->request);
      $form_state->setTriggeringElement($form['actions']['submit']);
      $form_state->setValue(ConsentScreen::NAME_ELEMENT, 'Mine now');
      $screen->renameAgent($form, $form_state);
      $this->assertSame($consumer->label(), $this->reloaded($consumer)->label());
    }

    // Denying names nothing — refusing is not standing behind anything.
    $denied = $this->consumerLabelled('Claude' . ActingIdentity::UNVERIFIED_SUFFIX);
    $form = $this->screenFor($denied, ['agent:read']);
    $form_state = new FormState();
    $form_state->set('auth_request', $this->request);
    $form_state->setTriggeringElement($form['actions']['cancel']);
    $form_state->setValue(ConsentScreen::NAME_ELEMENT, 'Rex');
    $screen->renameAgent($form, $form_state);
    $this->assertSame('Claude (unverified)', $this->reloaded($denied)->label());
  }

  /**
   * A name one of the person's agents already holds is refused.
   *
   * Assignments are keyed by `{uid, via}` with `via` the name, so two of one
   * person's agents under one name would each answer the other's work. The
   * suggestion does not have to be unique — the name that is saved does, and
   * Allow with a colliding suggestion untouched is refused the same way.
   */
  public function testEachAgentNeedsItsOwnName(): void {
    $this->container->get('simple_oauth_personal_consumers.manager')
      ->create($this->approver, 'claude');
    $taken = 'You already have an agent named claude. Choose another name.';

    // The suggestion collides, and is still what the field offers.
    $arriving = $this->consumerLabelled('Claude Code (okb-1x)' . ActingIdentity::UNVERIFIED_SUFFIX);
    $form = $this->screenFor($arriving, ['agent:read']);
    $this->assertSame('claude', $form[ConsentScreen::NAME_ELEMENT]['#default_value']);
    $this->assertSame($taken, $this->approve($form, ''), 'the untouched suggestion is refused too');
    $this->assertSame(
      'Claude Code (okb-1x) (unverified)',
      $this->reloaded($arriving)->label(),
      'nothing is saved, so simple_oauth never issues a code under the name',
    );
    // Case is not a difference — the two would be one assignee. The error
    // names the name as it was typed.
    $this->assertSame(
      'You already have an agent named CLAUDE. Choose another name.',
      $this->approve($form, 'CLAUDE'),
    );

    // Another name, and the approval goes through.
    $this->allow($form, 'claude-2');
    $this->assertSame('claude-2', $this->reloaded($arriving)->label());

    // Consenting again to an agent under the name it already has is not a
    // collision with itself.
    $again = $this->screenFor($this->reloaded($arriving), ['agent:read']);
    $this->allow($again, 'claude-2');
    $this->assertSame('claude-2', $this->reloaded($arriving)->label());

    // Somebody else's agent may be called the same thing.
    $other = $this->createUser();
    $this->setCurrentUser($other);
    $theirs = $this->consumerLabelled('Claude' . ActingIdentity::UNVERIFIED_SUFFIX, owner: $other);
    $this->approver = $other;
    $this->allow($this->screenFor($theirs, ['agent:read']), 'claude');
    $this->assertSame('claude', $this->reloaded($theirs)->label());
  }

  /**
   * A form that is not the consent screen's is left untouched.
   */
  public function testIgnoresFormsWithoutAnAuthorizationRequest(): void {
    $form = ['title' => ['#type' => 'textfield']];
    $before = $form;
    $this->container->get('openkb_agent.consent_screen')->alterForm($form, new FormState());
    $this->assertSame($before, $form);
  }

}
