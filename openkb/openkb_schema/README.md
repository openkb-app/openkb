# OpenKB Schema — derived frontmatter contract

Publishes the `kb_page` frontmatter contract as JSON Schema:

```
GET /openkb/schema
```

There is no hand-maintained field list. The **`frontmatter` form display**
(`core.entity_form_display.node.kb_page.frontmatter`, shipped by
`recipes/openkb_recipe_main/`) is the single exposure contract:

- **Placed = exposed.** Every configurable field placed in that display
  becomes a schema property; unplaced fields do not exist as far as the
  frontmatter surface is concerned.
- **Order = weight.** Property order follows the component weights.
- **Widget = rendering hint.** The widget id + settings ship on each
  property as `x-widget` for schema-driven form rendering.

Site-builders manage exposure with Field UI
(`/admin/structure/types/manage/kb_page/form-display/frontmatter`).

## The body's text format

The body is not frontmatter, but the format it is authored in is configured
the same way: `field_kb_body`'s `allowed_formats`, which names exactly one.
`BodyFormat` reads it there, and the module is the only place that knows it:

- **Readers** get that format's `filter_html` restrictions as `body.allowedHtml`
  on the response — `{tag: true | {attribute: true | {value: true}}}`, as
  Drupal parses them, with a trailing `*` globbing an attribute name or value
  and the `*` tag carrying what applies to every tag. The frontend's comark
  tree passes filter HTML elements and component nodes against it. Absent when
  the format restricts nothing, or the field names no single format — then the
  frontend's built-in checks are the whole filter.
- **Writers** send a body value and nothing else: the presave stamps the
  configured format onto every `kb_page` body that arrives without one, so
  no write surface — JSON:API, the commit route, the create tool — names a
  format. A field naming no single format leaves the body's format unset and
  logs.

## Publishing the values

The schema says *which* fields are exposed; the `kb_page` **CE display**
(`custom_elements.entity_ce_display.node.kb_page.full`) carries their
*values*. A published `.md` and the `tool_api__get_page` tool project their
frontmatter straight off `content.props` of the page response, so the two
displays have to agree: each exposed field needs a prop on the CE display,
named for its frontmatter key (`field_type` → `type`), and every reference
carries `include_uuid` + `include_label` so it arrives with the `uuid` and raw
`label` that make up the `{id, label}` pair of the wire format.

Exposing a field in the form display without publishing it on the CE display
would serve it as permanently empty; `PageFrontmatterCeDisplayTest` fails
on that rather than letting it ship.

## Key naming

Frontmatter key = field machine name minus the `field_` prefix:
`field_owner` → `owner`, `field_tags` → `tags`, …

The key alone cannot address the field in JSON:API, so every property also
carries `x-field-name` with the machine name — that is what the collab
session's field seeding and the commit payload read and write through.

## Property derivation

| Field type | Schema |
|---|---|
| `string`, `string_long` | `{"type": "string"}` |
| `list_string` | `{"type": "string", "enum": [...], "x-enum-labels": {value: label}}` |
| `entity_reference` | `{"type": "object", "properties": {"id", "label"}, "required": ["id"], "x-entity-reference": {"entity_type", "bundles"?}}` — matches the `{id, label}` shape refs use in the collab Y.Map |
| `boolean` / `integer` / `decimal` / `float` | corresponding JSON type |
| anything else | `{"type": "string"}` |

Cardinality 1 emits the item schema directly; multi-value fields emit
`{"type": "array", "items": ...}` (+ `maxItems` for bounded cardinality).
Required fields land in the top-level `required` array; single-value scalar
defaults ship as `default`.

## Example

```bash
curl http://openkb-dev-project.localdev.space:8081/openkb/schema
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "kb_page frontmatter",
  "type": "object",
  "properties": {
    "type": { "type": "string", "enum": ["article", "adr", "guide", "runbook"], "default": "article", "…": "…" },
    "summary": { "type": "string", "…": "…" },
    "owner": { "type": "object", "x-entity-reference": { "entity_type": "user" }, "…": "…" },
    "contributors": { "type": "array", "…": "…" },
    "tags": { "type": "array", "…": "…" }
  },
  "required": ["type"],
  "additionalProperties": false,
  "body": {
    "allowedHtml": { "a": { "href": true }, "code": { "class": { "language-*": true } }, "…": "…" }
  }
}
```

## Caching

The response is a `CacheableJsonResponse` tagged with the form display's cache
tags, every exposed field config's, and the body field's and its format's —
changing the exposure contract in Field UI invalidates it immediately. Access
requires `access content`, the same anonymous-read posture as the CE-API.

## What's inside

| Path | Role |
|---|---|
| `src/SchemaBuilder.php` | Derives the JSON Schema from the form display + field definitions; collects cacheability. |
| `src/BodyFormat.php` | The body field's single configured text format — what the schema publishes the allowed list of, and what writes are stored under. |
| `src/Hook/BodyFormatHooks.php` | Presave: stamps that format onto a body that arrives without one. |
| `src/Controller/SchemaController.php` | Thin controller: builder → `CacheableJsonResponse`; 404 while the form display doesn't exist. |
| `tests/src/Kernel/SchemaEndpointTest.php` | Kernel coverage: schema shape, enum values, placed/unplaced consistency, cache tags. |
| `tests/src/Kernel/BodyFormatPresaveTest.php` | Kernel coverage: a body saved without a format is stored with the field's. |
| `tests/src/Kernel/PageFrontmatterCeDisplayTest.php` | Pins the CE display against the exposure contract: a prop per exposed field, references as `{uuid, name}`. |

## Tests

```bash
docker compose exec cli ./vendor/bin/phpunit openkb/openkb_schema/tests
```
