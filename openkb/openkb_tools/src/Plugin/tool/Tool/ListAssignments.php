<?php

declare(strict_types=1);

namespace Drupal\openkb_tools\Plugin\tool\Tool;

use Drupal\Core\Access\AccessResult;
use Drupal\Core\Access\AccessResultInterface;
use Drupal\Core\Database\Connection;
use Drupal\Core\Datetime\DateFormatterInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Render\Markup;
use Drupal\Core\Session\AccountInterface;
use Drupal\Core\StringTranslation\TranslatableMarkup;
use Drupal\node\NodeInterface;
use Drupal\openkb_agent\ActingIdentity;
use Drupal\openkb_space\SpaceStorage;
use Drupal\path_alias\AliasManagerInterface;
use Drupal\tool\Attribute\Tool;
use Drupal\tool\ExecutableResult;
use Drupal\tool\Tool\ToolBase;
use Drupal\tool\Tool\ToolOperation;
use Drupal\tool\TypedData\InputDefinition;
use Drupal\tool\TypedData\ListInputDefinition;
use Drupal\tool\TypedData\MapInputDefinition;
use Symfony\Component\DependencyInjection\ContainerInterface;

/**
 * The comment threads handed to the calling identity, across pages.
 *
 * A thread is assigned to `{uid, via}` — the account and, for an agent, its
 * client label — so an agent that was not in the session when the thread was
 * handed over still finds it here on its next connection. `waitForChanges`
 * reports the ones opened while it is watching; this answers the standing ones.
 * A thread where the caller said the last word is answered already, as
 * `waitForChanges` counts it too.
 *
 * The gate is `update` per page, as the editing tools take: a thread on a page
 * the caller may read but not write is not work it can do.
 */
#[Tool(
  id: 'openkb_list_assignments',
  label: new TranslatableMarkup('List assignments'),
  description: new TranslatableMarkup('The comment threads assigned to you that nobody has marked done and where somebody else said the last word, across every page you may edit. This is what to call when you connect: a thread can be handed to you while you are away, and waitForChanges only reports what happens while you watch. Each answer carries the page path getPageForEditing and updateBlocks read by, the block the thread is on, the thread id commentOnBlock replies to, and what was last said. Answer a thread with commentOnBlock and leave marking it done to a person. Pass whole_account to read what is waiting for the account you act for as a whole.'),
  operation: ToolOperation::Read,
  destructive: FALSE,
  input_definitions: [
    'space' => new InputDefinition(
      data_type: 'string',
      label: new TranslatableMarkup('Space'),
      description: new TranslatableMarkup('Narrows to one space, by the slug tool_api__list_spaces reports. Left out, every space you may edit in is answered.'),
      required: FALSE,
    ),
    'whole_account' => new InputDefinition(
      data_type: 'boolean',
      label: new TranslatableMarkup('Whole account'),
      description: new TranslatableMarkup('Answer every thread assigned to the account you act for — the person themselves and their other agents included. Left out, only the threads handed to you are answered.'),
      required: FALSE,
    ),
  ],
  output_definitions: [
    'total' => new InputDefinition(
      data_type: 'integer',
      label: new TranslatableMarkup('Total'),
      description: new TranslatableMarkup('How many threads are waiting for you; the list carries the most recent of them.'),
    ),
    'assignments' => new ListInputDefinition(
      label: new TranslatableMarkup('Assignments'),
      description: new TranslatableMarkup('The threads waiting for you, most recently active first.'),
      item_definition: new MapInputDefinition(
        label: new TranslatableMarkup('Assignment'),
        description: new TranslatableMarkup('One thread handed to you.'),
        property_definitions: [
          'path' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Path'),
            description: new TranslatableMarkup('The page path, as getPageForEditing and updateBlocks read by.'),
          ),
          'title' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Title'),
            description: new TranslatableMarkup('The page title.'),
          ),
          'blockId' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Block'),
            description: new TranslatableMarkup('The block the thread is about.'),
          ),
          'threadId' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Thread'),
            description: new TranslatableMarkup('The thread id, as commentOnBlock replies to.'),
          ),
          'text' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Last said'),
            description: new TranslatableMarkup('The latest message on the thread.'),
          ),
          'assignedBy' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Assigned by'),
            description: new TranslatableMarkup('Who handed the thread over.'),
          ),
          'at' => new InputDefinition(
            data_type: 'string',
            label: new TranslatableMarkup('Last activity'),
            description: new TranslatableMarkup('When the thread was last written to, ISO 8601.'),
          ),
        ],
      ),
    ),
  ],
)]
final class ListAssignments extends ToolBase {

  /**
   * How many threads one call answers.
   */
  private const LIMIT = 20;

  /**
   * The entity type manager.
   */
  protected EntityTypeManagerInterface $entityTypeManager;

  /**
   * Resolves the path a thread's page is addressed by.
   */
  protected AliasManagerInterface $aliasManager;

  /**
   * Formats the timestamp a thread carries.
   */
  protected DateFormatterInterface $dateFormatter;

  /**
   * Who the request acts as, and through which agent client.
   */
  protected ActingIdentity $identity;

  /**
   * The account the request acts as.
   */
  protected AccountInterface $currentUser;

  /**
   * Reads the messages without loading a page.
   */
  protected Connection $database;

  /**
   * {@inheritdoc}
   */
  public static function create(ContainerInterface $container, array $configuration, $plugin_id, $plugin_definition): static {
    $instance = parent::create($container, $configuration, $plugin_id, $plugin_definition);
    $instance->entityTypeManager = $container->get('entity_type.manager');
    $instance->aliasManager = $container->get('path_alias.manager');
    $instance->dateFormatter = $container->get('date.formatter');
    $instance->identity = $container->get('openkb_agent.acting_identity');
    $instance->currentUser = $container->get('current_user');
    $instance->database = $container->get('database');
    return $instance;
  }

  /**
   * {@inheritdoc}
   */
  protected function doExecute(array $values): ExecutableResult {
    $uid = (int) $this->currentUser->id();
    if ($uid <= 0) {
      return ExecutableResult::failure(
        new TranslatableMarkup('Only a signed-in identity has assignments.'),
      );
    }
    $via = $this->identity->via();
    $slug = trim((string) ($values['space'] ?? ''));
    $whole_account = (bool) ($values['whole_account'] ?? FALSE);

    $waiting = array_filter(
      $this->threads($slug),
      fn (array $thread): bool => $this->isFor($thread, $uid, $via, $whole_account),
    );
    // The query names the pages; access is decided on the loaded nodes.
    $pages = $this->editablePages(array_unique(array_column($waiting, 'nid')));
    $mine = [];
    foreach ($waiting as $thread) {
      if (isset($pages[$thread['nid']])) {
        $mine[] = ['node' => $pages[$thread['nid']]] + $thread;
      }
    }
    usort($mine, static fn (array $a, array $b): int => $b['at'] <=> $a['at']);

    $assignments = [];
    foreach (array_slice($mine, 0, self::LIMIT) as $thread) {
      $assignments[] = [
        'path' => $this->aliasManager->getAliasByPath('/node/' . $thread['node']->id()),
        'title' => (string) $thread['node']->label(),
        'blockId' => $thread['blockId'],
        'threadId' => $thread['threadId'],
        'text' => $thread['text'],
        'assignedBy' => $thread['assignedBy'] ?? '',
        'at' => $this->dateFormatter->format($thread['at'], 'custom', 'c'),
      ];
    }

    return ExecutableResult::success(
      $this->answer($assignments, count($mine)),
      ['total' => count($mine), 'assignments' => $assignments],
    );
  }

  /**
   * {@inheritdoc}
   */
  protected function checkAccess(array $values, AccountInterface $account, bool $return_as_object = FALSE): bool|AccessResultInterface {
    $access = AccessResult::allowedIf($account->isAuthenticated())
      ->addCacheContexts(['user.roles:authenticated']);

    return $return_as_object ? $access : $access->isAllowed();
  }

  /**
   * Whether a thread is one this call answers.
   *
   * A thread is handed to `{uid, via}`; `whole_account` widens that to every
   * client of the account, the person's own assignments included. A thread the
   * caller said the last word on is answered already.
   */
  private function isFor(array $thread, int $uid, ?string $via, bool $whole_account): bool {
    if ($thread['resolved'] || !is_array($thread['assignee'])) {
      return FALSE;
    }
    if ((int) ($thread['assignee']['uid'] ?? 0) !== $uid) {
      return FALSE;
    }
    if (!$whole_account && (($thread['assignee']['via'] ?? NULL) ?: NULL) !== $via) {
      return FALSE;
    }
    return $thread['lastBy'] !== ['uid' => $uid, 'via' => $via];
  }

  /**
   * The named pages the caller may edit, keyed by id.
   *
   * @param string[] $nids
   *   The page ids the threads are on.
   *
   * @return \Drupal\node\NodeInterface[]
   *   The pages, keyed by id.
   */
  private function editablePages(array $nids): array {
    if ($nids === []) {
      return [];
    }
    $pages = [];
    foreach ($this->entityTypeManager->getStorage('node')->loadMultiple($nids) as $id => $node) {
      if ($node instanceof NodeInterface && $node->access('update')) {
        $pages[(string) $id] = $node;
      }
    }
    return $pages;
  }

  /**
   * Every comment thread on a page, in the space if a slug is given.
   *
   * One query over the stored messages: what a thread is assigned to lives in
   * the message data, which no column holds, so the messages are folded here
   * rather than filtered by the database.
   *
   * Messages are ordered by when they were said, then by id, and a thread with
   * nothing said in it is not a thread yet.
   *
   * @return array[]
   *   Each as `{nid, threadId, blockId, assignee, assignedBy, resolved, text,
   *   lastBy, at}`.
   */
  private function threads(string $slug): array {
    $messages = $this->messages($slug);
    usort($messages, static fn (array $a, array $b): int =>
      ((int) ($a['data']['at'] ?? 0) <=> (int) ($b['data']['at'] ?? 0))
      ?: strcmp($a['msg_id'], $b['msg_id']));

    $threads = [];
    foreach ($messages as $message) {
      $key = $message['nid'] . ':' . $message['thread_id'];
      $thread = &$threads[$key];
      $thread ??= [
        'nid' => $message['nid'],
        'threadId' => $message['thread_id'],
        'blockId' => $message['anchor'],
        'assignee' => NULL,
        'assignedBy' => NULL,
        'resolved' => FALSE,
        'text' => '',
        'lastBy' => NULL,
        'at' => 0,
      ];
      $this->fold($thread, $message);
      unset($thread);
    }
    return array_filter($threads, static fn (array $thread): bool => $thread['text'] !== '');
  }

  /**
   * The stored messages about pages, in the space if a slug is given.
   *
   * @return array[]
   *   Each as `{nid, anchor, thread_id, msg_id, uid, data}`.
   */
  private function messages(string $slug): array {
    $query = $this->database->select('inline_comment', 'c')
      ->fields('c', ['entity_id', 'anchor', 'thread_id', 'msg_id', 'uid', 'data'])
      ->condition('c.entity_type', 'node');
    if ($slug !== '') {
      $spaces = SpaceStorage::get($this->entityTypeManager);
      $space = $spaces->getBySlug($slug);
      if ($space === NULL) {
        return [];
      }
      $query->join('node__field_space', 's', 's.entity_id = c.entity_id AND s.deleted = 0');
      $query->condition('s.field_space_target_id', $space->id());
    }

    $messages = [];
    foreach ($query->execute() as $row) {
      // The map field stores the message data serialized; no class comes out
      // of it, and a message may carry none.
      $stored = (string) $row->data;
      $data = $stored === '' ? [] : unserialize($stored, ['allowed_classes' => FALSE]);
      $messages[] = [
        'nid' => (string) $row->entity_id,
        'anchor' => (string) $row->anchor,
        'thread_id' => (string) $row->thread_id,
        'msg_id' => (string) $row->msg_id,
        'uid' => (int) $row->uid,
        'data' => is_array($data) ? $data : [],
      ];
    }
    return $messages;
  }

  /**
   * Folds one message into the thread it belongs to.
   *
   * A thread stands as its latest state-bearing message says: an assignment,
   * a resolve, and the words last said are three separate latest-wins values.
   * Who said them is the stored record's account, as the editor reads it.
   */
  private function fold(array &$thread, array $message): void {
    $data = $message['data'];
    // Messages carry milliseconds.
    $thread['at'] = max($thread['at'], intdiv((int) ($data['at'] ?? 0), 1000));
    if (array_key_exists('assignee', $data)) {
      $thread['assignee'] = is_array($data['assignee']) ? $data['assignee'] : NULL;
      $thread['assignedBy'] = (string) ($data['name'] ?? '');
    }
    if (array_key_exists('resolved', $data)) {
      $thread['resolved'] = (bool) $data['resolved'];
    }
    if (($data['text'] ?? '') !== '') {
      $thread['text'] = (string) $data['text'];
      $thread['lastBy'] = ['uid' => $message['uid'], 'via' => ($data['via'] ?? NULL) ?: NULL];
    }
  }

  /**
   * What the model reads: the threads, or that there are none.
   */
  private function answer(array $assignments, int $total): TranslatableMarkup {
    if ($assignments === []) {
      return new TranslatableMarkup('Nothing is assigned to you.');
    }
    $lines = [];
    foreach ($assignments as $assignment) {
      $lines[] = sprintf(
        '%s — %s, block %s, thread %s: "%s"',
        $assignment['title'],
        $assignment['path'],
        $assignment['blockId'],
        $assignment['threadId'],
        $assignment['text'],
      );
    }
    // Markup, not an escaping placeholder: what was said reaches the model as
    // the thread carries it.
    return new TranslatableMarkup("@total thread(s) assigned to you, the @count most recent:\n@list", [
      '@total' => $total,
      '@count' => count($assignments),
      '@list' => Markup::create(implode("\n", $lines)),
    ]);
  }

}
