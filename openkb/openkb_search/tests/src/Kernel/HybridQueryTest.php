<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\openkb_search\Retrieval\ChunkRetrievalInterface;
use Drupal\user\UserInterface;

/**
 * One OpenSearch query per search, on both arms, fused by the pipeline.
 *
 * The rows carry the section as analyzed text beside its vector, so a term a
 * section spells out is reachable whether or not the embedding places the
 * query near it. Relevance is gated on the vector clause: the pipeline
 * normalises each clause against its own result set, so the score a hit
 * carries ranks but does not measure.
 *
 * @group openkb_search
 */
final class HybridQueryTest extends ChunkIndexTestBase {

  /**
   * The read path under test.
   */
  private ChunkRetrievalInterface $retrieval;

  /**
   * On the Alpha roster only.
   */
  private UserInterface $alphaReader;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->retrieval = $this->container->get(ChunkRetrievalInterface::class);
    $this->alphaReader = $this->createUser(['access content']);
  }

  /**
   * The chunk text is analyzed, which is what a term can be matched in.
   */
  public function testTheChunkTextIsMappedAsAnalyzedText(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n");
    $this->indexPages();

    $index = 'default_' . $this->collection;
    $mapping = $this->provider->getClient()->indices()->getMapping(['index' => $index]);
    $content = $mapping[$index]['mappings']['properties']['content'];

    $this->assertSame('text', $content['type']);
    $this->assertSame('openkb_text', $content['analyzer']);
    $this->assertSame('keyword', $mapping[$index]['mappings']['properties']['space']['type']);
  }

  /**
   * One search is one query on the cluster, whatever the two clauses cost.
   *
   * A cold cache adds the mapping read and the pipeline write, so the count is
   * taken on a search that follows one.
   */
  public function testOneSearchIsOneQuery(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n");
    $this->indexPages();
    // The pipeline is written once, before the count is taken.
    $this->retrieval->retrieve('nightly', 10);

    $before = $this->queryCount();
    $this->retrieval->retrieve('Zxcvbnm runs nightly.', 10);
    $this->assertSame(1, $this->queryCount() - $before);
  }

  /**
   * A section is found by the term it spells, with the vector arm shut.
   *
   * The floor is unreachable, so nothing enters through the vector clause and
   * what answers can only have come from the lexical one.
   */
  public function testTheTermAloneFindsTheSection(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n");
    $this->createPage('Release checklist', TRUE, "Tag the release.\n");
    $this->indexPages();
    $this->setRelevanceFloor(1.0);

    $hits = $this->retrieval->retrieve('Zxcvbnm', 10);
    $this->assertNotSame([], $hits, 'the term the section spells reaches it');
    $this->assertSame('Backup policy', $hits[0]->title);
    $this->assertSame([], $this->retrieval->retrieve('Qwertzuiop', 10), 'a term no section spells reaches nothing');
  }

  /**
   * A page is found by the words of its title, with the vector arm shut.
   *
   * The title rides on every chunk of its page and is mapped analyzed, so a
   * query naming the page reaches its sections through the lexical clause
   * even where none of them spells the word.
   */
  public function testTheTitleAloneFindsTheSection(): void {
    $this->createPage('Zxcvbnm policy', TRUE, "It runs nightly.\n");
    $this->createPage('Release checklist', TRUE, "Tag the release.\n");
    $this->indexPages();
    $this->setRelevanceFloor(1.0);

    $hits = $this->retrieval->retrieve('Zxcvbnm', 10);
    $this->assertNotSame([], $hits, 'the word the title spells reaches the page');
    $this->assertSame('Zxcvbnm policy', $hits[0]->title);
  }

  /**
   * The title keeps an exact value beside the analyzed one.
   *
   * The row's `title` attribute is what a hit names its page by, which only a
   * keyword answers for a value the analyzer would cut up.
   */
  public function testTheTitleKeepsAnExactValueBesideTheAnalyzedText(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n");
    $this->indexPages();

    $index = 'default_' . $this->collection;
    $title = $this->provider->getClient()->indices()->getMapping(['index' => $index])[$index]['mappings']['properties']['title'];
    $this->assertSame('text', $title['type']);
    $this->assertSame('openkb_text', $title['analyzer']);
    $this->assertSame('keyword', $title['fields']['keyword']['type']);
  }

  /**
   * The lexical clause answers a row only where it holds every key.
   *
   * Search API parses a query under its AND conjunction, and the clause
   * carries it: a rare term beside words the section does not hold reaches
   * nothing through this arm.
   */
  public function testTheLexicalClauseNeedsEveryKey(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n");
    $this->indexPages();
    $this->setRelevanceFloor(1.0);

    $this->assertNotSame([], $this->retrieval->retrieve('Zxcvbnm nightly', 10), 'every key is in the section');
    $this->assertSame([], $this->retrieval->retrieve('Zxcvbnm on a bicycle', 10), 'a key the section lacks answers nothing');
  }

  /**
   * A key the query excludes takes the section carrying it out of the answer.
   *
   * Search API parses a minus-prefixed key into a negated group, which the
   * search filters on rather than scoring: with both arms live, neither the
   * lexical clause nor the vector one can bring the section back.
   */
  public function testTheExcludedKeyBoundsBothClauses(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n");
    $this->indexPages();

    $this->assertNotSame([], $this->retrieval->retrieve('Zxcvbnm', 10), 'the term alone reaches the section');
    $this->assertSame([], $this->retrieval->retrieve('Zxcvbnm -nightly', 10), 'the excluded key takes it back out');
  }

  /**
   * An excluded key is filtered on, so it is not in what the vector arm asks.
   *
   * Embedded it would pull the rows carrying it nearer, which is the opposite
   * of what the query asked for.
   */
  public function testTheExcludedKeyIsNotEmbedded(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n");
    $this->indexPages();

    $this->retrieval->retrieve('Zxcvbnm -nightly', 10);
    $this->assertSame(['Zxcvbnm'], $this->embeddedTexts());
  }

  /**
   * A section is found by its vector, with no term of the query in it.
   */
  public function testTheVectorAloneFindsTheSection(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n");
    $this->indexPages();

    $hits = $this->retrieval->retrieve('Qwertzuiop', 10);
    $this->assertNotSame([], $hits, 'the vector clause answers its nearest rows');
    $this->assertSame('Backup policy', $hits[0]->title);
  }

  /**
   * The floor cuts the vector clause, and the lexical clause is left alone.
   */
  public function testTheFloorSeparatesOnTheVectorClause(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n");
    $this->indexPages();

    $noise = $this->vectorScores('espresso machine descaling');
    $signal = $this->vectorScores('Zxcvbnm runs nightly.');
    $this->assertNotSame([], $noise, 'the vector clause answers its nearest row whatever the question');
    $this->assertGreaterThan($noise[0]['score'], $signal[0]['score']);

    $this->setRelevanceFloor(($noise[0]['score'] + $signal[0]['score']) / 2);

    $this->assertSame([], $this->retrieval->retrieve('espresso machine descaling', 10));
    $this->assertNotSame([], $this->retrieval->retrieve('Zxcvbnm runs nightly.', 10));
  }

  /**
   * A foreign space is out of reach on the lexical clause too.
   */
  public function testTheSpaceFilterBoundsBothClauses(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly.\n", $this->createSpace('Gamma', $this->createUser(['access content'])));
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);

    $this->setRelevanceFloor(1.0);
    $this->assertSame([], $this->retrieval->retrieve('Zxcvbnm', 10), 'the term reaches no page the account may not read');
    $this->setRelevanceFloor(0);
    $this->assertSame([], $this->retrieval->retrieve('Zxcvbnm runs nightly.', 10));
  }

  /**
   * A lexical hit carries the fragment its term was matched in.
   *
   * The mark is the provider's pair of private-use characters, so a page
   * spelling out a tag of its own cannot be read as one.
   */
  public function testTheLexicalHitCarriesItsMarkedFragment(): void {
    $this->createPage('Backup policy', TRUE, "Zxcvbnm runs nightly, and the log spells `<em>every</em>` out.\n");
    $this->indexPages();
    $this->setRelevanceFloor(1.0);

    $hits = $this->retrieval->retrieve('Zxcvbnm', 10);
    $this->assertNotSame([], $hits);
    // One fragment holds the whole section: it is shorter than the 100
    // characters the highlighter cuts at.
    $fragments = implode(' ', $hits[0]->highlights);
    // The provider's HIGHLIGHT_PRE / HIGHLIGHT_POST, which the frontend
    // splits the fragment on.
    $this->assertStringContainsString("\u{E000}Zxcvbnm\u{E001}", $fragments);
    $this->assertStringContainsString('<em>every</em>', $fragments, 'the page spells its own tag, unmarked');
  }

  /**
   * How many queries the collection has answered.
   */
  private function queryCount(): int {
    $client = $this->provider->getClient();
    $index = 'default_' . $this->collection;
    $stats = $client->indices()->stats(['index' => $index, 'metric' => 'search']);
    return (int) $stats['indices'][$index]['primaries']['search']['query_total'];
  }

}
