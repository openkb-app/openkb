<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite;

use Drupal\Core\Plugin\ConfigurablePluginBase;

/**
 * Base class for retrievers.
 *
 * Core's configurable base merges a plugin's defaults into its configuration,
 * so a retriever only declares its own settings and answers passages.
 */
abstract class RetrieverBase extends ConfigurablePluginBase implements RetrieverInterface {}
