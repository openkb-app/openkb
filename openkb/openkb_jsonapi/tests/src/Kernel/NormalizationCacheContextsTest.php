<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_jsonapi\Kernel;

use Drupal\Component\Serialization\Yaml;
use Drupal\Core\Cache\Cache;
use Drupal\Core\Cache\CacheableResponseInterface;
use Drupal\Core\DependencyInjection\ContainerBuilder;
use Drupal\Core\Session\AccountInterface;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\Tests\openkb_agent\Kernel\OpenkbRequestKernelTestBase;
use Symfony\Component\HttpFoundation\Response;

/**
 * The renderer's required cache contexts stay off JSON:API normalizations.
 *
 * Core varies every render array by `languages:language_interface`, `theme`
 * and `user.permissions`, and JSON:API renders processed text while
 * normalizing it: a read carrying the body varies by the first two, a read
 * without it does not, and the two shapes then share nothing past the address
 * they are cached under — VariationCache warns about a redirect "with one that
 * has nothing in common". Keeping only `user.permissions` removes the split,
 * and is right while one language and one theme are in use.
 *
 * @group openkb_jsonapi
 */
final class NormalizationCacheContextsTest extends OpenkbRequestKernelTestBase {

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'custom_elements',
    'openkb_schema',
    'openkb_collab_api',
    'openkb_jsonapi',
  ];

  /**
   * The space the page lives in.
   */
  private Space $space;

  /**
   * Gives the test container the parameter the site's services.yml sets.
   *
   * KernelTestBase builds its own container and does not read
   * sites/default/services.yml, so the file is loaded here rather than
   * restated — the assertions below are then about the deployed value.
   */
  public function register(ContainerBuilder $container): void {
    parent::register($container);
    $services = Yaml::decode((string) file_get_contents($this->root . '/sites/default/services.yml'));
    $container->setParameter('renderer.config', $services['parameters']['renderer.config']);
  }

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->importRecipeConfig($this->kbPageConfigNames());
    $this->importRecipeConfig($this->kbSpaceConfigNames());
    $this->importRecipeConfig($this->kbBodyConfigNames());
    $this->importRecipeConfig($this->kbModerationConfigNames());
    $this->container->get('router.builder')->rebuild();

    $this->space = Space::create([
      'label' => 'Engineering',
      'read_access' => 'all_users',
    ]);
    $this->space->save();
  }

  /**
   * The site narrows the renderer's required contexts to the one that varies.
   */
  public function testRequiredCacheContextsAreNarrowedToUserPermissions(): void {
    $this->assertSame(
      ['user.permissions'],
      $this->container->getParameter('renderer.config')['required_cache_contexts'],
    );
  }

  /**
   * A read that carries the body does not vary by theme or interface language.
   *
   * The response carries the normalization's own cacheability, so what is
   * absent here is absent from the normalization cache address.
   */
  public function testBodyReadDoesNotVaryByThemeOrInterfaceLanguage(): void {
    $user = $this->createEditor();
    $this->createPublishedPage($user->id());

    $contexts = $this->cacheContexts($this->read('/jsonapi/node/kb_page', 'title,field_kb_body', $user));
    $this->assertNotContains('theme', $contexts);
    $this->assertNotContains('languages:language_interface', $contexts);
  }

  /**
   * Reads with and without the body share one normalization cache address.
   *
   * Both shapes are written cold — a save invalidates the cached normalization
   * but not the redirects that lead to it — and the individual route adds
   * `url.query_args:consumerId` that the collection route does not. With the
   * renderer's contexts on the body-bearing shape the two have nothing in
   * common past the address they share, and the third read trips the warning.
   */
  public function testAlternatingReadsDoNotCollideInTheNormalizationCache(): void {
    $user = $this->createEditor();
    $page = $this->createPublishedPage($user->id());

    // VariationCache warns through trigger_error(), which a kernel test's
    // error handler never turns into a watchdog row. The handler takes every
    // error level and returns FALSE for anything but the redirect warning, so
    // PHPUnit's own handler still sees the rest.
    $warnings = [];
    set_error_handler(static function (int $severity, string $message) use (&$warnings): bool {
      $is_redirect_warning = $severity === E_USER_WARNING
        && str_contains($message, 'cache redirect');
      if (!$is_redirect_warning) {
        return FALSE;
      }
      $warnings[] = $message;
      return TRUE;
    });
    try {
      $this->read('/jsonapi/node/kb_page/' . $page->uuid(), 'title', $user);
      Cache::invalidateTags($page->getCacheTags());
      $this->read('/jsonapi/node/kb_page', 'title,field_kb_body', $user);
      Cache::invalidateTags($page->getCacheTags());
      $this->read('/jsonapi/node/kb_page/' . $page->uuid(), 'title', $user);
    }
    finally {
      restore_error_handler();
    }

    $this->assertSame([], $warnings);
  }

  /**
   * Reads a JSON:API path with a sparse fieldset, as the given user.
   */
  private function read(string $path, string $fields, AccountInterface $user): Response {
    // A real request starts with an empty process. Both caches memoize the
    // entity's cacheability, and JSON:API feeds an access result back onto the
    // entity, so without this the contexts of one read leak into the next.
    $this->container->get('entity_type.manager')->getStorage('node')->resetCache();
    $this->container->get('entity_type.manager')->getAccessControlHandler('node')->resetCache();

    $response = $this->request(
      $path . '?fields%5Bnode--kb_page%5D=' . rawurlencode($fields),
      $user,
      'GET',
      NULL,
      ['Accept' => 'application/vnd.api+json'],
    );
    $this->assertSame(200, $response->getStatusCode(), (string) $response->getContent());
    return $response;
  }

  /**
   * The cache contexts a response was built with.
   *
   * @return string[]
   *   The cache contexts.
   */
  private function cacheContexts(Response $response): array {
    $this->assertInstanceOf(CacheableResponseInterface::class, $response);
    return $response->getCacheableMetadata()->getCacheContexts();
  }

  /**
   * An account on the space's manager roster.
   */
  private function createEditor(): AccountInterface {
    $account = $this->createUser($this->recipeGrantedPermissions('authenticated'));
    $this->space->get('managers')->appendItem(['target_id' => $account->id()]);
    $this->space->save();
    return $account;
  }

  /**
   * A published page with a body, in the space.
   */
  private function createPublishedPage(string|int $uid): NodeInterface {
    $page = Node::create([
      'type' => 'kb_page',
      'title' => 'Shared page',
      'uid' => $uid,
      'moderation_state' => 'published',
      'field_space' => ['target_id' => $this->space->id()],
      'field_kb_body' => ['value' => 'Published body.', 'format' => 'comark'],
    ]);
    $page->save();
    return $page;
  }

}
