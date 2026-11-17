@iam @conditions
Feature: Every condition operator, enforced
  A statement can narrow an Allow or a Deny with conditions on declared
  attributes. Operators are StringEquals, StringNotEquals, StringLike, In, NotIn
  and Bool; all conditions of a statement must hold. A positive operator is true
  when any value of the attribute matches, a negated one only when none does,
  and an attribute the resource does not have makes positive operators false and
  negated ones true.

  The admin creates a project with two sprints, a done and an open status, and
  tasks T1 (S1, open), T2 (S1, done), T3 (S2, open) and T4 (no sprint, open).
  Each limited member signs in as themselves.

  Rule: Operators on task attributes

    Background:
      Given the user already has a stored authenticated admin session
      And a project with tasks T1, T2, T3 and T4 as described above

    Scenario: In matches any of the listed values
      Given a member may read tasks where "task.sprint_id" is In [S1, S2]
      Then the member lists T1, T2 and T3
      But T4, which has no sprint, answers 403

    Scenario: NotIn matches everything else, tasks without the attribute included
      Given a member may read tasks where "task.sprint_id" is NotIn [S1]
      Then the member lists T3 and T4
      And T1 and T2 answer 403

    Scenario: StringNotEquals is true and StringEquals false for a missing attribute
      Given one member reads tasks where the sprint is not S1 and another where it is S1
      Then the first reads T4 and not T1
      And the second reads T1 and not T4

    Scenario: StringLike treats * as a run of characters and ? as exactly one
      Given roles using a prefix of S1's id with "*", S1's id with a final "?", and one "?" too few
      Then the first two list exactly the tasks of S1
      And the third lists nothing

    Scenario: task.status_id scopes by status and follows a status change
      Given a member may read tasks in the open status
      Then T2 answers 403
      When the admin finishes T1
      Then T1 answers 403 for the member on the next request and the total drops to 2

    Scenario: task.type_id scopes by task type
      Given a member may read tasks of one task type
      Then tasks of that type are listed and opened, those of another type answer 403

    Scenario: Every condition of a statement must hold
      Given a member may read tasks in S1 that are also in the open status
      Then only T1 is listed
      And T2 (S1 but done) and T3 (open but S2) answer 403

    Scenario: Conditions under different operators are ANDed as well
      Given a statement with In on the sprint and StringNotEquals on the done status
      Then the member lists T1 and T3

    Scenario: A conditional Deny hides only what matches
      Given a member may read all tasks but is denied those in the done status
      Then T2 answers 403 and T1 answers 200

    Scenario: A Deny on a negated operator also hits tasks that lack the attribute
      Given a member may read all tasks but is denied those whose sprint is not S1
      Then only T1 and T2 are listed and T4 answers 403

  Rule: task.assignee_id is multi-valued

    Background:
      Given the user already has a stored authenticated admin session
      And a project with a sprint and members Alice and Bob

    Scenario: A positive operator needs one matching assignee, a negated one needs none
      Given tasks assigned to Alice, to both, to Bob and to nobody
      And one member may read tasks assigned to Alice and another those not assigned to her
      Then the first lists Alice's task and the shared one
      And the second lists Bob's task and the unassigned one

    Scenario: A task cannot be created or handed over outside the assignee scope
      Given a member may read and write only tasks assigned to themselves
      Then creating a task with no assignee, or assigned to someone else, answers 403
      And a task assigned to themselves is created
      But reassigning it to someone else answers 403

  Rule: principal.id and principal.type

    Background:
      Given the user already has a stored authenticated admin session
      And a project with a task

    Scenario: NotIn principal.id spares the listed users
      Given two members share a reading role and both hold a Deny for everyone not in a list of one
      Then the listed member reads tasks and the other answers 403

    Scenario: principal.type separates users from agents
      Given a role granting reads only to principals of type "user", and another only to "agent"
      Then a user holding the first reads tasks and a user holding the second answers 403

  Rule: What is refused when the policy is saved

    Background:
      Given the user already has a stored authenticated admin session
      And a project

    Scenario: An unknown operator is refused at its path
      When a role uses the operator "StringEqualsIgnoreCase"
      Then it answers 422 ROLE_POLICY_INVALID with the issue at the operator and key

    Scenario: An unknown key, an empty operand and a non-boolean Bool operand are refused
      Then each answers 422

    Scenario: A key of another resource kind is refused
      When a statement on tasks uses "doc.folder_id"
      Then the issue points at that condition key

    Scenario: Operands are a string, a list of strings or a bool
      Then those are accepted, and null or a number is refused
