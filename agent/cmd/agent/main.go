package main

import (
	"fmt"
	"net/http"
	"os"

	agent "github.com/homenfv/agent/internal"
)

func main() {
	addr := os.Getenv("HOMENFV_LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8787"
	}
	secret := os.Getenv("HOMENFV_SHARED_SECRET")
	root := os.Getenv("HOMENFV_STORAGE_ROOT")
	if root == "" {
		root = "/srv/homenfv/files"
	}

	if err := os.MkdirAll(root, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "cannot create storage root: %v\n", err)
		os.Exit(1)
	}

	fileHandler := &agent.FileHandler{Root: root}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	mux.Handle("/api/files", fileHandler)
	mux.HandleFunc("/api/mkdir", fileHandler.Mkdir)

	var handler http.Handler = mux
	if secret != "" {
		handler = agent.AuthMiddleware(secret, mux)
	}

	fmt.Printf("HomeNFV agent listening on %s (root: %s)\n", addr, root)
	if err := http.ListenAndServe(addr, handler); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
