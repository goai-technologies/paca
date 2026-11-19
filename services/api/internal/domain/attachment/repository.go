package attachmentdom

import (
	"context"

	"github.com/google/uuid"
)

// Repository is the persistence contract for the attachment aggregate.
type Repository interface {
	FileRepository
	TaskAttachmentRepository
}

// FileRepository defines persistence operations for file metadata.
type FileRepository interface {
	CreateFile(ctx context.Context, f *File) error
	FindFileByID(ctx context.Context, id uuid.UUID) (*File, error)
	UpdateFileStatus(ctx context.Context, id uuid.UUID, status UploadStatus, multipartUploadID *string) error
	DeleteFile(ctx context.Context, id uuid.UUID) error
}

// TaskAttachmentRepository defines persistence operations for task attachments.
type TaskAttachmentRepository interface {
	// ListTaskAttachments returns one page of the task's attachments with their
	// file metadata, ordered by created_at then id ascending. cursorAfter is the
	// cursor from EncodeCursor (nil for the first page); hasMore reports whether
	// more follow and total counts every attachment of the task.
	ListTaskAttachments(ctx context.Context, taskID uuid.UUID, cursorAfter *string, limit int) (attachments []*TaskAttachment, hasMore bool, total int, err error)
	FindTaskAttachmentByID(ctx context.Context, id uuid.UUID) (*TaskAttachment, error)
	CreateTaskAttachment(ctx context.Context, a *TaskAttachment) error
	DeleteTaskAttachment(ctx context.Context, id uuid.UUID) error
}
