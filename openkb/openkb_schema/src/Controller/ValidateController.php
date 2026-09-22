<?php

declare(strict_types=1);

namespace Drupal\openkb_schema\Controller;

use Drupal\Component\Render\PlainTextOutput;
use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\Core\Entity\EntityRepositoryInterface;
use Drupal\Core\Field\FieldDefinitionInterface;
use Drupal\node\NodeInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\BadRequestHttpException;

/**
 * Dry-run field validation for the frontmatter editing session.
 *
 * Endpoint: POST /openkb/node/{node}/validate with a JSON body of
 * `{"fields": {"<field name>": <value>}}`, where values use the session's
 * frontmatter shapes: scalars as-is, entity references as `{id, label}`
 * objects (id = UUID), multi-value fields as arrays of either.
 *
 * The submitted values are set on the loaded node — which is never saved —
 * and each submitted field is validated through TypedData. The response is
 * `{"errors": {"<field name>": ["message", ...]}}`, empty when everything
 * validates. Advisory only: commit-time validation stays authoritative, this
 * route just lets the editor surface server-side rules while typing.
 *
 * Access mirrors the commit surface: `node.update` entity access, and the
 * request must carry the X-CSRF-Token session token (cookie-authed POST).
 */
final class ValidateController implements ContainerInjectionInterface {

  /**
   * Constructs the validate controller.
   */
  public function __construct(
    private readonly EntityRepositoryInterface $entityRepository,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self($container->get('entity.repository'));
  }

  /**
   * Validates submitted field values against the node without saving.
   */
  public function validate(NodeInterface $node, Request $request): JsonResponse {
    $payload = json_decode($request->getContent(), TRUE);
    $fields = $payload['fields'] ?? NULL;
    if (!is_array($fields)) {
      throw new BadRequestHttpException('Request body must be {"fields": {"<field name>": <value>}}.');
    }

    $errors = [];
    foreach ($fields as $name => $value) {
      if (!is_string($name) || !$node->hasField($name)) {
        $errors[$name][] = sprintf('Unknown field "%s".', $name);
        continue;
      }
      $definition = $node->getFieldDefinition($name);
      $ref_errors = [];
      $node->set($name, $this->mapValue($definition, $value, $ref_errors));
      if ($ref_errors) {
        // An unresolvable reference target can never validate — report it
        // instead of TypedData's opaque "invalid target_id" phrasing, and in
        // the same wording the commit lane uses.
        $errors[$name] = $ref_errors;
        continue;
      }
      foreach ($node->get($name)->validate() as $violation) {
        $errors[$name][] = PlainTextOutput::renderFromHtml((string) $violation->getMessage());
      }
    }

    return new JsonResponse(['errors' => $errors ?: new \stdClass()]);
  }

  /**
   * Maps a session value shape onto the Drupal field value.
   *
   * References arrive as `{id, label}` with a UUID id; each is resolved to
   * its target entity, and one that resolves nowhere collects an error
   * (mirroring the commit lane's message) instead of a field value.
   *
   * @param \Drupal\Core\Field\FieldDefinitionInterface $definition
   *   The field definition.
   * @param mixed $value
   *   The submitted session value.
   * @param string[] $ref_errors
   *   Collects per-reference resolution errors.
   *
   * @return mixed
   *   The value in a shape FieldItemList::setValue() accepts.
   */
  private function mapValue(FieldDefinitionInterface $definition, mixed $value, array &$ref_errors): mixed {
    $storage = $definition->getFieldStorageDefinition();
    if ($storage->getType() !== 'entity_reference') {
      return $value;
    }

    $target_type = (string) $storage->getSetting('target_type');
    if ($value === NULL) {
      return NULL;
    }
    if (!is_array($value)) {
      $ref_errors[] = 'Invalid reference value.';
      return NULL;
    }
    $refs = array_is_list($value) ? $value : [$value];
    $ids = [];
    foreach ($refs as $ref) {
      $uuid = is_array($ref) ? ($ref['id'] ?? NULL) : NULL;
      $label = is_array($ref) ? ($ref['label'] ?? '') : '';
      if (!is_string($uuid) || $uuid === '') {
        $ref_errors[] = 'Invalid reference value.';
        continue;
      }
      $target = $this->entityRepository->loadEntityByUuid($target_type, $uuid);
      if (!$target) {
        $ref_errors[] = sprintf('Referenced %s "%s" does not exist.', $target_type, $label !== '' ? $label : $uuid);
        continue;
      }
      $ids[] = $target->id();
    }
    return $ids;
  }

}
