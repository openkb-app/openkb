<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite;

use Drupal\ai_rag_cite\ValueObject\GroundingSettings;

/**
 * Applies the gate, builds the prompt the sources go into, and cites them back.
 *
 * Every method is a pure function of its arguments.
 */
class Grounding {

  /**
   * What the model is told when the turn stands on no sources at all.
   *
   * Only reached in `grounded` mode: the model answers, and the answer cites
   * nothing, so the reader is shown where it came from instead.
   */
  public const NO_SOURCES_INSTRUCTION = 'Nothing in the readable pages was found for this question. If it asks about the knowledge base\'s content, say so plainly and stop; otherwise answer briefly, and cite nothing.';

  /**
   * One citation marker, together with the space in front of it.
   */
  public const MARKER = '/ ?\\[(\\d+)\\]/';

  /**
   * The sources a turn may be grounded on, best first.
   *
   * A chunked index answers several sections of one page, and each surviving
   * section is a numbered source of its own, landing on its own block. Three
   * cuts in order: the score gate, the per-page cap on how many sections are
   * read, and the cap on how many sources are offered.
   *
   * @param \Drupal\ai_rag_cite\ValueObject\Source[] $sources
   *   The retrieved sources, best first.
   * @param \Drupal\ai_rag_cite\ValueObject\GroundingSettings $settings
   *   The assistant's grounding settings.
   *
   * @return \Drupal\ai_rag_cite\ValueObject\Source[]
   *   The surviving sections, in the order they scored.
   */
  public function gate(array $sources, GroundingSettings $settings): array {
    $kept = [];
    $perPage = [];
    foreach ($sources as $source) {
      if ($source->score < $settings->scoreGate) {
        continue;
      }
      // A source naming no entity is a page of its own.
      $key = $source->entityId === '' ? '#' . count($kept) : $source->entityId;
      if (($perPage[$key] ?? 0) >= $settings->maxPerEntity) {
        continue;
      }
      if (count($kept) >= $settings->maxSources) {
        break;
      }
      $perPage[$key] = ($perPage[$key] ?? 0) + 1;
      $kept[] = $source;
    }
    return $kept;
  }

  /**
   * The system prompt a grounded turn runs with.
   *
   * The assistant's own prompt is kept and the contract, any extra guidance
   * and the numbered source list appended, so grounding adds rules rather
   * than replacing the assistant's voice. With no sources the turn is told
   * that instead; the extra guidance still holds, the contract has nothing
   * to hold it to.
   *
   * @param string $systemPrompt
   *   The assistant's own system prompt.
   * @param \Drupal\ai_rag_cite\ValueObject\Source[] $sources
   *   The sources that survived the gate.
   * @param \Drupal\ai_rag_cite\ValueObject\GroundingSettings $settings
   *   The assistant's grounding settings.
   *
   * @return string
   *   The system prompt to run with.
   */
  public function systemPrompt(string $systemPrompt, array $sources, GroundingSettings $settings): string {
    if (!$sources) {
      return implode("\n\n", array_filter([
        trim($systemPrompt),
        trim($settings->extraGuidance),
        self::NO_SOURCES_INSTRUCTION,
      ]));
    }
    $contract = trim($settings->citationContract);
    $blocks = array_filter([
      trim($systemPrompt),
      $contract,
      trim($settings->extraGuidance),
      $this->sourceList($sources),
      // Retrieved text is the one part of this prompt nobody here wrote, so
      // the rules are repeated as the last thing the model reads.
      $contract,
    ]);
    return implode("\n\n", $blocks);
  }

  /**
   * The sources as the numbered list the answer cites by.
   *
   * Each passage is fenced, so text that reads like an instruction is visibly
   * quoted material rather than another line of the prompt.
   *
   * @param \Drupal\ai_rag_cite\ValueObject\Source[] $sources
   *   The sources that survived the gate.
   *
   * @return string
   *   The list.
   */
  public function sourceList(array $sources): string {
    $lines = ['Sources:'];
    foreach ($sources as $index => $source) {
      $number = $index + 1;
      $line = sprintf('[%d] %s — %s', $number, $source->title, $source->path);
      if ($source->excerpt !== '') {
        $line .= sprintf("\n<source n=\"%d\">\n%s\n</source>", $number, $this->fenced($source->excerpt));
      }
      $lines[] = $line;
    }
    return implode("\n", $lines);
  }

  /**
   * A passage with no fence of its own to close the real one early.
   */
  private function fenced(string $excerpt): string {
    return (string) preg_replace('#</?source\b[^>]*>#i', '', $excerpt);
  }

  /**
   * The sources the answer cited, in the numbering the answer used.
   *
   * A source the answer never marked is dropped, and the numbers are left as
   * written: a streamed answer is read before this runs.
   *
   * @param string $text
   *   The generated answer.
   * @param \Drupal\ai_rag_cite\ValueObject\Source[] $sources
   *   The sources the turn was grounded on.
   *
   * @return array<int, array<string, mixed>>
   *   The cited sources, in first-citation order.
   */
  public function citations(string $text, array $sources): array {
    if (!$sources || !preg_match_all(self::MARKER, $text, $matches)) {
      return [];
    }

    $citations = [];
    foreach ($matches[1] as $raw) {
      $number = (int) $raw;
      if (isset($citations[$number]) || !isset($sources[$number - 1])) {
        continue;
      }
      $citations[$number] = $sources[$number - 1]->toCitation($number);
    }
    return array_values($citations);
  }

  /**
   * The answer without the `[n]` markers that name no source.
   *
   * The space in front of a dropped marker goes with it, so the sentence
   * closes on its last word rather than on a gap.
   *
   * @param string $text
   *   The generated answer.
   * @param int $count
   *   How many sources the turn was grounded on.
   *
   * @return string
   *   The answer.
   */
  public function stripOutOfRangeMarkers(string $text, int $count): string {
    return preg_replace_callback(
      self::MARKER,
      static fn (array $match): string => (int) $match[1] >= 1 && (int) $match[1] <= $count ? $match[0] : '',
      $text,
    ) ?? $text;
  }

}
