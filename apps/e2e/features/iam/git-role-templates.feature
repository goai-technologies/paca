@iam @git
Feature: Git actions in roles
  The built-in project roles carry the Git actions they should: Editor reads and
  writes, Viewer has none, Admin has everything. A custom role may hold any of
  the four project actions, and the workspace action lives on the workspace
  resource root.

  Background:
    Given the user already has a stored authenticated admin session
    And a project

  Scenario: The built-in project roles
    Then "Editor" allows git:read and git:write but not git:approve or git:merge
    And "Viewer" allows no Git action
    And "Admin" allows every Git action, including git:merge

  Scenario Outline: A custom project role may hold <action>
    When a project role allowing "<action>" is created
    Then it is stored with that action
    Examples:
      | action      |
      | git:read    |
      | git:write   |
      | git:approve |
      | git:merge   |
      | git:*       |

  Scenario: A workspace role may hold git.identities:manage on its own resource
    When a workspace role allowing "git.identities:manage" on "git_identity/*" is created
    Then it is stored
    And the same action on an unknown resource root is refused (ROLE_POLICY_INVALID, 422)
    And so is an unknown action in the same domain

  Scenario: The workspace action on a project resource is accepted but grants nothing
    Given a workspace role allowing "git.identities:manage" on "project/<id>/*"
    Then the policy validator accepts it, because it checks only the resource root and the action name
    But a user holding it still answers 403 on the workspace identity routes, which are checked on "git_identity/*"

  Scenario: The Editor role really works
    Given a member holding only the built-in Editor role
    Then they read repositories and settings and write settings
    But they cannot approve, merge, or link a repository
