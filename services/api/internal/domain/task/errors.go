package taskdom

import "errors"

// Sentinel domain errors for the task aggregate.
var (
	ErrTaskNotFound              = errors.New("task: not found")
	ErrTaskTitleInvalid          = errors.New("task: title is empty or invalid")
	ErrEpicCannotHaveParent      = errors.New("task: epic tasks cannot have a parent task")
	ErrTaskCannotBeOwnParent     = errors.New("task: a task cannot be its own parent")
	ErrTaskParentCycleDetected   = errors.New("task: setting this parent would create a cycle")
	ErrTaskAssignmentModeInvalid = errors.New("task: assignment_mode must be \"manual\" or \"auto\"")

	ErrTypeNotFound     = errors.New("task type: not found")
	ErrTypeNameInvalid  = errors.New("task type: name is empty or invalid")
	ErrTypeIsSystem     = errors.New("task type: system types cannot be modified")
	ErrTypeNameReserved = errors.New("task type: name is reserved for system types")
	ErrTypeIsDefault    = errors.New("task type: the default type cannot be deleted")

	ErrStatusNotFound          = errors.New("task status: not found")
	ErrStatusNameInvalid       = errors.New("task status: name is empty or invalid")
	ErrStatusCategoryInvalid   = errors.New("task status: invalid category value")
	ErrStatusReorderInvalid    = errors.New("task status: provided status IDs do not match the project's statuses")
	ErrStatusInUseByAutomation = errors.New("task status: still referenced by an automation")
	ErrStatusIsDefault         = errors.New("task status: the default status cannot be deleted")

	ErrCustomFieldNotFound    = errors.New("custom field: not found")
	ErrCustomFieldKeyInvalid  = errors.New("custom field: key is empty or invalid")
	ErrCustomFieldKeyTaken    = errors.New("custom field: key already in use within project")
	ErrCustomFieldTypeInvalid = errors.New("custom field: invalid field type")
	ErrCustomFieldNameInvalid = errors.New("custom field: display name is empty or invalid")

	// Task link errors.
	ErrTaskLinkNotFound     = errors.New("task link: not found")
	ErrTaskLinkSelf         = errors.New("task link: a task cannot be linked to itself")
	ErrTaskLinkDuplicate    = errors.New("task link: this relationship already exists")
	ErrTaskLinkTypeInvalid  = errors.New("task link: invalid link type")
	ErrTaskLinkCrossProject = errors.New("task link: cannot link tasks from different projects")

	// Commitment membership (tasks.commitment_task_id).
	ErrCommitmentNotFound              = errors.New("commitment: not found")
	ErrCommitmentSelf                  = errors.New("commitment: a task cannot be its own commitment")
	ErrCommitmentOnChildTask           = errors.New("commitment: set the commitment on the top-level ticket; children inherit it")
	ErrCommitmentOnCommitment          = errors.New("commitment: a commitment cannot belong to another commitment")
	ErrCommitmentTargetNotCommitment   = errors.New("commitment: target task is not of type Commitment")
	ErrCommitmentOutsideCatalog        = errors.New("commitment: target is not in the Commitments project")
	ErrCommitmentClosed                = errors.New("commitment: this commitment is closed and accepts no new tickets")
	ErrCommitmentsProjectNotConfigured = errors.New("commitment: no Commitments project is configured in workspace settings")

	// Activity / comment errors.
	ErrActivityNotFound      = errors.New("activity: not found")
	ErrActivityForbidden     = errors.New("activity: only the author can modify this comment")
	ErrActivityNotAComment   = errors.New("activity: this entry is not a comment and cannot be edited")
	ErrCommentContentInvalid = errors.New("activity: comment content must not be empty")

	// ErrCommentActorUnidentified is returned when the authenticated caller is
	// the built-in system actor, which is never itself a project member, so
	// there is no member to attribute the comment to.
	ErrCommentActorUnidentified = errors.New("activity: request has no identifiable project member")
)
