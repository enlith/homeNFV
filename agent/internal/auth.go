package agent

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"time"
)

func AuthMiddleware(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}

		ts := r.Header.Get("X-HomeNFV-Timestamp")
		sig := r.Header.Get("X-HomeNFV-Signature")
		if ts == "" || sig == "" {
			http.Error(w, `{"error":"missing auth headers"}`, http.StatusUnauthorized)
			return
		}

		t, err := strconv.ParseInt(ts, 10, 64)
		if err != nil || math.Abs(float64(time.Now().Unix()-t)) > 30 {
			http.Error(w, `{"error":"invalid or expired timestamp"}`, http.StatusUnauthorized)
			return
		}

		expected := sign(secret, fmt.Sprintf("%s:%s:%s", r.Method, r.URL.Path, ts))
		if !hmac.Equal([]byte(sig), []byte(expected)) {
			http.Error(w, `{"error":"invalid signature"}`, http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func sign(secret, message string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}
