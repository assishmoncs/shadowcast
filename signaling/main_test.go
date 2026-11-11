package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func newTestConfig() *Config {
	return &Config{
		Port:              ":0",
		AllowedOrigins:    []string{"*"},
		MaxRooms:          5,
		MaxClientsPerRoom: 3,
		RateLimitPerSec:   50,
		AuthToken:         "",
		ReadLimitBytes:    65536,
		PingInterval:      5 * time.Second,
		PongWait:          10 * time.Second,
	}
}

func dialWS(t *testing.T, serverURL string, headers http.Header) *websocket.Conn {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(serverURL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("failed to dial websocket: %v", err)
	}
	return conn
}

func readJSONMsg(t *testing.T, conn *websocket.Conn) map[string]interface{} {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("failed to read websocket message: %v", err)
	}
	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("failed to unmarshal message: %v", err)
	}
	return msg
}

func TestHealthAndMetricsEndpoints(t *testing.T) {
	handler := newSignalingServer(newTestConfig())
	ts := httptest.NewServer(handler)
	defer ts.Close()

	// 1. /healthz
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from /healthz, got %v, err=%v", resp, err)
	}

	// 2. /ready
	resp, err = http.Get(ts.URL + "/ready")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from /ready, got %v, err=%v", resp, err)
	}
	var readyPayload map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&readyPayload); err != nil {
		t.Fatalf("failed to decode /ready JSON: %v", err)
	}
	if readyPayload["status"] != "ready" {
		t.Fatalf("expected status=ready, got %v", readyPayload["status"])
	}

	// 3. /metrics
	resp, err = http.Get(ts.URL + "/metrics")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from /metrics, got %v, err=%v", resp, err)
	}
	buf := new(bytes.Buffer)
	_, _ = buf.ReadFrom(resp.Body)
	if !strings.Contains(buf.String(), "shadowcast_active_clients") {
		t.Fatalf("expected prometheus metrics output, got: %s", buf.String())
	}
}

func TestWebSocketJoinAndSignalingRelay(t *testing.T) {
	handler := newSignalingServer(newTestConfig())
	ts := httptest.NewServer(handler)
	defer ts.Close()

	c1 := dialWS(t, ts.URL, nil)
	defer c1.Close()
	c2 := dialWS(t, ts.URL, nil)
	defer c2.Close()

	// Consume initial self-id messages
	msg1 := readJSONMsg(t, c1)
	if msg1["type"] != "self-id" {
		t.Fatalf("expected self-id, got %v", msg1)
	}
	msg2 := readJSONMsg(t, c2)
	if msg2["type"] != "self-id" {
		t.Fatalf("expected self-id, got %v", msg2)
	}

	// Peer 1 joins room with explicit client ID
	_ = c1.WriteJSON(map[string]interface{}{
		"type": "join",
		"room": "test-room",
		"from": "peer-alpha",
	})
	roomPeers1 := readJSONMsg(t, c1)
	if roomPeers1["type"] != "room-peers" {
		t.Fatalf("expected room-peers for peer-alpha, got %v", roomPeers1)
	}

	// Peer 2 joins same room with explicit client ID
	_ = c2.WriteJSON(map[string]interface{}{
		"type": "join",
		"room": "test-room",
		"from": "peer-beta",
	})
	roomPeers2 := readJSONMsg(t, c2)
	if roomPeers2["type"] != "room-peers" {
		t.Fatalf("expected room-peers for peer-beta, got %v", roomPeers2)
	}
	peersSlice, ok := roomPeers2["peers"].([]interface{})
	if !ok || len(peersSlice) != 1 || peersSlice[0] != "peer-alpha" {
		t.Fatalf("expected peers=[peer-alpha], got %v", roomPeers2["peers"])
	}

	// Peer 1 receives peer-joined for peer-beta
	joinedNotification := readJSONMsg(t, c1)
	if joinedNotification["type"] != "peer-joined" || joinedNotification["id"] != "peer-beta" {
		t.Fatalf("expected peer-joined for peer-beta, got %v", joinedNotification)
	}

	// Peer 1 sends WebRTC offer to peer-beta
	_ = c1.WriteJSON(map[string]interface{}{
		"type":   "offer",
		"target": "peer-beta",
		"sdp":    map[string]interface{}{"type": "offer", "sdp": "v=0..."},
	})

	offerMsg := readJSONMsg(t, c2)
	if offerMsg["type"] != "offer" || offerMsg["from"] != "peer-alpha" {
		t.Fatalf("expected offer from peer-alpha, got %v", offerMsg)
	}
}

func TestRateLimiter(t *testing.T) {
	rl := NewRateLimiter(2) // 2 per sec, burst capacity 4
	if !rl.Allow() || !rl.Allow() {
		t.Fatalf("expected initial tokens to allow requests")
	}
	if rl.Allow() {
		t.Fatalf("expected 3rd immediate request to be rate-limited")
	}
}

func writeJSONMsg(t *testing.T, conn *websocket.Conn, message map[string]any) {
	t.Helper()
	if err := conn.WriteJSON(message); err != nil {
		t.Fatalf("write websocket message: %v", err)
	}
}

func joinAs(t *testing.T, conn *websocket.Conn, room, peer string) map[string]any {
	t.Helper()
	writeJSONMsg(t, conn, map[string]any{"type": "join", "room": room, "from": peer})
	return readJSONMsg(t, conn)
}

func startTestServer(t *testing.T, config *Config) (*SignalingServer, *httptest.Server) {
	t.Helper()
	server := newSignalingServer(config)
	httpServer := httptest.NewServer(server)
	t.Cleanup(func() {
		server.close()
		httpServer.Close()
	})
	return server, httpServer
}

func connectTestPeer(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn := dialWS(t, url, nil)
	t.Cleanup(func() { _ = conn.Close() })
	if msg := readJSONMsg(t, conn); msg["type"] != "self-id" {
		t.Fatalf("unexpected initial message: %v", msg)
	}
	return conn
}

func TestRoomRelayIsolationAndIdentity(t *testing.T) {
	t.Parallel()
	_, server := startTestServer(t, newTestConfig())
	alpha := connectTestPeer(t, server.URL)
	beta := connectTestPeer(t, server.URL)
	offer := map[string]any{
		"type": "offer", "from": "forged", "target": "beta",
		"sdp": map[string]string{"type": "offer", "sdp": "v=0"},
	}
	writeJSONMsg(t, alpha, offer)
	if msg := readJSONMsg(t, alpha); msg["type"] != "error" {
		t.Fatalf("expected unjoined relay rejection: %v", msg)
	}
	if msg := joinAs(t, alpha, "first", "alpha"); msg["id"] != "alpha" || msg["room"] != "first" {
		t.Fatalf("invalid join acknowledgment: %v", msg)
	}
	if msg := joinAs(t, beta, "second", "alpha"); msg["type"] != "error" {
		t.Fatalf("expected duplicate ID rejection: %v", msg)
	}
	if msg := joinAs(t, beta, "second", "beta"); msg["type"] != "room-peers" {
		t.Fatalf("failed to join second room: %v", msg)
	}

	writeJSONMsg(t, alpha, offer)
	if msg := readJSONMsg(t, alpha); msg["type"] != "error" {
		t.Fatalf("expected cross-room rejection: %v", msg)
	}
	if msg := joinAs(t, beta, "first", "beta"); msg["type"] != "room-peers" {
		t.Fatalf("expected clean acknowledgment after blocked relay: %v", msg)
	}
	if msg := readJSONMsg(t, alpha); msg["type"] != "peer-joined" || msg["id"] != "beta" {
		t.Fatalf("expected join notification: %v", msg)
	}

	if msg := joinAs(t, alpha, "first", "renamed"); msg["type"] != "error" {
		t.Fatalf("expected immutable peer ID: %v", msg)
	}
	writeJSONMsg(t, alpha, offer)
	if msg := readJSONMsg(t, beta); msg["type"] != "offer" || msg["from"] != "alpha" {
		t.Fatalf("expected authenticated sender identity: %v", msg)
	}

	if msg := joinAs(t, beta, "third", "beta"); msg["room"] != "third" {
		t.Fatalf("failed to switch rooms: %v", msg)
	}
	if msg := readJSONMsg(t, alpha); msg["type"] != "peer-left" || msg["id"] != "beta" {
		t.Fatalf("expected leave notification: %v", msg)
	}
}

func TestConcurrentJoinsHonorCapacity(t *testing.T) {
	t.Parallel()
	config := newTestConfig()
	config.MaxRooms = 1
	config.MaxClientsPerRoom = 1
	_, server := startTestServer(t, config)
	clients := []*websocket.Conn{connectTestPeer(t, server.URL), connectTestPeer(t, server.URL)}
	for _, conn := range clients {
		writeJSONMsg(t, conn, map[string]any{"type": "join", "room": "limited"})
	}
	first := readJSONMsg(t, clients[0])
	second := readJSONMsg(t, clients[1])
	if first["type"] == second["type"] {
		t.Fatalf("expected exactly one successful join: %v %v", first, second)
	}
	winner, loser := clients[0], clients[1]
	if first["type"] == "error" {
		winner, loser = loser, winner
	}
	if msg := joinAs(t, loser, "other", ""); msg["type"] != "error" {
		t.Fatalf("expected room capacity rejection: %v", msg)
	}
	if msg := joinAs(t, winner, "other", ""); msg["room"] != "other" {
		t.Fatalf("the sole member should be able to move at the room limit: %v", msg)
	}
}

func TestAuthenticationOriginAndShutdown(t *testing.T) {
	t.Parallel()
	config := newTestConfig()
	config.AuthToken = "test-secret"
	config.AllowedOrigins = []string{"https://assets.example"}
	handler, server := startTestServer(t, config)
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"

	for _, tc := range []struct {
		name, token, origin string
		status              int
	}{
		{"missing token", "", "https://assets.example", http.StatusUnauthorized},
		{"untrusted origin", "test-secret", "https://other.example", http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn, resp, err := websocket.DefaultDialer.Dial(url, http.Header{
				"Origin": {tc.origin}, "X-Auth-Token": {tc.token},
			})
			if conn != nil {
				_ = conn.Close()
			}
			if resp != nil {
				defer resp.Body.Close()
			}
			if err == nil || resp == nil || resp.StatusCode != tc.status {
				t.Fatalf("expected upgrade status %d, got %v, %v", tc.status, resp, err)
			}
		})
	}
	conn := dialWS(t, server.URL, http.Header{
		"Origin": {"https://assets.example"}, "X-Auth-Token": {"test-secret"},
	})
	defer conn.Close()
	readJSONMsg(t, conn)
	handler.close()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := conn.ReadMessage(); err == nil {
		t.Fatal("shutdown should close the active WebSocket")
	}
	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected draining readiness status, got %d", ready.Code)
	}
}
