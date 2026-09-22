<?php

declare(strict_types=1);

namespace Drupal\Tests\comark\Unit;

use Drupal\Tests\UnitTestCase;
use Drupal\comark\ComarkEntities;

/**
 * The entity boundary a Drupal read hands a model (ADR 0014).
 *
 * The cases mirror the frontend helper's
 * (frontend/server/utils/comark-entities.test.ts): both runtimes decode with
 * the one codec the editor's serializer encodes with, and both leave code
 * alone.
 *
 * @group comark
 */
final class ComarkEntitiesTest extends UnitTestCase {

  /**
   * The stored spelling and what a model reads instead.
   *
   * @return array<string, array{string, string}>
   *   Case name => [stored, decoded].
   */
  public static function bodies(): array {
    return [
      'the specials' => [
        'Wiki &amp; AI, 5 &lt; 6, 7 &gt; 6',
        'Wiki & AI, 5 < 6, 7 > 6',
      ],
      'a tag kept as text' => ['&lt;span&gt;x&lt;/span&gt;', '<span>x</span>'],
      'a quote' => ['&quot;quoted&quot;', '"quoted"'],
      'one level only, so a literal entity stays visible' => [
        '&amp;amp; and &amp;copy;',
        '&amp; and &copy;',
      ],
      'a code span is the serializer verbatim' => [
        'a &amp; b `c &amp; d` e &amp; f',
        'a & b `c &amp; d` e & f',
      ],
      'a fenced block is too' => [
        "&amp; one\n\n```\n&amp; code\n```\n\n&amp; two",
        "& one\n\n```\n&amp; code\n```\n\n& two",
      ],
      'a tilde fence counts' => ["~~~js\nx &gt; y\n~~~", "~~~js\nx &gt; y\n~~~"],
      'an unclosed backtick run is text' => ['a ` b &amp; c', 'a ` b & c'],
      'a table' => [
        "| a &amp; b | c &lt; d |\n| --- | --- |\n| 1 | 2 |",
        "| a & b | c < d |\n| --- | --- |\n| 1 | 2 |",
      ],
      'a block id rides along untouched' => [
        'Wiki &amp; AI {#b-29c630f6}',
        'Wiki & AI {#b-29c630f6}',
      ],
      'nothing to do' => ['plain prose', 'plain prose'],
      'empty' => ['', ''],
    ];
  }

  /**
   * A stored body reads as the characters its entities stand for.
   *
   * @dataProvider bodies
   */
  public function testDecode(string $stored, string $decoded): void {
    $this->assertSame($decoded, ComarkEntities::decode($stored));
  }

}
