@iam @git
Feature: Every Git operation route declares the one action it needs
  The review, comment, issue, CI and file routes under a linked repository are
  gated in the router, each by exactly one project action: git:read for reads,
  git:write for writes, git:approve for approvals and git:merge for merges. The
  actions are separate: git:write does not imply git:read and the other way
  round. A role holding git:* reaches all of them, and an explicit deny wins.

  Background:
    Given the user already has a stored authenticated admin session
    And a project with members holding only "git:read", only "git:write", only "git:approve", only "git:merge", "git:*", and nothing

  Scenario Outline: A route is open to its own action and closed to the others
    When each member calls "<method> <route>"
    Then only the member holding "<action>" (and "git:*") gets past the gate
    And everyone else answers 403

    Examples:
      | method | route                                      | action      |
      | GET    | change-requests/1                          | git:read    |
      | GET    | change-requests/1/files                    | git:read    |
      | GET    | change-requests/1/diff                     | git:read    |
      | GET    | change-requests/1/threads                  | git:read    |
      | GET    | subjects/issue/1/comments                  | git:read    |
      | GET    | issues/1                                   | git:read    |
      | GET    | checks                                     | git:read    |
      | GET    | checks/1/logs                              | git:read    |
      | GET    | files                                      | git:read    |
      | GET    | code-search                                | git:read    |
      | POST   | credential/read                            | git:read    |
      | POST   | change-requests                            | git:write   |
      | PATCH  | change-requests/1                          | git:write   |
      | POST   | change-requests/1/reviews                  | git:write   |
      | POST   | change-requests/1/reviewers                | git:write   |
      | POST   | change-requests/1/threads/t/replies        | git:write   |
      | POST   | change-requests/1/threads/t/resolution     | git:write   |
      | POST   | subjects/issue/1/comments                  | git:write   |
      | POST   | subjects/issue/1/labels                    | git:write   |
      | PUT    | subjects/issue/1/assignees                 | git:write   |
      | POST   | checks/rerun                               | git:write   |
      | POST   | credential/write                           | git:write   |
      | DELETE | (the repository itself)                    | git:write   |
      | POST   | change-requests/1/approvals                | git:approve |
      | POST   | change-requests/1/merge                    | git:merge   |

  Scenario: A denied action wins over a wildcard grant
    Given a member whose role allows "git:*" and denies "git:write"
    Then reads pass the gate and every write answers 403

  Scenario: Repository ids and project ids are validated
    Then a non-UUID project id and a non-UUID repository id answer 400 for a signed-in caller
    And an unknown repository id answers 404 with a JSON body
