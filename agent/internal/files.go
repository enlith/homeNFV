package agent

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type FileInfo struct {
	Name    string `json:"name"`
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modified"`
}

type FileHandler struct {
	Root string
}

func (h *FileHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Sanitize path to prevent directory traversal
	reqPath := r.URL.Query().Get("path")
	if reqPath == "" {
		reqPath = "/"
	}
	clean := filepath.Clean("/" + reqPath)
	fullPath := filepath.Join(h.Root, clean)
	if !strings.HasPrefix(fullPath, h.Root) {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	switch r.Method {
	case http.MethodGet:
		h.handleGet(w, r, fullPath, clean)
	case http.MethodPut:
		h.handlePut(w, fullPath, r)
	case http.MethodDelete:
		h.handleDelete(w, fullPath)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *FileHandler) handleGet(w http.ResponseWriter, r *http.Request, fullPath, clean string) {
	info, err := os.Stat(fullPath)
	if err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}

	if info.IsDir() {
		h.listDir(w, fullPath)
		return
	}

	// Serve file
	w.Header().Set("X-File-Size", strings.Itoa(int(info.Size())))
	w.Header().Set("X-File-Modified", strings.Itoa(int(info.ModTime().Unix())))
	http.ServeFile(w, r, fullPath)
}

func (h *FileHandler) listDir(w http.ResponseWriter, fullPath string) {
	entries, err := os.ReadDir(fullPath)
	if err != nil {
		http.Error(w, `{"error":"cannot read directory"}`, http.StatusInternalServerError)
		return
	}

	files := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:    e.Name(),
			IsDir:   e.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime().Unix(),
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"path": fullPath, "files": files})
}

func (h *FileHandler) handlePut(w http.ResponseWriter, fullPath string, r *http.Request) {
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

	if _, err := io.Copy(f, r.Body); err != nil {
		http.Error(w, `{"error":"write failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (h *FileHandler) handleDelete(w http.ResponseWriter, fullPath string) {
	if err := os.RemoveAll(fullPath); err != nil {
		http.Error(w, `{"error":"delete failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

// Mkdir creates a directory
func (h *FileHandler) Mkdir(w http.ResponseWriter, r *http.Request) {
	reqPath := r.URL.Query().Get("path")
	if reqPath == "" {
		http.Error(w, `{"error":"path required"}`, http.StatusBadRequest)
		return
	}
	clean := filepath.Clean("/" + reqPath)
	fullPath := filepath.Join(h.Root, clean)
	if !strings.HasPrefix(fullPath, h.Root) {
		http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
		return
	}

	if err := os.MkdirAll(fullPath, 0755); err != nil {
		http.Error(w, `{"error":"cannot create directory"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
