package agent

import (
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/storage"
)

func isPeerLink(url string) bool {
	return strings.HasPrefix(url, "magnet:") || strings.HasSuffix(strings.ToLower(url), ".torrent")
}

func (h *FileHandler) peerFetch(uri, destDir string) {
	cfg := torrent.NewDefaultClientConfig()
	cfg.DataDir = destDir
	cfg.DefaultStorage = storage.NewFileByInfoHash(destDir)
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

	// Move files from hash-based storage to destination
	info := t.Info()
	srcBase := filepath.Join(destDir, t.InfoHash().HexString())
	for _, f := range info.UpvertedFiles() {
		dp := f.DisplayPath(info)
		src := filepath.Join(srcBase, dp)
		dst := filepath.Join(destDir, dp)
		if src == dst {
			continue
		}
		os.MkdirAll(filepath.Dir(dst), 0755)
		os.Rename(src, dst)
	}
	os.RemoveAll(srcBase)

	log.Printf("p2p: completed %q", t.Name())
}
