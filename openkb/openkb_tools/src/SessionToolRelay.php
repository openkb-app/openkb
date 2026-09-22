<?php

declare(strict_types=1);

namespace Drupal\openkb_tools;

use Drupal\Core\Config\ConfigFactoryInterface;
use Drupal\Core\Logger\LoggerChannelInterface;
use Drupal\Core\Render\Markup;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\Core\Utility\Error;
use Drupal\lupus_decoupled_ce_api\BaseUrlProvider;
use Drupal\tool\ExecutableResult;
use GuzzleHttp\ClientInterface;

/**
 * Runs a session-bound tool by asking the frontend to run it.
 *
 * A JSON-RPC `tools/call` to the frontend's `/api/mcp`, under a token issued
 * for the chatting account. The session's own refusals come back as results
 * the model acts on, never as errors.
 */
final class SessionToolRelay {

  /**
   * Where the frontend serves MCP, under its base URL.
   */
  private const ENDPOINT_PATH = '/api/mcp';

  /**
   * How long one relayed call may take, in seconds.
   */
  private const TIMEOUT = 30;

  public function __construct(
    private readonly ClientInterface $httpClient,
    private readonly ConfigFactoryInterface $configFactory,
    private readonly ChatAgentToken $tokens,
    private readonly LoggerChannelInterface $logger,
    private readonly ?BaseUrlProvider $baseUrls = NULL,
  ) {}

  /**
   * Calls one session tool and maps its answer onto a tool result.
   *
   * $tool is the frontend's name for it, e.g. "updateBlocks"; the arguments go
   * through as given, and the answer's structured content comes back under the
   * $output definition.
   */
  public function call(string $tool, array $arguments, string $output, AccountInterface $account): ExecutableResult {
    $endpoint = $this->endpoint();
    if ($endpoint === '') {
      return ExecutableResult::failure(new TranslatableMarkup('This knowledge base has no editing frontend configured, so its live editing session cannot be reached.'));
    }

    try {
      $bearer = $this->tokens->issue($account);
    }
    catch (ChatIdentityUnavailable $e) {
      return ExecutableResult::failure($this->said($e->getMessage()));
    }

    try {
      $response = $this->httpClient->request('POST', $endpoint, [
        'headers' => [
          'Authorization' => 'Bearer ' . $bearer,
          // The MCP streamable-HTTP transport answers 406 to a POST whose
          // Accept lists anything less than both of these.
          'Accept' => 'application/json, text/event-stream',
        ],
        'json' => [
          'jsonrpc' => '2.0',
          'id' => 1,
          'method' => 'tools/call',
          'params' => ['name' => $tool, 'arguments' => (object) $arguments],
        ],
        'timeout' => self::TIMEOUT,
        // A 4xx is the session answering; only a transport failure or a 5xx
        // says it could not be reached.
        'http_errors' => FALSE,
      ]);
      $status = $response->getStatusCode();
      $decoded = json_decode((string) $response->getBody(), TRUE);
      $body = is_array($decoded) ? $decoded : [];
    }
    catch (\Throwable $e) {
      Error::logException($this->logger, $e);
      return $this->unreachable();
    }

    if ($status >= 500) {
      $this->logger->error('The editing session answered @status to a @tool call.', [
        '@status' => $status,
        '@tool' => $tool,
      ]);
      return $this->unreachable();
    }
    if ($status >= 400) {
      return ExecutableResult::failure($this->said(
        $this->refusalText($body) ?? sprintf('The editing session refused the call (%d).', $status),
      ));
    }
    // A 200 whose body is not JSON carries no result, so the session is as
    // good as unreachable and the caller is told so.
    if (!is_array($decoded)) {
      $this->logger->error('The editing session answered a @tool call with a body that is not JSON: @content_type.', [
        '@tool' => $tool,
        '@content_type' => $response->getHeaderLine('Content-Type') ?: 'no content type',
      ]);
      return $this->unreachable();
    }

    return $this->result($body, $output);
  }

  /**
   * The failure a frontend that did not answer leaves the caller with.
   */
  private function unreachable(): ExecutableResult {
    return ExecutableResult::failure(new TranslatableMarkup("The knowledge base frontend, where this page's editing session runs, could not be reached. The error has been logged."));
  }

  /**
   * What a refusal says, if it says anything.
   *
   * A JSON-RPC envelope words it under error.message, an H3 refusal under
   * statusMessage.
   */
  private function refusalText(array $body): ?string {
    $candidates = [
      $body['error']['message'] ?? NULL,
      $body['statusMessage'] ?? NULL,
      $body['message'] ?? NULL,
      $body['error'] ?? NULL,
    ];
    foreach ($candidates as $text) {
      if (is_string($text) && $text !== '') {
        return $text;
      }
    }

    return NULL;
  }

  /**
   * The JSON-RPC answer as a tool result.
   */
  private function result(array $body, string $output): ExecutableResult {
    if (isset($body['error'])) {
      return ExecutableResult::failure($this->said(
        $this->refusalText($body) ?? 'The editing session refused the call.',
      ));
    }

    $result = is_array($body['result'] ?? NULL) ? $body['result'] : [];
    $structured = is_array($result['structuredContent'] ?? NULL) ? $result['structuredContent'] : [];
    $message = $this->said($this->text($result));
    // A refusal keeps its structured content: the retry is built from it.
    $values = $structured === [] ? [] : [$output => $structured];

    return !empty($result['isError'])
      ? ExecutableResult::failure($message, $values)
      : ExecutableResult::success($message, $values);
  }

  /**
   * What the session said, as a result message.
   *
   * Passed through rather than placed: the text is a page's markdown on its
   * way to the model as JSON, and a placeholder would escape every quote.
   */
  private function said(string $text): TranslatableMarkup {
    return new TranslatableMarkup('@message', ['@message' => Markup::create($text)]);
  }

  /**
   * The prose the session answered with.
   */
  private function text(array $result): string {
    foreach ($result['content'] ?? [] as $part) {
      if (is_array($part) && ($part['type'] ?? '') === 'text' && ($part['text'] ?? '') !== '') {
        return (string) $part['text'];
      }
    }

    return 'The editing session answered without saying anything.';
  }

  /**
   * Where the frontend answers a relayed call.
   *
   * The setting names the in-network origin, because the call carries a Bearer
   * and the public host may be behind Basic auth. Unset, the configured
   * frontend base URL serves.
   */
  private function endpoint(): string {
    $configured = trim((string) $this->configFactory->get('openkb_tools.settings')->get('session_endpoint'));
    if ($configured !== '') {
      return $configured;
    }
    $base = rtrim((string) $this->baseUrls?->getFrontendBaseUrl(), '/');

    return $base === '' ? '' : $base . self::ENDPOINT_PATH;
  }

}
