@ux @pagination
Feature: Pagination
  Lists that can grow without bound are never loaded whole. Table views page by
  number and let the viewer pick how many rows a page shows; card, chip and
  sidebar lists load more as the viewer scrolls or clicks "Load more". Counts
  always come from the server, so they stay right while only part of a list is
  loaded. The same rules are exercised against the API in
  services/api/test/e2e/list_pagination_test.go.

  @authenticated
  Rule: Tables page by number with a rows-per-page menu

    Scenario: The users table pages and remembers the page size
      Given 25 users match the search "E2E_PAGINATION_U_"
      When the admin searches the users page for that prefix
      Then the footer should read "1–20 of 25" and 20 rows should show
      When the admin clicks "Next page"
      Then the footer should read "21–25 of 25" and 5 rows should show
      When the admin chooses 10 rows per page
      Then the footer should read "1–10 of 25" and 10 rows should show
      And after reloading the page the menu should still show 10 rows per page
      When the admin chooses 100 rows per page
      Then all 25 rows should show on one page

    Scenario: The service accounts table pages and searches on the server
      Given 25 service accounts share a prefix
      Then the footer should read "1–20 of 25"
      When the admin searches for a narrower prefix matching 9 accounts
      Then the footer should read "1–9 of 9" with no page buttons

    Scenario: The global roles table counts the shipped roles too
      Given 22 workspace roles exist besides the shipped ones
      Then the footer total should be at least 25
      When the admin clicks "Next page"
      Then the footer range should start at 21

    Scenario: The API keys table pages a user's own keys
      Given a user holds 25 API keys
      Then the footer should read "1–20 of 25"

    Scenario: A short table keeps its footer
      Given a fresh project with only the shipped roles, statuses and task types
      When the user opens Roles, Task Statuses and Task Types in the settings
      Then each table should show "Rows per page" and a range such as "1–3 of 3"
      And no page buttons should be offered

    Scenario: Project settings tables page by number
      Given a project has 22 extra roles and 22 extra task statuses
      When the user opens Roles in the project settings
      Then the footer should show the first 20 of the total
      When the user opens Task Statuses
      Then the list should page the same way and number rows across pages

  @authenticated
  Rule: Other lists load more on demand

    Scenario: The sidebar badge counts every draft sprint
      Given a project has 35 draft sprints
      When the user opens the backlog
      Then the "Draft Sprints" badge should read 35
      And "Load more" (or scrolling) should bring in the sprints beyond the first 30

    Scenario: The team list loads members past the first page
      Given a project has 33 members
      When the user opens the team page
      Then the heading count should read "33 members"
      And "Load more" (or scrolling) should reveal the last member
