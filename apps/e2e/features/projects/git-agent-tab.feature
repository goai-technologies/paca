@projects @git
Feature: An agent's Git tab
  The agent page's Git tab shows which identity the agent acts through (the
  shared bot or its own), lets the right people create, install and remove an
  own identity, and lists the Git triggers that start the agent. Providers,
  identities and triggers are stubbed in the browser; the agent and the
  signed-in user's permissions are real.

  Background:
    Given the user already has a stored authenticated admin session
    And a project with an agent
    And the user opens the agent's "Git" tab

  Rule: Identity

    Scenario: No Git platform is available
      Given no provider is installed
      Then the tab says "No Git platform available"

    Scenario: The agent uses the shared identity by default
      Given a provider is installed and the agent has no identity of its own
      Then the tab says it uses the shared identity
      And "Create identity" is offered

    Scenario: Creating an own identity starts the platform's setup
      When the user clicks "Create identity"
      Then the platform is asked to set up an identity for this agent and project
      And the browser is sent to the platform's approval page

    Scenario: An own identity shows the bot and can be removed
      Given the agent has its own identity "paca-reviewer"
      Then the tab shows "Own identity" and "@paca-reviewer"
      When the user clicks "Remove"
      Then the platform is asked to delete that identity

    Scenario: Installing on another account asks the platform
      Given the agent has its own identity
      When the user types "other-org" and clicks "Install"
      Then the platform is asked to begin an access grant for "other-org"

    Scenario: Someone without git.identities:manage is told to ask an administrator
      Given a member with "agents:read", "agents:write" and "git:write" but not the workspace action
      Then the tab says "Ask a workspace administrator to create one."

  Rule: Triggers

    Scenario: Triggers are grouped by purpose
      Given a provider that supports every trigger
      Then the groups "Respond to requests", "Follow up on its own pull requests" and "Act on its own" are shown

    Scenario: Switching a trigger saves it
      When the user switches off "Mentioned"
      Then the platform is asked to disable "mention" for this agent

    Scenario: Triggers the platforms cannot deliver say so
      Given a provider that supports no trigger
      Then each trigger says "Not supported by the connected Git platforms." and its switch is disabled

    Scenario: A reader cannot change triggers
      Given a member with only "agents:read"
      Then the trigger switches are disabled
