<?php

declare(strict_types=1);

namespace Drupal\openkb_search\Retrieval;

use Drupal\search_api\SearchApiException;

/**
 * The provider refused the caller's own words, so the index was never asked.
 *
 * An answer about the query, not about the index: a surface that can say
 * "nothing matches" says that rather than offering a retry that cannot
 * succeed. It extends the exception every consumer already reads as
 * unavailability, so a surface not telling the two apart keeps its behaviour.
 */
final class QueryRefusedException extends SearchApiException {}
