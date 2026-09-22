<?php

declare(strict_types=1);

namespace Drupal\openkb_agent;

use Drupal\Component\Render\FormattableMarkup;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\consumers\Entity\ConsumerInterface;
use Drupal\simple_oauth\Entities\ScopeEntityInterface as SimpleOauthScopeEntityInterface;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface;
use League\OAuth2\Server\RequestTypes\AuthorizationRequest;

/**
 * What the consent screen says, asks and does.
 *
 * The props are computed while the consent form is built, ride along on the
 * form, and are shipped as the custom element's attributes by
 * \Drupal\openkb_agent\Controller\Oauth2AuthorizeCeController. The one thing
 * the screen asks for — the agent's name, and only where that name is the
 * visitor's to set — is an element on that same form, so approving carries it
 * back over simple_oauth's own POST.
 */
final class ConsentScreen {

  use StringTranslationTrait;

  /**
   * The form property the props travel on, from the alter to the controller.
   */
  private const PROPS_PROPERTY = '#openkb_consent_props';

  /**
   * The element the person names the agent in.
   */
  public const NAME_ELEMENT = 'agent_name';

  /**
   * Offered when a client's own name holds nothing to suggest.
   */
  private const FALLBACK_NAME = 'agent';

  public function __construct(
    private readonly ActingIdentity $identity,
    private readonly PersonalConsumerManagerInterface $consumers,
    private readonly EntityTypeManagerInterface $entityTypeManager,
  ) {}

  /**
   * Puts the props and the name field on the consent form.
   *
   * @param array $form
   *   The simple_oauth consent form.
   * @param \Drupal\Core\Form\FormStateInterface $form_state
   *   Its state, carrying the authorization request.
   */
  public function alterForm(array &$form, FormStateInterface $form_state): void {
    $auth_request = $form_state->get('auth_request');
    if (!$auth_request instanceof AuthorizationRequest) {
      return;
    }
    $consumer = $auth_request->getClient()->getDrupalEntity();
    $label = (string) $consumer->label();
    $form[self::PROPS_PROPERTY] = [
      // The heading names the client as it is registered, so the screen is
      // about the thing that asked. Only the marking is dropped: it is the
      // site's word about the name, not part of it.
      'client' => $this->unmarked($label),
      'scopes' => $this->requestedScopes($auth_request),
      'callback' => $this->callbackUri($auth_request),
    ];
    // Asked only where the name is the visitor's to set: elsewhere the field
    // could not be acted on, and its description would not hold.
    if (!$this->isOwnAgent($consumer)) {
      return;
    }
    $name = $this->defaultName($label);
    $form[self::NAME_ELEMENT] = [
      '#type' => 'textfield',
      '#title' => $this->t('Name of this agent'),
      '#default_value' => $name,
      '#description' => $this->actingLine($name),
      '#maxlength' => 255,
      '#weight' => -10,
    ];
    // Both before simple_oauth's own handlers: a name that is not the
    // person's to take stops the grant, so no code is issued under it.
    $form['#validate'] = [[$this, 'validateName'], ...($form['#validate'] ?? [])];
    $form['#submit'] = [[$this, 'renameAgent'], ...($form['#submit'] ?? [])];
  }

  /**
   * The props put on the form by ::alterForm().
   *
   * @param array $form
   *   The built consent form.
   *
   * @return array
   *   The props, or an empty array on a form that is not the consent screen's.
   */
  public function props(array $form): array {
    return $form[self::PROPS_PROPERTY] ?? [];
  }

  /**
   * Refuses a name another of the person's agents already holds.
   *
   * Work is assigned to `{uid, via}` with `via` the name, so two agents of one
   * person under one name would each answer the other's assignments. Refused
   * on the way in: with an error on the field nothing is saved, and
   * simple_oauth never reaches the point of issuing a code.
   *
   * @param array $form
   *   The submitted consent form.
   * @param \Drupal\Core\Form\FormStateInterface $form_state
   *   Its state, carrying the authorization request and the typed name.
   */
  public function validateName(array &$form, FormStateInterface $form_state): void {
    $consumer = $this->consumerBeingNamed($form_state);
    if ($consumer === NULL) {
      return;
    }
    $name = $this->chosenName($form_state, $consumer);
    $owner = $this->entityTypeManager->getStorage('user')->load($this->identity->uid());
    if ($owner !== NULL && $this->consumers->nameTaken($owner, $name, $consumer)) {
      $form_state->setErrorByName(self::NAME_ELEMENT, $this->consumers->nameTakenError($name));
    }
  }

  /**
   * Names the agent as the person just did, on Allow.
   *
   * The label is the whole of it: attribution reads it, so renaming here is
   * what makes writes appear as "you via <the name you chose>".
   *
   * A human having set or confirmed the name means it carries no
   * {@see ActingIdentity::UNVERIFIED_SUFFIX} from now on: the field was
   * pre-filled without one, and Allow is the confirmation.
   *
   * Runs before the grant is completed, so the consumer is saved before the
   * authorization code exists: saving one revokes the consumer's tokens
   * (simple_oauth's TokenExpiryTriggerHandler), and a code is one of those.
   *
   * @param array $form
   *   The submitted consent form.
   * @param \Drupal\Core\Form\FormStateInterface $form_state
   *   Its state, carrying the authorization request and the typed name.
   */
  public function renameAgent(array &$form, FormStateInterface $form_state): void {
    $consumer = $this->consumerBeingNamed($form_state);
    if ($consumer === NULL) {
      return;
    }
    $name = $this->chosenName($form_state, $consumer);
    if ((string) $consumer->label() === $name) {
      return;
    }
    $consumer->set('label', $name);
    $consumer->save();
  }

  /**
   * The client an approval is naming, or NULL where none is being named.
   *
   * Backstop as much as a read: ::alterForm() asks nobody but the owner, and a
   * posted value is no question having been asked. Denying names nothing.
   */
  private function consumerBeingNamed(FormStateInterface $form_state): ?ConsumerInterface {
    if (!($form_state->getTriggeringElement()['#authorized'] ?? FALSE)) {
      return NULL;
    }
    $auth_request = $form_state->get('auth_request');
    if (!$auth_request instanceof AuthorizationRequest) {
      return NULL;
    }
    $consumer = $auth_request->getClient()->getDrupalEntity();
    return $this->isOwnAgent($consumer) ? $consumer : NULL;
  }

  /**
   * The name an approval carries: what was typed, or the pre-filled one.
   *
   * An empty field means the pre-filled name confirmed, never an empty label.
   */
  private function chosenName(FormStateInterface $form_state, ConsumerInterface $consumer): string {
    $typed = trim((string) $form_state->getValue(self::NAME_ELEMENT));
    return $typed !== '' ? $typed : $this->defaultName((string) $consumer->label());
  }

  /**
   * Drops the scope list, which the props state instead.
   *
   * Two lists of scopes — one in the props, one in the markup — could disagree
   * with each other.
   *
   * @param array $form
   *   The built consent form, on its way out as custom elements.
   */
  public function removeScopeList(array &$form): void {
    unset($form['scopes']);
  }

  /**
   * Marks Allow and Deny, for the frontend to style them apart.
   *
   * @param array $form
   *   The built consent form, on its way out as custom elements.
   */
  public function markDecisionButtons(array &$form): void {
    $form['actions']['submit']['#attributes']['class'][] = 'okb-consent-allow';
    $form['actions']['cancel']['#attributes']['class'][] = 'okb-consent-deny';
  }

  /**
   * A label without {@see ActingIdentity::UNVERIFIED_SUFFIX}.
   *
   * The marking is the site's word about a name nobody vouched for, so neither
   * the heading nor the pre-filled field carries it.
   */
  private function unmarked(string $label): string {
    return str_ends_with($label, ActingIdentity::UNVERIFIED_SUFFIX)
      ? substr($label, 0, -strlen(ActingIdentity::UNVERIFIED_SUFFIX))
      : $label;
  }

  /**
   * What the name field pre-fills.
   *
   * A marked label is a name the client gave itself, so the field offers a
   * short one instead. An unmarked label is a name a human already chose —
   * here, on the api-clients form, or at an earlier consent — and Allow with
   * the field untouched must leave it alone: attribution reads the label, and
   * standing assignments are keyed by it.
   */
  private function defaultName(string $label): string {
    return str_ends_with($label, ActingIdentity::UNVERIFIED_SUFFIX)
      ? $this->suggestedName($label)
      : $label;
  }

  /**
   * The name to offer for an agent: one short lowercase word.
   *
   * A client names itself for the install it runs on ("Claude Code (okb-1x)"),
   * and the name becomes how every page names the agent — so what is suggested
   * is the agent, not the install: every parenthetical drops out, wherever it
   * sits, and the first word of what is left is the offer. Lowercase, the way
   * a handle reads. Anything longer is the person's to type.
   */
  private function suggestedName(string $label): string {
    $name = trim((string) preg_replace('/\s*\([^()]*\)/', ' ', $this->unmarked($label)));
    $first = strstr($name, ' ', TRUE);
    $first = $first === FALSE ? $name : $first;
    return $first !== '' ? mb_strtolower($first) : self::FALLBACK_NAME;
  }

  /**
   * What the name is for: who the agent acts as, and how its writes read.
   *
   * The name sits in its own span so the frontend can refresh the line as the
   * person types; the server-rendered one states the pre-filled name.
   */
  private function actingLine(string $name): TranslatableMarkup {
    $user = $this->identity->name();
    return $this->t("It acts on behalf of you (@user). Everything it writes is recorded as '@user via @name'.", [
      '@user' => $user,
      '@name' => new FormattableMarkup('<span data-okb-agent-name>@name</span>', ['@name' => $name]),
    ]);
  }

  /**
   * Whether this agent is the person's to name.
   *
   * A personal consumer is one person's agent credential and its label is how
   * their writes are attributed. Unowned means this very consent is what claims
   * it ({@see \Drupal\openkb_agent_registration\Hook\RegistrationHooks}).
   * Anything else is somebody else's name to choose.
   */
  private function isOwnAgent(ConsumerInterface $consumer): bool {
    if (!$consumer->hasField('personal') || !$consumer->get('personal')->value) {
      return FALSE;
    }
    $owner = $consumer->get('user_id');
    return $owner->isEmpty() || (int) $owner->target_id === $this->identity->uid();
  }

  /**
   * The scopes the request asks for, described in words a person can act on.
   *
   * What is asked for is what approving grants: a request reaching beyond what
   * a client may hold is refused at registration, never quietly narrowed.
   */
  private function requestedScopes(AuthorizationRequest $auth_request): array {
    $words = $this->scopeWords();
    $scopes = [];
    foreach ($auth_request->getScopes() as $scope) {
      $name = $scope->getIdentifier();
      $configured = $scope instanceof SimpleOauthScopeEntityInterface
        ? (string) $scope->getDescription('authorization_code')
        : '';
      $scopes[] = [
        'name' => $name,
        'description' => (string) ($words[$name] ?? $configured),
      ];
    }
    return $scopes;
  }

  /**
   * What each agent scope allows, keyed by the scope id the request names.
   *
   * A scope's configured description states the permissions it caps, which is
   * what an administrator needs and not what the person deciding does. A scope
   * missing here — anything outside the agent family — is shown by its own
   * description.
   *
   * @return array<string, \Drupal\Core\StringTranslation\TranslatableMarkup>
   *   The scope ids and what they allow.
   */
  private function scopeWords(): array {
    return [
      'agent:read' => $this->t('Read published pages on your behalf.'),
      'agent:read:content' => $this->t('Read published pages.'),
      'agent:read:space' => $this->t('Read pages in the spaces you belong to.'),
      'agent:write' => $this->t('Create and edit pages on your behalf.'),
      'agent:write:content' => $this->t('Edit existing pages.'),
      'agent:write:create' => $this->t('Create new pages.'),
      'agent:write:draft' => $this->t('Save a page as a draft.'),
      'agent:write:format' => $this->t("Write page text in openKB's Markdown."),
      'agent:write:latest' => $this->t('Read the newest version of a page, published or not.'),
      'agent:write:revisions' => $this->t("Read a page's earlier versions."),
      'agent:write:space' => $this->t('Edit pages in the spaces you may edit.'),
      'agent:write:unpublished:any' => $this->t('Read unpublished pages, whoever wrote them.'),
    ];
  }

  /**
   * Where deciding sends the browser next.
   */
  private function callbackUri(AuthorizationRequest $auth_request): string {
    $uri = $auth_request->getRedirectUri();
    if ($uri === NULL || $uri === '') {
      $registered = $auth_request->getClient()->getRedirectUri();
      $uri = is_array($registered) ? (string) reset($registered) : (string) $registered;
    }
    return $uri;
  }

}
