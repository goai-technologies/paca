@projects @git
Feature: Pull requests and branches on a task (API)
  A task lists the change requests and branches linked to it. Reading needs
  tasks:read. Linking, unlinking and creating need tasks:write on the task plus
  git:read (git:write for creating a branch on the platform). Nothing is linked
  to a repository that is not linked to the project.

  Background:
    Given the user already has a stored authenticated admin session
    And a project with a task

  Scenario: A task with nothing linked
    Then GET /tasks/{id}/git answers empty change_requests and branches

  Scenario Outline: Each link route needs its own permissions
    When a member calls "<route>"
    Then <held> passes the gate and <missing> answers 403
    Examples:
      | route                               | needs                     |
      | GET    git                          | tasks:read                |
      | POST   git/change-requests          | tasks:write + git:read    |
      | DELETE git/change-requests/1        | tasks:write + git:read    |
      | POST   git/branches                 | tasks:write + git:read    |
      | DELETE git/branches                 | tasks:write + git:read    |
      | POST   git/branches/new             | tasks:write + git:write   |

  Scenario: A repository that is not linked to the project is not found
    Then linking a change request or a branch to an unknown repository answers 404 GIT_NOT_FOUND
    And creating a branch there answers 404 GIT_NOT_FOUND
    And unlinking from it answers 404 GIT_NOT_FOUND

  Scenario: A link request must say what it links
    Then a link without a number is a 400
    And a task of another project is not reachable through this one

  Scenario: Anonymous callers are refused
    Then every task Git route answers 401
