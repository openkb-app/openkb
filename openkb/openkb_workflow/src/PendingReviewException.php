<?php

declare(strict_types=1);

namespace Drupal\openkb_workflow;

use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * A publication refused because changes are still waiting for review.
 *
 * Carries the blockers rather than a sentence about them: the editor's drawer
 * has to name the changes and say what each owes, and a client that has to
 * scrape ids out of prose has a contract that rots the first time the wording
 * changes. \Drupal\openkb_workflow\EventSubscriber\PendingReviewSubscriber
 * renders it.
 */
final class PendingReviewException extends HttpException {

  /**
   * Constructs the refusal.
   *
   * @param array<string, string[]> $blockers
   *   Review item => the steps it is pending on.
   */
  public function __construct(
    public readonly array $blockers,
  ) {
    parent::__construct(422, self::sentence($blockers));
  }

  /**
   * The refusal in the words the editor is shown, on the button and in a toast.
   *
   * @param array<string, string[]> $blockers
   *   Review item => the steps it is pending on.
   *
   * @return string
   *   The sentence.
   */
  public static function sentence(array $blockers): string {
    return sprintf(
      '%d change(s) are waiting for review: %s.',
      count($blockers),
      implode(', ', array_map(
        static fn (string $id): string => PageBlocks::itemName($id),
        array_keys($blockers),
      )),
    );
  }

  /**
   * The refusal as an error document — one error object per blocking change.
   *
   * `meta.item` is the sidecar key, which is what a client names back when it
   * signs the change off: a block id, a removed block's id, or a reviewed
   * field's entry.
   *
   * @return array
   *   The response document.
   */
  public function toDocument(): array {
    $errors = [];
    foreach ($this->blockers as $id => $steps) {
      $title = $id === PageBlocks::FIELD_TITLE;
      $errors[] = [
        'status' => '422',
        'title' => 'Unprocessable Content',
        'detail' => sprintf(
          '%s is waiting for: %s.',
          PageBlocks::itemName($id),
          implode(', ', $steps),
        ),
        'source' => [
          'pointer' => $title
            ? '/data/attributes/title'
            : '/data/attributes/field_kb_body/' . $id,
        ],
        'meta' => ['item' => $id, 'steps' => $steps],
      ];
    }
    return ['errors' => $errors];
  }

}
