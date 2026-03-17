//go:build p2p

package agent

import (
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/storage"
)

func isPeerLink(url string) bool {
	if strings.HasPrefix(url, "magnet:") {
		return true
	}
	path := url
	if i := strings.Index(path, "?"); i != -1 {
		path = path[:i]
	}
	return strings.HasSuffix(strings.ToLower(path), ".torrent")
}

func (h *FileHandler) peerFetch(uri, destDir string) {
	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = destDir
	cfg.DefaultStorage = storage.NewFile(destDir)
	cfg.Seed = false
	cfg.DisableAggressiveUpload = true
	cfg.ListenPort = 0

	client, err := torrent.NewClient(cfg)
	if err != nil {
		log.Printf("p2p: failed to create client: %v", err)
		return
	}
	defer func() {
		client.Close()
		// Clean up DB files from working dir and destDir
		for _, dir := range []string{".", destDir} {
			for _, pat := range []string{".torrent.db", ".torrent.db-shm", ".torrent.db-wal"} {
				os.Remove(filepath.Join(dir, pat))
			}
		}
	}()

	var t *torrent.Torrent
	if strings.HasPrefix(uri, "magnet:") {
		t, err = client.AddMagnet(uri)
	} else if strings.HasPrefix(uri, "http://") || strings.HasPrefix(uri, "https://") {
		tmp, dlErr := os.CreateTemp("", "homenfv-*.torrent")
		if dlErr != nil {
			log.Printf("p2p: cannot create temp file: %v", dlErr)
			return
		}
		tmpPath := tmp.Name()
		defer os.Remove(tmpPath)

		resp, dlErr := http.Get(uri)
		if dlErr != nil {
			tmp.Close()
			log.Printf("p2p: failed to download descriptor: %v", dlErr)
			return
		}
		_, dlErr = io.Copy(tmp, resp.Body)
		resp.Body.Close()
		tmp.Close()
		if dlErr != nil {
			log.Printf("p2p: failed to write descriptor: %v", dlErr)
			return
		}
		t, err = client.AddTorrentFromFile(tmpPath)
	} else {
		t, err = client.AddTorrentFromFile(uri)
	}
	if err != nil {
		log.Printf("p2p: failed to add: %v", err)
		return
	}

	log.Printf("p2p: waiting for metadata...")
	select {
	case <-t.GotInfo():
	case <-time.After(5 * time.Minute):
		log.Printf("p2p: metadata timeout")
		return
	}

	total := t.Length()
	t.DownloadAll()
	log.Printf("p2p: downloading %q (%d MB, %d pieces)", t.Name(), total/1024/1024, t.NumPieces())

	// Log progress every 30s
	done := make(chan bool, 1)
	go func() {
		for {
			select {
			case <-done:
				return
			case <-time.After(30 * time.Second):
				completed := t.BytesCompleted()
				pct := float64(completed) / float64(total) * 100
				stats := t.Stats()
				log.Printf("p2p: %q %.1f%% (%d/%d MB) peers: %d active: %d",
					t.Name(), pct, completed/1024/1024, total/1024/1024,
					stats.TotalPeers, stats.ActivePeers)
			}
		}
	}()

	ok := client.WaitAll()
	done <- true

	if !ok {
		log.Printf("p2p: download incomplete for %q", t.Name())
		return
	}

	log.Printf("p2p: completed %q (%d MB)", t.Name(), total/1024/1024)
}
