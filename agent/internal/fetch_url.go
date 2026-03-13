package agent

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func (h *FileHandler) FetchURL(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL  string `json:"url"`
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" || req.Path == "" {
		http.Error(w, `{"error":"url and path required"}`, http.StatusBadRequest)
		return
	}

	clean := filepath.Clean("/" + req.Path)
	fullPath := filepath.Join(h.Root, clean)
	if !strings.HasPrefix(fullPath, h.Root) {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		http.Error(w, `{"error":"cannot create directory"}`, http.StatusInternalServerError)
		return
	}

	// Respond immediately, download in background
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "downloading"})

	go func() {
		resp, err := http.Get(req.URL)
		if err != nil {
			log.Printf("fetch-url: failed to fetch %s: %v", req.URL, err)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			log.Printf("fetch-url: %s returned %d", req.URL, resp.StatusCode)
			return
		}
		f, err := os.Create(fullPath)
		if err != nil {
			log.Printf("fetch-url: cannot create %s: %v", fullPath, err)
			return
		}
		defer f.Close()
		written, err := io.Copy(f, resp.Body)
		if err != nil {
			os.Remove(fullPath)
			log.Printf("fetch-url: write failed for %s: %v", fullPath, err)
			return
		}
		log.Printf("fetch-url: saved %s (%d bytes)", clean, written)
	}()
}
