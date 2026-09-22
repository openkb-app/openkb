<?php

declare(strict_types=1);

namespace Drupal\ai_rag_cite;

/**
 * Thrown when a retriever cannot reach what it retrieves from.
 *
 * Distinct from retrieving nothing, so an outage cannot read as an empty
 * knowledge base.
 */
class RetrieverException extends \RuntimeException {}
