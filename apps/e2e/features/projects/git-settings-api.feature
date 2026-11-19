@projects @git
Feature: A project's Git automation settings, runs and providers (API)
  Each project keeps its own Git workflow policy: the default responder agent,
  the minimum repository permission an actor needs to start an agent, and a
  pause switch. The settings are read with git:read and written with git:write.

  Background:
    Given the user already has a stored authenticated admin session
    And a project

  Scenario: A new project has the default policy
    Then the settings are not paused, the minimum permission is "write" and there is no responder
    And the runs list is empty and no provider is listed

  Scenario: A save replaces the whole policy
    When the settings are saved with only paused false
    Then the omitted fields go back to their defaults

  Scenario: Saving settings for a project that does not exist is a 404
    When the settings of an unknown project id are saved
    Then the answer is 404 GIT_NOT_FOUND, not 500

  Scenario: Settings round-trip
    When the settings are saved with paused true and minimum permission "admin"
    Then reading them back returns the same values

  Scenario Outline: Each minimum permission level is accepted
    When the minimum permission is "<level>"
    Then the answer is 200 and the value is stored
    Examples:
      | level    |
      | read     |
      | triage   |
      | write    |
      | maintain |
      | admin    |

  Scenario: An unknown minimum permission is a 400
    When the minimum permission is "root"
    Then the answer is 400 BAD_REQUEST and the stored value is unchanged

  Scenario: The default responder must be an agent of this project
    Given an agent of the project and an agent of another project
    Then the project's agent is accepted
    And the other project's agent is a 400
    And clearing the responder with null is accepted

  Scenario: Projects do not share settings
    Given two projects
    When one is paused
    Then the other is not

  Scenario: A malformed body is a 400
    Then a body that is not JSON answers 400
