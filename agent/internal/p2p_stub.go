//go:build !p2p

package agent

func isPeerLink(_ string) bool { return false }

func (h *FileHandler) peerFetch(_, _ string) {}
