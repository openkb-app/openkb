<?php

namespace drunomics\Composer;

use Composer\Composer;
use Composer\Script\Event;
use Composer\Util\StreamContextFactory;
use Symfony\Component\Filesystem\Filesystem;

/**
 * Scripthandler for installing (development) tools.
 */
class PharInstaller {

  /**
   * Install phar tools as noted in the extra tools section.
   *
   * This is like tm/tooly-composer-script but faster.
   *
   * @param \Composer\Script\Event $event
   */
  public static function installPharTools(Event $event) {
    $fs = new Filesystem();
    $composer = $event->getComposer();
    $bin_dir = $composer->getConfig()->get('bin-dir');
    $extras = $composer->getPackage()->getExtra();

    if (array_key_exists('tools', $extras)) {
      foreach ($extras['tools'] as $tool => $data) {
        if (empty($data['url'])) {
          throw new \LogicException("Missing tool url.");
        }
        if (!empty($data['dev']) && !$event->isDevMode()) {
          continue;
        }
        $filename = basename($data['url']) . '-' . $data['version'];

        if (!$fs->exists("$bin_dir/$filename")) {
          if (!$fs->exists($bin_dir)) {
            $fs->mkdir($bin_dir);
          }
          $event->getIO()->write("<info>Downloading $filename...</info>");
          $content = static::download($data['url'], $composer);
          $fs->dumpFile("$bin_dir/$filename", $content);
          $fs->chmod("$bin_dir/$filename", 0755);

          if ($fs->exists("$bin_dir/$tool")) {
            $fs->remove("$bin_dir/$tool");
          }
          $fs->symlink($filename, "$bin_dir/$tool");
        }
      }
    }
  }

  /**
   * Downloads a tool binary.
   *
   * GitHub release-asset URLs
   * (https://github.com/<o>/<r>/releases/download/...) are fetched via the
   * api.github.com release-asset endpoint instead of the github.com web host.
   * The web tier intermittently returns edge 504s for some CI egress IPs (and
   * applies stricter unauthenticated limits), whereas the API host and its
   * *.githubusercontent.com asset CDN are independent of it. Uses the
   * github-oauth token Composer already holds (when present) for the API
   * metadata request. Falls back to the original URL on any failure.
   */
  protected static function download($url, ?Composer $composer = NULL) {
    if (preg_match('#^https://github\.com/([^/]+)/([^/]+)/releases/download/([^/]+)/(.+)$#', $url, $m)) {
      try {
        return static::downloadGithubReleaseAsset($m[1], $m[2], $m[3], $m[4], static::githubToken($composer));
      }
      catch (\RuntimeException $e) {
        // Fall back to the direct github.com URL below (legacy behaviour).
      }
    }
    return static::httpGet($url);
  }

  /**
   * Resolves the configured github.com OAuth token, if any.
   */
  protected static function githubToken(?Composer $composer) {
    if (!$composer) {
      return NULL;
    }
    $oauth = $composer->getConfig()->get('github-oauth') ?: [];
    return $oauth['github.com'] ?? NULL;
  }

  /**
   * Fetches a GitHub release asset via api.github.com.
   *
   * The binary itself is fetched without an Authorization header: the API
   * 302-redirects to a pre-signed CDN URL that rejects an extra auth header,
   * and these tools live in public repos. The token (when present) only
   * authenticates the metadata lookup to relax unauthenticated rate limits.
   */
  protected static function downloadGithubReleaseAsset($owner, $repo, $tag, $name, $token) {
    $headers = ['Accept: application/vnd.github+json'];
    if ($token) {
      $headers[] = 'Authorization: token ' . $token;
    }
    $meta = static::httpGet("https://api.github.com/repos/$owner/$repo/releases/tags/" . rawurlencode($tag), $headers);
    $release = json_decode($meta, TRUE);
    if (!is_array($release) || empty($release['assets'])) {
      throw new \RuntimeException("No release assets for $owner/$repo@$tag.");
    }
    foreach ($release['assets'] as $asset) {
      if (isset($asset['name'], $asset['url']) && $asset['name'] === $name) {
        return static::httpGet($asset['url'], ['Accept: application/octet-stream']);
      }
    }
    throw new \RuntimeException("Release asset '$name' not found in $owner/$repo@$tag.");
  }

  /**
   * HTTP GET via Composer's stream context (proxy/TLS aware), with retries.
   */
  protected static function httpGet($url, array $headers = []) {
    $headers[] = 'User-Agent: drunomics phar-installer';
    $options = [
      'http' => [
        'header' => $headers,
        'follow_location' => 1,
        'max_redirects' => 5,
        'timeout' => 60,
      ],
    ];
    $last = 'no response';
    for ($attempt = 1; $attempt <= 3; $attempt++) {
      $context = StreamContextFactory::getContext($url, $options);
      $content = @file_get_contents($url, FALSE, $context);
      if ($content !== FALSE && $content !== '') {
        return $content;
      }
      if (isset($http_response_header[0])) {
        $last = $http_response_header[0];
      }
      if ($attempt < 3) {
        // Brief backoff for transient 5xx / network blips.
        sleep($attempt * 2);
      }
    }
    throw new \RuntimeException("Failed to download $url ($last).");
  }

}
