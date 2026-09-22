<?php

declare(strict_types=1);

namespace Drupal\openkb_media_library\Controller;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Asset\AssetCollectionRendererInterface;
use Drupal\Core\Cache\RefinableCacheableDependencyInterface;
use Drupal\Core\Asset\AssetResolverInterface;
use Drupal\Core\Asset\AttachedAssets;
use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\Core\Language\LanguageManagerInterface;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\Theme\ThemeManagerInterface;
use Drupal\Core\Url;
use Drupal\media_library\MediaLibraryOpenerInterface;
use Drupal\media_library\MediaLibraryState;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;

/**
 * Serves the Drupal assets the decoupled editor needs for the media dialog.
 *
 * The editor page is a Nuxt app on another vhost; to open Drupal's own
 * media-library dialog in that page it needs Drupal's dialog JS/CSS and
 * drupalSettings. This endpoint resolves a fixed library set through the
 * standard asset pipeline (aggregation-aware, admin theme via
 * _admin_route so the dialog renders native Claro) and returns:
 *
 * - dialogUrl: the media_library.ui URL with a server-built
 *   MediaLibraryState (opener id + access hash) — the frontend never
 *   constructs state.
 * - css / js: root-relative asset URLs, in load order.
 * - settings: drupalSettings incl. ajaxPageState (theme + theme_token +
 *   loaded libraries), so subsequent Drupal.ajax requests render their
 *   responses in the same theme and only deliver missing libraries.
 *
 * All URLs are root-relative: the frontend serves them same-origin through
 * its Nitro proxy, which keeps Drupal's dialog JS unmodified (no CORS).
 */
final class EditorAssetsController implements ContainerInjectionInterface {

  /**
   * Libraries the editor page needs before it can call Drupal.ajax.
   *
   * Dialog content itself (views, media_library UI libraries) arrives via
   * the AJAX response, diffed against ajaxPageState from this set.
   */
  private const LIBRARIES = [
    'core/drupal',
    'core/drupal.ajax',
    'core/drupal.dialog.ajax',
    'openkb_media_library/selection',
  ];

  public function __construct(
    private readonly AssetResolverInterface $assetResolver,
    private readonly AssetCollectionRendererInterface $cssCollectionRenderer,
    private readonly AssetCollectionRendererInterface $jsCollectionRenderer,
    private readonly ConfigFactoryInterface $configFactory,
    private readonly LanguageManagerInterface $languageManager,
    private readonly ThemeManagerInterface $themeManager,
    private readonly MediaLibraryOpenerInterface $opener,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): static {
    return new static(
      $container->get('asset.resolver'),
      $container->get('asset.css.collection_renderer'),
      $container->get('asset.js.collection_renderer'),
      $container->get('config.factory'),
      $container->get('language_manager'),
      $container->get('theme.manager'),
      $container->get('openkb_media_library.opener'),
    );
  }

  /**
   * Route access: the opener's own entity-access check, nothing else.
   *
   * The manifest is only useful together with the state it carries, so the
   * gate is the same one media_library.ui runs for that state: the opener
   * delegates to update access on the target page (?nid=). Anonymous and
   * read-only users fail the real node-access check — no extra permission.
   */
  public function access(AccountInterface $account, Request $request): AccessResultInterface {
    $nid = $request->query->get('nid');
    $access = is_numeric($nid)
      ? $this->opener->checkAccess($this->buildState((int) $nid), $account)
      : AccessResult::forbidden('The nid query parameter is required.');
    if ($access instanceof RefinableCacheableDependencyInterface) {
      $access->addCacheContexts(['url.query_args:nid']);
    }
    return $access;
  }

  /**
   * Builds the media-library state the manifest hands to the frontend.
   *
   * Server-built only — the frontend never constructs state, it just echoes
   * the hash-protected query the dialog URL carries.
   */
  private function buildState(int $nid): MediaLibraryState {
    return MediaLibraryState::create(
      'openkb_media_library.opener',
      ['image'],
      'image',
      // Unlimited selection; the editor inserts one embed per selected
      // media.
      -1,
      // The access decision rides on the target page: the opener checks
      // update access on this node. String-typed: the hash serializes the
      // parameters, and on the dialog request they arrive query-parsed as
      // strings — an int here would never validate.
      ['nid' => (string) $nid],
    );
  }

  /**
   * Builds the asset manifest.
   */
  public function build(Request $request): JsonResponse {
    $state = $this->buildState((int) $request->query->get('nid'));
    $dialog_url = Url::fromRoute('media_library.ui')
      ->setOption('query', $state->all())
      ->toString(TRUE)
      ->getGeneratedUrl();

    // The dialog's AJAX response only delivers libraries its own render
    // attaches; the theme's global libraries normally come from the page —
    // include them here so the dialog gets the native admin look.
    $theme_libraries = $this->themeManager->getActiveTheme()->getLibraries();
    $assets = AttachedAssets::createFromRenderArray([
      '#attached' => ['library' => array_merge(self::LIBRARIES, $theme_libraries)],
    ]);
    $performance = $this->configFactory->get('system.performance');
    $language = $this->languageManager->getCurrentLanguage();

    $css_collection = $this->assetResolver->getCssAssets($assets, (bool) $performance->get('css.preprocess'), $language);
    [$js_header, $js_footer] = $this->assetResolver->getJsAssets($assets, (bool) $performance->get('js.preprocess'), $language);

    // The resolver injects drupalSettings as a synthetic inline asset; pull
    // the settings out — the manifest carries them as data, the frontend
    // writes the drupal-settings-json script tag itself.
    $settings = ($js_header['drupalSettings'] ?? $js_footer['drupalSettings'] ?? ['data' => []])['data'];
    unset($js_header['drupalSettings'], $js_footer['drupalSettings']);

    // Root-relative only: aggregate URLs come out absolute when
    // file_public_base_url is configured absolute; the frontend must load
    // everything same-origin through its proxy.
    $relativize = static fn (string $url): string => preg_replace('#^https?://[^/]+#', '', $url);

    $css_urls = [];
    foreach ($this->cssCollectionRenderer->render($css_collection) as $element) {
      if (!empty($element['#attributes']['href'])) {
        $css_urls[] = $relativize($element['#attributes']['href']);
      }
    }
    $js_urls = [];
    foreach ($this->jsCollectionRenderer->render(array_merge($js_header, $js_footer)) as $element) {
      if (!empty($element['#attributes']['src'])) {
        $js_urls[] = $relativize($element['#attributes']['src']);
      }
    }

    // Per-session content (theme_token); never cache across users.
    return new JsonResponse([
      'dialogUrl' => $dialog_url,
      'css' => $css_urls,
      'js' => $js_urls,
      'settings' => $settings,
    ], 200, ['Cache-Control' => 'no-store, private']);
  }

}
