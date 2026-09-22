# Simple OAuth Personal Consumers

Self-service, owner-bound OAuth2 consumers on top of
[Simple OAuth](https://www.drupal.org/project/simple_oauth): any user with the
`manage own personal consumers` permission can provision client-credentials
API clients on their own profile ("API clients" tab), each acting **as that
user** with strictly capped permissions.

## Model

- **One consumer per client.** Provisioning creates a confidential,
  client-credentials-only consumer with `user_id` set to the owner and the
  module's `personal` flag. The client secret is shown exactly once.
- **Owner-derived permissions, live.** Tokens issued via client_credentials
  carry no user identifier, which makes simple_oauth grant the raw scope
  permissions. This module stamps the consumer's owner onto each token
  (`auth_user_id`), so simple_oauth computes **owner's permissions ∩ scope**
  per request — role changes on the owner apply immediately, no syncing.
- **Scope ceiling.** The `simple_oauth_personal_consumers.settings:scopes`
  config lists the OAuth2 scope IDs every provisioned consumer gets. A token
  can never exceed that allow-list, whatever the owner may do.
- **No admin owners.** A token acts as its owner, and simple_oauth passes an
  admin owner's bypass straight through — an admin-owned client would ignore
  its scope ceiling. Administrator accounts (any admin role, and the
  super-user uid 1) are therefore refused, on both the profile form and the
  provisioning service. The same check runs again at **access time**, on every
  request a personal-consumer token authenticates, so an owner promoted after
  provisioning loses the token instead of gaining an uncapped one; demoting
  them restores it. Agents run on non-admin accounts.
- **Age and use are stamped.** Every consumer carries `created` (set when the
  entity is created) and `last_used`. `last_used` means **the last time a
  token was issued** for the consumer — a client_credentials grant, an
  auth-code exchange or a refresh — kept to the hour. An API request made
  with an existing token does not update it, so its precision is the token
  lifetime plus that hour: read it as "last (re-)connected", not "last API
  call". The stamp is written straight to storage because saving a consumer
  entity makes simple_oauth delete every non-refresh token it holds.
- **Unclaimed clients are swept.** A self-registered client
  (`openkb_agent_registration`) is a personal consumer owned by nobody until
  the first person authorizes it. Cron deletes the ones nobody ever did, once
  they are older than
  `simple_oauth_personal_consumers.settings:unclaimed_retention` (7 days).
  Owned consumers are never swept, whatever their age.
- **Revoke = disable + keep.** Revoking kills all of the consumer's tokens
  and blocks new issuance (empty grant list, status disabled), but keeps the
  entity so historical attribution to the client keeps resolving. Revoked
  clients stay listed as such on the profile tab.

## Setup

1. Install the module and configure Simple OAuth (keys, expiration).
2. Create the OAuth2 scopes that define the ceiling and list their IDs in
   `simple_oauth_personal_consumers.settings:scopes`.
3. Grant `manage own personal consumers` to the intended roles.

Users manage their clients at `/user/{uid}/api-clients`; tokens are fetched
from `/oauth/token` with `grant_type=client_credentials`.
