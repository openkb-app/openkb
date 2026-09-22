<?php

declare(strict_types=1);

namespace Drupal\openkb_collab_api\Drush\Commands;

use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Password\PasswordGeneratorInterface;
use Drupal\user\UserInterface;
use Drush\Attributes as CLI;
use Drush\Commands\AutowireTrait;
use Drush\Commands\DrushCommands;

/**
 * Provisions the OAuth clients a deployment needs from its environment.
 *
 * Idempotent by client id: a re-run brings an existing consumer to the shape
 * its options describe, secret included — so a secret rotated in the
 * environment reaches the site on the next deploy.
 */
final class OAuthConsumerCommands extends DrushCommands {

  use AutowireTrait;

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly PasswordGeneratorInterface $passwordGenerator,
  ) {
    parent::__construct();
  }

  /**
   * Creates or updates an OAuth consumer and its service user.
   *
   * @param string $label
   *   The consumer's human-readable label.
   * @param array $options
   *   The command options.
   */
  #[CLI\Command(name: 'okb:create-oauth-consumer')]
  #[CLI\Argument(name: 'label', description: 'The human-readable label for the consumer.')]
  #[CLI\Option(name: 'client-id', description: 'The OAuth client ID.')]
  #[CLI\Option(name: 'secret', description: 'The OAuth client secret; hashed on save.')]
  #[CLI\Option(name: 'secret-env', description: 'Name of an environment variable holding the secret, read instead of --secret so it never reaches the process list.')]
  #[CLI\Option(name: 'user', description: 'The service account name, created if missing.')]
  #[CLI\Option(name: 'role', description: 'The role the service account holds.')]
  #[CLI\Option(name: 'scopes', description: 'Comma-separated OAuth scope IDs.')]
  #[CLI\Option(name: 'grant-types', description: 'Comma-separated OAuth grant types.')]
  #[CLI\Usage(
    name: 'drush okb:create-oauth-consumer "Collaboration server" --client-id=$OKB_COLLAB_CLIENT_ID --secret-env=OKB_COLLAB_CLIENT_SECRET --user=collab_server --role=collab_server --scopes=collab',
    description: 'Provisions the collaboration server\'s own OAuth client.',
  )]
  public function createOauthConsumer(
    string $label,
    array $options = [
      'client-id' => self::REQ,
      'secret' => self::REQ,
      'secret-env' => self::REQ,
      'user' => self::REQ,
      'role' => self::REQ,
      'scopes' => NULL,
      'grant-types' => 'client_credentials',
    ],
  ): void {
    $secret = $options['secret-env']
      ? (string) getenv((string) $options['secret-env'])
      : (string) $options['secret'];

    // `self::REQ` only means the option takes a value: an unset environment
    // variable arrives as an empty string, so emptiness is checked here.
    $required = [
      'client-id' => $options['client-id'],
      'secret' => $secret,
      'user' => $options['user'],
      'role' => $options['role'],
    ];
    foreach ($required as $option => $value) {
      if (trim((string) $value) === '') {
        throw new \InvalidArgumentException("--$option is required and must not be empty.");
      }
    }
    if (!$this->entityTypeManager->hasDefinition('consumer')) {
      throw new \RuntimeException('The consumer entity type is not available. Is simple_oauth installed?');
    }

    $client_id = trim((string) $options['client-id']);
    $user = $this->serviceUser(trim((string) $options['user']), trim((string) $options['role']));
    $values = [
      'label' => $label,
      'secret' => $secret,
      'user_id' => $user->id(),
      'owner_id' => $user->id(),
      'confidential' => TRUE,
      'is_default' => FALSE,
      'third_party' => FALSE,
      'grant_types' => array_map('trim', explode(',', (string) $options['grant-types'])),
    ];
    // Set on every run, empty option included: converging means the consumer
    // ends up with the scopes the options name and no others.
    $scopes = array_filter(array_map('trim', explode(',', (string) $options['scopes'])));
    $values['scopes'] = array_map(
      static fn (string $id) => ['scope_id' => $id],
      array_values($scopes),
    );

    $storage = $this->entityTypeManager->getStorage('consumer');
    $existing = $storage->loadByProperties(['client_id' => $client_id]);
    if (count($existing) > 1) {
      throw new \RuntimeException("Client id \"$client_id\" is on more than one consumer; refusing to guess which one to converge.");
    }
    if ($existing !== []) {
      $consumer = reset($existing);
      foreach ($values as $field => $value) {
        $consumer->set($field, $value);
      }
      $consumer->save();
      $this->logger()?->notice('Updated OAuth consumer "{label}" ({client_id}).', [
        'label' => $label,
        'client_id' => $client_id,
      ]);
      return;
    }

    $storage->create(['client_id' => $client_id] + $values)->save();
    $this->logger()?->notice('Created OAuth consumer "{label}" ({client_id}).', [
      'label' => $label,
      'client_id' => $client_id,
    ]);
  }

  /**
   * The service account the consumer acts as, created if it is not there.
   *
   * Its password is random and never used: a `client_credentials` token
   * authenticates the client id and secret, never a login.
   *
   * @param string $name
   *   The account name.
   * @param string $role
   *   The role it holds, ensured on an account that already exists.
   *
   * @return \Drupal\user\UserInterface
   *   The account.
   */
  private function serviceUser(string $name, string $role): UserInterface {
    $storage = $this->entityTypeManager->getStorage('user');
    $existing = $storage->loadByProperties(['name' => $name]);
    if ($existing !== []) {
      /** @var \Drupal\user\UserInterface $user */
      $user = reset($existing);
      if (!in_array($role, $user->getRoles(), TRUE)) {
        $user->addRole($role);
        $user->save();
        $this->logger()?->notice('Granted "{role}" to service user "{name}".', [
          'role' => $role,
          'name' => $name,
        ]);
      }
      return $user;
    }

    /** @var \Drupal\user\UserInterface $user */
    $user = $storage->create([
      'name' => $name,
      'mail' => $name . '@openkb.invalid',
      'pass' => $this->passwordGenerator->generate(32),
      'status' => TRUE,
      'roles' => [$role],
    ]);
    $user->save();
    $this->logger()?->notice('Created service user "{name}".', ['name' => $name]);
    return $user;
  }

}
