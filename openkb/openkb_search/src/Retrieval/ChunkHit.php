<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Retrieval;

/**
 * One retrieved chunk, read off the index row and nothing else.
 *
 * Both consumers cite through this shape: the chat's grounding builds its
 * numbered Source from it, the search_pages tool answers it as a hit. No
 * entity is loaded to fill any field.
 */
final class ChunkHit {

  /**
   * Constructs a chunk hit.
   *
   * @param string $entityId
   *   The id of the page the chunk belongs to.
   * @param string $blockId
   *   The id of the chunk's first block, the citation's anchor. A page's lead
   *   section opens on the title heading, so that is its block.
   * @param string $title
   *   The page title.
   * @param string $path
   *   The page's alias.
   * @param string $space
   *   The space the page lives in.
   * @param float $score
   *   The score the backend answered.
   * @param string $excerpt
   *   The chunk's raw text.
   * @param list<string> $headingPath
   *   The headings above the chunk, outermost first.
   * @param int $part
   *   The part, above 0 only where one block was split.
   * @param string $langcode
   *   The page's language.
   * @param int $changed
   *   When the page was last changed, as a Unix timestamp.
   * @param list<string> $highlights
   *   The fragments the lexical clause matched in, each matched word between
   *   the provider's mark characters. Everything but those characters is page
   *   text, and untrusted as such. Empty where the section was found by the
   *   vector clause alone.
   * @param string $type
   *   The page's document type, as the frontmatter's machine name.
   * @param list<string> $tags
   *   The page's tags, by name.
   * @param list<string> $cites
   *   The sources the chunk's blocks cite, as "<nid>" and "<nid>#<block>".
   *   An answer grounded on this section can say what the section itself was
   *   derived from.
   */
  public function __construct(
    public readonly string $entityId,
    public readonly string $blockId,
    public readonly string $title,
    public readonly string $path,
    public readonly string $space,
    public readonly float $score,
    public readonly string $excerpt,
    public readonly array $headingPath = [],
    public readonly int $part = 0,
    public readonly string $langcode = '',
    public readonly int $changed = 0,
    public readonly array $highlights = [],
    public readonly string $type = '',
    public readonly array $tags = [],
    public readonly array $cites = [],
  ) {}

  /**
   * The page path with the anchor a citation lands on.
   */
  public function anchoredPath(): string {
    return $this->blockId === '' ? $this->path : $this->path . '#' . $this->blockId;
  }

  /**
   * The heading path as one line, for a citation's meta line.
   */
  public function headingLine(): string {
    return implode(' › ', $this->headingPath);
  }

  /**
   * The chunk's text without the heading it opens on.
   *
   * The chunker puts a section's heading in front of its text, and every
   * surface names that heading beside the excerpt already. A split block's
   * later parts open mid-section and carry no heading to drop.
   */
  public function prose(): string {
    $heading = $this->headingPath === [] ? '' : $this->headingPath[array_key_last($this->headingPath)];
    if ($this->part > 0 || $heading === '' || !str_starts_with($this->excerpt, $heading . "\n")) {
      return $this->excerpt;
    }
    return ltrim(substr($this->excerpt, strlen($heading)), "\n");
  }

}
