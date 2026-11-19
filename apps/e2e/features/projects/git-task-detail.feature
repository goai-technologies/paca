@projects @git
Feature: Pull requests and branches on the task page
  Once a project has a linked repository, a task shows the pull requests and
  branches tied to it. Each pull request shows its state, author and the CI
  state of open ones. People who may edit the task can link and unlink them.
  The Git endpoints are stubbed in the browser (the e2e stack has no Git
  provider plugin); the task itself is real.

  Background:
    Given the user already has a stored authenticated admin session
    And a project with a task

  Scenario: Nothing is shown until a repository is linked
    Given the project has no linked repository
    Then the task page has no "Pull requests" or "Branches" section

  Scenario: Both sections show their empty states and actions
    Given the project has a linked repository and the task has no links
    Then "No pull requests linked yet." and "No branches linked yet." are shown
    And "Link pull request", "Link branch" and "New branch" are offered

  Scenario Outline: A pull request shows its state and CI
    Given a <kind> pull request "<title>" by "alice" <ci>
    Then the task page lists "<title>" with "by alice" and "<badge>"
    Examples:
      | kind   | title        | ci              | badge        |
      | open   | Add login    | with CI passing | CI passing   |
      | open   | Fix flake    | with CI failing | CI failing   |
      | open   | Refactor db  | with CI running | CI running   |
      | merged | Ship it      | without CI      | Merged       |
      | closed | Dropped      | without CI      | Closed       |

  Scenario: A linked branch is listed and can be unlinked
    Given the task has the branch "feat/login"
    Then it is listed with its repository
    When the user unlinks it
    Then the platform is asked to unlink that branch and it disappears

  Scenario: A pull request is unlinked
    Given the task has a linked pull request
    When the user unlinks it
    Then the platform is asked to unlink it and it disappears

  Scenario: A pull request is linked by pasted link
    When the user pastes a pull request link and submits
    Then the platform is asked to link that number in that repository

  Scenario: A link the platform rejects is explained
    When linking answers GIT_NOT_FOUND
    Then the form says it wasn't found in that repository

  Scenario: Without edit access the actions are hidden
    Given a member who can read the task but not edit it
    Then the sections are shown without link, unlink or new-branch actions
