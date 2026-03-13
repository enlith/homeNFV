package agent

import (
	"encoding/json"
	"fmt"
	"io"
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

	// Sanitize path
	clean := filepath.Clean("/" + req.Path)
	fullPath := filepath.Join(h.Root, clean)
	if !strings.HasPrefix(fullPath, h.Root) {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	// Fetch URL
	resp, err := http.Get(req.URL)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"fetch failed: %s"}`, err.Error()), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		http.Error(w, fmt.Sprintf(`{"error":"URL returned %d"}`, resp.StatusCode), http.StatusBadGateway)
		return
	}

	// Create parent dirs and write file
	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		http.Error(w, `{"error":"cannot create directory"}`, http.StatusInternalServerError)
		return
	}

	f, err := os.Create(fullPath)
	if err != nil {
		http.Error(w, `{"error":"cannot create file"}`, http.StatusInternalServerError)
		return
	}
	defer f.Close()

	written, err := io.Copy(f, resp.Body)
	if err != nil {
		os.Remove(fullPath)
		http.Error(w, `{"error":"write failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "ok", "size": written})
}
