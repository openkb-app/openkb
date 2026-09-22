<?php

declare(strict_types=1);

namespace Drupal\openkb_tools;

use Drupal\Component\Datetime\TimeInterface;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\File\FileSystemInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Site\Settings;
use Drupal\consumers\Entity\Consumer;
use Drupal\simple_oauth\Entities\ClientEntity;
use Drupal\simple_oauth\Entities\ScopeEntity;
use Drupal\simple_oauth_personal_consumers\PersonalConsumerManagerInterface;
use Drupal\user\UserInterface;
use League\OAuth2\Server\CryptKey;
use League\OAuth2\Server\Repositories\AccessTokenRepositoryInterface;

/**
 * Issues the token a relayed call acts under.
 *
 * Drupal is the OAuth server, so it signs the token itself: short-lived, for
 * the chatting account, on the client the chat recipe ships, carrying the
 * scopes that client holds.
 */
final class ChatAgentToken {

  /**
   * The client id of the consumer the chat acts through.
   */
  public const CLIENT_ID = 'openkb_chat';

  /**
   * The consumer label, shown as the `via` of every relayed write.
   */
  public const LABEL = 'OpenKB AI';

  /**
   * Token lifetime, in seconds.
   */
  private const LIFETIME = 300;

  /**
   * How much life a reused token must have left, in seconds.
   */
  private const MARGIN = 60;

  /**
   * One token per account this process acted as.
   *
   * @var array<int, array{token: string, expires: int}>
   */
  private array $issued = [];

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly AccessTokenRepositoryInterface $accessTokens,
    private readonly PersonalConsumerManagerInterface $personalConsumers,
    private readonly ConfigFactoryInterface $configFactory,
    private readonly FileSystemInterface $fileSystem,
    private readonly TimeInterface $time,
  ) {}

  /**
   * Issues the bearer token the frontend authenticates $account by.
   *
   * @throws \Drupal\openkb_tools\ChatIdentityUnavailable
   *   When this site or this account cannot hold one.
   */
  public function issue(AccountInterface $account): string {
    $uid = (int) $account->id();
    $now = $this->time->getCurrentTime();
    $held = $this->issued[$uid] ?? NULL;
    if ($held !== NULL && $held['expires'] - self::MARGIN > $now) {
      return $held['token'];
    }

    $this->assertMayAct($account);
    $consumer = $this->consumer();
    $expires = $now + self::LIFETIME;
    $token = $this->accessTokens->getNewToken(
      new ClientEntity($consumer),
      $this->scopes($consumer),
      (string) $uid,
    );
    $token->setIdentifier(bin2hex(random_bytes(40)));
    $token->setExpiryDateTime(new \DateTimeImmutable('@' . $expires));
    $token->setPrivateKey($this->privateKey());
    $this->accessTokens->persistNewAccessToken($token);
    $bearer = $token->toString();
    $this->issued[$uid] = ['token' => $bearer, 'expires' => $expires];

    return $bearer;
  }

  /**
   * Refuses an administrator.
   *
   * An agent token acts as its owner, so an admin's bypass would pass through
   * it and the scope ceiling would mean nothing.
   */
  private function assertMayAct(AccountInterface $account): void {
    $user = $this->entityTypeManager->getStorage('user')->load($account->id());
    if ($user instanceof UserInterface && $this->personalConsumers->isAdminAccount($user)) {
      throw new ChatIdentityUnavailable('Editing from the chat runs under an agent token, which an administrator account cannot hold. Use an editor account.');
    }
  }

  /**
   * The client the chat acts through.
   */
  private function consumer(): Consumer {
    $found = $this->entityTypeManager->getStorage('consumer')
      ->loadByProperties(['client_id' => self::CLIENT_ID]);
    if ($found === []) {
      throw new ChatIdentityUnavailable(sprintf('This site has no "%s" OAuth client, so the chat cannot act on anybody\'s behalf. Apply the openkb_recipe_chat recipe, which ships it.', self::LABEL));
    }

    return reset($found);
  }

  /**
   * The scopes the client carries, which cap every token issued on it.
   *
   * @param \Drupal\consumers\Entity\Consumer $consumer
   *   The client the chat acts through.
   *
   * @return \Drupal\simple_oauth\Entities\ScopeEntity[]
   *   One entity per scope.
   */
  private function scopes(Consumer $consumer): array {
    /** @var \Drupal\simple_oauth\Plugin\Field\FieldType\Oauth2ScopeReferenceItemListInterface $field */
    $field = $consumer->get('scopes');
    $scopes = $field->getScopes();
    if ($scopes === []) {
      throw new ChatIdentityUnavailable(sprintf('The "%s" OAuth client carries no scope this site defines, so no chat token can be issued.', self::LABEL));
    }

    return array_map(static fn ($scope): ScopeEntity => new ScopeEntity($scope), $scopes);
  }

  /**
   * The site's OAuth2 signing key.
   */
  private function privateKey(): CryptKey {
    $path = (string) $this->configFactory->get('simple_oauth.settings')->get('private_key');
    $contents = $path === '' ? FALSE : @file_get_contents($this->fileSystem->realpath($path) ?: $path);
    if (!is_string($contents) || $contents === '') {
      throw new ChatIdentityUnavailable('The OAuth2 signing key is not readable, so no chat token can be issued.');
    }

    return new CryptKey($contents, NULL, Settings::get('simple_oauth.key_permissions_check', TRUE));
  }

}
