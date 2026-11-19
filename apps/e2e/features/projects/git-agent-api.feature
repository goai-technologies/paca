@projects @git
Feature: An agent's Git triggers and identity (API)
  Each project agent decides which Git events start it. Reading its triggers
  and identity needs agents:read on the agent; changing triggers needs
  agents:write; creating or removing its own bot identity also needs the
  workspace action git.identities:manage, and installing that identity on
  another account needs git:write on the project.

  Background:
    Given the user already has a stored authenticated admin session
    And a project with an agent

  Scenario: A new agent has the default triggers
    Then the triggers list every kind, none explicit, and only "auto_review" is off
    And no trigger is supported while no provider is installed
    And the agent has no identity

  Scenario: Switching a trigger is remembered as an explicit choice
    When the "mention" trigger is switched off
    Then it is disabled and explicit, and the others are unchanged
    When it is switched on again
    Then it is enabled and still explicit

  Scenario: An unknown trigger kind is a 400
    Then switching "bogus" answers 400 BAD_REQUEST

  Scenario Outline: Each agent route needs its own permissions
    When a member calls "<route>"
    Then only holders of "<needs>" pass the gate
    Examples:
      | route                                | needs                                   |
      | GET   git/triggers                   | agents:read                             |
      | PUT   git/triggers/mention           | agents:write                            |
      | GET   git/identity                   | agents:read                             |
      | POST  git/identity/setup             | agents:write + git.identities:manage    |
      | DELETE git/identity                  | agents:write + git.identities:manage    |
      | POST  git/identity/access/begin      | agents:write + git:write                |

  Scenario: Identity setup without a provider plugin is unavailable
    Then setting up an identity for an unknown provider answers 503 GIT_PROVIDER_UNAVAILABLE
