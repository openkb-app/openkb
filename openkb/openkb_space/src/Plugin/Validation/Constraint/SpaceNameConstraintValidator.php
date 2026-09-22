<?php

declare(strict_types=1);

namespace Drupal\openkb_space\Plugin\Validation\Constraint;

use Drupal\Core\DependencyInjection\ContainerInjectionInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Field\FieldItemListInterface;
use Drupal\Core\Path\PathValidatorInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Symfony\Component\DependencyInjection\ContainerInterface;
use Symfony\Component\Validator\Constraint;
use Symfony\Component\Validator\ConstraintValidator;

/**
 * Validates {@see SpaceNameConstraint}.
 */
final class SpaceNameConstraintValidator extends ConstraintValidator implements ContainerInjectionInterface {

  /**
   * Top-level paths the frontend answers at, which Drupal knows no route for.
   *
   * Its own pages and Nitro routes, plus the Drupal directories it proxies,
   * plus `all` — the word that stands for every space wherever one is named,
   * so no space can answer to it. `SpaceReservedNameTest` holds the rest of
   * the list to what the frontend ships.
   */
  public const RESERVED = [
    'access-denied',
    'all',
    'api',
    'ce-api',
    'collaboration',
    'core',
    'files',
    'login',
    'media-library',
    'modules',
    'node',
    'openkb',
    'register',
    'search',
    'sites',
    'themes',
    'user',
    'views',
  ];

  public function __construct(
    private readonly EntityTypeManagerInterface $entityTypeManager,
    private readonly PathValidatorInterface $pathValidator,
  ) {}

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container): self {
    return new self(
      $container->get('entity_type.manager'),
      $container->get('path.validator'),
    );
  }

  /**
   * {@inheritdoc}
   */
  public function validate(mixed $value, Constraint $constraint): void {
    assert($constraint instanceof SpaceNameConstraint);
    if (!$value instanceof FieldItemListInterface) {
      return;
    }
    $space = $value->getEntity();
    $label = (string) $value->value;
    // A missing name is NotNull's to refuse.
    if (!$space instanceof SpaceInterface || $label === '') {
      return;
    }
    $slug = Space::slugify($label);
    if ($slug === '') {
      $this->context->addViolation($constraint->message, ['%label' => $label]);
      return;
    }
    if ($this->isTaken($space, $slug)) {
      return;
    }
    if (in_array($slug, self::RESERVED, TRUE) || $this->isRoute($space, $slug)) {
      $this->context->addViolation($constraint->reservedMessage, ['%label' => $label]);
    }
  }

  /**
   * Whether anything else already answers at the alias, adding core's message.
   */
  private function isTaken(SpaceInterface $space, string $slug): bool {
    // Whether the URL is free is core's question: the alias the save will
    // write goes through the `path_alias` entity's own validation, carrying
    // the space's system path so its current alias is no collision.
    $path_alias = $this->entityTypeManager->getStorage('path_alias')->create([
      'path' => $space->isNew() ? NULL : '/' . $space->toUrl()->getInternalPath(),
      'alias' => '/' . $slug,
      'langcode' => $space->language()->getId(),
    ]);
    $taken = FALSE;
    foreach ($path_alias->validate() as $violation) {
      // Entity-level constraints — uniqueness among them — carry no property
      // path; a field's own complaint about the stand-in is not the space's.
      if ($violation->getPropertyPath() === '') {
        $this->context->buildViolation($violation->getMessageTemplate())
          ->setParameters($violation->getParameters())
          ->addViolation();
        $taken = TRUE;
      }
    }
    return $taken;
  }

  /**
   * Whether a page of the site itself answers at the slug.
   *
   * A space's own alias resolves to its canonical route, so that one match is
   * the space itself rather than a page it would cover.
   */
  private function isRoute(SpaceInterface $space, string $slug): bool {
    $url = $this->pathValidator->getUrlIfValidWithoutAccessCheck('/' . $slug);
    if (!$url || !$url->isRouted()) {
      return FALSE;
    }
    return $url->getRouteName() !== 'entity.openkb_space.canonical'
      || (string) ($url->getRouteParameters()['openkb_space'] ?? '') !== (string) $space->id();
  }

}
