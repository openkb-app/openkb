<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_tools\Traits;

use Mcp\Schema\JsonRpc\Error;
use Mcp\Schema\JsonRpc\Response;
use Mcp\Schema\Request\CallToolRequest;
use Mcp\Schema\Request\ListToolsRequest;
use Mcp\Server;
use Mcp\Server\Handler\Request\CallToolHandler;
use Mcp\Server\Handler\Request\ListToolsHandler;
use Mcp\Server\Session\SessionInterface;

/**
 * Reads Drupal's MCP endpoint as the current account sees it.
 *
 * The SDK exposes no accessor for a built server's request handlers, so they
 * are reached by reflection; that is the whole reason this is a trait rather
 * than a couple of calls.
 */
trait McpSurfaceTrait {

  /**
   * Builds the server as the current account sees it.
   */
  protected function buildServer(): Server {
    return $this->container->get('mcp_server.server.factory')->create();
  }

  /**
   * Everything tools/list advertises.
   *
   * @return object[]
   *   The tools.
   */
  protected function tools(Server $server): array {
    return $this->handler($server, ListToolsHandler::class)->handle(
      ListToolsRequest::fromArray(['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/list']),
      $this->createMock(SessionInterface::class),
    )->result->tools;
  }

  /**
   * The tools tools/list reports.
   *
   * @return string[]
   *   The names.
   */
  protected function toolNames(Server $server): array {
    return array_map(static fn ($tool): string => $tool->name, $this->tools($server));
  }

  /**
   * One advertised tool, by name.
   */
  protected function tool(Server $server, string $name): object {
    foreach ($this->tools($server) as $tool) {
      if ($tool->name === $name) {
        return $tool;
      }
    }
    $this->fail(sprintf('Tool "%s" is not advertised.', $name));
  }

  /**
   * Sends one tools/call and returns whatever the SDK answers.
   */
  protected function call(Server $server, string $name, array $arguments): Response|Error {
    return $this->handler($server, CallToolHandler::class)->handle(
      CallToolRequest::fromArray([
        'jsonrpc' => '2.0',
        'id' => 1,
        'method' => 'tools/call',
        'params' => ['name' => $name, 'arguments' => $arguments],
      ]),
      $this->createMock(SessionInterface::class),
    );
  }

  /**
   * Reflects into the built server for one of its request handlers.
   *
   * @param \Mcp\Server $server
   *   The built server.
   * @param class-string $class
   *   The handler class to find.
   */
  protected function handler(Server $server, string $class): object {
    $protocol = (new \ReflectionProperty($server, 'protocol'))->getValue($server);
    foreach ((new \ReflectionProperty($protocol, 'requestHandlers'))->getValue($protocol) as $handler) {
      if ($handler instanceof $class) {
        return $handler;
      }
    }
    $this->fail($class . ' not found in server protocol.');
  }

}
