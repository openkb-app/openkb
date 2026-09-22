<?php

declare(strict_types=1);

namespace Drupal\comark;

/**
 * The entity boundary between stored comark and a model.
 *
 * The stored body carries the serializer's `&amp;`, `&lt;` and `&gt;`; a tool
 * hands a model the plain characters. Decode only: no Drupal tool takes page
 * content from a model, so the frontend owns the encode.
 * See docs/adr/0014-wire-format-keeps-html-entities.md.
 */
final class ComarkEntities {

  /**
   * Opens or closes a fenced code block.
   */
  private const FENCE = '/^ {0,3}(`{3,}|~{3,})/';

  /**
   * Stored comark => what a model reads.
   *
   * Code is left as the serializer wrote it. Indented code is not recognised:
   * the serializer writes fenced blocks.
   *
   * @param string $markdown
   *   The stored body.
   *
   * @return string
   *   The body spelled with the characters the entities stand for.
   */
  public static function decode(string $markdown): string {
    $out = [];
    $prose = [];
    $fence = NULL;
    foreach (explode("\n", $markdown) as $line) {
      $marker = preg_match(self::FENCE, $line, $matches) === 1 ? $matches[1] : NULL;
      if ($fence !== NULL) {
        $out[] = $line;
        if ($marker !== NULL && $marker[0] === $fence[0] && strlen($marker) >= strlen($fence)) {
          $fence = NULL;
        }
        continue;
      }
      if ($marker !== NULL) {
        self::flush($out, $prose);
        $out[] = $line;
        $fence = $marker;
        continue;
      }
      $prose[] = $line;
    }
    self::flush($out, $prose);
    return implode("\n", $out);
  }

  /**
   * Moves the pending prose lines into the output, decoded.
   *
   * @param string[] $out
   *   The lines written so far.
   * @param string[] $prose
   *   The pending prose lines.
   */
  private static function flush(array &$out, array &$prose): void {
    if ($prose !== []) {
      $out[] = self::decodeOutsideCodeSpans(implode("\n", $prose));
    }
    $prose = [];
  }

  /**
   * Decodes everything outside code spans; a run that never closes is text.
   */
  private static function decodeOutsideCodeSpans(string $text): string {
    preg_match_all('/`+/', $text, $matches, PREG_OFFSET_CAPTURE);
    $runs = $matches[0];
    $count = count($runs);
    $out = '';
    $at = 0;
    for ($i = 0; $i < $count; $i++) {
      [$run, $start] = $runs[$i];
      for ($j = $i + 1; $j < $count; $j++) {
        if (strlen($runs[$j][0]) !== strlen($run)) {
          continue;
        }
        $closed = $runs[$j][1] + strlen($runs[$j][0]);
        $out .= self::decodeText(substr($text, $at, $start - $at))
          . substr($text, $start, $closed - $start);
        $at = $closed;
        $i = $j;
        continue 2;
      }
    }
    return $out . self::decodeText(substr($text, $at));
  }

  /**
   * The serializer's codec, run backwards: one level, `&` last.
   */
  private static function decodeText(string $text): string {
    return str_replace(
      ['&lt;', '&gt;', '&quot;', '&amp;'],
      ['<', '>', '"', '&'],
      $text,
    );
  }

}
