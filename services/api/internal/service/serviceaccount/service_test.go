package serviceaccountsvc_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"

	accountdom "github.com/Paca-AI/api/internal/domain/account"
	serviceaccountsvc "github.com/Paca-AI/api/internal/service/serviceaccount"
)

type fakeRepo struct {
	byID    map[uuid.UUID]*accountdom.Account
	deleted []uuid.UUID
}

func newFakeRepo() *fakeRepo { return &fakeRepo{byID: map[uuid.UUID]*accountdom.Account{}} }

func (r *fakeRepo) Create(_ context.Context, a *accountdom.Account) error {
	c := *a
	r.byID[a.ID] = &c
	return nil
}
func (r *fakeRepo) FindByID(_ context.Context, id uuid.UUID) (*accountdom.Account, error) {
	a, ok := r.byID[id]
	if !ok {
		return nil, accountdom.ErrServiceAccountNotFound
	}
	c := *a
	return &c, nil
}
func (r *fakeRepo) List(context.Context, accountdom.ServiceAccountFilter, *string, int) ([]*accountdom.Account, bool, int, error) {
	return nil, false, 0, nil
}
func (r *fakeRepo) Update(_ context.Context, a *accountdom.Account) error {
	c := *a
	r.byID[a.ID] = &c
	return nil
}
func (r *fakeRepo) Delete(_ context.Context, id uuid.UUID) error {
	delete(r.byID, id)
	r.deleted = append(r.deleted, id)
	return nil
}

func TestCreate_ValidatesAndTrims(t *testing.T) {
	svc := serviceaccountsvc.New(newFakeRepo())
	for _, name := range []string{"", "   ", strings.Repeat("x", accountdom.MaxNameLen+1)} {
		if _, err := svc.Create(t.Context(), accountdom.CreateServiceAccountInput{Name: name}); !errors.Is(err, accountdom.ErrNameInvalid) {
			t.Errorf("name %q: %v", name, err)
		}
	}
	long := strings.Repeat("d", accountdom.MaxDescriptionLen+1)
	if _, err := svc.Create(t.Context(), accountdom.CreateServiceAccountInput{Name: "ok", Description: long}); !errors.Is(err, accountdom.ErrDescriptionTooLong) {
		t.Errorf("long description: %v", err)
	}

	by := uuid.New()
	a, err := svc.Create(t.Context(), accountdom.CreateServiceAccountInput{Name: "  CI bot ", Description: " deploys ", CreatedBy: &by})
	if err != nil {
		t.Fatal(err)
	}
	if a.Kind != accountdom.KindServiceAccount || a.Name != "CI bot" || a.Description != "deploys" || a.CreatedBy == nil || *a.CreatedBy != by || a.ID == uuid.Nil {
		t.Fatalf("created = %+v", a)
	}
}

func TestUpdate_PatchesOnlyGivenFields(t *testing.T) {
	repo := newFakeRepo()
	svc := serviceaccountsvc.New(repo)
	a, _ := svc.Create(t.Context(), accountdom.CreateServiceAccountInput{Name: "CI", Description: "keep"})

	name := " Release "
	got, err := svc.Update(t.Context(), a.ID, accountdom.UpdateServiceAccountInput{Name: &name})
	if err != nil || got.Name != "Release" || got.Description != "keep" {
		t.Fatalf("update = %+v err=%v", got, err)
	}
	empty := ""
	if _, err := svc.Update(t.Context(), a.ID, accountdom.UpdateServiceAccountInput{Name: &empty}); !errors.Is(err, accountdom.ErrNameInvalid) {
		t.Fatalf("empty name: %v", err)
	}
	if _, err := svc.Update(t.Context(), uuid.New(), accountdom.UpdateServiceAccountInput{Name: &name}); !errors.Is(err, accountdom.ErrServiceAccountNotFound) {
		t.Fatalf("unknown: %v", err)
	}
}

func TestDelete_UnknownIsNotFound(t *testing.T) {
	repo := newFakeRepo()
	svc := serviceaccountsvc.New(repo)
	if err := svc.Delete(t.Context(), uuid.New()); !errors.Is(err, accountdom.ErrServiceAccountNotFound) {
		t.Fatalf("got %v", err)
	}
	a, _ := svc.Create(t.Context(), accountdom.CreateServiceAccountInput{Name: "x"})
	if err := svc.Delete(t.Context(), a.ID); err != nil || len(repo.deleted) != 1 {
		t.Fatalf("delete err=%v deleted=%v", err, repo.deleted)
	}
}

type countingGrants struct{ calls int }

func (c *countingGrants) Invalidate(...string) { c.calls++ }

func TestDelete_AnnouncesLostAccess(t *testing.T) {
	grants := &countingGrants{}
	svc := serviceaccountsvc.New(newFakeRepo()).WithGrantsNotifier(grants)
	if err := svc.Delete(t.Context(), uuid.New()); err == nil {
		t.Fatal("deleting an unknown account must fail")
	}
	if grants.calls != 0 {
		t.Fatalf("a failed delete announced %d times", grants.calls)
	}
	a, _ := svc.Create(t.Context(), accountdom.CreateServiceAccountInput{Name: "x"})
	if err := svc.Delete(t.Context(), a.ID); err != nil {
		t.Fatal(err)
	}
	if grants.calls != 1 {
		t.Fatalf("announced %d times, want 1", grants.calls)
	}
}

func TestAvatarOperationsNeedTheAvatarService(t *testing.T) {
	svc := serviceaccountsvc.New(newFakeRepo())
	if _, err := svc.RemoveAvatar(t.Context(), uuid.New()); !errors.Is(err, serviceaccountsvc.ErrAvatarServiceRequired) {
		t.Fatalf("got %v", err)
	}
}
