# Inline comment

Threaded comments anchored to a region of an entity — the storage half of a
review conversation, with no opinion about what the regions are.

One entity translation holds one set of messages, named by
`entity_type + entity_id + langcode + anchor + thread_id + msg_id`. Coordinates
are columns; everything else the consumer holds about a message rides an opaque
`data` map, this side never reads inside it. So resolving, quoting, agent
labels and whatever else a conversation needs are the consumer's vocabulary,
and adding one is no schema change here.

## Using it

`/api/inline-comments` is the whole surface, per entity translation:

- `GET ?entity_type=&entity_id=&langcode=` — the stored messages.
- `PUT` — the messages as the caller now holds them. Stated coordinates that
  are not stored are added, stored ones are left exactly as they are, and
  stored ones the caller does not state are dropped. So the durable set is a
  mirror of the live one, and restating it costs nothing.
- `DELETE ?entity_type=&entity_id=&langcode=` — drops them all.

`inline_comment.settings:entity_types` is the list of entity types this site
comments on. A request naming any other type is refused with a 400.

## Who it answers

Two answers, both required on every verb:

- `use inline comments api`, the switch that turns the surface off;
- the commented entity's own `update` access, which decides which entities.
  Annotations quote text that is being worked on, so the roster that may change
  an entity is the roster that may read and say what is said about it.

One surface for every caller. A browser and a server both authenticate as an
account and are answered the same way; what a caller may do is what its
account's roles say.

## Naming an author

Every message names its own author, and a caller is taken at its word about it:
a conversation is delivered by whoever witnessed it, which is not the person
who said any given line — one call carries several people's words. What keeps
that honest is who may call at all, plus the author having to be an account
that exists, which the stored reference decides.
