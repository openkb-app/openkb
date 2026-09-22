<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_tools\Kernel;

use Drupal\Tests\openkb_search\Kernel\ChunkIndexTestBase;
use Drupal\Tests\openkb_tools\SessionRelayModules;
use Drupal\openkb_search_test\Hook\LoadCounter;
use Drupal\path_alias\Entity\PathAlias;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolInterface;
use Drupal\tool\Tool\ToolManager;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;

/**
 * The retrieval the chat and `/mcp` share, executed in Drupal.
 *
 * Runs against the shipped `kb_chunks` index, so what passes is the tool over
 * the real index config and not over a fixture of its own. A hit is one
 * section: the caller is told which block it opens on and lands there.
 *
 * @group openkb_tools
 */
final class SearchPagesToolTest extends ChunkIndexTestBase {

  /**
   * On the Alpha roster only.
   */
  private UserInterface $alphaReader;

  /**
   * The tool under test.
   */
  private ToolManager $tools;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'token',
    'pathauto',
    'path',
    'mcp_server',
    'tool',
    'openkb_schema',
    ...SessionRelayModules::OAUTH,
    'openkb_tools',
    'openkb_tools_test',
  ];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installConfig(['openkb_tools']);

    $this->alphaReader = $this->createUser(['access content']);
    $this->tools = $this->container->get('plugin.manager.tool');
  }

  /**
   * A hit carries everything an answer needs to judge and cite the section.
   */
  public function testEveryHitCarriesTheCitationContract(): void {
    $this->createPage('Alpha page', TRUE, "Qwertzuiop.\n\n## Accounts\n\nAsk IT first.\n", $this->createSpace('Alpha', $this->alphaReader));
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);

    $outputs = $this->retrieve('Ask IT first.');
    $this->assertSame('Ask IT first.', $outputs['query']);
    $this->assertSame(2, $outputs['total'], 'The page has two sections, and both are hits.');

    $hit = $this->hitOf($outputs['hits'], 'Alpha page › Accounts');
    $this->assertSame(
      ['id', 'title', 'path', 'block_id', 'space', 'type', 'heading', 'excerpt', 'score'],
      array_keys($hit),
    );
    $this->assertSame('Alpha page', $hit['title']);
    $this->assertSame('Alpha', $hit['space']);
    $this->assertSame('article', $hit['type']);
    $this->assertStringContainsString('Ask IT first.', $hit['excerpt']);
    $this->assertNotSame('', $hit['block_id']);
    $this->assertStringEndsWith('#' . $hit['block_id'], $hit['path']);
    $this->assertGreaterThan(0, $hit['score']);
  }

  /**
   * The answer lists its hits, and numbers none of them.
   *
   * A `[n]` in a tool result is a number the answer could cite; only the
   * grounding layer's numbering may be cited.
   */
  public function testTheAnswerListsItsHitsUnnumbered(): void {
    $this->createPage('Alpha page', TRUE, "Qwertzuiop.\n", $this->createSpace('Alpha', $this->alphaReader));
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);

    $message = (string) $this->execute('Qwertzuiop.')->getMessage();
    $this->assertStringContainsString('Alpha page — /', $message);
    $this->assertDoesNotMatchRegularExpression('/\[\d+\]/', $message);
  }

  /**
   * Only the caller's own spaces answer — the index filters the query.
   */
  public function testTheCallerReachesOnlyItsOwnSpaces(): void {
    $this->createPage('Alpha page', TRUE, "Qwertzuiop.\n", $this->createSpace('Alpha', $this->alphaReader));
    $this->createPage('Beta page', TRUE, "Qwertzuiop.\n", $this->createSpace('Beta', $this->createUser(['access content'])));
    $this->indexPages();

    $this->setCurrentUser($this->alphaReader);
    $this->assertSame(['Alpha page'], $this->titles('Qwertzuiop.'));

    $this->setCurrentUser(User::getAnonymousUser());
    $this->assertFalse($this->tool('Qwertzuiop.')->access());
  }

  /**
   * The `type` argument narrows the hits to one kind of document.
   */
  public function testTheTypeArgumentNarrowsTheHits(): void {
    $alpha = $this->createSpace('Alpha', $this->alphaReader);
    $this->createPage('Deploy runbook', TRUE, "Qwertzuiop.\n", $alpha, frontmatter: [
      'field_type' => 'runbook',
      'field_tags' => [$this->createTag('on-call')->id()],
    ]);
    $this->createPage('Alpha page', TRUE, "Qwertzuiop.\n", $alpha, frontmatter: ['field_type' => 'article']);
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);

    $titles = $this->titles('Qwertzuiop.');
    sort($titles);
    $this->assertSame(['Alpha page', 'Deploy runbook'], $titles);

    $hits = $this->retrieve('Qwertzuiop.', 'runbook')['hits'];
    $this->assertSame(['Deploy runbook'], array_column($hits, 'title'));
    $this->assertSame('runbook', $hits[0]['type']);
    $this->assertSame('on-call', $hits[0]['tags']);
  }

  /**
   * A type the frontmatter schema does not list is a failed call.
   *
   * Answering no hits would read as "nothing is about this", which is a
   * finding the model would act on.
   */
  public function testAnUnknownTypeFailsTheCall(): void {
    $this->setCurrentUser($this->alphaReader);

    $result = $this->execute('Qwertzuiop.', 'no-such-type');

    $this->assertFalse($result->isSuccess());
    $this->assertStringContainsString('no document type "no-such-type"', (string) $result->getMessage());
    $this->assertStringContainsString('runbook', (string) $result->getMessage());
  }

  /**
   * A draft never reaches an agent: it was never embedded to begin with.
   */
  public function testDraftsAreNeverAnswered(): void {
    $alpha = $this->createSpace('Alpha', $this->alphaReader);
    $this->createPage('Alpha page', TRUE, "Qwertzuiop.\n", $alpha);
    $this->createPage('Alpha draft', FALSE, "Qwertzuiop, unpublished.\n", $alpha);
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);

    $this->assertSame(['Alpha page'], $this->titles('Qwertzuiop, unpublished.'));
  }

  /**
   * The hit count is a setting, not something the model sends.
   *
   * A missing one answers no empty result: "no matches" is a finding the model
   * would act on, and unconfigured retrieval is not that.
   */
  public function testTheHitCountComesFromSettings(): void {
    $this->setCurrentUser($this->alphaReader);

    $this->config('openkb_tools.settings')->set('search.top_k', 0)->save();
    $result = $this->execute('Qwertzuiop.');
    $this->assertFalse($result->isSuccess());
    $this->assertStringContainsString('no hit count is configured', (string) $result->getMessage());
  }

  /**
   * Unconfigured retrieval says so, rather than answering no matches.
   */
  public function testMissingIndexIsUnavailability(): void {
    $this->setCurrentUser($this->alphaReader);
    $this->config('openkb_search.settings')->set('chunk_index', 'no_such_index')->save();

    $result = $this->execute('Qwertzuiop.');
    $this->assertFalse($result->isSuccess());
    $this->assertStringContainsString('the index could not be queried', (string) $result->getMessage());
  }

  /**
   * A hit is read off the index row, and cites the page as it is read.
   *
   * Title and path travel in the row, so the tool cites a page without
   * loading it — and the row holds both as they were written.
   */
  public function testTheHitIsBuiltFromTheIndex(): void {
    $node = $this->createPage('Release Checklist', TRUE, "## Steps\n\nZxcvbnm.\n", $this->createSpace('Gamma', $this->alphaReader));
    PathAlias::create([
      'path' => '/node/' . $node->id(),
      'alias' => '/gamma/release-checklist',
    ])->save();
    // A kernel container builds no router, and the alias manager skips every
    // path prefix the router does not know.
    $this->container->get('state')->set('router.path_roots', ['node']);
    $this->container->get('path_alias.whitelist')->clear();
    $this->container->get('path_alias.manager')->cacheClear();
    $this->indexPages();

    $this->setCurrentUser($this->alphaReader);
    // Created in this request, so a load would answer from the entity memory
    // cache and never reach the hook that counts one.
    $this->container->get('entity_type.manager')->getStorage('node')->resetCache();
    $state = $this->container->get('state');
    LoadCounter::reset($state);

    $hit = $this->hitOf($this->retrieve('Zxcvbnm.')['hits'], 'Release Checklist › Steps');
    $this->assertSame('Release Checklist', $hit['title']);
    $this->assertSame('/gamma/release-checklist#b-2', $hit['path']);
    $this->assertSame(0, LoadCounter::loads($state, 'node'), 'No page is loaded to build a hit.');
  }

  /**
   * A hit on the page's lead section is cited by the title heading's block.
   *
   * That section opens on the heading the page renders as its own `<h1>`, so
   * it is anchored like any other — `get_page` answers that block's id as
   * `title_block_id`, since the body it serves drops the heading.
   */
  public function testTheLeadSectionIsCitedByTheTitleBlock(): void {
    $this->createPage('Backup Policy', TRUE, "Zxcvbnm opens the page.\n\n## Nightly\n\nAnd this is the second section.\n", $this->createSpace('Gamma', $this->alphaReader));
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);

    $hit = $this->hitOf($this->retrieve('Zxcvbnm opens the page.')['hits'], 'Backup Policy');
    $this->assertSame('b-1', $hit['block_id']);
    $this->assertStringEndsWith('#b-1', $hit['path']);
  }

  /**
   * A section whose markdown spells no id is answered unanchored.
   *
   * Every writer mints one, so this is the shape of a body that reached the
   * field another way: the model is told the section has no block rather than
   * handed a path ending in a bare "#".
   */
  public function testTheSectionWithNoBlockIdIsAnsweredUnanchored(): void {
    $this->createPage('Backup Policy', TRUE, "Zxcvbnm opens the page.\n\n## Nightly\n\nAnd this is the second section.\n", $this->createSpace('Gamma', $this->alphaReader), blockIds: FALSE);
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);

    $hit = $this->hitOf($this->retrieve('Zxcvbnm opens the page.')['hits'], 'Backup Policy');
    $this->assertSame('', $hit['block_id']);
    $this->assertStringNotContainsString('#', $hit['path']);
  }

  /**
   * The excerpt is the section's own prose, and not the whole page.
   *
   * The heading is answered in its own key, so it is not in the excerpt too.
   */
  public function testTheExcerptIsTheSectionText(): void {
    $this->createPage('Backup Policy', TRUE, "The opening line.\n\n## Nightly\n\nZxcvbnm runs nightly.\n", $this->createSpace('Gamma', $this->alphaReader));
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);

    $hit = $this->hitOf($this->retrieve('Zxcvbnm runs nightly.')['hits'], 'Backup Policy › Nightly');
    $this->assertSame('Zxcvbnm runs nightly.', $hit['excerpt']);
  }

  /**
   * A question no page is about is answered nothing.
   *
   * A kNN always answers its nearest rows, so what makes an off-topic
   * question answer nothing is the floor on the vector clause, not the query.
   * The case proves the floor is wired, not a number: it is this fixture's
   * own, and the question shares no term with the page, so the lexical clause
   * does not reach it either.
   */
  public function testTheQueryMatchingNoWordAnswersNothing(): void {
    $this->createPage('Backup Policy', TRUE, "Zxcvbnm runs nightly.\n", $this->createSpace('Gamma', $this->alphaReader));
    $this->indexPages();
    $this->setCurrentUser($this->alphaReader);

    $noise = $this->vectorScores('espresso machine descaling');
    $this->assertNotSame([], $noise, 'the kNN answers its nearest row whatever the question');
    $signal = $this->vectorScores('Zxcvbnm runs nightly.');
    $this->assertGreaterThan($noise[0]['score'], $signal[0]['score']);

    $this->setRelevanceFloor(($noise[0]['score'] + $signal[0]['score']) / 2);

    $outputs = $this->retrieve('espresso machine descaling');
    $this->assertSame([], $outputs['hits']);
    $this->assertSame(0, $outputs['total']);
    $this->assertStringContainsString(
      'No page you may read matches',
      (string) $this->execute('espresso machine descaling')->getMessage(),
    );
    $this->assertNotSame([], $this->retrieve('Zxcvbnm runs nightly.')['hits'], 'the page its question is about still answers');
  }

  /**
   * The model reads the list back, so it carries the title verbatim.
   */
  public function testTheListIsNotHtmlEscaped(): void {
    $this->createPage('R&D <draft>', TRUE, "Qwertzuiop.\n", $this->createSpace('Gamma', $this->alphaReader));
    $this->indexPages();

    $this->setCurrentUser($this->alphaReader);
    $this->assertStringContainsString('R&D <draft>', (string) $this->execute('Qwertzuiop.')->getMessage());
  }

  /**
   * The hit whose heading line is the one named.
   *
   * @param array<int, array<string, mixed>> $hits
   *   The hits.
   * @param string $heading
   *   The heading line the section sits under.
   *
   * @return array<string, mixed>
   *   The hit.
   */
  private function hitOf(array $hits, string $heading): array {
    foreach ($hits as $hit) {
      if (($hit['heading'] ?? '') === $heading) {
        return $hit;
      }
    }
    $this->fail(sprintf('No hit under "%s"; the hits were %s.', $heading, json_encode(array_column($hits, 'heading'))));
  }

  /**
   * Runs the tool and returns its outputs.
   *
   * @return array<string, mixed>
   *   The tool's outputs.
   */
  private function retrieve(string $keywords, string $type = ''): array {
    $result = $this->execute($keywords, $type);
    $this->assertTrue($result->isSuccess(), (string) $result->getMessage());
    return $result->getContextValues();
  }

  /**
   * Hit page titles, in result order and without repeating a page.
   *
   * @return list<string>
   *   The titles.
   */
  private function titles(string $keywords): array {
    return array_values(array_unique(array_column($this->retrieve($keywords)['hits'], 'title')));
  }

  /**
   * Executes the tool for the current account.
   */
  private function execute(string $keywords, string $type = ''): ExecutableResult {
    return $this->tool($keywords, $type)->execute()->getResult();
  }

  /**
   * The tool, with the query set on it.
   */
  private function tool(string $keywords, string $type = ''): ToolInterface {
    $tool = $this->tools->createInstance('openkb_search_pages')->setInputValue('q', $keywords);
    return $type === '' ? $tool : $tool->setInputValue('type', $type);
  }

}
