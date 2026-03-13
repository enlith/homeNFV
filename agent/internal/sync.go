package agent

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type SyncLoop struct {
	workerURL string
	secret    string
	root      string
	watcher   *Watcher
	client    *http.Client
	done      chan struct{}
}

func NewSyncLoop(workerURL, secret, root string) *SyncLoop {
	return &SyncLoop{
		workerURL: workerURL,
		secret:    secret,
		root:      root,
		watcher:   NewWatcher(root),
		client:    &http.Client{Timeout: 30 * time.Second},
		done:      make(chan struct{}),
	}
}

func (s *SyncLoop) Start() error {
	if err := s.watcher.Start(); err != nil {
		return fmt.Errorf("watcher start: %w", err)
	}

	// Push metadata changes from inotify
	go s.pushLoop()

	// Pull pending files from R2 temp
	go s.pullLoop()

	log.Println("sync loop started")
	return nil
}

func (s *SyncLoop) Stop() {
	close(s.done)
	s.watcher.Stop()
}

// pushLoop sends file metadata changes to the Worker when inotify fires
func (s *SyncLoop) pushLoop() {
	for {
		select {
		case changes := <-s.watcher.Changes():
			var created []FileChange
			var deleted []string
			for _, c := range changes {
				if c.Deleted {
					deleted = append(deleted, c.Path)
				} else {
					created = append(created, c)
				}
			}

			if len(created) > 0 {
				body, _ := json.Marshal(map[string]interface{}{"entries": created})
				if err := s.workerRequest("POST", "/api/sync/metadata", body); err != nil {
					log.Printf("push metadata: %v", err)
				} else {
					log.Printf("pushed %d metadata entries", len(created))
				}
			}

			if len(deleted) > 0 {
				body, _ := json.Marshal(map[string]string{"paths": ""})
				// Re-marshal with correct type
				body, _ = json.Marshal(map[string][]string{"paths": deleted})
				if err := s.workerRequest("DELETE", "/api/sync/metadata", body); err != nil {
					log.Printf("push deletes: %v", err)
				} else {
					log.Printf("pushed %d deletes", len(deleted))
				}
			}

		case <-s.done:
			return
		}
	}
}

// pullLoop polls the Worker for files pending sync from R2 temp → local disk
func (s *SyncLoop) pullLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// Run immediately on start
	s.pullPending()

	for {
		select {
		case <-ticker.C:
			s.pullPending()
		case <-s.done:
			return
		}
	}
}

func (s *SyncLoop) pullPending() {
	resp, err := s.signedRequest("GET", "/api/sync/pending", nil)
	if err != nil {
		log.Printf("poll pending: %v", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return
	}

	var result struct {
		Files []struct {
			Path string `json:"path"`
			Size int64  `json:"size"`
		} `json:"files"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return
	}

	for _, f := range result.Files {
		if err := s.downloadAndSave(f.Path); err != nil {
			log.Printf("sync %s: %v", f.Path, err)
			continue
		}
		// Acknowledge successful sync
		if err := s.workerRequest("POST", "/api/sync/pending/ack?path="+url.QueryEscape(f.Path), nil); err != nil {
			log.Printf("ack %s: %v", f.Path, err)
		} else {
			log.Printf("synced: %s", f.Path)
		}
	}
}

func (s *SyncLoop) downloadAndSave(filePath string) error {
	resp, err := s.signedRequest("GET", "/api/sync/pending/download?path="+url.QueryEscape(filePath), nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("download status %d", resp.StatusCode)
	}

	fullPath := filepath.Join(s.root, filepath.Clean(filePath))
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return err
	}

	f, err := os.Create(fullPath)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = io.Copy(f, resp.Body)
	return err
}

func (s *SyncLoop) workerRequest(method, path string, body []byte) error {
	resp, err := s.signedRequest(method, path, body)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

func (s *SyncLoop) signedRequest(method, path string, body []byte) (*http.Response, error) {
	ts := strconv.FormatInt(time.Now().Unix(), 10)

	// Extract just the path portion (before query string) for signing
	u, _ := url.Parse(path)
	message := fmt.Sprintf("%s:%s:%s", method, u.Path, ts)
	mac := hmac.New(sha256.New, []byte(s.secret))
	mac.Write([]byte(message))
	sig := hex.EncodeToString(mac.Sum(nil))

	var bodyReader io.Reader
	if body != nil {
		bodyReader = bytes.NewReader(body)
	}

	req, err := http.NewRequest(method, s.workerURL+path, bodyReader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-HomeNFV-Timestamp", ts)
	req.Header.Set("X-HomeNFV-Signature", sig)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	return s.client.Do(req)
}
