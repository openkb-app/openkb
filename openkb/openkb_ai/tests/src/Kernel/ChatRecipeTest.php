<?php

declare(strict_types=1);

namespace Drupal\Tests\openkb_ai\Kernel;

use Drupal\Core\Recipe\RecipeRunner;
use Drupal\FunctionalTests\Core\Recipe\RecipeTestTrait;
use Drupal\KernelTests\KernelTestBase;
use Drupal\ai\OperationType\Chat\ChatInput;
use Drupal\ai\OperationType\Chat\ChatMessage;
use Drupal\ai_assistant_api\Entity\AiAssistant;
use Drupal\vercel_ai_sdk_mock\Plugin\AiProvider\MockProvider;
use Symfony\Component\Yaml\Yaml;

/**
 * Applies the chat recipes and asserts what a fresh install ends up with.
 *
 * A recipe installs its modules as syncing, and Drupal skips a module's
 * `config/install` *entities* while syncing — simple config still lands, config
 * entities do not. So every config entity the chat surface needs has to be
 * named in the recipe's `config: import:`, or a fresh install has a chat
 * surface with nothing behind it.
 *
 * AssistantConfigTest cannot see that gap: `installConfig()` imports the
 * module's config directly, which is exactly what a recipe does not do.
 *
 * The recipe is applied without its `openkb_recipe_main` dependency (that one
 * builds the whole KB content model); everything else is the shipped file.
 *
 * @group openkb_ai
 */
final class ChatRecipeTest extends KernelTestBase {

  use RecipeTestTrait;

  /**
   * {@inheritdoc}
   */
  protected static $modules = ['system', 'user'];

  /**
   * {@inheritdoc}
   */
  protected function setUp(): void {
    parent::setUp();
    // The recipe grants a permission to the authenticated role, so the role
    // has to exist before it is applied.
    $this->installConfig(['user']);
  }

  /**
   * Every config entity the chat surface needs exists after the recipe runs.
   */
  public function testChatConfigEntitiesExistAfterRecipeApply(): void {
    $storage = $this->container->get('config.storage');
    self::assertFalse($storage->exists('ai_assistant_api.ai_assistant.openkb'));

    $this->applyChatRecipe();

    $moduleHandler = \Drupal::moduleHandler();
    self::assertTrue($moduleHandler->moduleExists('openkb_ai'));
    self::assertTrue($moduleHandler->moduleExists('ai_provider_openai'));
    self::assertTrue($moduleHandler->moduleExists('ai_provider_amazeeio'));
    // Carries Tool API tools to the assistant as AI function calls.
    self::assertTrue($moduleHandler->moduleExists('tool_ai_connector'));

    /** @var \Drupal\ai_assistant_api\Entity\AiAssistant|null $assistant */
    $assistant = \Drupal::entityTypeManager()->getStorage('ai_assistant')->load('openkb');
    self::assertInstanceOf(AiAssistant::class, $assistant);
    self::assertSame('openai', (string) $assistant->get('llm_provider'));
    self::assertSame('gpt-4o-mini', (string) $assistant->get('llm_model'));
    // The prompt lives in the one field the assistant form edits.
    self::assertNotSame('', (string) $assistant->get('instructions'));
    self::assertSame('', (string) $assistant->get('preprompt_instructions'));

    // ai_provider_amazeeio.settings references these by id; without them the
    // provider cannot be given a key.
    $keys = \Drupal::entityTypeManager()->getStorage('key');
    self::assertNotNull($keys->load('amazeeio_ai'));
    self::assertNotNull($keys->load('amazeeio_ai_database'));
  }

  /**
   * The OpenAI provider is keyed from the environment by the recipe.
   *
   * An environment that exports OPENAI_API_KEY is then one assistant setting
   * away from answering from OpenAI: no key form, no provider form.
   */
  public function testTheOpenAiProviderReadsItsKeyFromTheEnvironment(): void {
    $this->applyChatRecipe();

    /** @var \Drupal\key\Entity\Key|null $key */
    $key = \Drupal::entityTypeManager()->getStorage('key')->load('openai_env');
    self::assertNotNull($key);
    $provider = $key->getKeyProvider();
    self::assertSame('env', $provider->getPluginId());
    self::assertSame(
      'OPENAI_API_KEY',
      $provider->getConfiguration()['env_variable']
    );

    // The provider form's *API Key* select, pre-picked.
    self::assertSame(
      'openai_env',
      $this->config('ai_provider_openai.settings')->get('api_key')
    );

    // No variable, no key: the provider stays unusable, as an unkeyed one is.
    putenv('OPENAI_API_KEY');
    self::assertNull($key->getKeyValue(TRUE));

    putenv('OPENAI_API_KEY=sk-openkb-test');
    self::assertSame('sk-openkb-test', $key->getKeyValue(TRUE));
    putenv('OPENAI_API_KEY');
  }

  /**
   * The mock recipe leaves the assistant answering without a key.
   */
  public function testTheMockRecipePointsTheAssistantAtTheMock(): void {
    $this->applyChatRecipe();
    $this->applyRecipe('openkb_recipe_chat_mock');

    self::assertTrue(\Drupal::moduleHandler()->moduleExists('vercel_ai_sdk_mock'));

    /** @var \Drupal\ai_assistant_api\Entity\AiAssistant $assistant */
    $assistant = \Drupal::entityTypeManager()->getStorage('ai_assistant')->load('openkb');
    self::assertSame('mock', (string) $assistant->get('llm_provider'));
    self::assertSame(MockProvider::MODEL, (string) $assistant->get('llm_model'));
  }

  /**
   * The logging recipe installs the module that has somewhere to log to.
   *
   * `drupal/ai` ships a deprecated submodule of the same machine name, and
   * which of the two Drupal finds is directory order — so the assertion is on
   * the entity type only the standalone project defines.
   */
  public function testTheLoggingRecipeInstallsTheStandaloneModule(): void {
    $this->applyChatRecipe();
    $this->applyRecipe('openkb_recipe_chat_mock');
    $this->applyRecipe('openkb_recipe_ai_logging');

    self::assertTrue(\Drupal::moduleHandler()->moduleExists('ai_logging'));
    self::assertSame(
      'modules/contrib/ai_logging',
      \Drupal::service('extension.list.module')->getPath('ai_logging'),
    );
    $logs = \Drupal::entityTypeManager()->getStorage('ai_log');
    self::assertCount(0, $logs->loadMultiple());

    // A module that is installed but logs nothing is the failure this guards,
    // on the streamed call the bridge makes.
    $input = new ChatInput([new ChatMessage('user', 'How do we release?')]);
    $input->setStreamedOutput(TRUE);
    $output = \Drupal::service('ai.provider')
      ->createInstance('mock')
      ->chat($input, MockProvider::MODEL);
    foreach ($output->getNormalized() as $chunk) {
      // The log is written when the answer has been read, as a real one is.
    }

    self::assertNotEmpty($logs->loadMultiple());
  }

  /**
   * Applies the shipped chat recipe, minus its openkb_recipe_main dependency.
   */
  private function applyChatRecipe(): void {
    $data = Yaml::parseFile(dirname(DRUPAL_ROOT) . '/recipes/openkb_recipe_chat/recipe.yml');
    unset($data['recipes']);
    RecipeRunner::processRecipe($this->createRecipe($data, 'openkb_recipe_chat'));
  }

  /**
   * Applies a shipped recipe, minus the recipes it is applied on top of.
   */
  private function applyRecipe(string $name): void {
    $data = Yaml::parseFile(dirname(DRUPAL_ROOT) . '/recipes/' . $name . '/recipe.yml');
    unset($data['recipes']);
    RecipeRunner::processRecipe($this->createRecipe($data, $name));
  }

}
