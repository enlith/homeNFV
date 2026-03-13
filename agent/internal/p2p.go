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
	// Temp dir for client state (DB files etc)
	stateDir, err := os.MkdirTemp("", "homenfv-p2p-*")
	if err != nil {
		log.Printf("p2p: cannot create state dir: %v", err)
		return
	}
	defer os.RemoveAll(stateDir)

	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = stateDir
	cfg.DefaultStorage = storage.NewFile(destDir)
	cfg.Seed = false
	cfg.NoDHT = false
	cfg.ListenPort = 0

	client, err := torrent.NewClient(cfg)
	if err != nil {
		log.Printf("p2p: failed to create client: %v", err)
		return
	}
	defer client.Close()

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

	t.DownloadAll()
	log.Printf("p2p: downloading %q (%d bytes)", t.Name(), t.Length())
	if !client.WaitAll() {
		log.Printf("p2p: download incomplete")
		return
	}

	log.Printf("p2p: completed %q", t.Name())
}
