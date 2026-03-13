package main

import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"

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
	workerURL := os.Getenv("HOMENFV_WORKER_URL")

	if err := os.MkdirAll(root, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "cannot create storage root: %v\n", err)
		os.Exit(1)
	}

	fileHandler := &agent.FileHandler{Root: root}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"status":"ok"}`)
	})
	mux.Handle("/api/files", fileHandler)
	mux.HandleFunc("/api/mkdir", fileHandler.Mkdir)

	var handler http.Handler = mux
	if secret != "" {
		handler = agent.AuthMiddleware(secret, mux)
	}

	// Start sync loop if worker URL is configured
	if workerURL != "" && secret != "" {
		sync := agent.NewSyncLoop(workerURL, secret, root)
		if err := sync.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "sync loop failed: %v\n", err)
			os.Exit(1)
		}
		defer sync.Stop()
	}

	// Graceful shutdown
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		fmt.Println("\nshutting down")
		os.Exit(0)
	}()

	fmt.Printf("HomeNFV agent listening on %s (root: %s)\n", addr, root)
	if err := http.ListenAndServe(addr, handler); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
