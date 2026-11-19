@realtime @event-authorization
Feature: Live events follow the same policies as the API
  A socket joins the rooms its roles give it some action for, and every event
  is then checked against the account on the resource it is about. A Deny on
  one task, a role limited to one sprint's tasks or one folder's documents, or
  an Allow on a single resource applies to what is pushed exactly as it applies
  to what is fetched.

  The specs open real socket.io connections as signed-in members, change
  content as the admin over the API and assert on what each socket receives.
  A negative assertion waits for a socket that IS allowed to receive the same
  event first, so "nothing arrived" never means "nothing has arrived yet".

  Rule: Connecting

    Scenario: A connection without credentials is refused
      Then the server answers "missing authentication"

    Scenario: A token that is not a valid JWT is refused
      Then the server answers "invalid or expired token"

    Scenario: The session cookie and the handshake token both work
      Given a member of a project
      Then a socket on the member's cookie joins the project
      And a socket on the member's token in the handshake joins it too

    Scenario: Expired, wrongly signed and refresh-kind tokens are refused
      Then a token minted already expired is refused
      And a token signed with another secret is refused
      And a token of kind "refresh" is refused
      But the same token minted correctly is accepted

    Scenario: A deleted user holds nothing
      Given a member whose account is then deleted
      Then a socket on their old token, if accepted, joins no rooms

  Rule: Joining a project

    Scenario: The socket is placed in exactly the rooms its roles allow
      Given a member whose role reads tasks, docs and views
      Then joining the project grants "tasks", "docs" and "views" and nothing else

    Scenario: A member who may only open the project gets no rooms
      Then joining grants no namespaces

    Scenario: The admin gets every room
      Then joining grants conversations, docs, environments, sprints, tasks, views and workflows

    Scenario: A grant on one task is enough for the tasks room
      Given a member holding tasks:read on a single task
      Then joining grants "tasks"

    Scenario: A user who is not a member gets nothing and receives nothing
      Then joining grants no namespaces
      And no event about the project reaches the socket

    Scenario: Being a member of one project does not open another
      Given a member of project one
      Then joining project two grants no namespaces and delivers no events

    Scenario: A malformed join is ignored and the socket keeps working
      When the socket emits join with no payload, null, an empty object, a number, an empty string or a bare string
      Then none of them is acknowledged and the socket stays connected
      And a valid join afterwards works

    Scenario: Leaving stops delivery and joining again restores it
      Then after leave no event about the project arrives
      And after joining again events arrive

  Rule: Task events

    Scenario: A denied task's events are held back and the others are delivered
      Given a role allowing tasks:read on the project with a Deny on one task
      Then events about the open task arrive
      But events about the denied task do not

    Scenario: A denied task's creation, update and deletion are all held back
      Then none of its task.updated and task.deleted events arrive

    Scenario: Creation, update and deletion reach a member allowed on the whole project
      Then task.created, task.updated and task.deleted arrive

    Scenario: Events of one task arrive in the order they happened
      When the task is renamed five times in a row
      Then the five updates arrive in that order

    Scenario: A role limited to one sprint's tasks (task.sprint_id)
      Then events about tasks of that sprint arrive
      But events about another sprint's tasks and about backlog tasks do not

    Scenario: tasks:read on a single task delivers only that task
      Then that task's events arrive and other tasks' do not

    Scenario: An Allow from one role and a Deny from another
      Then the Deny wins for its task and the rest is delivered

    Scenario: Two roles each allowing a different sprint are unioned
      Then the events of both sprints' tasks arrive

    Scenario: Two members each denied a different task
      Then each receives the events the other is denied and none of their own denied ones

    Scenario: Every socket of the same account receives the event
      Given the account has two sockets
      Then both receive it

    Scenario: A user who only holds roles elsewhere receives nothing
      Then no event about this project reaches them

    # Not decided yet: a task that moves out of a member's scope is checked on
    # its new attributes, so the member is told nothing and the card stays until
    # the board refreshes; a deletion under a conditional grant is checked after
    # the attributes are gone. A content-free "left your scope" message would
    # fix both.
    @fixme
    Scenario: A member is told that a task left their scope

    @fixme
    Scenario: The deletion of a task inside a role limited by a condition is delivered

  Rule: Notifications

    Scenario: A task assignment notifies the assignee only
      Given two members and a task assigned to the first
      Then the first receives notification.created
      And the second receives nothing

  Rule: Document events

    Scenario: A denied document's events are held back
      Then events about the open document arrive and the denied one's do not

    Scenario: A role limited to a folder (doc.ancestor_folder_ids)
      Then documents in the folder and in its subfolders arrive
      But documents elsewhere do not

    Scenario: A member who reads tasks but not documents gets no document events
      Then joining does not grant "docs" and no document event arrives

  Rule: Sprint and view events

    Scenario: A denied sprint's events are held back
      Then the open sprint's events arrive and the denied one's do not

    Scenario: View events need views:read, not sprints:read
      Given one member reading sprints and another reading views
      Then only the views reader is placed in "views" and receives view.created

    Scenario: A role limited to one sprint's views (view.sprint_id)
      Then that sprint's view events arrive and the other sprint's do not

  Rule: Automation and environment events

    Scenario: A denied automation is held back and members without workflows:read get none
      Then the open automation's events arrive for a workflows reader
      And the denied automation's do not
      And a member without workflows:read is not in "workflows" and receives no automation event

    Scenario: A denied environment is held back
      Then status events of the denied environment reach nobody who is denied it

  Rule: Conversation events

    # The e2e stack has no LLM credentials, so no agent replies.
    @fixme
    Scenario: A conversation's events reach only members who may read that conversation

    @fixme
    Scenario: An owner-private conversation reaches its owner alone

    @fixme
    Scenario: agent.session.started refreshes task boards without carrying any content
