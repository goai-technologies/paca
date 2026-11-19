@realtime @live-updates-ui
Feature: The web app follows live changes
  The web app keeps one socket per signed-in session and refetches what an
  event says changed. These scenarios drive the real app in a browser, change
  data as the admin over the API, and check that the page follows without a
  reload.

  Rule: The page follows other people's changes

    Background:
      Given a member who can read and write tasks is signed in on the backlog table

    Scenario: A task created by someone else appears without a reload

    Scenario: A task renamed by someone else updates in place

    Scenario: A deleted task disappears

    Scenario: A task the member is denied never shows up, while the others do

  Rule: The page follows edits to the member's role

    Scenario: Losing tasks:write hides "Add task" and getting it back shows it again

    Scenario: Losing tasks:read empties the list and getting it back fills it again
      Then the cached tasks are dropped rather than left on screen when the refetch is refused

    Scenario: Removing the member leaves them without the project's tasks

  Rule: The session and the socket

    Scenario: The page opens one realtime connection and keeps it

    Scenario: The server's reauth is answered by refreshing the session and reconnecting
      Given the browser holds an access token that expires in 75 seconds
      Then the page receives a "reauth" frame, posts /auth/refresh and opens a new connection
      And live changes still arrive afterwards
      And they keep arriving past the old token's expiry

    Scenario: A dropped connection catches up when it comes back
      Given the page goes offline and a task is created meanwhile
      When it comes back online
      Then the socket reconnects and the missed task appears
