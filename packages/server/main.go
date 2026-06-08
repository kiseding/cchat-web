package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"crypto/rand"
)

// ── Types ──

type SessionMeta struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	CreatedAt       int64  `json:"createdAt"`
	UpdatedAt       int64  `json:"updatedAt"`
	MessageCount    int    `json:"messageCount"`
	ClaudeSessionID string `json:"claudeSessionId,omitempty"`
}

type MessagePart struct {
	Type       string                 `json:"type"`
	Text       string                 `json:"text,omitempty"`
	ToolName   string                 `json:"toolName,omitempty"`
	ToolInput  map[string]interface{} `json:"toolInput,omitempty"`
	ToolOutput string                 `json:"toolOutput,omitempty"`
	ToolID     string                 `json:"toolId,omitempty"`
}

type SessionMessage struct {
	ID        string        `json:"id"`
	Role      string        `json:"role"`
	Content   string        `json:"content"`
	Parts     []MessagePart `json:"parts,omitempty"`
	Timestamp int64         `json:"timestamp"`
}

// ── Globals ──

var (
	authToken      = getEnv("AUTH_TOKEN", "cchat2web")
	port           = getEnv("PORT", "4096")
	claudePath     = getEnv("CLAUDE_PATH", "claude")
	sessionsDir    = filepath.Join(os.Getenv("HOME"), ".cchat2web", "sessions")
	processes      = map[string]*ClaudeProcess{}
	procMu         sync.Mutex
	sessionProcMap = map[string]string{}
	spMu           sync.Mutex
)

func getEnv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func uuid() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// ── Claude Process ──

type ClaudeEvent struct {
	Type string
	Data map[string]interface{}
}

type ClaudeProcess struct {
	sessionID string
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	Events    chan ClaudeEvent
	mu        sync.Mutex
	alive     bool
	done      chan bool
}

func startClaude(sessionID string) (*ClaudeProcess, error) {
	choiceRule := "IMPORTANT: When asking the user to choose, format options as: 1. ShortLabel 2. ShortLabel 3. ShortLabel on ONE line separated by spaces."
	cmd := exec.Command(claudePath,
		"--session-id", sessionID,
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"-p", "--verbose",
		"--tools", "Task,Bash,CronCreate,CronDelete,CronList,Edit,EnterPlanMode,EnterWorktree,ExitPlanMode,ExitWorktree,Glob,Grep,NotebookEdit,Read,ScheduleWakeup,Skill,TaskCreate,TaskGet,TaskList,TaskOutput,TaskStop,TaskUpdate,WebFetch,WebSearch,Workflow,Write",
		"--append-system-prompt", choiceRule,
	)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	cp := &ClaudeProcess{
		sessionID: sessionID,
		cmd:       cmd,
		stdin:     stdin,
		Events:    make(chan ClaudeEvent, 100),
		alive:     true,
		done:      make(chan bool),
	}

	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			var msg map[string]interface{}
			if err := json.Unmarshal([]byte(line), &msg); err != nil {
				continue
			}
			msgType, _ := msg["type"].(string)
			subtype, _ := msg["subtype"].(string)

			switch {
			case msgType == "system" && subtype == "init":
				cp.Events <- ClaudeEvent{Type: "init", Data: msg}
			case msgType == "system" && subtype == "thinking_tokens":
				cp.Events <- ClaudeEvent{Type: "thinking", Data: msg}
			case msgType == "assistant":
				cp.Events <- ClaudeEvent{Type: "assistant", Data: msg}
			case msgType == "user":
				cp.Events <- ClaudeEvent{Type: "tool_result", Data: msg}
			case msgType == "result":
				cp.Events <- ClaudeEvent{Type: "done", Data: msg}
				cp.mu.Lock()
				cp.alive = false
				cp.mu.Unlock()
				goto done
			}
		}
	done:
		cmd.Wait()
		cp.done <- true
	}()

	return cp, nil
}

func (cp *ClaudeProcess) send(text string) error {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	msg := map[string]interface{}{
		"type": "user",
		"message": map[string]interface{}{
			"role":    "user",
			"content": []map[string]interface{}{{"type": "text", "text": text}},
		},
	}
	data, _ := json.Marshal(msg)
	_, err := cp.stdin.Write(append(data, '\n'))
	return err
}

func (cp *ClaudeProcess) kill() {
	cp.mu.Lock()
	defer cp.mu.Unlock()
	cp.alive = false
	if cp.cmd != nil && cp.cmd.Process != nil {
		cp.cmd.Process.Kill()
	}
}

// ── Session Storage ──

func ensureDir() { os.MkdirAll(sessionsDir, 0755) }

func listSessions() ([]SessionMeta, error) {
	ensureDir()
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return nil, err
	}
	var sessions []SessionMeta
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") && !strings.Contains(e.Name(), "-messages") {
			data, err := os.ReadFile(filepath.Join(sessionsDir, e.Name()))
			if err != nil {
				continue
			}
			var s SessionMeta
			if json.Unmarshal(data, &s) == nil {
				sessions = append(sessions, s)
			}
		}
	}
	return sessions, nil
}

func getSession(id string) (*SessionMeta, error) {
	data, err := os.ReadFile(filepath.Join(sessionsDir, id+".json"))
	if err != nil {
		return nil, err
	}
	var s SessionMeta
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, err
	}
	return &s, nil
}

func createSession(id, name string) (*SessionMeta, error) {
	ensureDir()
	now := time.Now().UnixMilli()
	if name == "" {
		name = "New Session-" + id[:8]
	}
	s := SessionMeta{ID: id, Title: name, CreatedAt: now, UpdatedAt: now}
	data, _ := json.Marshal(s)
	return &s, os.WriteFile(filepath.Join(sessionsDir, id+".json"), data, 0644)
}

func deleteSession(id string) {
	os.Remove(filepath.Join(sessionsDir, id+".json"))
	os.Remove(filepath.Join(sessionsDir, id+"-messages.json"))
}

func getMessages(id string) ([]SessionMessage, error) {
	data, err := os.ReadFile(filepath.Join(sessionsDir, id+"-messages.json"))
	if err != nil {
		return []SessionMessage{}, nil
	}
	var msgs []SessionMessage
	json.Unmarshal(data, &msgs)
	return msgs, nil
}

func appendMessage(id string, msg SessionMessage) error {
	msgs, _ := getMessages(id)
	msgs = append(msgs, msg)
	data, _ := json.Marshal(msgs)
	return os.WriteFile(filepath.Join(sessionsDir, id+"-messages.json"), data, 0644)
}

func updateSession(id string, title string, count int) {
	s, err := getSession(id)
	if err != nil {
		return
	}
	if title != "" {
		s.Title = title
	}
	if count >= 0 {
		s.MessageCount = count
	}
	s.UpdatedAt = time.Now().UnixMilli()
	data, _ := json.Marshal(s)
	os.WriteFile(filepath.Join(sessionsDir, id+".json"), data, 0644)
}

// ── HTTP Handlers ──

func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			next(w, r)
			return
		}
		auth := r.Header.Get("Authorization")
		if auth != "Bearer "+authToken {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(401)
			json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized"})
			return
		}
		next(w, r)
	}
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next(w, r)
	}
}

func handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		sessions, _ := listSessions()
		if sessions == nil {
			sessions = []SessionMeta{}
		}
		writeJSON(w, 200, sessions)
	case "POST":
		var body struct{ Name string }
		json.NewDecoder(r.Body).Decode(&body)
		name := strings.TrimSpace(body.Name)
		if name != "" {
			existing, _ := listSessions()
			for _, s := range existing {
				if s.Title == name {
					writeJSON(w, 409, map[string]string{"error": "Session name already exists"})
					return
				}
			}
		}
		s, _ := createSession(uuid(), name)
		writeJSON(w, 201, s)
	}
}

func handleSession(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	id = strings.Split(id, "/")[0]

	switch r.Method {
	case "GET":
		s, err := getSession(id)
		if err != nil {
			writeJSON(w, 404, map[string]string{"error": "Session not found"})
			return
		}
		msgs, _ := getMessages(id)
		writeJSON(w, 200, map[string]interface{}{"title": s.Title, "id": s.ID, "createdAt": s.CreatedAt, "updatedAt": s.UpdatedAt, "messageCount": s.MessageCount, "messages": msgs})
	case "DELETE":
		deleteSession(id)
		writeJSON(w, 200, map[string]bool{"ok": true})
	}
}

func handleMessages(w http.ResponseWriter, r *http.Request) {
	// Parse session ID from URL: /api/sessions/<id>/messages
	path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || parts[1] != "messages" {
		writeJSON(w, 404, map[string]string{"error": "Not found"})
		return
	}
	id := parts[0]

	var body struct{ Text string }
	json.NewDecoder(r.Body).Decode(&body)
	text := strings.TrimSpace(body.Text)
	if text == "" {
		writeJSON(w, 400, map[string]string{"error": "Empty message"})
		return
	}

	// Ensure session exists
	_, err := getSession(id)
	if err != nil {
		createSession(id, "")
	}

	// Save user message
	userMsg := SessionMessage{ID: uuid(), Role: "user", Content: text, Timestamp: time.Now().UnixMilli()}
	appendMessage(id, userMsg)

	// Build context prompt
	allMsgs, _ := getMessages(id)
	ctxMsgs := allMsgs
	if len(allMsgs) > 1 {
		ctxMsgs = allMsgs[:len(allMsgs)-1]
	}
	if len(ctxMsgs) > 30 {
		ctxMsgs = ctxMsgs[len(ctxMsgs)-30:]
	}
	var historyParts []string
	for _, m := range ctxMsgs {
		role := "User"
		if m.Role == "assistant" {
			role = "Assistant"
		}
		historyParts = append(historyParts, fmt.Sprintf("%s: %s", role, m.Content))
	}
	prompt := text
	if len(historyParts) > 0 {
		prompt = fmt.Sprintf("Previous conversation:\n%s\n\nUser: %s\n\nContinue as Assistant.", strings.Join(historyParts, "\n\n"), text)
	}

	// SSE streaming
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, 500, map[string]string{"error": "Streaming not supported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	// Build Claude command with stdin piped
	choiceRule := "IMPORTANT: When asking the user to choose, format options as: 1. ShortLabel 2. ShortLabel 3. ShortLabel on ONE line separated by spaces."
	msgData, _ := json.Marshal(map[string]interface{}{
		"type": "user",
		"message": map[string]interface{}{
			"role":    "user",
			"content": []map[string]interface{}{{"type": "text", "text": prompt}},
		},
	})

	cmd := exec.Command(claudePath,
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"-p", "--verbose",
		"--tools", "Task,Bash,CronCreate,CronDelete,CronList,Edit,EnterPlanMode,EnterWorktree,ExitPlanMode,ExitWorktree,Glob,Grep,NotebookEdit,Read,ScheduleWakeup,Skill,TaskCreate,TaskGet,TaskList,TaskOutput,TaskStop,TaskUpdate,WebFetch,WebSearch,Workflow,Write",
		"--append-system-prompt", choiceRule,
	)
	cmd.Stdin = strings.NewReader(string(msgData) + "\n")
	cmd.Stderr = os.Stderr

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		sendSSE(w, flusher, "error", map[string]string{"message": err.Error()})
		return
	}

	if err := cmd.Start(); err != nil {
		sendSSE(w, flusher, "error", map[string]string{"message": err.Error()})
		return
	}
	var contentBlocks []MessagePart
	var currentText string

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		msgType, _ := msg["type"].(string)
		subtype, _ := msg["subtype"].(string)

		switch {
		case msgType == "system" && subtype == "init":
			sendSSE(w, flusher, "init", map[string]interface{}{"model": msg["model"], "permissionMode": msg["permissionMode"]})
		case msgType == "system" && subtype == "thinking_tokens":
			sendSSE(w, flusher, "thinking", map[string]interface{}{"tokens": msg["estimated_tokens"]})
		case msgType == "assistant":
			amsg, _ := msg["message"].(map[string]interface{})
			content, _ := amsg["content"].([]interface{})
			for _, c := range content {
				part, _ := c.(map[string]interface{})
				if part["type"] == "text" {
					t, _ := part["text"].(string)
					currentText += t
					sendSSE(w, flusher, "text-delta", map[string]string{"text": t})
				} else if part["type"] == "tool_use" {
					if strings.TrimSpace(currentText) != "" {
						contentBlocks = append(contentBlocks, MessagePart{Type: "text", Text: currentText})
						currentText = ""
					}
					name, _ := part["name"].(string)
					id, _ := part["id"].(string)
					input, _ := part["input"].(map[string]interface{})
					contentBlocks = append(contentBlocks, MessagePart{Type: "tool_call", ToolName: name, ToolID: id, ToolInput: input})
					sendSSE(w, flusher, "tool-start", map[string]interface{}{"toolId": id, "toolName": name, "toolInput": input})
				}
			}
		case msgType == "user":
			umsg, _ := msg["message"].(map[string]interface{})
			content, _ := umsg["content"].([]interface{})
			for _, c := range content {
				part, _ := c.(map[string]interface{})
				if part["type"] == "tool_result" {
					output := ""
					if s, ok := part["content"].(string); ok {
						output = s
					} else {
						data, _ := json.Marshal(part["content"])
						output = string(data)
					}
					if len(output) > 5000 {
						output = output[:5000] + "\n... [truncated]"
					}
					id, _ := part["tool_use_id"].(string)
					contentBlocks = append(contentBlocks, MessagePart{Type: "tool_result", ToolID: id, ToolOutput: output})
					sendSSE(w, flusher, "tool-end", map[string]interface{}{"toolId": id, "output": output})
				}
			}
		case msgType == "result":
			if strings.TrimSpace(currentText) != "" {
				contentBlocks = append(contentBlocks, MessagePart{Type: "text", Text: currentText})
			}
			sendSSE(w, flusher, "done", map[string]string{})
			goto done
		}
	}
done:
	cmd.Wait()

	// Save assistant message
	fullText := ""
	for _, b := range contentBlocks {
		if b.Type == "text" {
			fullText += b.Text + "\n\n"
		}
	}
	fullText = strings.TrimSpace(fullText)
	if fullText != "" || len(contentBlocks) > 0 {
		assistantMsg := SessionMessage{ID: uuid(), Role: "assistant", Content: fullText, Parts: contentBlocks, Timestamp: time.Now().UnixMilli()}
		appendMessage(id, assistantMsg)
		msgs, _ := getMessages(id)
		updateSession(id, generateTitle(text), len(msgs))
	}
}

func handleAbort(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	id = strings.Split(id, "/")[0]
	spMu.Lock()
	if cid, ok := sessionProcMap[id]; ok {
		procMu.Lock()
		if p, ok := processes[cid]; ok {
			p.kill()
			delete(processes, cid)
		}
		procMu.Unlock()
		delete(sessionProcMap, id)
	}
	spMu.Unlock()
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ── Helpers ──

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func sendSSE(w http.ResponseWriter, flusher http.Flusher, event string, data interface{}) {
	d, _ := json.Marshal(data)
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(d))
	flusher.Flush()
}

func generateTitle(text string) string {
	t := strings.Join(strings.Fields(text), " ")
	if len(t) > 60 {
		return t[:60] + "..."
	}
	return t
}

// ── Main ──

func main() {
	mux := http.NewServeMux()

	// API routes
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok"})
	})
	apiHandler := corsMiddleware(authMiddleware(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/api/sessions" || path == "/api/sessions/" {
			handleSessions(w, r)
			return
		}
		if strings.HasSuffix(path, "/messages") {
			handleMessages(w, r)
			return
		}
		if strings.HasSuffix(path, "/abort") {
			handleAbort(w, r)
			return
		}
		handleSession(w, r)
	}))
	mux.HandleFunc("/api/sessions", apiHandler)
	mux.HandleFunc("/api/sessions/", apiHandler)

	// Static files
	staticDir := filepath.Join(filepath.Dir(os.Args[0]), "..", "app", "dist")
	if _, err := os.Stat(staticDir); os.IsNotExist(err) {
		staticDir = filepath.Join("..", "app", "dist")
	}
	fs := http.FileServer(http.Dir(staticDir))

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			return
		}
		// Try static file, fallback to index.html
		path := filepath.Join(staticDir, r.URL.Path)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}
		fs.ServeHTTP(w, r)
	})

	addr := "0.0.0.0:" + port
	log.Printf("CChat-Web server starting on http://localhost:%s", port)
	log.Fatal(http.ListenAndServe(addr, mux))
}
