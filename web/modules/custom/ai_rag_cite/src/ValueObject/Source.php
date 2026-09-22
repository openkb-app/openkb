<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite\ValueObject;

/**
 * One retrieved passage, as the model reads it and the client cites it.
 */
readonly class Source {

  /**
   * Constructs a source.
   *
   * @param string $entityId
   *   What the per-entity cap counts by. A chunked index answers several
   *   passages of the same page and they share this id.
   * @param string $title
   *   The title an answer names the source by.
   * @param string $path
   *   Where the source is read in full.
   * @param string $meta
   *   One line placing the source, shown next to the title.
   * @param string $excerpt
   *   The text the model reads and grounds its claims on.
   * @param float $score
   *   How well the source matched, on the retriever's own scale.
   * @param list<string> $cites
   *   What the passage itself cites, in whatever form the retriever's index
   *   names a source. Empty where the retriever knows of none.
   */
  public function __construct(
    public string $entityId,
    public string $title,
    public string $path,
    public string $meta,
    public string $excerpt,
    public float $score,
    public array $cites = [],
  ) {}

  /**
   * The source as the client renders it, numbered by its place in the list.
   *
   * @param int $number
   *   The `[n]` the answer cites this source by.
   *
   * @return array<string, mixed>
   *   The citation.
   */
  public function toCitation(int $number): array {
    return [
      'n' => $number,
      'title' => $this->title,
      'path' => $this->path,
      'meta' => $this->meta,
      'score' => $this->score,
    ];
  }

}
