<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_search\Kernel;

use Drupal\KernelTests\KernelTestBase;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_search\Controller\SearchController;
use Drupal\openkb_space\Entity\Space;
use Drupal\openkb_space\SpaceInterface;
use Drupal\taxonomy\Entity\Term;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpKernel\Exception\UnprocessableEntityHttpException;
use Symfony\Component\Yaml\Yaml;

/**
 * What `GET /openkb/search` lists when no query is asked.
 *
 * A browse, not a search: the newest published pages the account may read,
 * straight off the entity query. No index is touched, so this runs without
 * OpenSearch — which is also the property the listing exists for.
 *
 * @group openkb_search
 */
final class SearchListingTest extends KernelTestBase {

  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = [
    'system',
    'user',
    'field',
    'filter',
    'text',
    'node',
    'options',
    'path',
    'path_alias',
    'key',
    'search_api',
    'search_api_opensearch',
    'taxonomy',
    'ai',
    'ai_search',
    'ai_vdb_provider_opensearch',
    // The document types a listing narrows by come from the frontmatter
    // schema, which openkb_search's PageTypes reads.
    'openkb_schema',
    'openkb_search',
    'openkb_space',
    'openkb_space_access',
  ];

  /**
   * Pages in one window, as the controller sizes it.
   */
  private const PAGE_SIZE = 10;

  /**
   * The controller under test.
   */
  private SearchController $controller;

  /**
   * The space every page is filed in unless a case names another.
   */
  private Space $space;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();

    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('taxonomy_term');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['field', 'filter', 'node', 'user']);

    User::create(['uid' => 0, 'name' => '', 'status' => 0])->save();
    $this->setCurrentUser($this->createUser(['bypass node access']));

    $this->importRecipeConfig([
      'node.type.kb_page',
      'taxonomy.vocabulary.kb_tags',
      'field.storage.node.field_kb_body',
      'field.storage.node.field_space',
      'field.storage.node.field_type',
      'field.storage.node.field_tags',
      'field.storage.node.field_summary',
      'field.storage.node.field_owner',
      'field.storage.node.field_contributors',
      'field.field.node.kb_page.field_kb_body',
      'field.field.node.kb_page.field_space',
      'field.field.node.kb_page.field_type',
      'field.field.node.kb_page.field_tags',
      'field.field.node.kb_page.field_summary',
      'field.field.node.kb_page.field_owner',
      'field.field.node.kb_page.field_contributors',
      // The exposure contract: what it places is what a listing may filter by.
      'core.entity_form_mode.node.frontmatter',
      'core.entity_form_display.node.kb_page.frontmatter',
    ]);

    $this->space = Space::create(['label' => 'Handbook']);
    $this->space->save();

    $this->controller = SearchController::create($this->container);
  }

  /**
   * The newest published pages, one window at a time.
   */
  public function testTheNewestPagesAreListedNewestFirst(): void {
    $this->createPage('Oldest', changed: 100);
    $this->createPage('Middle', changed: 200);
    $this->createPage('Newest', changed: 300);

    $body = $this->listing();

    $this->assertSame('', $body['query']);
    $this->assertSame(0, $body['page']);
    $this->assertSame(self::PAGE_SIZE, $body['page_size']);
    $this->assertFalse($body['has_more']);
    $this->assertSame(['Newest', 'Middle', 'Oldest'], array_column($body['pages'], 'title'));
  }

  /**
   * The count is of every page the caller may read, not of the window.
   */
  public function testTheListingCountsEveryPageTheCallerMayRead(): void {
    foreach (range(1, self::PAGE_SIZE + 2) as $number) {
      $this->createPage('Page ' . $number, changed: 100 + $number);
    }

    $this->assertSame(self::PAGE_SIZE + 2, $this->listing()['total']);
    // The count is of the whole listing, so a deeper window answers the same.
    $this->assertSame(self::PAGE_SIZE + 2, $this->listing('1')['total']);
  }

  /**
   * The count is narrowed the way the rows are.
   */
  public function testTheCountIsNarrowedLikeTheRows(): void {
    $reader = $this->createUser(['access content']);
    $alpha = $this->createSpace('Alpha', $reader);
    $beta = $this->createSpace('Beta', $this->createUser(['access content']));
    $this->createPage('Alpha handbook', changed: 300, space: $alpha);
    $this->createPage('Beta handbook', changed: 400, space: $beta);

    $this->setCurrentUser($reader);
    $this->assertSame(1, $this->listing()['total']);
    $this->assertSame(1, $this->listing('0', $alpha->getSlug())['total']);
    $this->assertSame(0, $this->listing('0', $beta->getSlug())['total']);
  }

  /**
   * A listed row is the row shape a matched page answers in.
   */
  public function testTheListedRowCarriesWhatItShows(): void {
    $node = $this->createPage('Onboarding', changed: 300, type: 'guide', tags: [
      $this->createTag('Search'),
      $this->createTag('Editing'),
    ]);

    $row = $this->listing()['pages'][0];

    $this->assertSame(sprintf('entity:node/%d:en', $node->id()), $row['id']);
    $this->assertSame('Onboarding', $row['title']);
    $this->assertSame('/node/' . $node->id(), $row['path']);
    $this->assertSame('Handbook', $row['space']);
    // The frontmatter the row shows, the way a matched page answers it.
    $this->assertSame('guide', $row['type']);
    $this->assertSame(['Search', 'Editing'], $row['tags']);
    $this->assertSame(300, $row['changed']);
    // Nothing was ranked and nothing matched.
    $this->assertSame(0, $row['score']);
    $this->assertSame([], $row['sections']);
  }

  /**
   * A page that fills in no frontmatter still answers both keys.
   */
  public function testTheListedRowCarriesTheKeysWithoutFrontmatter(): void {
    $this->createPage('Onboarding', changed: 300);

    $row = $this->listing()['pages'][0];

    // The type field's own default; nothing was typed into the form.
    $this->assertSame('article', $row['type']);
    $this->assertSame([], $row['tags']);
  }

  /**
   * A draft is not listed; a listing is of what is published.
   */
  public function testDraftsAreNotListed(): void {
    $this->createPage('Published', changed: 300);
    $this->createPage('Draft', changed: 400, published: FALSE);

    $this->assertSame(['Published'], array_column($this->listing()['pages'], 'title'));
  }

  /**
   * A further window is announced, and the last one is not.
   */
  public function testTheAnswerSaysWhetherFurtherWindowFollows(): void {
    foreach (range(1, self::PAGE_SIZE + 2) as $number) {
      $this->createPage('Page ' . $number, changed: 100 + $number);
    }

    $first = $this->listing();
    $this->assertCount(self::PAGE_SIZE, $first['pages']);
    $this->assertTrue($first['has_more']);

    $second = $this->listing('1');
    $this->assertSame(1, $second['page']);
    $this->assertCount(2, $second['pages']);
    $this->assertFalse($second['has_more']);
  }

  /**
   * A window holds no page the one before it held.
   */
  public function testWindowsDoNotOverlap(): void {
    // Every page saved in the same second, so only the tie-breaker orders them.
    foreach (range(1, self::PAGE_SIZE + 5) as $number) {
      $this->createPage('Page ' . $number, changed: 500);
    }

    $first = array_column($this->listing()['pages'], 'id');
    $second = array_column($this->listing('1')['pages'], 'id');

    $this->assertCount(self::PAGE_SIZE, $first);
    $this->assertCount(5, $second);
    $this->assertSame([], array_intersect($first, $second));
  }

  /**
   * A page of a space the account is not on is never listed.
   */
  public function testForeignSpacesAreNeverListed(): void {
    $reader = $this->createUser(['access content']);
    $alpha = $this->createSpace('Alpha', $reader);
    $beta = $this->createSpace('Beta', $this->createUser(['access content']));
    $this->createPage('Alpha handbook', changed: 300, space: $alpha);
    $this->createPage('Beta handbook', changed: 400, space: $beta);

    $this->setCurrentUser($reader);
    $this->assertSame(['Alpha handbook'], array_column($this->listing()['pages'], 'title'));
  }

  /**
   * The `space` parameter is the slug the URL carries, not the label.
   */
  public function testTheSpaceParameterTakesTheSlug(): void {
    $reader = $this->createUser(['access content']);
    $alpha = $this->createSpace('Alpha Space', $reader);
    $this->createPage('Alpha handbook', changed: 300, space: $alpha);
    $this->createPage('Handbook page', changed: 400);

    $this->setCurrentUser($reader);
    $this->assertSame('alpha-space', $alpha->getSlug());
    $titles = array_column($this->listing('0', 'alpha-space')['pages'], 'title');
    $this->assertSame(['Alpha handbook'], $titles);
  }

  /**
   * A slug naming no space narrows to nothing, not to everything.
   */
  public function testTheSlugNamingNoSpaceListsNoPage(): void {
    $this->createPage('Handbook page', changed: 300);

    $this->assertSame([], $this->listing('0', 'no-such-space')['pages']);
    $this->assertSame(0, $this->listing('0', 'no-such-space')['total']);
  }

  /**
   * A slug the caller may not read narrows to nothing, not to everything.
   */
  public function testTheSlugOfUnreadableSpaceListsNoPage(): void {
    $reader = $this->createUser(['access content']);
    $beta = $this->createSpace('Beta', $this->createUser(['access content']));
    $this->createPage('Beta handbook', changed: 300, space: $beta);

    $this->setCurrentUser($reader);
    $this->assertSame([], $this->listing('0', $beta->getSlug())['pages']);
  }

  /**
   * The listing walks further than a search's chunk fetch reaches.
   */
  public function testTheListingPagesPastTheSearchWindow(): void {
    $this->createPage('Handbook page', changed: 300);

    $this->assertSame(50, $this->listing('50')['page']);
    $this->assertSame([], $this->listing('50')['pages']);
  }

  /**
   * A page that is not a whole number in range is refused.
   */
  public function testThePageThatIsNotWindowIsRefused(): void {
    foreach (['abc', '-5', '1.5', '1000'] as $page) {
      try {
        $this->listing($page);
        $this->fail(sprintf('page=%s was accepted.', $page));
      }
      catch (UnprocessableEntityHttpException) {
        // The page is refused, which is what this asserts.
      }
    }
  }

  /**
   * A type the frontmatter schema lists narrows the listing and its count.
   */
  public function testTheListingNarrowsToOneDocumentType(): void {
    $this->createPage('Deploy runbook', changed: 300, type: 'runbook');
    $this->createPage('Handbook page', changed: 400, type: 'article');

    $body = $this->listing('0', '', 'runbook');

    $this->assertSame(['Deploy runbook'], array_column($body['pages'], 'title'));
    $this->assertSame(1, $body['total']);
  }

  /**
   * A type the frontmatter schema does not list is refused.
   */
  public function testTheTypeNoSchemaListsIsRefused(): void {
    $this->createPage('Handbook page', changed: 300, type: 'article');

    $this->expectException(UnprocessableEntityHttpException::class);
    $this->listing('0', '', 'memo');
  }

  /**
   * An author narrows the listing to the pages they own.
   */
  public function testTheListingNarrowsToOneAuthor(): void {
    $rosa = $this->createUser(['access content']);
    $this->createPage('Rosa handbook', changed: 300, author: $rosa);
    $this->createPage('Handbook page', changed: 400);

    $body = $this->listing('0', '', '', $rosa->getAccountName());

    $this->assertSame(['Rosa handbook'], array_column($body['pages'], 'title'));
    $this->assertSame(1, $body['total']);
  }

  /**
   * An update range narrows the listing to what changed inside it.
   */
  public function testTheListingNarrowsToWhatChangedInsideTheRange(): void {
    $now = (int) $this->container->get('datetime.time')->getRequestTime();
    $this->createPage('This week', changed: $now - 86400);
    $this->createPage('Last year', changed: $now - 200 * 86400);

    $body = $this->listing('0', '', '', '', 'week');

    $this->assertSame(['This week'], array_column($body['pages'], 'title'));
    $this->assertSame(1, $body['total']);
  }

  /**
   * The answer body for one listing request.
   *
   * @return array<string, mixed>
   *   The decoded body.
   */
  private function listing(string $page = '0', string $space = '', string $type = '', string $author = '', string $updated = ''): array {
    $request = Request::create('/openkb/search', 'GET', array_filter([
      'page' => $page,
      'space' => $space,
      'type' => $type,
      'author' => $author,
      'updated' => $updated,
    ]));
    return json_decode((string) $this->controller->search($request)->getContent(), TRUE);
  }

  /**
   * Creates a published kb_page in a space, changed at a given second.
   */
  private function createPage(string $title, int $changed, bool $published = TRUE, ?Space $space = NULL, string $type = '', ?UserInterface $author = NULL, array $tags = []): Node {
    $node = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'status' => $published ? NodeInterface::PUBLISHED : NodeInterface::NOT_PUBLISHED,
      'uid' => 1,
      'changed' => $changed,
      'field_kb_body' => ['value' => "# $title\n", 'format' => 'comark'],
      'field_space' => ['target_id' => ($space ?? $this->space)->id()],
      'field_tags' => array_map(
        static fn (Term $tag): array => ['target_id' => $tag->id()],
        $tags,
      ),
    ] + ($type === '' ? [] : ['field_type' => $type])
      + ($author === NULL ? [] : ['field_owner' => ['target_id' => $author->id()]]));
    $node->save();
    return $node;
  }

  /**
   * A tag of the kb_tags vocabulary, for a frontmatter reference.
   */
  private function createTag(string $name): Term {
    $term = Term::create(['vid' => 'kb_tags', 'name' => $name]);
    $term->save();
    return $term;
  }

  /**
   * A members-only space whose viewer roster holds the one account.
   */
  private function createSpace(string $name, UserInterface $viewer): SpaceInterface {
    $space = Space::create([
      'label' => $name,
      'viewers' => [['target_id' => $viewer->id()]],
      // A space is reached by its alias, and the alias unslashed is the slug
      // every URL names it by.
      'path' => ['alias' => '/' . strtolower(str_replace(' ', '-', $name))],
    ]);
    $space->save();
    return $space;
  }

  /**
   * Creates config entities straight from the recipe's YAML files.
   *
   * @param string[] $names
   *   Config names, in dependency order.
   */
  private function importRecipeConfig(array $names): void {
    /** @var \Drupal\Core\Config\ConfigManagerInterface $manager */
    $manager = $this->container->get('config.manager');
    foreach ($names as $name) {
      $data = Yaml::parseFile(dirname(DRUPAL_ROOT) . "/recipes/openkb_recipe_main/config/$name.yml");
      unset($data['dependencies']);
      $entityType = $manager->getEntityTypeIdByName($name);
      if ($entityType === NULL) {
        $this->config($name)->setData($data)->save();
        continue;
      }
      // A recipe file holds a storage record: a list field's allowed values
      // are a list there and a map on the entity.
      $storage = $this->container->get('entity_type.manager')->getStorage($entityType);
      $storage->createFromStorageRecord($data)->save();
    }
  }

}
