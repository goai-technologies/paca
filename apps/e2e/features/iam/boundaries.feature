@iam @boundaries
Feature: The edges of the authorization model
  Who gets in without signing in, where workspace grants stop and project grants
  begin, what a role attached to one project can reach, what the built-in ADMIN
  role cannot do, what a removed member or deleted account keeps, and the
  read-only helpers (simulate and "my permissions").

  Rule: Callers who are not signed in

    Background:
      Given the user already has a stored authenticated admin session
      And a project with a task

    Scenario: A private project and every workspace route answer 401
      Then reads and writes without credentials answer 401 on projects, admin, roles and permission routes

    Scenario: A malformed or forged token is 401
      Then tokens "garbage", "a.b.c" and an empty one answer 401 on project and admin routes

    Scenario: There is no public mode
      When a client sends the retired "is_public" flag on a project
      Then the project does not report it
      And an anonymous caller still answers 401 on the project, members, statuses, tasks, sprints, docs and views

    Scenario: A signed-in user with no role on the project is refused
      Then reading the project and its tasks answers 403

    Scenario: A non-UUID project id is a 400
      Then project routes with "not-a-uuid" answer 400 for a signed-in caller

  Rule: Workspace grants do not reach into projects

    Background:
      Given the user already has a stored authenticated admin session
      And two projects, each with a task

    Scenario: A named project action on the workspace resources opens no project
      Given a workspace role allowing tasks, docs and sprints actions on the workspace resources only
      Then its holder answers 403 on tasks, sprints and task creation in both projects

    Scenario: Only * on * or a grant on project/... reaches inside projects
      Given a workspace role with full access and one naming a single project for tasks:read
      Then full access reads both projects
      And the named-project role reads that project only, and cannot write there

    Scenario: A full-access role attached to one project reaches that project and nothing else
      Given a role with "*" on "*" attached to a member of project 1
      Then the member works in project 1
      But project 2 and /admin routes, including role creation, answer 403

    Scenario: A project Admin has no say outside its project
      Given a member holding the project's Admin role
      Then the other project and the admin surface answer 403

    Scenario: Deny on a project beats a workspace-wide full-access role
      Given full access with a Deny of tasks:read and tasks:write on project 2
      Then project 1 lists tasks, project 2 answers 403 for listing, creating and editing tasks but still opens its sprints

    Scenario: A Deny of tasks:read also stops by-id reads
      Given full access with a Deny of tasks:read on project 2
      Then opening a task of project 2, with its activities, links and attachments, answers 403

  Rule: The built-in ADMIN role runs the workspace but not the roles

    Background:
      Given the user already has a stored authenticated admin session

    Scenario: ADMIN manages users, agents and plugins and reads roles
      Given a user holding only ADMIN
      Then it lists users, roles, agents and plugins and creates a user
      But creating or editing a role, assigning SUPER_ADMIN and changing the default role answer 403

    Scenario: ADMIN reads every project but holds no role inside one
      Then it lists and opens a project it is not a member of
      But listing or opening its tasks, and creating a task or a sprint there, answer 403

  Rule: Access ends when the membership or the account does

    Background:
      Given the user already has a stored authenticated admin session
      And a project with a task and a signed-in Editor member

    Scenario: A removed member is refused on the very next request
      When the admin removes the member
      Then the same session answers 403 on reads and writes

    Scenario: A deleted account's open session gets nothing
      When the admin deletes the user
      Then the same session answers 401 or 403

    Scenario: Deleting a workspace role takes its powers away at once
      When the admin deletes the role of a signed-in holder
      Then the holder's next request answers 403

  Rule: Simulating a request

    Background:
      Given the user already has a stored authenticated admin session
      And a project

    Scenario: A policy alone can be tried by anyone signed in
      Then Allow and Deny are evaluated, Deny wins, and the deciding statements are named
      And nothing matching is a default deny with no statements

    Scenario: Condition attributes come only from the request
      Then a supplied matching value allows, a different or missing one denies

    Scenario: A bad policy, an unknown action or a missing field is refused
      Then the answer is 422 ROLE_POLICY_INVALID or 400

    Scenario: Naming a principal needs roles:read
      Then a caller without roles:read answers 403 for the same question that is fine without a principal
      And a caller with roles:read gets the principal's own roles evaluated with the policy

  Rule: What the permission endpoints report

    Background:
      Given the user already has a stored authenticated admin session
      And a project

    Scenario: Workspace permissions follow the roles and a Deny removes an action
      Then a user lists the actions of their roles and not others, and a Deny hides plugins:read

    Scenario: A role without statements reports no action
      Then the list is empty

    Scenario: In a project a conditional Allow shows the action, an unconditional Deny hides it
      Then tasks:read is listed, docs:write is not, and sprints:write stays for a resource-dependent Deny
