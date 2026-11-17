@iam @accounts
Feature: Unified accounts
  A user, an agent and a service account are one accounts row each
  (docs/architecture/database-schema.md, "Accounts model"). Each authenticates
  with its own API key and is judged by its own role attachments only.

  Scenario Outline: An account authenticates with its own key and is judged by its own roles
    Given a <kind> with a key and no workspace role
    Then its key authenticates but is refused
    When a role is attached it is allowed, and when detached it is refused again

    Examples:
      | kind            |
      | user            |
      | agent           |
      | service_account |

  Scenario Outline: A deleted account no longer authenticates
    Given a <kind> holding a role
    When the account is deleted
    Then its key answers 401
    And the role, no longer attached, can be deleted

    Examples:
      | kind            |
      | user            |
      | agent           |
      | service_account |

  Scenario: Headers naming another account change nothing
    Given an agent key sent with X-Agent-ID and X-Actor-User-ID of other accounts
    Then the agent is judged by its own roles only

  Scenario: The retired shared agent key is not a credential

  Scenario: Users, agents and service accounts are members of one project
    Then one member listing carries all three member types
    And each is judged by its own project roles

  Scenario: Usernames are unique among live users only
  Scenario: Agent handles are unique per project and workspace-wide for global agents
  Scenario: Service account names are not identifiers
