<?php

declare(strict_types=1);

namespace Drupal\openkb_space\Controller;

use Drupal\Component\Serialization\Json;
use Drupal\Core\Controller\ControllerBase;
use Drupal\openkb_space\SpaceInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;
use Symfony\Component\HttpKernel\Exception\ConflictHttpException;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;

/**
 * Restructuring a space's pages: `PUT /openkb/space/{space}/outline`.
 *
 * The tree is one `outline` value on the space, so a drag saves no page and
 * mints no revision. `expect` makes the write compare-and-swap, so one
 * editor's drag cannot carry away another's. What a tree may be is the field's
 * constraints, so only the envelope is read here.
 */
final class OutlineResource extends ControllerBase {

  /**
   * The field carrying the tree.
   */
  private const FIELD = 'outline';

  /**
   * Replaces a space's page tree.
   *
   * @param \Drupal\openkb_space\SpaceInterface $openkb_space
   *   The space, as resolved by the route.
   * @param \Symfony\Component\HttpFoundation\Request $request
   *   The request carrying `{"outline": […], "expect": […]}`.
   *
   * @return \Symfony\Component\HttpFoundation\JsonResponse
   *   The tree as it now stands.
   */
  public function write(SpaceInterface $openkb_space, Request $request): JsonResponse {
    $payload = Json::decode((string) $request->getContent());
    $outline = is_array($payload) ? ($payload['outline'] ?? NULL) : NULL;
    $expect = is_array($payload) ? ($payload['expect'] ?? NULL) : NULL;
    if (!self::isList($outline) || !self::isList($expect)) {
      throw new BadRequestHttpException('Request body must be {"outline": […], "expect": […]}.');
    }

    $stored = $this->storedTree($openkb_space);
    if (self::normalise($expect) !== $stored) {
      throw new ConflictHttpException(
        'The tree changed since it was read, so nothing was written. Read it again and re-apply the move.',
      );
    }

    // Judged as it arrived, so the field constraints answer the caller's tree
    // and not a rewriting of it.
    $openkb_space->set(self::FIELD, Json::encode($outline));
    $violations = $openkb_space->get(self::FIELD)->validate();
    if ($violations->count() > 0) {
      throw new UnprocessableEntityHttpException((string) $violations->get(0)->getMessage());
    }
    // Stored in one spelling, so the value does not vary with how a client
    // writes an empty child list. Every node the constraint passed carries a
    // string id and a list of children, so this only re-spells the tree.
    $openkb_space->set(self::FIELD, Json::encode(self::strip(self::normalise($outline))));
    $openkb_space->save();

    return new JsonResponse(['outline' => $this->storedTree($openkb_space)]);
  }

  /**
   * The tree the field holds, in the one shape a comparison and a client read.
   *
   * @param \Drupal\openkb_space\SpaceInterface $space
   *   The space.
   *
   * @return array
   *   The normalised tree.
   */
  private function storedTree(SpaceInterface $space): array {
    return self::normalise(Json::decode((string) ($space->get(self::FIELD)->value ?? '')));
  }

  /**
   * One canonical reading of a tree, whatever wrote it.
   *
   * A stored tree, an `expect` and a response all pass through this, so an
   * omitted `children`, an explicit empty one and a value the field was
   * hand-mangled with all compare and serialise alike. Mirrors `parseOutline`
   * in `frontend/shared/utils/kb-outline.ts`.
   *
   * @param mixed $nodes
   *   Whatever stood where a sibling list belongs.
   *
   * @return array
   *   The sibling list, each node `{id, children}`.
   */
  private static function normalise(mixed $nodes): array {
    if (!self::isList($nodes)) {
      return [];
    }
    $clean = [];
    foreach ($nodes as $node) {
      if (!is_array($node) || !isset($node['id']) || !is_string($node['id']) || $node['id'] === '') {
        continue;
      }
      $clean[] = ['id' => $node['id'], 'children' => self::normalise($node['children'] ?? [])];
    }
    return $clean;
  }

  /**
   * The stored spelling of a normalised tree: empty `children` left out.
   *
   * @param array $nodes
   *   A normalised sibling list.
   *
   * @return array
   *   The same list, minus the empty child lists.
   */
  private static function strip(array $nodes): array {
    return array_map(
      static fn (array $node): array => $node['children'] === []
        ? ['id' => $node['id']]
        : ['id' => $node['id'], 'children' => self::strip($node['children'])],
      $nodes,
    );
  }

  /**
   * Whether a decoded value is a JSON array rather than an object or a scalar.
   */
  private static function isList(mixed $value): bool {
    return is_array($value) && array_is_list($value);
  }

}
