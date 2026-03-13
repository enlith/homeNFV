package agent

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
)

type FileChange struct {
	Path    string `json:"path"`
	Parent  string `json:"parent"`
	Name    string `json:"name"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modified"`
	Deleted bool   `json:"-"`
}

type Watcher struct {
	root    string
	changes chan []FileChange
	done    chan struct{}
}

func NewWatcher(root string) *Watcher {
	return &Watcher{
		root:    root,
		changes: make(chan []FileChange, 16),
		done:    make(chan struct{}),
	}
}

func (w *Watcher) Changes() <-chan []FileChange { return w.changes }

func (w *Watcher) Start() error {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	// Watch root and all subdirectories
	if err := w.watchRecursive(fsw, w.root); err != nil {
		fsw.Close()
		return err
	}

	// Debounce: collect events over 500ms then emit batch
	go func() {
		defer fsw.Close()
		pending := make(map[string]bool) // path → deleted?
		timer := time.NewTimer(time.Hour)
		timer.Stop()

		for {
			select {
			case event, ok := <-fsw.Events:
				if !ok {
					return
				}
				rel := w.relPath(event.Name)
				if rel == "" {
					continue
				}

				deleted := event.Has(fsnotify.Remove) || event.Has(fsnotify.Rename)
				pending[rel] = deleted

				// Watch new directories
				if event.Has(fsnotify.Create) {
					if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
						w.watchRecursive(fsw, event.Name)
					}
				}

				timer.Reset(500 * time.Millisecond)

			case <-timer.C:
				if len(pending) == 0 {
					continue
				}
				changes := w.resolveChanges(pending)
				if len(changes) > 0 {
					w.changes <- changes
				}
				pending = make(map[string]bool)

			case err, ok := <-fsw.Errors:
				if !ok {
					return
				}
				log.Printf("watcher error: %v", err)

			case <-w.done:
				return
			}
		}
	}()

	return nil
}

func (w *Watcher) Stop() { close(w.done) }

func (w *Watcher) watchRecursive(fsw *fsnotify.Watcher, dir string) error {
	return filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip errors
		}
		if info.IsDir() {
			return fsw.Add(path)
		}
		return nil
	})
}

func (w *Watcher) relPath(absPath string) string {
	rel, err := filepath.Rel(w.root, absPath)
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	return "/" + rel
}

func (w *Watcher) resolveChanges(pending map[string]bool) []FileChange {
	var changes []FileChange
	for rel, deleted := range pending {
		absPath := filepath.Join(w.root, rel)
		parent := filepath.Dir(rel)
		if parent == "." {
			parent = "/"
		}
		name := filepath.Base(rel)

		if deleted {
			changes = append(changes, FileChange{
				Path: rel, Parent: parent, Name: name, Deleted: true,
			})
			continue
		}

		info, err := os.Stat(absPath)
		if err != nil {
			// File gone between event and resolve
			changes = append(changes, FileChange{
				Path: rel, Parent: parent, Name: name, Deleted: true,
			})
			continue
		}

		changes = append(changes, FileChange{
			Path:    rel,
			Parent:  parent,
			Name:    name,
			IsDir:   info.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Unix(),
		})
	}
	return changes
}
