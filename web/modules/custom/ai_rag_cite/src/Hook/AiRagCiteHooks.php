<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite\Hook;

use Drupal\Component\Plugin\Exception\PluginException;
use Drupal\Core\Config\Entity\ConfigEntityInterface;
use Drupal\Core\DependencyInjection\DependencySerializationTrait;
use Drupal\Core\Entity\EntityFormInterface;
use Drupal\Core\Entity\EntityTypeManagerInterface;
use Drupal\Core\Extension\ModuleHandlerInterface;
use Drupal\Core\Form\FormStateInterface;
use Drupal\Core\Hook\Attribute\Hook;
use Drupal\Core\Render\Element;
use Drupal\Core\StringTranslation\StringTranslationTrait;
use Drupal\ai_rag_cite\RetrieverPluginManager;
use Drupal\ai_rag_cite\ValueObject\GroundingSettings;

/**
 * The module's hooks.
 */
class AiRagCiteHooks {

  // The callbacks below put this object in the form array, and an AJAX rebuild
  // caches that: the services it holds travel as their ids instead.
  use DependencySerializationTrait;
  use StringTranslationTrait;

  /**
   * The assistant-form operations that edit one, rather than confirm about it.
   */
  private const EDIT_OPERATIONS = ['default', 'edit'];

  /**
   * Constructs the hooks.
   *
   * @param \Drupal\ai_rag_cite\RetrieverPluginManager $retrievers
   *   The retriever plugins offered on the form.
   * @param \Drupal\Core\Entity\EntityTypeManagerInterface $entityTypeManager
   *   Loads the other assistants, to keep the Explorer claim unique.
   * @param \Drupal\Core\Extension\ModuleHandlerInterface $moduleHandler
   *   Says whether there is an API Explorer to claim.
   */
  public function __construct(
    protected readonly RetrieverPluginManager $retrievers,
    protected readonly EntityTypeManagerInterface $entityTypeManager,
    protected readonly ModuleHandlerInterface $moduleHandler,
  ) {}

  /**
   * Implements hook_form_alter().
   *
   * Grounding is a property of the assistant, so it is configured where the
   * assistant is rather than on a settings page of its own.
   */
  #[Hook('form_alter')]
  public function formAlter(array &$form, FormStateInterface $form_state, string $form_id): void {
    $form_object = $form_state->getFormObject();
    if (!$form_object instanceof EntityFormInterface
      || !in_array($form_object->getOperation(), self::EDIT_OPERATIONS, TRUE)) {
      return;
    }
    $entity = $form_object->getEntity();
    if (!$entity instanceof ConfigEntityInterface || $entity->getEntityTypeId() !== 'ai_assistant') {
      return;
    }

    $settings = GroundingSettings::fromAssistant($entity) ?? new GroundingSettings();
    $options = ['' => $this->t('- Not grounded -')];
    foreach ($this->retrievers->getDefinitions() as $id => $definition) {
      $options[$id] = $definition['label'];
    }

    $form['ai_rag_cite'] = [
      '#type' => 'details',
      '#title' => $this->t('Grounding'),
      '#description' => $this->t('Retrieve before the model answers, hand it a numbered source list to cite, and say where an answer without sources came from.'),
      '#open' => $settings->retriever !== '',
      '#tree' => TRUE,
      'retriever' => [
        '#type' => 'select',
        '#title' => $this->t('Retriever'),
        '#options' => $options,
        '#default_value' => $settings->retriever,
      ],
      'retriever_settings' => [
        '#type' => 'textarea',
        '#title' => $this->t('Retriever settings'),
        '#description' => $this->t('One <em>key: value</em> per line, as the retriever documents them.'),
        '#default_value' => $this->toLines($settings->retrieverSettings),
        '#rows' => 4,
        '#element_validate' => [[$this, 'validateRetrieverSettings']],
      ],
      'score_gate' => [
        '#type' => 'container',
        'value' => [
          '#type' => 'number',
          '#title' => $this->t('Score gate'),
          '#description' => $this->t('The score a source has to reach to be offered to the model, on the scale the index returns. Each index and backend scores on its own scale, so measure it against yours.'),
          '#step' => 0.01,
          '#min' => 0,
          '#default_value' => $settings->scoreGate,
        ],
      ],
      'min_sources' => [
        '#type' => 'number',
        '#title' => $this->t('Minimum sources'),
        '#description' => $this->t('Fewer than this clearing the gate leaves the turn standing on nothing, which is what the mode below decides.'),
        '#min' => 1,
        '#default_value' => $settings->minSources,
      ],
      'max_sources' => [
        '#type' => 'number',
        '#title' => $this->t('Maximum sources'),
        '#min' => 1,
        '#default_value' => $settings->maxSources,
      ],
      'max_per_entity' => [
        '#type' => 'number',
        '#title' => $this->t('Maximum passages per page'),
        '#min' => 1,
        '#default_value' => $settings->maxPerEntity,
      ],
      'mode' => [
        '#type' => 'radios',
        '#title' => $this->t('Mode'),
        '#options' => [
          GroundingSettings::MODE_GROUNDED => $this->t('Grounded'),
          GroundingSettings::MODE_STRICT => $this->t('Strict'),
        ],
        GroundingSettings::MODE_GROUNDED => [
          '#description' => $this->t('Answers always come; ones without sources are marked "not from your knowledge base".'),
        ],
        GroundingSettings::MODE_STRICT => [
          '#description' => $this->t('When nothing in the readable pages supports an answer, the assistant says so and does not ask the model.'),
        ],
        '#default_value' => $settings->mode,
      ],
      'citation_contract' => [
        '#type' => 'textarea',
        '#title' => $this->t('Citation contract'),
        '#default_value' => $settings->citationContract,
        '#rows' => 3,
      ],
      'extra_guidance' => [
        '#type' => 'textarea',
        '#title' => $this->t('Extra guidance'),
        '#default_value' => $settings->extraGuidance,
        '#rows' => 2,
      ],
      'no_answer_message' => [
        '#type' => 'textfield',
        '#title' => $this->t('No-answer message'),
        '#description' => $this->t('Answered in strict mode, and whenever the retriever cannot be reached.'),
        '#default_value' => $settings->noAnswerMessage,
      ],
      'ground_explorer_calls' => [
        '#type' => 'checkbox',
        '#title' => $this->t('Also ground API Explorer chat calls'),
        '#description' => $this->t("The API Explorer names no assistant, so its chat calls are ungrounded. Switch this on to try this assistant's grounding there, with any provider and model. Only one assistant can claim them."),
        '#default_value' => $settings->groundExplorerCalls,
        '#access' => $this->moduleHandler->moduleExists('ai_api_explorer'),
        '#element_validate' => [[$this, 'validateExplorerClaim']],
      ],
    ];

    // Everything under the retriever describes what to do with what it found.
    $grounded = ['visible' => [':input[name="ai_rag_cite[retriever]"]' => ['!value' => '']]];
    foreach (Element::children($form['ai_rag_cite']) as $key) {
      if ($key !== 'retriever') {
        $form['ai_rag_cite'][$key]['#states'] = $grounded;
      }
    }

    $form['#entity_builders'][] = [$this, 'store'];
  }

  /**
   * Rejects a setting the chosen retriever does not have.
   *
   * @param array $element
   *   The textarea.
   * @param \Drupal\Core\Form\FormStateInterface $form_state
   *   The form state.
   */
  public function validateRetrieverSettings(array &$element, FormStateInterface $form_state): void {
    $retriever = (string) $form_state->getValue(['ai_rag_cite', 'retriever']);
    if ($retriever === '') {
      return;
    }
    try {
      $known = array_keys($this->retrievers->createInstance($retriever)->defaultConfiguration());
    }
    catch (PluginException) {
      return;
    }
    $unknown = array_diff(array_keys($this->fromLines((string) $element['#value'])), $known);
    if ($unknown) {
      $form_state->setError($element, $this->t('@retriever has no setting @keys. It reads: @known.', [
        '@retriever' => $retriever,
        '@keys' => implode(', ', $unknown),
        '@known' => implode(', ', $known),
      ]));
    }
  }

  /**
   * Rejects a second assistant claiming the API Explorer's chat calls.
   *
   * The Explorer names no assistant, so a claim has to be unique for the
   * grounding of its calls to be predictable.
   *
   * @param array $element
   *   The checkbox.
   * @param \Drupal\Core\Form\FormStateInterface $form_state
   *   The form state.
   */
  public function validateExplorerClaim(array &$element, FormStateInterface $form_state): void {
    if (!$element['#value']) {
      return;
    }
    $form_object = $form_state->getFormObject();
    $id = $form_object instanceof EntityFormInterface ? $form_object->getEntity()->id() : NULL;
    foreach ($this->entityTypeManager->getStorage('ai_assistant')->loadMultiple() as $assistant) {
      $settings = $assistant instanceof ConfigEntityInterface ? GroundingSettings::fromAssistant($assistant) : NULL;
      if ($settings?->groundExplorerCalls && $assistant->id() !== $id) {
        $form_state->setError($element, $this->t("@assistant already grounds the API Explorer's chat calls. Switch it off there first.", [
          '@assistant' => $assistant->label() ?? $assistant->id(),
        ]));
        return;
      }
    }
  }

  /**
   * Puts the submitted grounding settings on the assistant.
   *
   * @param string $entity_type
   *   The entity type id.
   * @param \Drupal\Core\Config\Entity\ConfigEntityInterface $entity
   *   The assistant.
   * @param array $form
   *   The form.
   * @param \Drupal\Core\Form\FormStateInterface $form_state
   *   The form state.
   */
  public function store(string $entity_type, ConfigEntityInterface $entity, array &$form, FormStateInterface $form_state): void {
    $values = (array) $form_state->getValue('ai_rag_cite');
    $values['ground_explorer_calls'] = (bool) ($values['ground_explorer_calls'] ?? FALSE);
    $values['retriever_settings'] = $this->fromLines((string) ($values['retriever_settings'] ?? ''));
    $values['score_gate']['value'] = (float) $values['score_gate']['value'];
    foreach (['min_sources', 'max_sources', 'max_per_entity'] as $key) {
      $values[$key] = (int) $values[$key];
    }
    GroundingSettings::store($entity, $values);
  }

  /**
   * The retriever settings as the form edits them.
   *
   * @param array<string, mixed> $settings
   *   The settings.
   */
  private function toLines(array $settings): string {
    $lines = [];
    foreach ($settings as $key => $value) {
      $lines[] = $key . ': ' . (is_scalar($value) ? (string) $value : '');
    }
    return implode("\n", $lines);
  }

  /**
   * The retriever settings as they are stored.
   *
   * A numeric-looking value is stored as a number: the schema types `top_k`
   * as an integer, and a string there fails config validation.
   *
   * @return array<string, mixed>
   *   The settings.
   */
  private function fromLines(string $lines): array {
    $settings = [];
    foreach (preg_split('/\R/', $lines) ?: [] as $line) {
      if (!str_contains($line, ':')) {
        continue;
      }
      [$key, $value] = explode(':', $line, 2);
      $value = trim($value);
      $settings[trim($key)] = is_numeric($value) ? $value + 0 : $value;
    }
    return $settings;
  }

}
