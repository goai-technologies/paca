@projects @interactions @subtasks
Feature: Hierarchical subtasks in task views
  Tasks can have children through their parent task.  The list API reports
  how many direct children a task has (`subtask_count`) and how many of them
  are in a status of category "done" (`subtask_done_count`).  The Table views
  (product backlog and sprints) and the Timeline show those parents with a
  chevron and a "done/total" progress chip; expanding a row loads its
  children on demand, indented under the parent, using the view's filters and
  sort.  Board cards show the same chip but do not nest.  One "Subtask
  setting in the View settings panel of Table and Timeline views chooses
  "Nested, collapsed" (the default), "Nested, expanded" or "Hidden (flat
  list)"; it is saved with the view like any other view setting.  Rows the
  user opens or closes by hand are remembered per user and per view.  System "Subtask"
  Tasks stay out of the top level of the Table and Timeline while nesting is
  on and appear only under their parent (the "exclude_subtasks" list filter);
  tasks that merely belong to an Epic stay in the list.  With nesting off, or
  on the Board, every task is shown as its own row or card.

  @authenticated
  Rule: The task list API reports subtask counts and lists children

    Background:
      Given the user already has a stored authenticated session
      And a project named "E2E_SUB_API_PROJECT" exists
      And the project has a task "Parent" with three subtasks, one of them in a "done" status
      And one more subtask of "Parent" has been deleted

    Scenario: A parent's list entry carries its subtask counts
      When the task list is requested
      Then "Parent" should report subtask_count 3 and subtask_done_count 1
      And a task without subtasks should report no subtask counts

    Scenario: Listing by parent returns only that parent's children
      When the task list is requested with parent_task_id of "Parent"
      Then exactly the three live subtasks should be returned

    Scenario: exclude_subtasks hides subtasks but keeps tasks of an Epic
      Given the project has an Epic with one task
      When the task list is requested with exclude_subtasks
      Then the Epic, its task, "Parent" and a task without subtasks should be returned
      And no subtask of "Parent" should be returned

    Scenario: Children can be filtered by status
      When the task list is requested with parent_task_id of "Parent" and the "done" status
      Then only the done subtask should be returned

    Scenario: Listing children ignores the sprint filter
      Given "Parent" is in a sprint and its subtasks are not
      When the children of "Parent" are requested together with that sprint filter
      Then all three subtasks should still be returned

  @authenticated
  Rule: The product backlog Table nests subtasks under their parents

    Background:
      Given the user already has a stored authenticated session
      And a project named "E2E_SUB_TABLE_PROJECT" exists
      And the project has a task "Parent" with three subtasks, one of them done
      And the user has navigated to the "Product Backlog" Table view

    Scenario: A parent shows its progress and starts collapsed
      Then "Parent" should show an "Expand 3 subtasks" chevron and a "1/3" chip
      And none of its subtasks should be visible

    Scenario: Expanding a parent shows its subtasks and collapsing hides them
      When the user expands "Parent"
      Then its three subtasks should be visible
      When the user collapses "Parent"
      Then its subtasks should be hidden again

    Scenario: A task without subtasks has no chevron
      Given the project has a task "Lone" without subtasks
      Then "Lone" should have no expand chevron and no progress chip

    Scenario: Subtasks do not appear as top-level rows
      Then no subtask of "Parent" should be listed as a top-level row

    Scenario: A subtask can be added under an expanded parent
      When the user expands "Parent"
      And the user adds a subtask "Fourth" with the "Add subtask" button
      Then "Fourth" should appear under "Parent"
      And "Parent" should show a "1/4" chip

    Scenario: Clicking the chevron does not open the task
      When the user expands "Parent"
      Then the task detail should not be open

    Scenario: Clicking a subtask opens its details
      When the user expands "Parent"
      And the user clicks the subtask "Child done"
      Then the task detail for "Child done" should open

    Scenario: Expanded rows are remembered after a reload
      When the user expands "Parent"
      And the page is reloaded
      Then the subtasks of "Parent" should still be visible

  @authenticated
  Rule: The Subtasks view setting controls nesting

    Background:
      Given the user already has a stored authenticated session
      And a project named "E2E_SUB_SETTING_PROJECT" exists
      And the project has a task "Parent" with three subtasks, one of them done
      And the user has navigated to the "Product Backlog" Table view

    Scenario: The setting defaults to "Nested, collapsed"
      When the user opens the View settings panel
      Then the "Subtasks" setting should show "Nested, collapsed"

    Scenario: "Nested, expanded" shows subtasks without clicking the chevron
      When the user chooses "Nested, expanded" and saves only for themselves
      Then the three subtasks of "Parent" should be visible
      And "Parent" should show a "Collapse 3 subtasks" chevron

    Scenario: A row can still be collapsed by hand when subtasks start expanded
      Given the "Subtasks" setting is "Nested, expanded"
      When the user collapses "Parent"
      Then its subtasks should be hidden and the chevron should offer to expand

    Scenario: "Hidden (flat list)" removes the chevrons and the chips
      When the user chooses "Hidden (flat list)" and saves only for themselves
      Then no parent should show a chevron or a progress chip
      And the subtasks should be shown as plain top-level rows

    Scenario: Switching back to nested restores the chevrons
      Given the "Subtasks" setting is "Hidden (flat list)"
      When the user chooses "Nested, collapsed" and saves only for themselves
      Then "Parent" should show its chevron and its "1/3" chip
      And its subtasks should be hidden

    Scenario: The setting is remembered after a reload
      When the user chooses "Nested, expanded" and saves only for themselves
      And the page is reloaded
      Then the subtasks of "Parent" should be visible
      And the "Subtasks" setting should show "Nested, expanded"

  @authenticated
  Rule: The Timeline nests tasks under their Epics

    Background:
      Given the user already has a stored authenticated session
      And a project named "E2E_SUB_TIMELINE_PROJECT" exists
      And the project has an Epic "Epic" with two child tasks
      And the user has navigated to the Timeline interaction

    Scenario: An Epic shows its child count and expands to its tasks
      Then "Epic" should show an "Expand 2 subtasks" chevron
      When the user expands "Epic"
      Then both child tasks should be visible under "Epic"

    Scenario: The Subtasks view setting also applies to the Timeline
      When the user chooses "Nested, expanded" and saves only for themselves
      Then both child tasks should be visible under "Epic"

  @authenticated
  Rule: Board cards show a subtask progress chip

    Background:
      Given the user already has a stored authenticated session
      And a project named "E2E_SUB_BOARD_PROJECT" exists
      And the project has a task "Parent" with three subtasks, one of them done
      And the user has navigated to the "Product Backlog" Board view

    Scenario: A card with subtasks shows "done/total"
      Then the "Parent" card should show a "1/3" chip

    Scenario: The Board offers no Subtasks view setting
      When the user opens the View settings panel
      Then there should be no "Subtasks" setting

    Scenario: Subtasks stay visible as their own cards
      Then the subtasks of "Parent" should each be shown as a card
