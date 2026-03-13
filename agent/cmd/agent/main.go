package main

import (
	"fmt"
	"net/http"
	"os"
)

func main() {
	addr := os.Getenv("HOMENFV_LISTEN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8787"
	}

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})

	fmt.Printf("HomeNFV agent listening on %s\n", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
