<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_tools\Kernel;

use Drupal\Core\Session\AnonymousUserSession;
use Drupal\KernelTests\KernelTestBase;
use Drupal\consumers\Entity\Consumer;
use Drupal\simple_oauth\Authentication\TokenAuthUser;
use Drupal\Tests\openkb_agent\Traits\RecipeConfigTrait;
use Drupal\Tests\openkb_tools\SessionRelayModules;
use Drupal\Tests\openkb_tools\Traits\McpSurfaceTrait;
use Drupal\Tests\user\Traits\UserCreationTrait;
use Drupal\node\Entity\Node;
use Drupal\node\NodeInterface;
use Drupal\openkb_space\Entity\Space;
use Drupal\user\Entity\Role;
use Drupal\user\Entity\User;
use Drupal\user\UserInterface;
use Mcp\Schema\JsonRpc\Response;

/**
 * The threads waiting for the caller, driven through the MCP endpoint.
 *
 * A thread is handed to `{uid, via}`, so the answer depends on who asks and
 * through which client: the person sees what was handed to them, and their
 * agent sees what was handed to the agent. Neither sees the other's.
 *
 * The gate is `update` per page, so a thread on a page the caller may read and
 * not write is not answered.
 *
 * @group openkb_tools
 */
final class ListAssignmentsToolTest extends KernelTestBase {

  use McpSurfaceTrait;
  use RecipeConfigTrait;
  use UserCreationTrait;

  /**
   * {@inheritdoc}
   */
  protected bool $usesSuperUserAccessPolicy = FALSE;

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
    'taxonomy',
    'path',
    'path_alias',
    'token',
    'pathauto',
    'workflows',
    'content_moderation',
    'inline_comment',
    'openkb_agent',
    'openkb_schema',
    'openkb_space',
    'openkb_space_access',
    'mcp_server',
    'tool',
    'mcp_server_tool_bridge',
    'search_api',
    ...SessionRelayModules::OAUTH,
    'openkb_tools',
  ];

  /**
   * On the space's member roster: may edit its pages.
   */
  private UserInterface $editor;

  /**
   * On the viewer roster: may read the same pages and edit none.
   */
  private UserInterface $viewer;

  /**
   * Who asks in the threads, so the last word is not the caller's.
   */
  private UserInterface $asker;

  /**
   * When the next stored message was said, in milliseconds.
   */
  private int $at = 1789000000000;

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    $this->installEntitySchema('user');
    $this->installEntitySchema('node');
    $this->installEntitySchema('taxonomy_term');
    $this->installEntitySchema('openkb_space');
    $this->installEntitySchema('path_alias');
    $this->installEntitySchema('content_moderation_state');
    $this->installEntitySchema('inline_comment');
    $this->installEntitySchema('consumer');
    $this->installEntitySchema('oauth2_token');
    $this->installSchema('node', ['node_access']);
    $this->installConfig(['system', 'filter', 'node', 'pathauto', 'mcp_server']);

    $this->importRecipeConfig([
      ...$this->kbPageConfigNames(),
      ...$this->kbBodyConfigNames(),
      ...$this->kbSpaceConfigNames(),
      ...$this->kbModerationConfigNames(),
      'pathauto.pattern.kb_page',
      ...$this->mcpToolConfigNames(),
      ...$this->agentConfigNames(),
      'simple_oauth.oauth2_scope.agent_write_draft',
      'simple_oauth.oauth2_scope.agent_write_latest',
      'simple_oauth.oauth2_scope.agent_write_unpublished_any',
    ]);

    // User 1 is the superuser and bypasses everything; burn it on a
    // placeholder so no account under test inherits that.
    User::create(['name' => 'superuser'])->save();

    $editor = Role::create(['id' => 'kb_editor', 'label' => 'KB editor']);
    $editor->grantPermission('access content');
    $editor->grantPermission('edit any kb_page content');
    $editor->grantPermission('view any unpublished content');
    $editor->grantPermission('use text format comark');
    $editor->grantPermission('use editorial transition create_new_draft');
    $editor->save();

    $reader = Role::create(['id' => 'kb_reader', 'label' => 'KB reader']);
    $reader->grantPermission('access content');
    $reader->save();

    $this->editor = $this->userWithRole('editor', $editor->id());
    $this->viewer = $this->userWithRole('viewer', $reader->id());
    $this->asker = $this->userWithRole('asker', $reader->id());

    Space::create([
      'label' => 'Team Wiki',
      'read_access' => 'members_only',
      'field_moderation' => TRUE,
      'members' => [['target_id' => $this->editor->id()]],
      'viewers' => [['target_id' => $this->viewer->id()]],
    ])->save();
  }

  /**
   * A thread handed to the account, with everything needed to answer it.
   */
  public function testAnswersTheThreadsHandedToTheCaller(): void {
    $page = $this->page('Roadmap');
    $this->thread($page, 'c-1', 'b-seed', 'Can you add the dates?', [
      'uid' => (int) $this->editor->id(),
      'via' => NULL,
    ]);

    $this->setCurrentUser($this->editor);
    $assignments = $this->listAssignments();

    $this->assertCount(1, $assignments);
    $this->assertSame(
      ['path', 'title', 'blockId', 'threadId', 'text', 'assignedBy', 'at'],
      array_keys($assignments[0]),
    );
    $this->assertSame('/team-wiki/roadmap', $assignments[0]['path']);
    $this->assertSame('Roadmap', $assignments[0]['title']);
    $this->assertSame('b-seed', $assignments[0]['blockId']);
    $this->assertSame('c-1', $assignments[0]['threadId']);
    $this->assertSame('Can you add the dates?', $assignments[0]['text']);
  }

  /**
   * {@inheritdoc}
   */
  protected function tearDown(): void {
    $this->container->get('current_user')->setAccount(new AnonymousUserSession());
    parent::tearDown();
  }

  /**
   * An agent's threads are the agent's, and the account's are the account's.
   *
   * Both identities are the same person; the client label is what separates
   * what was handed to the agent from what was handed to them.
   */
  public function testAgentSeesOnlyWhatWasHandedToIt(): void {
    $page = $this->page('Roadmap');
    $this->thread($page, 'c-mine', 'b-seed', 'Yours to answer.', [
      'uid' => (int) $this->editor->id(),
      'via' => NULL,
    ]);
    $this->thread($page, 'c-agent', 'b-seed', 'The agent can do this one.', [
      'uid' => (int) $this->editor->id(),
      'via' => 'Claude',
    ]);

    $this->setCurrentUser($this->editor);
    $this->assertSame(['c-mine'], array_column($this->listAssignments(), 'threadId'));

    $this->actAsAgent($this->editor, 'Claude');
    $this->assertSame(['c-agent'], array_column($this->listAssignments(), 'threadId'));
  }

  /**
   * Whole-account answers what is waiting for the account as a whole.
   *
   * The agent reads the threads handed to the person and to its sibling
   * clients as well as its own, and nothing of anybody else's.
   */
  public function testWholeAccountAnswersEveryClientOfTheAccount(): void {
    $other = $this->userWithRole('other', 'kb_editor');
    $page = $this->page('Roadmap');
    $this->thread($page, 'c-person', 'b-seed', 'Yours to answer.', [
      'uid' => (int) $this->editor->id(),
      'via' => NULL,
    ]);
    $this->thread($page, 'c-agent', 'b-seed', 'The agent can do this one.', [
      'uid' => (int) $this->editor->id(),
      'via' => 'Claude',
    ]);
    $this->thread($page, 'c-sibling', 'b-seed', 'The other agent can do this.', [
      'uid' => (int) $this->editor->id(),
      'via' => 'codex',
    ]);
    $this->thread($page, 'c-somebody-else', 'b-seed', 'Not this account.', [
      'uid' => (int) $other->id(),
      'via' => NULL,
    ]);

    $this->actAsAgent($this->editor, 'Claude');
    $this->assertSame(['c-agent'], array_column($this->listAssignments(), 'threadId'));
    $threads = array_column($this->listAssignments('', TRUE), 'threadId');
    sort($threads);
    $this->assertSame(['c-agent', 'c-person', 'c-sibling'], $threads);
  }

  /**
   * A thread the agent said the last word on is answered; a reply reopens it.
   */
  public function testThreadTheCallerAnsweredLastIsNotWaiting(): void {
    $page = $this->page('Roadmap');
    $this->thread($page, 'c-1', 'b-seed', 'Can you add the dates?', [
      'uid' => (int) $this->editor->id(),
      'via' => 'Claude',
    ]);
    $this->message($page, 'c-1', 'b-seed', ['text' => 'Added them.', 'via' => 'Claude']);

    $this->actAsAgent($this->editor, 'Claude');
    $this->assertSame([], $this->listAssignments());

    $this->message($page, 'c-1', 'b-seed', ['text' => 'And the owners?', 'uid' => (int) $this->asker->id()]);
    $this->assertSame(['c-1'], array_column($this->listAssignments(), 'threadId'));
  }

  /**
   * A thread handed to somebody else on a page the caller edits is theirs.
   */
  public function testAnotherPersonsThreadIsNotAnswered(): void {
    $other = $this->userWithRole('other', 'kb_editor');
    $this->thread($this->page('Roadmap'), 'c-1', 'b-seed', 'For someone else.', [
      'uid' => (int) $other->id(),
      'via' => NULL,
    ]);

    $this->setCurrentUser($this->editor);
    $this->assertSame([], $this->listAssignments());
  }

  /**
   * Messages count in the order they were said, not the order they were saved.
   *
   * A peer that was offline saves its older assignment after a newer handing
   * back; the handing back still stands.
   */
  public function testTheLatestSaidWinsWhateverWasSavedLast(): void {
    $page = $this->page('Roadmap');
    $this->message($page, 'c-1', 'b-seed', ['text' => 'Take this.', 'uid' => (int) $this->asker->id()]);
    $assignedAt = $this->at;
    $this->message($page, 'c-1', 'b-seed', ['assignee' => NULL]);
    $this->message($page, 'c-1', 'b-seed', [
      'assignee' => ['uid' => (int) $this->editor->id(), 'name' => 'editor', 'via' => NULL],
      'at' => $assignedAt,
    ]);

    $this->setCurrentUser($this->editor);
    $this->assertSame([], $this->listAssignments());
  }

  /**
   * A reopened thread is waiting again.
   */
  public function testReopenedThreadIsWaitingAgain(): void {
    $page = $this->page('Roadmap');
    $this->thread($page, 'c-1', 'b-seed', 'Take this.', [
      'uid' => (int) $this->editor->id(),
      'via' => NULL,
    ]);
    $this->message($page, 'c-1', 'b-seed', ['resolved' => TRUE]);
    $this->message($page, 'c-1', 'b-seed', ['resolved' => FALSE]);

    $this->setCurrentUser($this->editor);
    $assignments = $this->listAssignments();
    $this->assertSame(['c-1'], array_column($assignments, 'threadId'));
    $this->assertSame('editor', $assignments[0]['assignedBy']);
  }

  /**
   * A thread marked done waits for nobody.
   */
  public function testResolvedThreadIsNotWaiting(): void {
    $page = $this->page('Roadmap');
    $this->thread($page, 'c-done', 'b-seed', 'Handled already.', [
      'uid' => (int) $this->editor->id(),
      'via' => NULL,
    ]);
    $this->message($page, 'c-done', 'b-seed', ['resolved' => TRUE]);

    $this->setCurrentUser($this->editor);
    $this->assertSame([], $this->listAssignments());
  }

  /**
   * Unassigned again is not assigned: the latest word on it wins.
   */
  public function testHandingBackClearsTheThread(): void {
    $page = $this->page('Roadmap');
    $this->thread($page, 'c-1', 'b-seed', 'Take this.', [
      'uid' => (int) $this->editor->id(),
      'via' => NULL,
    ]);
    $this->message($page, 'c-1', 'b-seed', ['assignee' => NULL]);

    $this->setCurrentUser($this->editor);
    $this->assertSame([], $this->listAssignments());
  }

  /**
   * A page the caller may read and not write carries no work for it.
   */
  public function testPageTheCallerCannotEditIsNotAnswered(): void {
    $page = $this->page('Roadmap');
    $this->thread($page, 'c-1', 'b-seed', 'Only readable for you.', [
      'uid' => (int) $this->viewer->id(),
      'via' => NULL,
    ]);

    $this->setCurrentUser($this->viewer);
    $this->assertSame([], $this->listAssignments());
  }

  /**
   * A space narrows the answer to the pages that live in it.
   */
  public function testSpaceNarrowsTheAnswer(): void {
    Space::create([
      'label' => 'Open Notes',
      'read_access' => 'members_only',
      'field_moderation' => TRUE,
      'members' => [['target_id' => $this->editor->id()]],
    ])->save();
    $this->thread($this->page('Roadmap'), 'c-wiki', 'b-seed', 'In the wiki.', [
      'uid' => (int) $this->editor->id(),
      'via' => NULL,
    ]);
    $this->thread($this->page('Notes', 'Open Notes'), 'c-notes', 'b-seed', 'In the notes.', [
      'uid' => (int) $this->editor->id(),
      'via' => NULL,
    ]);

    $this->setCurrentUser($this->editor);

    $this->assertSame(['c-notes'], array_column($this->listAssignments('open-notes'), 'threadId'));
    $both = array_column($this->listAssignments(), 'threadId');
    sort($both);
    $this->assertSame(
      ['c-notes', 'c-wiki'],
      $both,
      'Without a space, every page the caller may edit is answered.',
    );
  }

  /**
   * The answer the model reads names the page and the thread.
   */
  public function testTheAnswerNamesThePageAndTheThread(): void {
    $page = $this->page('Roadmap');
    $this->thread($page, 'c-1', 'b-seed', 'Can you add the dates?', [
      'uid' => (int) $this->editor->id(),
      'via' => NULL,
    ]);

    $this->setCurrentUser($this->editor);
    $message = $this->answerText();

    $this->assertStringContainsString('Roadmap', $message);
    $this->assertStringContainsString('/team-wiki/roadmap', $message);
    $this->assertStringContainsString('c-1', $message);
    $this->assertStringContainsString('Can you add the dates?', $message);
  }

  /**
   * Acts as `$owner` through an agent token of a client labelled `$label`.
   */
  private function actAsAgent(UserInterface $owner, string $label): void {
    $client = Consumer::create([
      'label' => $label,
      'client_id' => strtolower($label),
      'personal' => TRUE,
      'grant_types' => ['client_credentials'],
    ]);
    $client->save();
    $token = $this->container->get('entity_type.manager')->getStorage('oauth2_token')->create([
      'bundle' => 'access_token',
      'client' => $client->id(),
      'auth_user_id' => $owner->id(),
      'scopes' => [['scope_id' => 'agent_read'], ['scope_id' => 'agent_write']],
      'value' => 'token-' . $client->id(),
      'expire' => $this->container->get('datetime.time')->getRequestTime() + 300,
    ]);
    $token->save();
    $this->container->get('current_user')->setAccount(new TokenAuthUser(
      $this->container->get('permission_checker'),
      $token,
      $this->container->get('psr7.http_message_factory'),
      $this->container->get('request_stack'),
    ));
  }

  /**
   * The assignments the tool answers for the current user.
   */
  private function listAssignments(string $space = '', bool $whole_account = FALSE): array {
    $response = $this->call(
      $this->buildServer(),
      'tool_api__list_assignments',
      ($space === '' ? [] : ['space' => $space])
      + ($whole_account ? ['whole_account' => TRUE] : []),
    );
    $this->assertInstanceOf(Response::class, $response);
    $this->assertFalse(
      $response->result->isError,
      $response->result->isError ? $response->result->content[0]->text : '',
    );
    return $response->result->structuredContent['data']['assignments'];
  }

  /**
   * The prose the same call answers with.
   */
  private function answerText(): string {
    $response = $this->call($this->buildServer(), 'tool_api__list_assignments', []);
    $this->assertInstanceOf(Response::class, $response);
    return $response->result->content[0]->text;
  }

  /**
   * One page in the space, published.
   */
  private function page(string $title, string $space = 'Team Wiki'): NodeInterface {
    $spaces = $this->container->get('entity_type.manager')->getStorage('openkb_space')
      ->loadByProperties(['label' => $space]);
    $node = Node::create([
      'type' => 'kb_page',
      'title' => $title,
      'uid' => $this->editor->id(),
      'field_space' => ['target_id' => reset($spaces)->id()],
      'field_kb_body' => ['value' => "# $title\n\nA body. {#b-seed}\n"],
      'moderation_state' => 'published',
    ]);
    $node->setRevisionUserId($this->editor->id());
    $node->save();
    return $node;
  }

  /**
   * A thread on a block: what the asker said, then who it was handed to.
   */
  private function thread(
    NodeInterface $page,
    string $threadId,
    string $blockId,
    string $text,
    array $assignee,
  ): void {
    $this->message($page, $threadId, $blockId, ['text' => $text, 'uid' => (int) $this->asker->id()]);
    $this->message($page, $threadId, $blockId, [
      'assignee' => ['uid' => $assignee['uid'], 'name' => 'editor', 'via' => $assignee['via']],
    ]);
  }

  /**
   * An account with one role.
   */
  private function userWithRole(string $name, string $role): UserInterface {
    $user = User::create(['name' => $name, 'status' => 1]);
    $user->addRole($role);
    $user->save();
    return $user;
  }

  /**
   * One stored message, as a checkpoint files it, said after the one before.
   */
  private function message(NodeInterface $page, string $threadId, string $blockId, array $data): void {
    $this->container->get('entity_type.manager')->getStorage('inline_comment')->create([
      'entity_type' => 'node',
      'entity_id' => (string) $page->id(),
      'langcode' => $page->language()->getId(),
      'anchor' => $blockId,
      'thread_id' => $threadId,
      'msg_id' => 'm-' . substr(hash('sha256', $threadId . json_encode($data)), 0, 8),
      'uid' => $data['uid'] ?? $this->editor->id(),
      'created' => \Drupal::time()->getRequestTime(),
      'data' => $data + ['uid' => (int) $this->editor->id(), 'name' => 'editor', 'at' => $this->at += 1000],
    ])->save();
  }

}
