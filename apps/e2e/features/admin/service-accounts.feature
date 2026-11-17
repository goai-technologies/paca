@admin @service-accounts
Feature: Service accounts
  A service account (docs/api/service-accounts.md) is a workspace-level,
  non-human account for integrations. It has a name, a description and an
  avatar, authenticates with its own API keys, holds roles like a user, and
  cannot sign in. Managed under /admin/service-accounts with the
  service_accounts:read and service_accounts:write permissions.

  Rule: Management

    Scenario: A service account is created, read, listed, renamed and deleted
      When an administrator creates a service account with a description
      Then it holds no role
      And it can be fetched and appears in the list
      When only its name is changed
      Then the description is unchanged
      When it is deleted
      Then it is gone from the list and fetching it returns 404

    Scenario: A name is required and bounded
      When a service account is created with an empty, blank or 101-character name
      Then the request is refused
      And a description over 1000 characters is refused too

    Scenario: Only service accounts are reachable on the service-account routes
      Given a user and an agent exist
      When their ids are used on the service-account routes
      Then every route answers 404 and the user and agent are untouched

    Scenario: A service account cannot sign in
      When its name or id is used as a username at login
      Then login is refused with 401

  Rule: API keys

    Scenario: A key is shown once and authenticates as the account
      When a key is created
      Then the raw key is returned once and is never listed
      And the key authenticates, as X-API-Key and as Authorization: ApiKey
      And last_used_at is set after use

    Scenario: A revoked key stops working
      Given an account with two keys
      When one is revoked
      Then it answers 401 and leaves the list, and the other key still works

    Scenario: A key cannot be revoked through another service account
      When a key is revoked under a different account's id
      Then the request is refused and the key keeps working

    Scenario: A key past its expiry is refused

    Scenario: Keys are managed with a session
      Given a service account whose role allows every action
      Then its key can manage service accounts
      But it cannot list, mint or revoke any service account key or a user's own keys

    Scenario: Deleting the account kills its keys

  Rule: Roles and access

    Scenario: A key is judged by the account's roles and an edit applies on the next request
      Then a Deny from another role beats an Allow

    Scenario: A service account works in a project only as a member
      Given the account is added with service_account_id
      Then it has the access of its project roles only
      And it appears as member_type "service_account"
      And deleting the account removes the membership

    Scenario: A project member request needs exactly one account

    Scenario: service_accounts:read and service_accounts:write are separate permissions

    Scenario: Minting a key needs the authority to assign every role the account holds
      Given a delegate with service_accounts:write who may assign only role LOW
      When the account holds no role or only LOW
      Then the delegate may mint a key
      When the account also holds role HIGH
      Then minting a key is refused with 403
