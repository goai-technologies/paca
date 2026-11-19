@realtime @iam-changes
Feature: A change to access takes effect on open sockets
  What a socket may receive follows the account's roles as they are now, not
  as they were when it connected. When a role is edited, attached, detached or
  deleted, or a member or user is removed, the API announces it; the realtime
  service drops its cached decisions, re-syncs every open socket's rooms and
  sends `permissions:changed` with the project and the namespaces now granted.

  Every scenario keeps ONE socket open across the change (its id never
  changes) and asserts on what that same socket receives before and after.

  Rule: Editing a role the member holds

    Scenario: Removing a Deny starts delivery, adding it back stops it at once
      Given a socket that has just been delivered a task's events
      When a Deny on that task is added to the role
      Then the very next event about it is held back although "allowed" was cached
      When the Deny is lifted
      Then its events arrive again on the same socket

    Scenario: Revoking tasks:read takes the tasks room away, restoring it brings it back
      Then the namespaces fall to "docs", task events stop and document events continue
      And after restoring, the namespaces include "tasks" again and task events arrive

    Scenario: permissions:changed names the project and the namespaces
      Then the message carries the project id and an array of namespaces

    Scenario: Narrowing a role to one task keeps the tasks room and limits what arrives
      Then only that task's events arrive

    Scenario: Changing the sprint a condition names swaps which tasks are delivered
      Then after the edit the other sprint's tasks arrive and the first sprint's do not

    Scenario: A burst of edits ends on the last one
      When four edits are made without waiting
      Then the namespaces converge on those of the last edit

    Scenario: It takes effect within a few seconds
      Then permissions:changed arrives in under five seconds

  Rule: Changing which roles a member holds

    Scenario: Replacing the member's roles re-syncs the open socket
      Then swapping to a docs-only role drops "tasks" and swapping back restores it

    Scenario: Attaching a second role adds its rooms and detaching it removes them
      Then document events arrive while the docs role is attached and stop after it is detached

    Scenario: A workspace role that names the project adds rooms
      Given a member who could only open the project
      When a workspace role granting tasks:read on the project is attached to the user
      Then the socket gains "tasks" and receives task events

    Scenario: Deleting the role the member holds empties their rooms
      Then the namespaces become empty and no events arrive

  Rule: Removing access altogether

    Scenario: Removing the member takes them out of every room
      Then the namespaces become empty and no events arrive

    Scenario: A member who is added back gets their rooms again on the same socket
      Then adding the member back announces a change that restores "tasks"
      And events arrive again without a new join

    Scenario: Deleting the user takes them out of every room
      Then the namespaces become empty and no events arrive

    Scenario: Deleting the project tells its members' sockets to refresh
      Then permissions:changed arrives for that project and the socket stays connected

  Rule: Other sockets

    Scenario: Every socket of the affected account is re-synced
      Given the account has two sockets
      Then both lose "tasks" when the role is edited

    Scenario: A socket the change does not concern keeps its rooms and events
      Given a second member whose role was not edited
      Then they are told to refresh with the same namespaces
      And they still receive task events

    Scenario: An administrator's socket is unaffected
      Then it keeps receiving every event
